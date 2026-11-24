'use strict';

/*
 * AGY Context direct Electron main-process overlay loader.
 *
 * Loaded side-by-side from <Antigravity>/resources/app/index.cjs before
 * app.asar starts. Injects sidecars/panel/runtime-overlay.js directly into
 * Antigravity conversation WebContents without requiring Chrome DevTools
 * Protocol (--remote-debugging-port) and without modifying app.asar.
 */
(function initAgyContextElectronLoader() {
  if (
    !process.versions ||
    !process.versions.electron ||
    (process.env.ELECTRON_RUN_AS_NODE && process.env.ELECTRON_RUN_AS_NODE !== '0') ||
    (process.type && process.type !== 'browser') ||
    (Array.isArray(process.argv) && process.argv.some((a) => typeof a === 'string' && a.startsWith('--type=')))
  ) {
    return;
  }

  if (globalThis.__AGY_CONTEXT_ELECTRON_LOADER_INIT__) return;
  globalThis.__AGY_CONTEXT_ELECTRON_LOADER_INIT__ = true;

  // Immediately scrub this loader from NODE_OPTIONS so child processes
  // (language_server.exe, node.exe, MCP servers, hooks, shells) never inherit it.
  if (typeof process.env.NODE_OPTIONS === 'string' && process.env.NODE_OPTIONS) {
    const scrubRe =
      /(?:^|\s)(?:--require|-r)(?:\s+|=)(?:"[^"]*[/\\]?electron-overlay-loader\.cjs"|'[^']*[/\\]?electron-overlay-loader\.cjs'|[^\s]*[/\\]?electron-overlay-loader\.cjs)(?=\s|$)/gi;
    const cleaned = process.env.NODE_OPTIONS.replace(scrubRe, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned) {
      process.env.NODE_OPTIONS = cleaned;
    } else {
      delete process.env.NODE_OPTIONS;
    }
  }

  // Tell child sidecar (server.mjs) that direct Electron injection is active,
  // so it does not spawn the fallback CDP runtime-injector.mjs daemon.
  process.env.AGY_DISABLE_RUNTIME_INJECTOR = '1';

  const fs = require('fs');
  const http = require('http');
  const path = require('path');
  const Module = require('module');

  const OVERLAY_FILE = path.resolve(__dirname, '..', 'sidecars', 'panel', 'runtime-overlay.js');
  const API_PORT = Math.max(1024, Math.min(65535, Number(process.env.AGY_INSPECTOR_API_PORT || 18922)));
  const POLL_MS = Math.max(500, Number(process.env.AGY_RUNTIME_POLL_MS || 2500));
  const OVERLAY_STAT_TTL_MS = 10000;
  const STATUS_FILE = path.join(
    process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity'),
    'plugin_data',
    'agy-model-inspector',
    'direct_loader_status.json'
  );

  function writeStatus(extra = {}) {
    try {
      fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
      fs.writeFileSync(
        STATUS_FILE,
        JSON.stringify({ active: true, pid: process.pid, updatedAt: new Date().toISOString(), ...extra }, null, 2),
        'utf8'
      );
    } catch {}
  }
  writeStatus({ stage: 'loaded' });

  let cachedOverlay = { mtimeMs: -1, checkedAt: 0, source: '', version: 'runtime-overlay-v22' };

  function getOverlayBundle() {
    const now = Date.now();
    if (cachedOverlay.source && (now - cachedOverlay.checkedAt) < OVERLAY_STAT_TTL_MS) {
      return cachedOverlay;
    }
    const st = fs.statSync(OVERLAY_FILE);
    if (cachedOverlay.mtimeMs !== st.mtimeMs || !cachedOverlay.source) {
      const source = fs.readFileSync(OVERLAY_FILE, 'utf8');
      const m = source.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
      cachedOverlay = {
        mtimeMs: st.mtimeMs,
        checkedAt: now,
        source,
        version: m ? m[1] : 'runtime-overlay-v22'
      };
    } else {
      cachedOverlay.checkedAt = now;
    }
    return cachedOverlay;
  }

  function isLoopbackHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function extractConversationId(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      if (!isLoopbackHost(parsed.hostname)) return '';
      if (parsed.port === String(API_PORT)) return '';
      const match = parsed.pathname.match(/^\/c\/([^/]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch {
      return '';
    }
  }

  function localApiRequest(method, apiPath, bodyObj = undefined, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      const hasBody = method === 'POST' && bodyObj !== undefined;
      const bodyText = hasBody
        ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj))
        : '';
      const headers = {};
      if (hasBody) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(bodyText, 'utf8');
      }
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: API_PORT,
          path: apiPath,
          method,
          headers,
          timeout: timeoutMs
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode || 0, json, text });
          });
        }
      );
      req.on('timeout', () => {
        try { req.destroy(new Error('timeout')); } catch {}
      });
      req.on('error', reject);
      if (bodyText) req.write(bodyText);
      req.end();
    });
  }

  async function readRuntimeState(conversationId, sinceRevision = '') {
    const revQuery = sinceRevision ? `&sinceRevision=${encodeURIComponent(sinceRevision)}` : '';
    const endpoints = [
      `/api/runtime-state?conversationId=${encodeURIComponent(conversationId)}${revQuery}`,
      `/api/state?conversationId=${encodeURIComponent(conversationId)}`
    ];
    let lastStatus = 0;
    for (const ep of endpoints) {
      const res = await localApiRequest('GET', ep, undefined, 2500);
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300 && res.json) {
        return res.json;
      }
    }
    throw new Error(`runtime state endpoints returned ${lastStatus}`);
  }

  async function execInMainFrame(wc, code) {
    if (!wc || wc.isDestroyed?.()) return null;
    const frame = wc.mainFrame;
    if (frame && typeof frame.executeJavaScript === 'function') {
      return frame.executeJavaScript(code, true);
    }
    if (typeof wc.executeJavaScript === 'function') {
      return wc.executeJavaScript(code, true);
    }
    return null;
  }

  async function injectOverlay(wc, overlaySource) {
    const expression = `${overlaySource}\n//# sourceURL=agy-context-runtime-overlay.js`;
    await execInMainFrame(wc, expression);
  }

  async function syncOverlay(wc, payload, overlayVersion) {
    const versionLiteral = JSON.stringify(overlayVersion);
    const body = payload?.unchanged
      ? `const tickRes=typeof overlay.tick==='function'?overlay.tick(${JSON.stringify(payload.revision || '')}):{needUpdate:true};return{needInject:false,needUpdate:Boolean(tickRes?.needUpdate),forkRequests:typeof overlay.drainForkRequests==='function'?overlay.drainForkRequests():[],quotaSamples:typeof overlay.drainQuotaSamples==='function'?overlay.drainQuotaSamples():[]};`
      : `overlay.update(${JSON.stringify(payload)});return{needInject:false,needUpdate:false,forkRequests:typeof overlay.drainForkRequests==='function'?overlay.drainForkRequests():[],quotaSamples:typeof overlay.drainQuotaSamples==='function'?overlay.drainQuotaSamples():[]};`;
    const expression = `(()=>{const overlay=globalThis.__AGY_MODEL_INSPECTOR_OVERLAY__;if(!overlay||overlay.version!==${versionLiteral})return{needInject:true,needUpdate:false,forkRequests:[],quotaSamples:[]};${body}})()`;
    const value = await execInMainFrame(wc, expression);
    return value && typeof value === 'object' ? value : { needInject: true, needUpdate: false, forkRequests: [], quotaSamples: [] };
  }

  async function submitQuotaSamples(samples) {
    let storedAny = false;
    for (const sample of (samples || []).slice(0, 3)) {
      try {
        const res = await localApiRequest('POST', '/api/quota-sample', sample, 4000);
        if (res.status >= 200 && res.status < 300 && res.json?.stored) storedAny = true;
      } catch {}
    }
    return storedAny;
  }

  async function resolveForkRequests(wc, conversationId, forkRequests) {
    for (const request of (forkRequests || []).slice(0, 1)) {
      if (
        request.conversationId !== conversationId ||
        !Number.isInteger(request.turnNumber) ||
        request.turnNumber < 1
      ) {
        continue;
      }
      let result;
      try {
        const res = await localApiRequest(
          'POST',
          '/api/fork-turn',
          { conversationId: request.conversationId, turnNumber: request.turnNumber },
          45000
        );
        result = res.json || {};
        if (res.status < 200 || res.status >= 300) {
          result = { error: result.error || '分支创建失败' };
        }
      } catch (err) {
        result = { error: String(err?.message || err) };
      }
      await execInMainFrame(
        wc,
        `globalThis.__AGY_MODEL_INSPECTOR_OVERLAY__?.resolveFork?.(${JSON.stringify(request.id)},${JSON.stringify(result)})`
      );
    }
  }

  const hookedWebContents = new WeakSet();
  const hookedApps = new WeakSet();
  const windowWakeRegistry = new WeakMap();
  const windowWakeDispatchers = new WeakMap();
  let BrowserWindowApi = null;

  function registerWindowWake(win, fn) {
    if (!win || win.isDestroyed?.()) return;
    let callbacks = windowWakeRegistry.get(win);
    if (!callbacks) {
      callbacks = new Set();
      windowWakeRegistry.set(win, callbacks);
      const dispatch = () => {
        for (const cb of Array.from(callbacks)) {
          try {
            cb();
          } catch {}
        }
      };
      windowWakeDispatchers.set(win, dispatch);
      win.on?.('show', dispatch);
      win.on?.('restore', dispatch);
      win.on?.('focus', dispatch);
    }
    callbacks.add(fn);
  }

  function unregisterWindowWake(win, fn) {
    if (!win) return;
    const callbacks = windowWakeRegistry.get(win);
    if (!callbacks) return;
    callbacks.delete(fn);
    if (callbacks.size === 0) {
      windowWakeRegistry.delete(win);
      const dispatch = windowWakeDispatchers.get(win);
      windowWakeDispatchers.delete(win);
      if (dispatch && !win.isDestroyed?.()) {
        win.off?.('show', dispatch);
        win.off?.('restore', dispatch);
        win.off?.('focus', dispatch);
      }
    }
  }

  function resolveHostWindow(wc) {
    try {
      if (!wc || wc.isDestroyed?.()) return null;
      if (BrowserWindowApi && typeof BrowserWindowApi.fromWebContents === 'function') {
        const direct = BrowserWindowApi.fromWebContents(wc);
        if (direct && !direct.isDestroyed?.()) return direct;
      }
      if (BrowserWindowApi && typeof BrowserWindowApi.getAllWindows === 'function') {
        for (const win of BrowserWindowApi.getAllWindows()) {
          if (!win || win.isDestroyed?.()) continue;
          if (win.webContents === wc) return win;
          const children = win.contentView?.children;
          if (Array.isArray(children) && children.some((v) => v && v.webContents === wc)) {
            return win;
          }
        }
      }
    } catch {}
    return null;
  }

  function isWebContentsVisible(wc) {
    try {
      if (!wc || wc.isDestroyed?.()) return false;
      const win = resolveHostWindow(wc);
      if (!win) return true;
      if (typeof win.isVisible === 'function' && !win.isVisible()) return false;
      if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
      return true;
    } catch {
      return true;
    }
  }

  function hookWebContents(wc) {
    if (!wc || typeof wc !== 'object' || hookedWebContents.has(wc)) return;
    if (wc.isDestroyed?.()) return;
    if (wc.getType?.() === 'webview') return;
    hookedWebContents.add(wc);

    const state = {
      lastUrl: '',
      overlayRevision: -1,
      lastRevision: '',
      busy: false,
      timer: null,
      boundWin: null
    };

    async function syncOnce() {
      if (state.busy || wc.isDestroyed?.()) return;
      const url = wc.getURL?.() || '';
      const cid = extractConversationId(url);
      if (!cid) {
        state.lastUrl = url;
        state.lastRevision = '';
        return;
      }
      state.busy = true;
      try {
        const bundle = getOverlayBundle();
        if (state.lastUrl !== url || state.overlayRevision !== bundle.mtimeMs) {
          await injectOverlay(wc, bundle.source);
          state.lastUrl = url;
          state.overlayRevision = bundle.mtimeMs;
          state.lastRevision = '';
          writeStatus({ stage: 'attached', url, conversationId: cid });
        }
        let payload = await readRuntimeState(cid, state.lastRevision || '');
        let sync = payload ? await syncOverlay(wc, payload, bundle.version) : null;
        if (sync?.needInject) {
          await injectOverlay(wc, bundle.source);
          state.overlayRevision = bundle.mtimeMs;
          state.lastRevision = '';
          if (!payload || payload.unchanged) payload = await readRuntimeState(cid, '');
          if (payload) sync = await syncOverlay(wc, payload, bundle.version);
        } else if (sync?.needUpdate) {
          payload = await readRuntimeState(cid, '');
          if (payload) sync = await syncOverlay(wc, payload, bundle.version);
        }
        if (payload?.revision) {
          state.lastRevision = String(payload.revision);
        } else if (payload && !payload.unchanged) {
          state.lastRevision = '';
        }
        if (sync?.quotaSamples?.length) {
          const stored = await submitQuotaSamples(sync.quotaSamples);
          if (stored) {
            payload = await readRuntimeState(cid, '');
            if (payload) {
              await syncOverlay(wc, payload, bundle.version);
              if (payload.revision) state.lastRevision = String(payload.revision);
            }
          }
        }
        if (sync?.forkRequests?.length) {
          await resolveForkRequests(wc, cid, sync.forkRequests);
        }
      } catch {
        // Sidecar backend may still be starting; retry on next poll tick.
      } finally {
        state.busy = false;
      }
    }

    const onWindowWake = () => {
      if (wc.isDestroyed?.()) {
        unbindHostWindowWake();
        return;
      }
      if (extractConversationId(wc.getURL?.() || '') && isWebContentsVisible(wc)) {
        void syncOnce();
      }
    };

    function unbindHostWindowWake() {
      if (state.boundWin) {
        unregisterWindowWake(state.boundWin, onWindowWake);
        state.boundWin = null;
      }
    }

    function bindHostWindowWake() {
      const win = resolveHostWindow(wc);
      if (state.boundWin === win) return;
      unbindHostWindowWake();
      if (!win) return;
      state.boundWin = win;
      registerWindowWake(win, onWindowWake);
    }

    function ensureTimer() {
      bindHostWindowWake();
      if (state.timer || wc.isDestroyed?.()) return;
      state.timer = setInterval(() => {
        if (wc.isDestroyed?.()) {
          clearInterval(state.timer);
          state.timer = null;
          unbindHostWindowWake();
          return;
        }
        bindHostWindowWake();
        if (!isWebContentsVisible(wc)) return;
        if (extractConversationId(wc.getURL?.() || '')) {
          void syncOnce();
        }
      }, POLL_MS);
      if (typeof state.timer.unref === 'function') state.timer.unref();
    }

    function onNav() {
      if (wc.isDestroyed?.()) return;
      const url = wc.getURL?.() || '';
      if (url !== state.lastUrl) {
        state.lastRevision = '';
      }
      if (extractConversationId(url)) {
        ensureTimer();
        if (isWebContentsVisible(wc)) {
          void syncOnce();
        }
      }
    }

    wc.on?.('dom-ready', onNav);
    wc.on?.('did-finish-load', onNav);
    wc.on?.('did-navigate', onNav);
    wc.on?.('did-navigate-in-page', onNav);
    wc.once?.('destroyed', () => {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      unbindHostWindowWake();
    });

    if (extractConversationId(wc.getURL?.() || '') && !wc.isLoadingMainFrame?.()) {
      ensureTimer();
      if (isWebContentsVisible(wc)) {
        void syncOnce();
      }
    }
  }

  function attachAll(app, webContentsApi, browserWindowApi) {
    if (browserWindowApi) BrowserWindowApi = browserWindowApi;
    if (app && !hookedApps.has(app)) {
      hookedApps.add(app);
      app.on?.('web-contents-created', (_ev, wc) => {
        hookWebContents(wc);
      });
    }
    try {
      const existing = webContentsApi?.getAllWebContents?.() || [];
      for (const wc of existing) {
        hookWebContents(wc);
      }
    } catch {}
  }

  function tryAttachElectron(electronMod) {
    if (globalThis.__AGY_CONTEXT_ELECTRON_ATTACHED__) return true;
    if (!electronMod || typeof electronMod !== 'object' || !electronMod.app) return false;
    globalThis.__AGY_CONTEXT_ELECTRON_ATTACHED__ = true;

    attachAll(electronMod.app, electronMod.webContents, electronMod.BrowserWindow);
    void electronMod.app.whenReady().then(() => {
      attachAll(electronMod.app, electronMod.webContents, electronMod.BrowserWindow);
    });
    return true;
  }

  let initialElectron = null;
  try {
    initialElectron = require('electron');
  } catch {}

  if (!tryAttachElectron(initialElectron)) {
    const origLoad = Module._load;
    let restored = false;
    function restoreLoad() {
      if (!restored && Module._load === wrappedLoad) {
        Module._load = origLoad;
        restored = true;
      }
    }
    function wrappedLoad(request, parent, isMain) {
      const exported = origLoad.apply(this, arguments);
      if (request === 'electron' && tryAttachElectron(exported)) {
        restoreLoad();
      }
      return exported;
    }
    Module._load = wrappedLoad;

    setImmediate(() => {
      if (globalThis.__AGY_CONTEXT_ELECTRON_ATTACHED__) {
        restoreLoad();
        return;
      }
      try {
        if (tryAttachElectron(require('electron'))) {
          restoreLoad();
        }
      } catch {}
    });
  }
})();
