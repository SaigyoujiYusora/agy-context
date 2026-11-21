/*
 * Attach the Model Inspector overlay to running Antigravity conversation pages.
 *
 * The injector talks to the renderer over the loopback Chrome DevTools
 * Protocol endpoint exposed by Antigravity. It does not patch the installed
 * application, load app.asar, or change any files outside this plugin folder.
 *
 * Usage (from the plugin directory):
 *   node --no-warnings ./scripts/runtime-injector.mjs
 *   node --no-warnings ./scripts/runtime-injector.mjs --once
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_FILE = path.resolve(__dirname, '..', 'sidecars', 'panel', 'runtime-overlay.js');
const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const DEVTOOLS_PORT_FILES = [
  process.env.AGY_CDP_PORT_FILE,
  path.join(USER_HOME, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
  path.join(USER_HOME, '.gemini', 'antigravity', 'DevToolsActivePort')
].filter(Boolean);
const POLL_MS = Math.max(500, Number(process.env.AGY_RUNTIME_POLL_MS || 1500));
const ONCE = process.argv.includes('--once');
const LOCK_PORT = Math.max(1024, Math.min(65535, Number(process.env.AGY_RUNTIME_LOCK_PORT || 18923)));
const API_BASE = String(process.env.AGY_INSPECTOR_API_BASE || 'http://127.0.0.1:18922').replace(/\/$/, '');
const TARGETS = new Map();
let lockServer = null;

function acquireInstanceLock() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    lockServer = server;
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        const duplicate = new Error(`runtime injector lock is already held on 127.0.0.1:${LOCK_PORT}`);
        duplicate.code = 'EALREADY';
        reject(duplicate);
      } else {
        reject(error);
      }
    });
    server.listen(LOCK_PORT, '127.0.0.1', () => resolve());
  });
}

function releaseInstanceLock() {
  try { lockServer?.close(); } catch {}
}

function readDevtoolsAddress() {
  const configured = String(process.env.AGY_CDP_URL || '').trim();
  if (configured) {
    const parsed = new URL(configured);
    if (!isLoopbackHost(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('AGY_CDP_URL must point to a local http(s) endpoint');
    }
    return configured.replace(/\/$/, '');
  }
  for (const portFile of DEVTOOLS_PORT_FILES) {
    try {
      const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
    } catch {}
  }
  return '';
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function validateApiBase() {
  const parsed = new URL(API_BASE);
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHost(parsed.hostname)) {
    throw new Error('AGY_INSPECTOR_API_BASE must point to a local http(s) endpoint');
  }
}

function isConversationTarget(target) {
  if (!target || target.type !== 'page') return false;
  try {
    const url = new URL(target.url || '');
    return url.protocol === 'https:' && isLoopbackHost(url.hostname) && /^\/c\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

const OVERLAY_VERSION = 'runtime-overlay-v37';
let cachedOverlay = { mtimeMs: -1, source: '' };

function getOverlayBundle() {
  const mtimeMs = fs.statSync(OVERLAY_FILE).mtimeMs;
  if (cachedOverlay.mtimeMs !== mtimeMs) {
    cachedOverlay = { mtimeMs, source: fs.readFileSync(OVERLAY_FILE, 'utf8') };
  }
  return cachedOverlay;
}

function cdpCall(webSocketUrl, method, params = {}, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    try {
      const endpoint = new URL(webSocketUrl);
      if (!['ws:', 'wss:'].includes(endpoint.protocol) || !isLoopbackHost(endpoint.hostname)) {
        reject(new Error('CDP target is not a loopback WebSocket'));
        return;
      }
    } catch (error) {
      reject(new Error(`Invalid CDP target: ${error.message}`));
      return;
    }
    const socket = new WebSocket(webSocketUrl);
    const id = Math.floor(Math.random() * 0x7fffffff);
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`CDP timeout: ${method}`)), timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
        if (message.id !== id) return;
        if (message.error) finish(new Error(`${method}: ${message.error.message || 'CDP error'}`));
        else finish(null, message.result || {});
      } catch (error) {
        finish(error);
      }
    });
    socket.addEventListener('error', () => finish(new Error(`CDP socket error: ${method}`)));
  });
}

async function listTargets(baseUrl) {
  const response = await fetch(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`CDP /json/list returned ${response.status}`);
  const result = await response.json();
  return Array.isArray(result) ? result : [];
}

async function injectTarget(target, overlaySource) {
  const expression = `${overlaySource}\n//# sourceURL=agy-model-inspector-runtime-overlay.js`;
  await cdpCall(target.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: expression });
  await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: false
  });
}

function targetConversationId(target) {
  try {
    const pathname = new URL(target.url || '').pathname;
    const match = pathname.match(/^\/c\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

async function readRuntimeState(target, sinceRevision = '') {
  const conversationId = targetConversationId(target);
  if (!conversationId) return null;
  const revQuery = sinceRevision ? `&sinceRevision=${encodeURIComponent(sinceRevision)}` : '';
  const endpoints = [
    `${API_BASE}/api/runtime-state?conversationId=${encodeURIComponent(conversationId)}${revQuery}`,
    `${API_BASE}/api/state?conversationId=${encodeURIComponent(conversationId)}`
  ];
  let lastStatus = 404;
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    lastStatus = response.status;
    if (response.ok) return response.json();
  }
  throw new Error(`runtime state endpoints returned ${lastStatus}`);
}

async function syncTargetOverlay(target, payload) {
  const versionLiteral = JSON.stringify(OVERLAY_VERSION);
  const body = payload?.unchanged
    ? `const tickRes=typeof overlay.tick==='function'?overlay.tick(${JSON.stringify(payload.revision || '')}):{needUpdate:true};return{needInject:false,needUpdate:Boolean(tickRes?.needUpdate),forkRequests:typeof overlay.drainForkRequests==='function'?overlay.drainForkRequests():[],quotaSamples:typeof overlay.drainQuotaSamples==='function'?overlay.drainQuotaSamples():[]};`
    : `overlay.update(${JSON.stringify(payload)});return{needInject:false,needUpdate:false,forkRequests:typeof overlay.drainForkRequests==='function'?overlay.drainForkRequests():[],quotaSamples:typeof overlay.drainQuotaSamples==='function'?overlay.drainQuotaSamples():[]};`;
  const expression = `(()=>{const overlay=globalThis.__AGY_MODEL_INSPECTOR_OVERLAY__;if(!overlay||overlay.version!==${versionLiteral})return{needInject:true,needUpdate:false,forkRequests:[],quotaSamples:[]};${body}})()`;
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  return result.result?.value || { needInject: true, needUpdate: false, forkRequests: [], quotaSamples: [] };
}

async function submitQuotaSamples(samples) {
  let storedAny = false;
  for (const sample of (samples || []).slice(0, 3)) {
    try {
      const response = await fetch(`${API_BASE}/api/quota-sample`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sample),
        signal: AbortSignal.timeout(4000)
      });
      const data = await response.json();
      if (response.ok && data?.stored) storedAny = true;
    } catch {}
  }
  return storedAny;
}

async function resolveForkRequests(target, forkRequests) {
  for (const request of (forkRequests || []).slice(0, 1)) {
    if (request.conversationId !== targetConversationId(target) || !Number.isInteger(request.turnNumber) || request.turnNumber < 1) continue;
    let result;
    try {
      const response = await fetch(`${API_BASE}/api/fork-turn`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({conversationId:request.conversationId,turnNumber:request.turnNumber}),
        signal:AbortSignal.timeout(45000)
      });
      result = await response.json();
      if (!response.ok) result = {error:result.error || '分支创建失败'};
    } catch (error) { result = {error:error.message}; }
    await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: `globalThis.__AGY_MODEL_INSPECTOR_OVERLAY__?.resolveFork?.(${JSON.stringify(request.id)},${JSON.stringify(result)})`, returnByValue:true
    });
  }
}

async function scanOnce() {
  const baseUrl = readDevtoolsAddress();
  if (!baseUrl) throw new Error(`DevToolsActivePort not found: ${DEVTOOLS_PORT_FILES.join(', ')}`);
  validateApiBase();
  const { mtimeMs: overlayRevision, source: overlaySource } = getOverlayBundle();
  const targets = (await listTargets(baseUrl)).filter(isConversationTarget);
  const liveIds = new Set(targets.map(target => target.id));
  for (const id of TARGETS.keys()) {
    if (!liveIds.has(id)) TARGETS.delete(id);
  }
  let attached = 0;
  for (const target of targets) {
    let known = TARGETS.get(target.id);
    try {
      if (!known || known.url !== target.url || known.overlayRevision !== overlayRevision) {
        await injectTarget(target, overlaySource);
        known = { url: target.url, overlayRevision, lastRevision: '', attachedAt: Date.now() };
        TARGETS.set(target.id, known);
        attached += 1;
        console.log(`[agy-model-inspector] overlay attached: ${target.id} ${target.url}`);
      }
      let payload = await readRuntimeState(target, known.lastRevision || '');
      let sync = payload ? await syncTargetOverlay(target, payload) : null;
      if (sync?.needInject) {
        await injectTarget(target, overlaySource);
        known.overlayRevision = overlayRevision;
        known.lastRevision = '';
        attached += 1;
        if (!payload || payload.unchanged) payload = await readRuntimeState(target, '');
        if (payload) sync = await syncTargetOverlay(target, payload);
      } else if (sync?.needUpdate) {
        payload = await readRuntimeState(target, '');
        if (payload) sync = await syncTargetOverlay(target, payload);
      }
      if (payload?.revision) {
        known.lastRevision = String(payload.revision);
      } else if (payload && !payload.unchanged) {
        known.lastRevision = '';
      }
      if (sync?.quotaSamples?.length) {
        const stored = await submitQuotaSamples(sync.quotaSamples);
        if (stored) {
          payload = await readRuntimeState(target, '');
          if (payload) {
            await syncTargetOverlay(target, payload);
            if (payload.revision) known.lastRevision = String(payload.revision);
          }
        }
      }
      if (sync?.forkRequests?.length) {
        await resolveForkRequests(target, sync.forkRequests);
      }
    } catch (error) {
      if (!known || known.url !== target.url) TARGETS.delete(target.id);
      console.warn(`[agy-model-inspector] runtime update failed: ${target.id}: ${error.message}`);
    }
  }
  return { targetCount: targets.length, attached };
}

async function main() {
  if (!fs.existsSync(OVERLAY_FILE)) throw new Error(`Overlay file not found: ${OVERLAY_FILE}`);
  await acquireInstanceLock();
  process.once('exit', releaseInstanceLock);
  process.once('SIGINT', () => { releaseInstanceLock(); process.exit(130); });
  process.once('SIGTERM', () => { releaseInstanceLock(); process.exit(143); });
  if (ONCE) {
    try {
      const result = await scanOnce();
      console.log(`[agy-model-inspector] scan complete: ${result.targetCount} conversation page(s), ${result.attached} attached`);
    } finally {
      releaseInstanceLock();
    }
    return;
  }
  console.log(`[agy-model-inspector] CDP runtime injector polling every ${POLL_MS}ms`);
  let firstError = true;
  while (true) {
    try {
      await scanOnce();
      firstError = true;
    } catch (error) {
      if (firstError) console.warn(`[agy-model-inspector] waiting for Antigravity CDP: ${error.message}`);
      firstError = false;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  releaseInstanceLock();
  console.error(`[agy-model-inspector] ${error.message}`);
  process.exitCode = 1;
});
