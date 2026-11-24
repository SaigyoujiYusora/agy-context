import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginConfig } from './model_core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const BUNDLED_DLL_PATH = path.join(PLUGIN_ROOT, 'native', 'DWrite.dll');
const DLL_MARKER = Buffer.from('AGY_CONTEXT_DWRITE_LOADER_V1', 'ascii');
const DLL_REV_PREFIX = Buffer.from('AGY_CONTEXT_DWRITE_REV=', 'ascii');

const BOOTSTRAP_INDEX_CJS = `'use strict';
// AGY_CONTEXT_ELECTRON_LOADER - self-healing bootstrapper (app.asar left untouched)

const fs = require('fs');
const os = require('os');
const path = require('path');

const loaderPath = path.join(
  process.env.USERPROFILE || process.env.HOME || os.homedir(),
  '.gemini', 'config', 'plugins', 'agy-model-inspector', 'scripts', 'electron-overlay-loader.cjs'
);
try {
  if (fs.existsSync(loaderPath)) {
    require(loaderPath);
  }
} catch (err) {
  console.warn('[AGY Context] Direct Electron loader skipped:', err && err.message ? err.message : err);
}

const asarPath = path.resolve(__dirname, '..', 'app.asar');
let realPkg = { main: 'dist/main.js' };
try {
  realPkg = JSON.parse(fs.readFileSync(path.join(asarPath, 'package.json'), 'utf8'));
} catch {}

try {
  const electron = require('electron');
  if (electron && electron.app) {
    if (realPkg && realPkg.version) {
      electron.app.getVersion = () => realPkg.version;
    }
    electron.app.getAppPath = () => asarPath;
  }
} catch {}

const mainRel = (realPkg && realPkg.main) ? realPkg.main : 'dist/main.js';
module.exports = require(path.join(asarPath, mainRel));
`;

function isValidPe64Dll(buf) {
  if (!buf || buf.length < 16 * 1024 || buf.length > 2 * 1024 * 1024) return false;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return false; // MZ
  const peOff = buf.readInt32LE(0x3c);
  if (peOff < 0 || peOff + 24 > buf.length) return false;
  if (buf[peOff] !== 0x50 || buf[peOff + 1] !== 0x45 || buf[peOff + 2] !== 0 || buf[peOff + 3] !== 0) return false; // PE\0\0
  const characteristics = buf.readUInt16LE(peOff + 22);
  return (characteristics & 0x2000) !== 0; // IMAGE_FILE_DLL
}

function isOurDwriteDll(buf) {
  return isValidPe64Dll(buf) && buf.indexOf(DLL_MARKER) >= 0;
}

function parseDllRev(buf) {
  const idx = buf.indexOf(DLL_REV_PREFIX);
  if (idx < 0) return 1;
  let off = idx + DLL_REV_PREFIX.length;
  let val = 0;
  let digits = 0;
  while (off < buf.length && digits < 6 && buf[off] >= 0x30 && buf[off] <= 0x39) {
    val = val * 10 + (buf[off] - 0x30);
    off += 1;
    digits += 1;
  }
  return digits > 0 ? val : 1;
}

function findAntigravityInstallDir() {
  const candidates = [];
  if (process.env.AGY_INSTALL_DIR) candidates.push(process.env.AGY_INSTALL_DIR);
  if (process.env.ANTIGRAVITY_INSTALL_DIR) candidates.push(process.env.ANTIGRAVITY_INSTALL_DIR);
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'antigravity'));
  if (process.execPath && path.basename(process.execPath).toLowerCase() === 'antigravity.exe') {
    candidates.push(path.dirname(process.execPath));
  }
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (
        fs.existsSync(path.join(dir, 'Antigravity.exe')) &&
        fs.existsSync(path.join(dir, 'resources', 'app.asar'))
      ) {
        return dir;
      }
    } catch {}
  }
  return '';
}

function readAsarRootPackageMeta(asarPath) {
  const fallback = { name: 'antigravity', productName: 'Antigravity', version: '', main: 'dist/main.js' };
  const parsePkgObj = (pkg) => {
    const version = typeof pkg?.version === 'string' && /^[0-9A-Za-z._+-]{1,48}$/.test(pkg.version) ? pkg.version : '';
    return {
      name: typeof pkg?.name === 'string' && pkg.name ? pkg.name : fallback.name,
      productName: typeof pkg?.productName === 'string' && pkg.productName ? pkg.productName : fallback.productName,
      version,
      main: typeof pkg?.main === 'string' && pkg.main ? pkg.main : fallback.main
    };
  };

  // When running under Electron (ELECTRON_RUN_AS_NODE), fs treats .asar as a virtual directory by default.
  try {
    const directPkg = JSON.parse(fs.readFileSync(path.join(asarPath, 'package.json'), 'utf8'));
    const parsed = parsePkgObj(directPkg);
    if (parsed.version) return parsed;
  } catch {}

  const prevNoAsar = process.noAsar;
  let fd;
  try {
    process.noAsar = true;
    fd = fs.openSync(asarPath, 'r');
    const hdr = Buffer.alloc(16);
    if (fs.readSync(fd, hdr, 0, 16, 0) !== 16) return fallback;
    const pickle0 = hdr.readUInt32LE(0);
    const hdrSize = hdr.readUInt32LE(4);
    const jsonLen = hdr.readUInt32LE(12);
    if (pickle0 !== 4 || hdrSize < 8 || jsonLen < 16 || jsonLen > 4 * 1024 * 1024) return fallback;
    const jbuf = Buffer.alloc(jsonLen);
    if (fs.readSync(fd, jbuf, 0, jsonLen, 16) !== jsonLen) return fallback;
    const meta = JSON.parse(jbuf.toString('utf8'));
    const entry = meta?.files?.['package.json'];
    if (!entry || !entry.size || entry.size > 65536) return fallback;
    const dataOffset = 8 + hdrSize + Number(entry.offset || 0);
    const pbuf = Buffer.alloc(entry.size);
    if (fs.readSync(fd, pbuf, 0, entry.size, dataOffset) !== entry.size) return fallback;
    return parsePkgObj(JSON.parse(pbuf.toString('utf8')));
  } catch {
    return fallback;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    process.noAsar = prevNoAsar;
  }
}

function cleanupOldDllFiles(agDir) {
  try {
    for (const name of fs.readdirSync(agDir)) {
      if (!/^DWrite\.dll\.old/i.test(name)) continue;
      try { fs.unlinkSync(path.join(agDir, name)); } catch {}
    }
  } catch {}
}

function syncBootstrapFiles(agDir) {
  const asarPath = path.join(agDir, 'resources', 'app.asar');
  const meta = readAsarRootPackageMeta(asarPath);
  const appDir = path.join(agDir, 'resources', 'app');
  const pkgPath = path.join(appDir, 'package.json');
  const idxPath = path.join(appDir, 'index.cjs');

  let curPkg = '';
  try { curPkg = fs.readFileSync(pkgPath, 'utf8'); } catch {}
  let effectiveVersion = meta.version;
  if (!effectiveVersion && curPkg) {
    try {
      const existing = JSON.parse(curPkg);
      if (typeof existing?.version === 'string' && existing.version && existing.version !== '0.0.0') {
        effectiveVersion = existing.version;
      }
    } catch {}
  }

  const pkgObj = {
    name: meta.name,
    productName: meta.productName,
    ...(effectiveVersion ? { version: effectiveVersion } : {}),
    main: 'index.cjs'
  };
  const expectedPkg = `${JSON.stringify(pkgObj, null, 2)}\n`;

  fs.mkdirSync(appDir, { recursive: true });
  let healed = false;

  if (curPkg !== expectedPkg) {
    fs.writeFileSync(pkgPath, expectedPkg, 'utf8');
    healed = true;
  }

  let curIdx = '';
  try { curIdx = fs.readFileSync(idxPath, 'utf8'); } catch {}
  if (curIdx !== BOOTSTRAP_INDEX_CJS) {
    fs.writeFileSync(idxPath, BOOTSTRAP_INDEX_CJS, 'utf8');
    healed = true;
  }

  return { healed, agVersion: meta.version };
}

/**
 * Automatically ensures <AntigravityDir>\DWrite.dll and resources\app\{package.json,index.cjs}
 * are present and up to date on Windows x64, recovering transparently after Antigravity updates
 * or zero-script plugin installations without ever overwriting foreign DWrite.dll files.
 */
export function ensureDirectDllSynced(opts = {}) {
  const directOverlay = Boolean(opts.directOverlay ?? (process.env.AGY_DISABLE_RUNTIME_INJECTOR === '1'));
  const now = Date.now();
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return { ok: true, status: 'unsupported_platform', needsRestart: false, checkedAtMs: now };
  }

  try {
    const cfg = getPluginConfig();
    if (cfg?.disableAutoDllInstall === true) {
      return { ok: true, status: 'disabled', needsRestart: false, checkedAtMs: now };
    }
  } catch {}

  const srcDll = opts.srcDllPath || BUNDLED_DLL_PATH;
  if (!fs.existsSync(srcDll)) {
    return { ok: true, status: 'no_bundled_dll', needsRestart: false, checkedAtMs: now };
  }

  const agDir = opts.agDir || findAntigravityInstallDir();
  if (!agDir) {
    return { ok: true, status: 'not_found', needsRestart: false, checkedAtMs: now };
  }

  try {
    cleanupOldDllFiles(agDir);

    const srcStat = fs.statSync(srcDll);
    const dstDll = path.join(agDir, 'DWrite.dll');
    let dllAction = 'up_to_date';
    let srcRev = 0;

    let dstStat = null;
    try { dstStat = fs.statSync(dstDll); } catch {}

    const fastMatch = Boolean(
      dstStat &&
      dstStat.size === srcStat.size &&
      Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1000
    );

    if (!fastMatch) {
      const srcBuf = fs.readFileSync(srcDll);
      if (!isOurDwriteDll(srcBuf)) {
        return { ok: false, status: 'invalid_bundled_dll', needsRestart: false, agDir, checkedAtMs: now };
      }
      srcRev = parseDllRev(srcBuf);

      if (!dstStat) {
        fs.copyFileSync(srcDll, dstDll);
        try { fs.utimesSync(dstDll, srcStat.atime, srcStat.mtime); } catch {}
        dllAction = 'installed';
      } else {
        const dstBuf = fs.readFileSync(dstDll);
        if (!isOurDwriteDll(dstBuf)) {
          return { ok: true, status: 'skipped_foreign_dll', needsRestart: false, agDir, checkedAtMs: now };
        }
        const dstRev = parseDllRev(dstBuf);
        const shouldUpgrade =
          srcRev > dstRev ||
          (srcRev === dstRev && !srcBuf.equals(dstBuf) && srcStat.mtimeMs > dstStat.mtimeMs);

        if (shouldUpgrade) {
          try {
            fs.copyFileSync(srcDll, dstDll);
          } catch {
            const oldPath = path.join(agDir, `DWrite.dll.old.${process.pid}`);
            fs.renameSync(dstDll, oldPath);
            try {
              fs.copyFileSync(srcDll, dstDll);
            } catch (copyErr) {
              try { fs.renameSync(oldPath, dstDll); } catch {}
              throw copyErr;
            }
          }
          try { fs.utimesSync(dstDll, srcStat.atime, srcStat.mtime); } catch {}
          dllAction = 'updated';
        }
      }
    }

    const { healed: bootstrapHealed, agVersion } = syncBootstrapFiles(agDir);
    const status =
      dllAction !== 'up_to_date'
        ? dllAction
        : bootstrapHealed
          ? 'healed_bootstrap'
          : 'up_to_date';
    const needsRestart =
      dllAction === 'installed' ||
      dllAction === 'updated' ||
      (!directOverlay && bootstrapHealed);

    return {
      ok: true,
      status,
      needsRestart,
      agDir,
      agVersion,
      ...(srcRev ? { dllRev: srcRev } : {}),
      dllAction,
      bootstrapHealed,
      checkedAtMs: now
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      error: String(err?.message || err),
      needsRestart: false,
      agDir,
      checkedAtMs: now
    };
  }
}
