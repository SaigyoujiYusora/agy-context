import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getPromptProfiles, savePromptProfiles, getPromptSources, getNativePromptState, readNativePromptCapture } from '../../scripts/prompt_profiles.mjs';
import {
  PLUGIN_DATA_DIR,
  BADGE_PORT,
  BADGE_BINDINGS_FILE,
  ensurePluginDataDir,
  getConversationModelsFromDb,
  listRecentConversations,
  getPluginConfig,
  savePluginConfig,
  saveLsEndpoint,
  loadLsEndpoint,
  readInflightState,
  resolveModelByEnum,
  renderInlineBadgeSvg,
  renderUsageBadgeSvg,
  renderForkBadgeSvg,
  syncConversationRulesSnapshot,
  getSessionTranscriptAnalytics,
  getFleetHierarchy,
  getFleetUsageRollup,
  getGlobalInsights,
  queryConversationInvocations
} from '../../scripts/model_core.mjs';
import {
  buildDshBootstrap,
  handleDshDetail,
  handleDshHeads,
  handleDshCommands,
  handleDshFleet,
  handleDshOverview,
  handleDshSkills,
  handleDshPage
} from '../../scripts/dsh_bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.resolve(__dirname, '..', '..', 'rules', 'AGENTS.md');
const UI_HTML_FILE = path.join(__dirname, 'ui.html');
const DSH_HOST_FILE = path.join(__dirname, 'dsh_host.js');
const VENDOR_DIR = path.join(__dirname, 'vendor');
const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'assets');

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 2 * 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function readUiHtml() {
  try {
    return fs.readFileSync(UI_HTML_FILE, 'utf8');
  } catch (err) {
    return `<!doctype html><html><body style="background:#151517;color:#f4f4f6;font-family:sans-serif;padding:24px;">Failed to load ui.html: ${String(err?.message || err)}</body></html>`;
  }
}

const port = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '18922', 10);
const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';

if (lsAddr && csrf && port !== BADGE_PORT) {
  saveLsEndpoint(lsAddr, csrf, port);
}

function getActiveConversationId() {
  try {
    const activeFile = path.join(PLUGIN_DATA_DIR, 'active_conversation.json');
    if (fs.existsSync(activeFile)) {
      const parsed = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      if (parsed?.conversationId) return String(parsed.conversationId);
    }
  } catch {}
  return '';
}

function loadBadgeBindings() {
  try {
    if (fs.existsSync(BADGE_BINDINGS_FILE)) {
      return JSON.parse(fs.readFileSync(BADGE_BINDINGS_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

let badgeBindings = loadBadgeBindings();
const pendingBadgePromises = new Map();

function persistBadgeBinding(bindKey, entry) {
  if (!bindKey || !entry) return;
  badgeBindings[bindKey] = entry;
  try {
    ensurePluginDataDir();
    const keys = Object.keys(badgeBindings);
    if (keys.length > 2000) {
      for (const oldKey of keys.slice(0, keys.length - 2000)) {
        delete badgeBindings[oldKey];
      }
    }
    fs.writeFileSync(BADGE_BINDINGS_FILE, JSON.stringify(badgeBindings), 'utf8');
  } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function resolveBadgeInvocation(cid, k, explicitIdx) {
  if (!cid) return null;

  const bindKey = k ? `${cid}:${k}` : (explicitIdx !== null && explicitIdx !== undefined && explicitIdx !== '' ? `${cid}:idx_${explicitIdx}` : '');
  if (bindKey && badgeBindings[bindKey]?.snapshot) {
    const cachedEntry = badgeBindings[bindKey];
    // Auto-upgrade legacy cached snapshots created before `tpsApprox` / `bodyOutputTokens` existed
    if ((cachedEntry.snapshot.tpsApprox === undefined || cachedEntry.snapshot.bodyOutputTokens === undefined) && Number.isFinite(Number(cachedEntry.idx))) {
      const refreshedSummary = getConversationModelsFromDb(cid);
      const freshSnap = refreshedSummary?.invocations?.[Number(cachedEntry.idx)];
      if (freshSnap) {
        persistBadgeBinding(bindKey, { idx: Number(cachedEntry.idx), boundAt: cachedEntry.boundAt || Date.now(), snapshot: freshSnap });
        return freshSnap;
      }
    }
    return cachedEntry.snapshot;
  }

  if (bindKey && pendingBadgePromises.has(bindKey)) {
    return pendingBadgePromises.get(bindKey);
  }

  // Deterministic `idx` binding: wait up to 5.5s for exact row `idxNum` to commit to SQLite WAL
  if (explicitIdx !== null && explicitIdx !== undefined && explicitIdx !== '' && Number.isFinite(Number(explicitIdx))) {
    const idxNum = Number(explicitIdx);
    const idxWork = (async () => {
      const deadline = Date.now() + 5500;
      while (Date.now() < deadline) {
        const summary = getConversationModelsFromDb(cid);
        if (summary?.invocations?.[idxNum]) {
          const snap = summary.invocations[idxNum];
          if (bindKey) {
            persistBadgeBinding(bindKey, { idx: idxNum, boundAt: Date.now(), snapshot: snap });
          }
          return snap;
        }
        await sleep(65);
      }
      const fallbackSummary = getConversationModelsFromDb(cid);
      if (fallbackSummary?.invocations?.[idxNum]) {
        const snap = fallbackSummary.invocations[idxNum];
        if (bindKey) {
          persistBadgeBinding(bindKey, { idx: idxNum, boundAt: Date.now(), snapshot: snap });
        }
        return snap;
      }
      const finalInflight = readInflightState(cid);
      if (finalInflight?.configuredModelEnum) {
        return resolveModelByEnum(finalInflight.configuredModelEnum);
      }
      return fallbackSummary?.latestModel || null;
    })();
    if (bindKey) {
      pendingBadgePromises.set(bindKey, idxWork);
      idxWork.finally(() => pendingBadgePromises.delete(bindKey));
    }
    return idxWork;
  }

  const work = (async () => {
    const deadline = Date.now() + 5500;
    let checkedColdOnce = false;

    while (Date.now() < deadline) {
      const inflight = readInflightState(cid);
      const summary = getConversationModelsFromDb(cid);
      const invCount = summary?.invocationCount || 0;
      const hasRecentInflight = Boolean(inflight && (Date.now() - (inflight.updatedAtMs || 0) < 180000));

      if (hasRecentInflight) {
        const expectedMinCount = (inflight.preDbCount ?? 0) + 1;
        if (invCount >= expectedMinCount || (inflight.inFlight === false && invCount > 0)) {
          const snap = summary.latestModel;
          if (bindKey && snap) {
            persistBadgeBinding(bindKey, { idx: invCount - 1, boundAt: Date.now(), snapshot: snap });
          }
          return snap;
        }
      } else {
        if (!checkedColdOnce) {
          checkedColdOnce = true;
          await sleep(160);
          continue;
        }
        if (summary?.latestModel) {
          const snap = summary.latestModel;
          if (bindKey) {
            persistBadgeBinding(bindKey, { idx: invCount - 1, boundAt: Date.now(), snapshot: snap });
          }
          return snap;
        }
        break;
      }

      await sleep(65);
    }

    // Timeout fallback (do not persist to badgeBindings so next load binds the real gen_metadata row)
    const finalSummary = getConversationModelsFromDb(cid);
    const finalInflight = readInflightState(cid);
    if (finalSummary?.latestModel && (!finalInflight || finalSummary.invocationCount > (finalInflight.preDbCount ?? 0))) {
      const snap = finalSummary.latestModel;
      if (bindKey) {
        persistBadgeBinding(bindKey, { idx: finalSummary.invocationCount - 1, boundAt: Date.now(), snapshot: snap });
      }
      return snap;
    }

    if (finalInflight?.configuredModelEnum) {
      return resolveModelByEnum(finalInflight.configuredModelEnum);
    }
    return finalSummary?.latestModel || null;
  })();

  if (bindKey) {
    pendingBadgePromises.set(bindKey, work);
    work.finally(() => pendingBadgePromises.delete(bindKey));
  }
  return work;
}

function sendSvg(req, res, svg) {
  const svgBuf = Buffer.from(svg, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': String(svgBuf.length),
    'Cache-Control': 'no-cache, max-age=0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length'
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(svgBuf);
  }
}

function resolveTargetConversation(url, recent = null) {
  const requestedId = url.searchParams.get('conversationId') || '';
  const activeId = getActiveConversationId();
  const list = recent || listRecentConversations(1);
  return requestedId || activeId || list[0]?.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

  if (['/api/prompt-profiles', '/api/prompt-sources', '/api/runtime-state', '/api/native-prompts', '/api/fork-turn'].includes(url.pathname)) {
    const origin = req.headers.origin;
    const host = req.headers.host || '';
    const pluginOrigin = /^plugin:\/\/agy-model-inspector--panel-(\d+)$/.exec(origin || '');
    const samePlugin = Boolean(pluginOrigin && Number(pluginOrigin[1]) === Number(host.split(':').at(-1)));
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (!samePlugin && (req.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && origin !== `http://${host}`)))) {
      res.writeHead(403); res.end('Forbidden origin'); return;
    }
    if (url.pathname === '/api/fork-turn') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) {
        res.writeHead(405); res.end(JSON.stringify({error:'POST JSON required'})); return;
      }
      const body = await readJsonBody(req);
      if (!/^[0-9a-f-]{36}$/i.test(body.conversationId || '') || !Number.isInteger(body.turnNumber) || body.turnNumber < 1) {
        res.writeHead(400); res.end(JSON.stringify({error:'Invalid conversation or turn'})); return;
      }
      try {
        const core = path.join(os.homedir(), '.gemini/config/plugins/agy-conversation-fork/scripts/fork_core.mjs');
        const { forkConversation } = await import(pathToFileURL(core).href);
        const endpoint = loadLsEndpoint();
        if (!endpoint) throw new Error('请等待 AGY 服务连接后重试');
        const result = await forkConversation({sourceCascadeId:body.conversationId, turnNumber:body.turnNumber, targetMode:'current', followUpPrompt:'', endpoint});
        res.end(JSON.stringify({ok:true,result}));
      } catch (err) { res.writeHead(400); res.end(JSON.stringify({error:err.message})); }
      return;
    }
    if (url.pathname === '/api/native-prompts') {
      try {
        const name = url.searchParams.get('capture');
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(name ? readNativePromptCapture(name) : getNativePromptState()));
      } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
      return;
    }
    if (url.pathname === '/api/prompt-profiles') {
      try {
        if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(getPromptProfiles())); return; }
        if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) {
          res.writeHead(405); res.end(); return;
        }
        const state = savePromptProfiles(await readJsonBody(req));
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state));
      } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
      return;
    }
    const cid = resolveTargetConversation(url);
    if (cid && !/^[a-zA-Z0-9_-]{1,100}$/.test(cid)) { res.writeHead(400); res.end('Invalid conversation ID'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/prompt-sources') { res.end(JSON.stringify(getPromptSources(cid))); return; }
    const summary = cid ? getConversationModelsFromDb(cid) : null;
    const analytics = cid ? getSessionTranscriptAnalytics(cid, summary, { includeBrowser: false }) : null;
    const revision = [
      cid,
      summary?.invocationCount || 0,
      summary?.updatedAtMs || 0,
      summary?.totals?.totalSessionTokens || 0,
      analytics?.sessionStats?.steps || 0,
      analytics?.sessionStats?.turns || 0,
      analytics?.sessionStats?.subagentCount || 0,
      analytics?.sessionStats?.teamTotalTokens || 0,
      analytics?.composition?.totalTokens || 0,
      Math.round(((analytics?.sessionStats?.teamEstimatedCostUsd ?? analytics?.sessionStats?.estimatedCostUsd) || 0) * 10000)
    ].join(':');
    const sinceRevision = (url.searchParams.get('sinceRevision') || '').trim();
    if (sinceRevision && sinceRevision === revision) {
      res.end(JSON.stringify({ ok: true, unchanged: true, conversationId: cid, revision }));
      return;
    }
    const lightSummary = summary ? { ...summary, invocations: undefined } : null;
    res.end(JSON.stringify({ ok: true, conversationId: cid, revision, summary: lightSummary, analytics, invocations: summary?.invocations || [] }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/prompts') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'prompts.html'), 'utf8')); return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/badge.svg') {
    const cid = (url.searchParams.get('cid') || url.searchParams.get('conversationId') || getActiveConversationId() || '').trim();
    const k = (url.searchParams.get('k') || '').trim();
    const explicitIdx = url.searchParams.get('idx');
    const cfg = getPluginConfig();
    const inv = await resolveBadgeInvocation(cid, k, explicitIdx);
    const sessionSummary = cid ? getConversationModelsFromDb(cid) : null;
    const svg = renderInlineBadgeSvg(inv, cfg, sessionSummary?.totals || null);
    sendSvg(req, res, svg);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/usage-badge.svg') {
    const cid = (url.searchParams.get('cid') || url.searchParams.get('conversationId') || getActiveConversationId() || '').trim();
    const sessionSummary = cid ? getConversationModelsFromDb(cid) : null;
    const svg = renderUsageBadgeSvg(sessionSummary?.totals || null);
    sendSvg(req, res, svg);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/fork-badge.svg') {
    sendSvg(req, res, renderForkBadgeSvg());
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sidebar')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, max-age=0'
    });
    res.end(readUiHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/dsh_host.js') {
    if (!fs.existsSync(DSH_HOST_FILE)) {
      res.writeHead(404);
      res.end('dsh_host.js missing');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, max-age=0'
    });
    res.end(fs.readFileSync(DSH_HOST_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
    const fileName = path.basename(url.pathname.slice('/vendor/'.length));
    const allowed = new Set(['react.production.min.js', 'react-dom.production.min.js', 'dsh-context-client.js', 'LICENSE.dsh-context']);
    const fullPath = path.join(VENDOR_DIR, fileName);
    if (!allowed.has(fileName) || !fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end('vendor asset missing');
      return;
    }
    res.writeHead(200, {
      'Content-Type': fileName.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(fs.readFileSync(fullPath));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const fileName = path.basename(url.pathname.slice('/assets/'.length));
    const allowed = new Set(['antigravity.png', 'logo.svg']);
    const fullPath = path.join(ASSETS_DIR, fileName);
    if (!allowed.has(fileName) || !fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end('asset missing');
      return;
    }
    res.writeHead(200, {
      'Content-Type': fileName.endsWith('.png') ? 'image/png' : 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(fs.readFileSync(fullPath));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const recent = listRecentConversations(60);
    const activeId = getActiveConversationId();
    const targetId = resolveTargetConversation(url, recent);
    const selected = targetId ? getConversationModelsFromDb(targetId) : null;
    const analytics = targetId ? getSessionTranscriptAnalytics(targetId, selected, { includeBrowser: false }) : null;
    const fleet = targetId ? getFleetHierarchy(targetId) : null;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      config: getPluginConfig(),
      activeConversationId: activeId,
      selectedConversation: selected,
      analytics,
      fleet,
      recentConversations: recent.map(r => ({
        conversationId: r.conversationId,
        title: r.title,
        updatedAt: r.updatedAt,
        invocationCount: r.invocationCount,
        latestModel: r.latestModel,
        totals: r.totals
      }))
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/browser') {
    const targetId = resolveTargetConversation(url);
    const selected = targetId ? getConversationModelsFromDb(targetId) : null;
    const analytics = targetId ? getSessionTranscriptAnalytics(targetId, selected, { includeBrowser: true }) : null;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      conversationId: targetId,
      analytics
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/insights') {
    const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit') || 60) || 60));
    const insights = getGlobalInsights(limit);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(insights));
    return;
  }

  if (url.pathname === '/api/set-config') {
    const badgeMode = url.searchParams.get('badgeMode');
    const tpsMode = url.searchParams.get('tpsMode');
    const patch = {};
    if (badgeMode && ['on_reply', 'every_step', 'off'].includes(badgeMode)) {
      patch.badgeMode = badgeMode;
    }
    if (tpsMode && ['decode', 'e2e'].includes(tpsMode)) {
      patch.tpsMode = tpsMode;
    }
    if (Object.keys(patch).length > 0) {
      const updated = savePluginConfig(patch);
      const activeId = getActiveConversationId();
      const cur = activeId ? getConversationModelsFromDb(activeId) : null;
      syncConversationRulesSnapshot(RULES_FILE, activeId, cur?.latestModel || null, updated);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, config: updated }));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid config parameters' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/composer-stats') {
    const requestedCid = (url.searchParams.get('conversationId') || '').trim();
    const targetId = requestedCid || getActiveConversationId() || listRecentConversations(1)[0]?.conversationId || '';
    const cfg = getPluginConfig();
    const inflight = targetId ? readInflightState(targetId) : null;
    const selected = targetId ? getConversationModelsFromDb(targetId) : null;
    const fleetUsage = targetId ? getFleetUsageRollup(targetId, selected) : null;
    const headsMap = targetId ? handleDshHeads({ ids: [targetId] }, cfg) : null;
    const rawHead = (targetId && headsMap?.[targetId]?.head) || null;
    const head = rawHead
      ? {
          counts: rawHead.counts || null,
          timing: rawHead.timing || null,
          current: rawHead.current ? { total: rawHead.current.total } : null,
          contextWindow: rawHead.contextWindow || null
        }
      : null;
    const revision = [
      targetId,
      selected?.invocationCount || 0,
      selected?.totals?.totalSessionTokens || 0,
      fleetUsage?.subagentCount || 0,
      fleetUsage?.team?.totalTokens || 0,
      cfg?.tpsMode || 'decode',
      cfg?.badgeMode || 'on_reply',
      inflight?.inFlight ? 1 : 0
    ].join(':');
    sendJson(res, 200, {
      ok: true,
      targetId,
      revision,
      config: cfg,
      inflight,
      head,
      fleetUsage,
      summary: selected
        ? {
            conversationId: selected.conversationId,
            title: selected.title,
            invocationCount: selected.invocationCount,
            latestModel: selected.latestModel,
            totals: selected.totals
          }
        : null
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/invocations') {
    const targetId = resolveTargetConversation(url);
    const scope = (url.searchParams.get('scope') || 'fleet').trim();
    const search = url.searchParams.get('search') || '';
    const onlyMismatch = url.searchParams.get('onlyMismatch') === '1' || url.searchParams.get('onlyMismatch') === 'true';
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 50);
    const result = targetId
      ? queryConversationInvocations(targetId, { scope, search, onlyMismatch, offset, limit })
      : { ok: true, conversationId: '', scope, offset: 0, limit, total: 0, totalUnfiltered: 0, selfCount: 0, fleetCount: 0, hasSubagents: false, agents: [], items: [], fetchedAtMs: Date.now() };
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/dsh-bootstrap') {
    const recent = listRecentConversations(100);
    const targetId = resolveTargetConversation(url, recent);
    const cfg = getPluginConfig();
    const sinceRevision = String(url.searchParams.get('sinceRevision') || '');
    const bs = buildDshBootstrap(targetId, cfg, recent);
    if (sinceRevision && bs?.revision && sinceRevision === bs.revision) {
      sendJson(res, 200, { ok: true, unchanged: true, targetId: bs.targetId || targetId, revision: bs.revision });
      return;
    }
    sendJson(res, 200, bs);
    return;
  }

  if (url.pathname.startsWith('/api/dsh-context/')) {
    const endpoint = url.pathname.slice('/api/dsh-context/'.length);
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const cfg = getPluginConfig();
    if (endpoint === 'detail' || endpoint === 'facts') {
      sendJson(res, 200, { ok: true, value: handleDshDetail(body, cfg) });
      return;
    }
    if (endpoint === 'heads') {
      sendJson(res, 200, { ok: true, value: handleDshHeads(body, cfg) });
      return;
    }
    if (endpoint === 'commands') {
      sendJson(res, 200, { ok: true, value: handleDshCommands(body, cfg) });
      return;
    }
    if (endpoint === 'fleet') {
      sendJson(res, 200, { ok: true, value: handleDshFleet(body, cfg) });
      return;
    }
    if (endpoint === 'overview') {
      const targetId = resolveTargetConversation(url);
      sendJson(res, 200, { ok: true, value: handleDshOverview(body, targetId) });
      return;
    }
    if (endpoint === 'skills') {
      sendJson(res, 200, { ok: true, value: handleDshSkills(body) });
      return;
    }
    if (endpoint === 'page') {
      sendJson(res, 200, { ok: true, value: handleDshPage(body, cfg) });
      return;
    }
    if (['recom', 'version', 'balance', 'backfill', 'attachment', 'delta', 'snapshot', 'pricing-refresh', 'update-check'].includes(endpoint)) {
      sendJson(res, 200, { ok: true, value: null });
      return;
    }
  }

  if (url.pathname === '/api/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
    setTimeout(() => process.exit(0), 40);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    } catch {}
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port === BADGE_PORT) {
    process.exit(0);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[agy-model-inspector] Sidecar UI listening on http://127.0.0.1:${port}`);
  if (process.env.AGY_DISABLE_RUNTIME_INJECTOR !== '1') {
    const child = spawn(process.execPath, ['--no-warnings', path.resolve(__dirname, '../../scripts/runtime-injector.mjs')], {
      detached: true, windowsHide: true, stdio: 'ignore', env: process.env
    });
    child.on('error', err => console.warn(`[agy-model-inspector] runtime injector: ${err.message}`));
    child.unref();
  }
  // Full prompts come from AGY's stored request metadata; no native bridge.
});

if (port !== BADGE_PORT) {
  const tryBindBadgePort = () => {
    const badgeServer = http.createServer((req, res) => {
      handleRequest(req, res).catch(() => {
        try { res.writeHead(500); res.end(); } catch {}
      });
    });
    badgeServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const retryTimer = setTimeout(tryBindBadgePort, 10000);
        retryTimer.unref();
      }
    });
    badgeServer.listen(BADGE_PORT, '127.0.0.1', () => {
      console.log(`[agy-model-inspector] Live SVG Badge endpoint listening on http://127.0.0.1:${BADGE_PORT}`);
    });
  };
  tryBindBadgePort();
}
