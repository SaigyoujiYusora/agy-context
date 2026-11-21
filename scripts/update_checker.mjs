import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DATA_DIR } from './model_core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_FILE = path.resolve(__dirname, '..', 'plugin.json');
const UPDATE_CACHE_FILE = path.join(PLUGIN_DATA_DIR, 'update_check.json');

export const GITHUB_OWNER = 'SaigyoujiYusora';
export const GITHUB_REPO = 'agy-context';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_CONTENTS_MANIFEST = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/plugin.json`;
const GITHUB_RAW_MANIFEST = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/plugin.json`;

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const STARTUP_DELAY_MS = 8000;

let memCache = null;
let memCacheMtimeMs = -1;
let inFlightCheck = null;
let schedulerStarted = false;

export function normalizeVersion(raw) {
  return String(raw || '').trim().replace(/^v/i, '');
}

function parseSemver(raw) {
  const clean = normalizeVersion(raw);
  const [corePart, prePart = ''] = clean.split('-', 2);
  const nums = corePart.split('.').map(p => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  while (nums.length < 3) nums.push(0);
  return {
    major: nums[0],
    minor: nums[1],
    patch: nums[2],
    prerelease: prePart.trim()
  };
}

export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;
  return pa.prerelease > pb.prerelease ? 1 : -1;
}

export function getLocalPluginVersion() {
  try {
    const raw = fs.readFileSync(PLUGIN_MANIFEST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const v = normalizeVersion(parsed?.version);
    if (v) return v;
  } catch {}
  return '0.0.0';
}

function readCacheDisk() {
  try {
    if (!fs.existsSync(UPDATE_CACHE_FILE)) {
      memCache = null;
      memCacheMtimeMs = 0;
      return null;
    }
    const stat = fs.statSync(UPDATE_CACHE_FILE);
    if (memCache && stat.mtimeMs === memCacheMtimeMs) {
      return memCache;
    }
    const parsed = JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      memCache = parsed;
      memCacheMtimeMs = stat.mtimeMs;
      return memCache;
    }
  } catch {}
  return memCache;
}

function writeCacheDisk(payload) {
  try {
    fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
    const tmp = `${UPDATE_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, UPDATE_CACHE_FILE);
    } catch {
      fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
      try { fs.unlinkSync(tmp); } catch {}
    }
    memCache = payload;
    try { memCacheMtimeMs = fs.statSync(UPDATE_CACHE_FILE).mtimeMs; } catch { memCacheMtimeMs = Date.now(); }
  } catch {}
}

function buildStatusShape(raw, currentVersion) {
  const latestVersion = normalizeVersion(raw?.latestVersion || '');
  const hasUpdate = Boolean(latestVersion && compareVersions(latestVersion, currentVersion) > 0);
  return {
    ok: !raw?.error || Boolean(latestVersion),
    currentVersion,
    latestVersion: latestVersion || null,
    hasUpdate,
    source: raw?.source || null,
    repoUrl: GITHUB_REPO_URL,
    releaseUrl: raw?.releaseUrl || GITHUB_REPO_URL,
    releaseName: raw?.releaseName || (latestVersion ? `v${latestVersion}` : ''),
    publishedAt: raw?.publishedAt || '',
    notes: raw?.notes || '',
    checkedAtMs: Number(raw?.checkedAtMs || 0) || 0,
    lastAttemptAtMs: Number(raw?.lastAttemptAtMs || raw?.checkedAtMs || 0) || 0,
    error: raw?.error || null
  };
}

export function getCachedUpdateStatus() {
  const currentVersion = getLocalPluginVersion();
  const cached = readCacheDisk();
  return buildStatusShape(cached, currentVersion);
}

async function fetchJsonWithTimeout(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: ctrl.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? null : `HTTP ${res.status}`
    };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? '请求超时' : String(err?.message || err);
    return { ok: false, status: 0, data: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForPluginUpdate({ force = false } = {}) {
  const currentVersion = getLocalPluginVersion();
  const cached = readCacheDisk();
  const now = Date.now();

  if (
    !force &&
    cached &&
    !cached.error &&
    cached.latestVersion &&
    cached.checkedAtMs &&
    (now - cached.checkedAtMs) < CACHE_TTL_MS &&
    cached.currentVersion === currentVersion
  ) {
    return { ...buildStatusShape(cached, currentVersion), fromCache: true };
  }

  if (inFlightCheck) {
    return inFlightCheck;
  }

  inFlightCheck = (async () => {
    const ua = `agy-context/${currentVersion}`;
    let latestVersion = '';
    let releaseUrl = GITHUB_REPO_URL;
    let releaseName = '';
    let publishedAt = '';
    let notes = '';
    let source = '';
    let lastError = null;

    // 1. Prefer official GitHub Release
    const relRes = await fetchJsonWithTimeout(GITHUB_RELEASES_API, {
      Accept: 'application/vnd.github+json',
      'User-Agent': ua
    });

    if (relRes.ok && relRes.data && (relRes.data.tag_name || relRes.data.name)) {
      latestVersion = normalizeVersion(relRes.data.tag_name || relRes.data.name);
      releaseUrl = String(relRes.data.html_url || `${GITHUB_REPO_URL}/releases/latest`);
      releaseName = String(relRes.data.name || relRes.data.tag_name || `v${latestVersion}`);
      publishedAt = String(relRes.data.published_at || '');
      notes = String(relRes.data.body || '').trim().slice(0, 1200);
      source = 'github_release';
    } else {
      lastError = relRes.error || 'GitHub Release 不可用';
      // 2. Fallback to GitHub REST contents API for plugin.json (works even when raw.githubusercontent.com is reset)
      const contentsRes = await fetchJsonWithTimeout(GITHUB_CONTENTS_MANIFEST, {
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': ua
      });
      if (contentsRes.ok && contentsRes.data && contentsRes.data.version) {
        latestVersion = normalizeVersion(contentsRes.data.version);
        releaseUrl = GITHUB_REPO_URL;
        releaseName = `v${latestVersion}`;
        publishedAt = '';
        notes = '';
        source = 'github_main';
        lastError = null;
      } else {
        lastError = contentsRes.error || lastError;
        // 3. Final fallback to raw.githubusercontent.com (exempt from GitHub REST API rate limits)
        const rawRes = await fetchJsonWithTimeout(GITHUB_RAW_MANIFEST, {
          'User-Agent': ua,
          'Cache-Control': 'no-cache'
        });
        if (rawRes.ok && rawRes.data && rawRes.data.version) {
          latestVersion = normalizeVersion(rawRes.data.version);
          releaseUrl = GITHUB_REPO_URL;
          releaseName = `v${latestVersion}`;
          publishedAt = '';
          notes = '';
          source = 'github_main';
          lastError = null;
        } else {
          lastError = rawRes.error || lastError || '网络请求失败';
        }
      }
    }

    const finishedAt = Date.now();
    if (latestVersion) {
      const payload = {
        currentVersion,
        latestVersion,
        hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
        source,
        repoUrl: GITHUB_REPO_URL,
        releaseUrl,
        releaseName,
        publishedAt,
        notes,
        checkedAtMs: finishedAt,
        lastAttemptAtMs: finishedAt,
        error: null
      };
      writeCacheDisk(payload);
      return { ...buildStatusShape(payload, currentVersion), fromCache: false };
    }

    // Preserve previous known latestVersion on transient error so UI doesn't flicker
    const failurePayload = {
      ...(cached && typeof cached === 'object' ? cached : {}),
      currentVersion,
      lastAttemptAtMs: finishedAt,
      error: lastError || '检查更新失败'
    };
    writeCacheDisk(failurePayload);
    return { ...buildStatusShape(failurePayload, currentVersion), ok: false, fromCache: false };
  })();

  try {
    return await inFlightCheck;
  } finally {
    inFlightCheck = null;
  }
}

export function startUpdateCheckScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const initTimer = setTimeout(() => {
    checkForPluginUpdate({ force: false }).catch(() => {});
  }, STARTUP_DELAY_MS);
  initTimer.unref();

  const periodicTimer = setInterval(() => {
    checkForPluginUpdate({ force: false }).catch(() => {});
  }, CACHE_TTL_MS);
  periodicTimer.unref();
}
