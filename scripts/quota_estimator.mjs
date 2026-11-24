import fs from 'node:fs';
import path from 'node:path';
import {
  CONVERSATIONS_DIR,
  PLUGIN_DATA_DIR,
  ensurePluginDataDir,
  getConversationModelsFromDb,
  estimateInvocationCost,
  loadLsEndpoint
} from './model_core.mjs';

export const QUOTA_SAMPLES_FILE = path.join(PLUGIN_DATA_DIR, 'quota_samples.jsonl');
export const QUOTA_DB_CACHE_FILE = path.join(PLUGIN_DATA_DIR, 'quota_db_cache.json');

const FIVE_HOUR_MS = 5 * 3600 * 1000;
const WEEKLY_MS = 7 * 24 * 3600 * 1000;
const MAX_SAMPLES = 1000;
const MAX_DB_CACHE_ENTRIES = 1000;
const QUOTA_DB_CACHE_VERSION = 1;
const SUMMARY_CACHE_TTL_MS = 10_000;
const ACTIVE_REFRESH_MS = 5 * 60 * 1000;
const IDLE_REFRESH_MIN_MS = 30 * 60 * 1000;
const IDLE_REFRESH_MAX_MS = 60 * 60 * 1000;

let cachedSamples = { stamp: '', rows: [] };
let cachedSummary = { stamp: '', computedAtMs: 0, value: null };
const dbInvocationsCache = new Map(); // conversationId -> { stamp, items }
let diskCacheLoaded = false;
let diskCacheDirty = false;
let diskCacheNeedsImmediateFlush = false;
let diskCacheSaveTimer = null;
let rpcFetchInFlight = null;
let schedulerState = {
  started: false,
  timer: null,
  lastFetchAtMs: 0,
  lastAttemptAtMs: 0,
  nextIdleDelayMs: 0,
  lastError: ''
};

function getFileStamp(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

export function classifyQuotaPool(inv) {
  const probe = [
    inv?.sentModel,
    inv?.responseModelFull,
    inv?.responseModel,
    inv?.modelDisplayName,
    inv?.apiProvider
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/claude|anthropic|gpt|openai/.test(probe)) return 'claude_gpt';
  return 'gemini';
}

function sanitizeWindowEntry(entry, capturedAtMs) {
  if (!entry || typeof entry !== 'object') return null;
  const fracRaw = entry.remainingFraction !== undefined ? Number(entry.remainingFraction) : NaN;
  const exactFraction = Boolean(entry.exactFraction) || Number.isFinite(fracRaw);
  const leftPct = Number.isFinite(fracRaw)
    ? Math.max(0, Math.min(100, fracRaw * 100))
    : Number(entry.leftPct);
  if (!Number.isFinite(leftPct) || leftPct < 0 || leftPct > 100) return null;
  let resetAtMs = Number(entry.resetAtMs);
  const resetInMs = Number(entry.resetInMs);
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) {
    resetAtMs = Number.isFinite(resetInMs) && resetInMs > 0 ? capturedAtMs + resetInMs : null;
  }
  return {
    leftPct: exactFraction ? Math.round(leftPct * 10000) / 10000 : Math.round(leftPct * 10) / 10,
    ...(Number.isFinite(fracRaw) ? { remainingFraction: Math.max(0, Math.min(1, fracRaw)) } : {}),
    ...(exactFraction ? { exactFraction: true } : {}),
    resetInMs: Number.isFinite(resetInMs) && resetInMs > 0 ? Math.round(resetInMs) : null,
    resetAtMs: resetAtMs ? Math.round(resetAtMs) : null,
    resetLabel: typeof entry.resetLabel === 'string' ? entry.resetLabel.slice(0, 40) : ''
  };
}

export function loadQuotaSamples() {
  const stamp = getFileStamp(QUOTA_SAMPLES_FILE);
  if (cachedSamples.stamp === stamp) return cachedSamples.rows;
  const rows = [];
  try {
    if (fs.existsSync(QUOTA_SAMPLES_FILE)) {
      const raw = fs.readFileSync(QUOTA_SAMPLES_FILE, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && Number.isFinite(Number(parsed.capturedAtMs)) && parsed.pools) {
            rows.push(parsed);
          }
        } catch {}
      }
    }
  } catch {}
  rows.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  cachedSamples = { stamp, rows };
  return rows;
}

function sampleStateSignature(sample) {
  const p = sample?.pools || {};
  const fmt = (w) => (w ? `${w.leftPct}:${w.resetAtMs ? Math.round(w.resetAtMs / (10 * 60_000)) : 'none'}` : 'null');
  return [
    fmt(p.gemini?.fiveHour),
    fmt(p.gemini?.weekly),
    fmt(p.claude_gpt?.fiveHour),
    fmt(p.claude_gpt?.weekly)
  ].join('|');
}

export function recordQuotaSample(rawSample) {
  if (!rawSample || typeof rawSample !== 'object' || !rawSample.pools) {
    throw new Error('Invalid quota sample payload');
  }
  const capturedAtMs = Number.isFinite(Number(rawSample.capturedAtMs))
    ? Math.round(Number(rawSample.capturedAtMs))
    : Date.now();

  const pools = {};
  for (const key of ['gemini', 'claude_gpt']) {
    const src = rawSample.pools[key];
    if (!src || typeof src !== 'object') continue;
    const fiveHour = sanitizeWindowEntry(src.fiveHour, capturedAtMs);
    const weekly = sanitizeWindowEntry(src.weekly, capturedAtMs);
    if (fiveHour || weekly) {
      pools[key] = { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
    }
  }
  if (!Object.keys(pools).length) {
    throw new Error('No valid quota pool entries in sample');
  }

  const record = {
    capturedAtMs,
    source: typeof rawSample.source === 'string' ? rawSample.source.slice(0, 32) : 'view_usage_dom',
    pools
  };

  const existing = loadQuotaSamples();
  const last = existing[existing.length - 1];
  const minDupGap = rawSample.force ? 5_000 : 55_000;
  if (last && sampleStateSignature(last) === sampleStateSignature(record) && Math.abs(capturedAtMs - last.capturedAtMs) < minDupGap) {
    return { ok: true, stored: false, reason: 'duplicate', sampleCount: existing.length };
  }

  ensurePluginDataDir();
  const nextRows = [...existing, record];
  if (nextRows.length > MAX_SAMPLES) {
    const trimmed = nextRows.slice(nextRows.length - MAX_SAMPLES);
    fs.writeFileSync(QUOTA_SAMPLES_FILE, trimmed.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } else {
    fs.appendFileSync(QUOTA_SAMPLES_FILE, JSON.stringify(record) + '\n', 'utf8');
  }
  cachedSamples = { stamp: '', rows: [] };
  cachedSummary = { stamp: '', computedAtMs: 0, value: null };
  return { ok: true, stored: true, sampleCount: Math.min(nextRows.length, MAX_SAMPLES) };
}

const PRICING_SIG_PRE_PROMO_MS = Date.UTC(2026, 6, 1);
const PRICING_SIG_POST_PROMO_MS = Date.UTC(2028, 0, 1);

function getPricingSignature() {
  const probe = (m, opts = {}) => {
    const c = estimateInvocationCost(m, 1000, 2000, 4000, opts);
    if (c && typeof c === 'object' && c.rate) {
      return `${Number(c.rate.miss || 0)}/${Number(c.rate.hit || 0)}/${Number(c.rate.out || 0)}`;
    }
    return Number(typeof c === 'number' ? c : (c?.totalUsd ?? c?.usd ?? 0)).toFixed(6);
  };
  const probes = [
    // GPT-OSS
    ['gpt-oss-120b'],
    ['gpt-oss-20b'],
    ['gpt-oss'],
    // Claude Opus / Sonnet / Haiku
    ['claude-opus-5-5'],
    ['claude-opus-4-6'],
    ['claude-opus-4-1'],
    ['claude-opus'],
    ['claude-sonnet-5'],
    ['claude-sonnet-4-6'],
    ['claude-sonnet'],
    ['claude-haiku-4-5'],
    ['claude-haiku-5-5', { promptTokens: 10_000 }],
    ['claude-haiku-5-5', { promptTokens: 200_000 }],
    // Gemini 4 family (probe pre-, post-, and current-time promo boundaries)
    ['gemini-4-neon'],
    ['gemini-4-argon', { atMs: PRICING_SIG_PRE_PROMO_MS }],
    ['gemini-4-argon', { atMs: PRICING_SIG_POST_PROMO_MS }],
    ['gemini-4-carbon', { atMs: PRICING_SIG_PRE_PROMO_MS }],
    ['gemini-4-carbon', { atMs: PRICING_SIG_POST_PROMO_MS }],
    ['gemini-4-carbon'],
    ['gemini-4-hydrogen'],
    // Gemini Flash-Lite & Flash
    ['gemini-2.5-flash-lite'],
    ['gemini-flash-lite'],
    ['gemini-2.5-flash'],
    ['gemini-3.8-flash', { atMs: PRICING_SIG_PRE_PROMO_MS }],
    ['gemini-3.8-flash', { atMs: PRICING_SIG_POST_PROMO_MS }],
    ['gemini-3.8-flash'],
    // Gemini Pro (short & long context, pre- & post-promo)
    ['gemini-3.1-pro', { promptTokens: 10_000, atMs: PRICING_SIG_PRE_PROMO_MS }],
    ['gemini-3.1-pro', { promptTokens: 10_000, atMs: PRICING_SIG_POST_PROMO_MS }],
    ['gemini-3.1-pro', { promptTokens: 250_000 }],
    ['gemini-2.5-pro', { promptTokens: 10_000 }],
    ['gemini-2.5-pro', { promptTokens: 250_000 }],
    ['gemini-pro', { atMs: PRICING_SIG_PRE_PROMO_MS }],
    ['gemini-pro', { atMs: PRICING_SIG_POST_PROMO_MS }],
    // Default fallback
    ['unknown-model', { atMs: PRICING_SIG_PRE_PROMO_MS }],
    ['unknown-model', { atMs: PRICING_SIG_POST_PROMO_MS }]
  ];
  return probes.map(([m, opts]) => probe(m, opts)).join('|');
}

function isValidCachedInvocation(it) {
  return Boolean(
    it &&
    typeof it === 'object' &&
    Number.isFinite(it.ts) && it.ts > 0 &&
    (it.pool === 'gemini' || it.pool === 'claude_gpt') &&
    typeof it.model === 'string' &&
    Number.isFinite(it.inputTokens) &&
    Number.isFinite(it.cacheReadTokens) &&
    Number.isFinite(it.outputTokens) &&
    Number.isFinite(it.thinkingTokens) &&
    Number.isFinite(it.totalTokens) &&
    Number.isFinite(it.usd)
  );
}

function ensureDiskCacheLoaded() {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    if (!fs.existsSync(QUOTA_DB_CACHE_FILE)) {
      diskCacheNeedsImmediateFlush = true;
      return;
    }
    const raw = fs.readFileSync(QUOTA_DB_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== QUOTA_DB_CACHE_VERSION ||
      parsed.pricingSig !== getPricingSignature() ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries)
    ) {
      try { fs.unlinkSync(QUOTA_DB_CACHE_FILE); } catch {}
      diskCacheNeedsImmediateFlush = true;
      return;
    }
    let droppedInvalid = false;
    for (const [cid, entry] of Object.entries(parsed.entries)) {
      if (
        !cid ||
        !entry ||
        typeof entry.stamp !== 'string' ||
        !Array.isArray(entry.items) ||
        !entry.items.every(isValidCachedInvocation)
      ) {
        droppedInvalid = true;
        continue;
      }
      dbInvocationsCache.set(cid, { stamp: entry.stamp, items: entry.items });
    }
    if (droppedInvalid) {
      diskCacheDirty = true;
      diskCacheNeedsImmediateFlush = true;
    }
  } catch {
    // Corrupted JSON or unreadable cache file: remove it and transparently rebuild from SQLite
    dbInvocationsCache.clear();
    try { fs.unlinkSync(QUOTA_DB_CACHE_FILE); } catch {}
    diskCacheNeedsImmediateFlush = true;
  }
}

function flushDiskCacheSync() {
  if (!diskCacheDirty) return false;
  const tmpPath = `${QUOTA_DB_CACHE_FILE}.${process.pid}.tmp`;
  let renamed = false;
  try {
    ensurePluginDataDir();
    while (dbInvocationsCache.size > MAX_DB_CACHE_ENTRIES) {
      const oldestKey = dbInvocationsCache.keys().next().value;
      if (oldestKey === undefined) break;
      dbInvocationsCache.delete(oldestKey);
    }
    const entries = {};
    for (const [cid, entry] of dbInvocationsCache.entries()) {
      entries[cid] = { stamp: entry.stamp, items: entry.items };
    }
    const payload = JSON.stringify({
      version: QUOTA_DB_CACHE_VERSION,
      pricingSig: getPricingSignature(),
      entries
    });
    fs.writeFileSync(tmpPath, payload, 'utf8');
    try {
      fs.renameSync(tmpPath, QUOTA_DB_CACHE_FILE);
      renamed = true;
    } catch {
      fs.writeFileSync(QUOTA_DB_CACHE_FILE, payload, 'utf8');
    }
    diskCacheDirty = false;
    diskCacheNeedsImmediateFlush = false;
    if (diskCacheSaveTimer) {
      clearTimeout(diskCacheSaveTimer);
      diskCacheSaveTimer = null;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

function scheduleDiskCacheSave() {
  if (!diskCacheDirty || diskCacheSaveTimer) return;
  diskCacheSaveTimer = setTimeout(() => {
    diskCacheSaveTimer = null;
    flushDiskCacheSync();
  }, 1500);
  if (typeof diskCacheSaveTimer.unref === 'function') diskCacheSaveTimer.unref();
}

function getCachedConversationInvocations(conversationId, precomputedStamp = '', precomputedModelDbStamp = '') {
  ensureDiskCacheLoaded();
  let stamp = precomputedStamp;
  if (!stamp) {
    const dbPath = path.join(CONVERSATIONS_DIR, `${conversationId}.db`);
    const walPath = `${dbPath}-wal`;
    stamp = `${getFileStamp(dbPath)}|${getFileStamp(walPath)}`;
  }
  const cached = dbInvocationsCache.get(conversationId);
  if (cached && cached.stamp === stamp) {
    // Refresh LRU order
    dbInvocationsCache.delete(conversationId);
    dbInvocationsCache.set(conversationId, cached);
    return cached.items;
  }

  const summary = getConversationModelsFromDb(conversationId, precomputedModelDbStamp);
  if (!summary) {
    // Transient SQLite open/lock error or missing file: do not poison cache with empty items.
    return cached?.items || [];
  }
  const items = [];
  if (summary.invocations?.length) {
    for (const inv of summary.invocations) {
      const ts = Number(inv.timestampMs || 0);
      if (!ts) continue;
      const model = inv.sentModel || inv.responseModelFull || inv.responseModel || inv.modelDisplayName || 'unknown';
      const inputTokens = Number(inv.inputTokens || 0);
      const cacheReadTokens = Number(inv.cacheReadTokens || 0);
      const outputTokens = Number(inv.outputTokens || 0);
      const thinkingTokens = Number(inv.thinkingOutputTokens || 0);
      const costObj = estimateInvocationCost(model, inputTokens, cacheReadTokens, outputTokens, { atMs: ts });
      const usd = Number(typeof costObj === 'number' ? costObj : (costObj?.totalUsd ?? costObj?.usd ?? 0)) || 0;
      items.push({
        ts,
        dedupeKey: inv.requestId || inv.responseId || inv.messageId || '',
        pool: classifyQuotaPool(inv),
        model,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        thinkingTokens,
        totalTokens: inputTokens + cacheReadTokens + outputTokens,
        usd
      });
    }
  }
  dbInvocationsCache.delete(conversationId);
  while (dbInvocationsCache.size >= MAX_DB_CACHE_ENTRIES) {
    const oldestKey = dbInvocationsCache.keys().next().value;
    if (oldestKey === undefined) break;
    dbInvocationsCache.delete(oldestKey);
  }
  dbInvocationsCache.set(conversationId, { stamp, items });
  diskCacheDirty = true;
  return items;
}

function collectPoolInvocations(sinceMs) {
  ensureDiskCacheLoaded();
  let files = [];
  try {
    files = fs.readdirSync(CONVERSATIONS_DIR);
  } catch {
    return [];
  }
  const out = [];
  const seenReqKeys = new Set();
  const presentIds = new Set();
  for (const name of files) {
    if (!name.endsWith('.db')) continue;
    const conversationId = name.slice(0, -3);
    if (!conversationId) continue;
    presentIds.add(conversationId);
    const dbPath = path.join(CONVERSATIONS_DIR, name);
    let dbSt;
    try {
      dbSt = fs.statSync(dbPath);
    } catch {
      continue;
    }
    let mtimeMs = dbSt.mtimeMs || 0;
    let walMtimeMs = 0;
    let walSize = 0;
    let walStamp = 'missing';
    try {
      const walSt = fs.statSync(`${dbPath}-wal`);
      walMtimeMs = walSt.mtimeMs || 0;
      walSize = walSt.size || 0;
      if (walMtimeMs > mtimeMs) mtimeMs = walMtimeMs;
      walStamp = `${walMtimeMs}:${walSize}`;
    } catch {}
    if (mtimeMs < sinceMs) continue;
    const stamp = `${dbSt.mtimeMs}:${dbSt.size}|${walStamp}`;
    const modelDbStamp = `${dbSt.mtimeMs}:${dbSt.size}:${walMtimeMs}:${walSize}`;
    const items = getCachedConversationInvocations(conversationId, stamp, modelDbStamp);
    for (const inv of items) {
      if (inv.ts < sinceMs) continue;
      if (inv.dedupeKey) {
        if (seenReqKeys.has(inv.dedupeKey)) continue;
        seenReqKeys.add(inv.dedupeKey);
      }
      out.push(inv);
    }
  }
  // Prune cache entries whose .db files no longer exist on disk
  for (const cid of dbInvocationsCache.keys()) {
    if (!presentIds.has(cid)) {
      dbInvocationsCache.delete(cid);
      diskCacheDirty = true;
    }
  }
  if (diskCacheDirty) {
    if (diskCacheNeedsImmediateFlush || !fs.existsSync(QUOTA_DB_CACHE_FILE)) {
      flushDiskCacheSync();
    } else {
      scheduleDiskCacheSave();
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function sumPoolWindow(invocations, poolKey, startMs, endMs) {
  let calls = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let totalTokens = 0;
  let usd = 0;
  let firstCallMs = 0;
  let lastCallMs = 0;
  const byModel = {};

  for (const inv of invocations) {
    if (inv.pool !== poolKey) continue;
    if (inv.ts < startMs || inv.ts > endMs) continue;
    calls += 1;
    inputTokens += inv.inputTokens;
    cacheReadTokens += inv.cacheReadTokens;
    outputTokens += inv.outputTokens;
    thinkingTokens += inv.thinkingTokens;
    totalTokens += inv.totalTokens;
    usd += inv.usd;
    if (!firstCallMs) firstCallMs = inv.ts;
    lastCallMs = inv.ts;
    byModel[inv.model] = (byModel[inv.model] || 0) + 1;
  }

  return {
    calls,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    totalTokens,
    usd: Number(usd.toFixed(4)),
    firstCallMs: firstCallMs || null,
    lastCallMs: lastCallMs || null,
    byModel
  };
}

function clusterResetCycle(resetAtMs, windowType) {
  if (!resetAtMs) return 'unstarted';
  const bucket = windowType === 'fiveHour' ? 15 * 60_000 : 4 * 3600_000;
  return `${windowType}:${Math.round(resetAtMs / bucket)}`;
}

function analyzePoolWindow(poolKey, windowType, samples, invocations, nowMs) {
  const windowMs = windowType === 'fiveHour' ? FIVE_HOUR_MS : WEEKLY_MS;
  const toleranceMs = windowType === 'fiveHour' ? 3 * 60_000 : 70 * 60_000;

  const entries = [];
  for (const s of samples) {
    const w = s.pools?.[poolKey]?.[windowType];
    if (!w) continue;
    const exactFraction = Boolean(w.exactFraction || Number.isFinite(Number(w.remainingFraction)) || String(s.source || '').includes('rpc'));
    const leftPct = Number.isFinite(Number(w.remainingFraction))
      ? Math.max(0, Math.min(100, Number(w.remainingFraction) * 100))
      : Number(w.leftPct);
    const usedPct = exactFraction
      ? Math.max(0, Math.min(100, Number((100 - leftPct).toFixed(4))))
      : Math.max(0, Math.min(100, Math.round((100 - leftPct) * 10) / 10));
    entries.push({
      capturedAtMs: s.capturedAtMs,
      leftPct: exactFraction ? Number(leftPct.toFixed(4)) : Math.round(leftPct * 10) / 10,
      usedPct,
      exactFraction,
      resetAtMs: w.resetAtMs || null,
      resetLabel: w.resetLabel || ''
    });
  }

  if (!entries.length) {
    return {
      sampled: false,
      windowType,
      sampleCount: 0,
      latest: null,
      liveUsage: null,
      estimate: null
    };
  }

  // Group entries into cycles ordered chronologically
  const cycles = [];
  const byCycleId = new Map();
  for (const e of entries) {
    const cid = clusterResetCycle(e.resetAtMs, windowType);
    let cyc = byCycleId.get(cid);
    if (!cyc) {
      cyc = { id: cid, resetAtMs: e.resetAtMs, entries: [] };
      byCycleId.set(cid, cyc);
      cycles.push(cyc);
    } else if (e.resetAtMs) {
      cyc.resetAtMs = e.resetAtMs;
    }
    cyc.entries.push(e);
  }

  // Build regression points across all cycles with usedPct > 0 and valid resetAtMs,
  // and track highest observed spend while still showing 100% left (for airtight lower bound).
  const regressionMap = new Map();
  let maxZeroPctUsd = 0;
  let prevResetAtMs = 0;
  const cycleBounds = new Map();

  for (const cyc of cycles) {
    const rawStart = cyc.resetAtMs ? cyc.resetAtMs - windowMs - toleranceMs : null;
    const searchStart = rawStart ? Math.max(prevResetAtMs, rawStart) : null;
    cycleBounds.set(cyc.id, { searchStart, resetAtMs: cyc.resetAtMs });

    if (searchStart) {
      for (const e of cyc.entries) {
        const usage = sumPoolWindow(invocations, poolKey, searchStart, e.capturedAtMs + 5000);
        if (e.usedPct <= 0) {
          if (usage.usd > maxZeroPctUsd) maxZeroPctUsd = usage.usd;
          continue;
        }
        if (usage.usd <= 0 && usage.totalTokens <= 0) continue;
        // For exact-fraction RPC samples: group by exact fraction (0.001% precision) and keep the EARLIEST
        // spend for a plateau (since a flat exact float means server billing hasn't flushed yet).
        // For legacy integer-DOM samples: bracket earliest & latest spend in each 1% bin to cancel rounding bias.
        const ptKey = e.exactFraction
          ? `ex:${cyc.id}:${Math.round(e.usedPct * 1000)}`
          : `dom:${cyc.id}:${Math.round(e.usedPct)}`;
        const prev = regressionMap.get(ptKey);
        if (!prev) {
          regressionMap.set(ptKey, {
            cycleId: cyc.id,
            capturedAtMs: e.capturedAtMs,
            usedPct: e.usedPct,
            exactFraction: e.exactFraction,
            minUsd: usage.usd,
            maxUsd: usage.usd,
            usd: usage.usd,
            minTokens: usage.totalTokens,
            maxTokens: usage.totalTokens,
            totalTokens: usage.totalTokens,
            calls: usage.calls
          });
        } else {
          prev.minUsd = Math.min(prev.minUsd, usage.usd);
          prev.maxUsd = Math.max(prev.maxUsd, usage.usd);
          prev.minTokens = Math.min(prev.minTokens, usage.totalTokens);
          prev.maxTokens = Math.max(prev.maxTokens, usage.totalTokens);
          if (e.exactFraction) {
            prev.usd = prev.minUsd;
            prev.totalTokens = prev.minTokens;
          } else {
            prev.usd = (prev.minUsd + prev.maxUsd) / 2;
            prev.totalTokens = Math.round((prev.minTokens + prev.maxTokens) / 2);
          }
          if (e.capturedAtMs >= prev.capturedAtMs) {
            prev.capturedAtMs = e.capturedAtMs;
            prev.usedPct = e.usedPct;
            prev.calls = usage.calls;
          }
        }
      }
      if (cyc.resetAtMs && cyc.resetAtMs > prevResetAtMs) {
        prevResetAtMs = cyc.resetAtMs;
      }
    }
  }

  const latest = entries[entries.length - 1];
  const latestCycleId = clusterResetCycle(latest.resetAtMs, windowType);
  const latestBound = cycleBounds.get(latestCycleId) || { searchStart: null, resetAtMs: latest.resetAtMs };
  const expired = Boolean(latest.resetAtMs && nowMs >= latest.resetAtMs);

  let liveUsage = null;
  if (!expired && latestBound.searchStart) {
    liveUsage = sumPoolWindow(invocations, poolKey, latestBound.searchStart, nowMs + 60_000);
  } else if (expired && latest.resetAtMs) {
    liveUsage = sumPoolWindow(invocations, poolKey, latest.resetAtMs, nowMs + 60_000);
  } else {
    // Unstarted window (100% left, no reset countdown)
    liveUsage = { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, usd: 0, firstCallMs: null, lastCallMs: null, byModel: {} };
  }

  const allPointsRaw = [...regressionMap.values()];
  // Google's 5h quota dynamically smooths global aggregate demand across cycles,
  // whereas weekly quota is tied directly to the user's tier.
  // Restrict 5h regression strictly to the current active cycle so prior cycles' load factors
  // cannot overpower the current cycle.
  const allPoints = windowType === 'fiveHour'
    ? (expired ? [] : allPointsRaw.filter((p) => p.cycleId === latestCycleId))
    : allPointsRaw;
  // Filter stale-cache RPC reads: if a newer exact sample in the same cycle arrived within 2 minutes
  // with a strictly higher usedPct, the earlier point was a pre-flush cached server snapshot.
  const rawExactPoints = allPoints.filter((p) => p.exactFraction).sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  const exactPoints = rawExactPoints.filter((pt, idx) => {
    for (let j = idx + 1; j < rawExactPoints.length; j++) {
      const nxt = rawExactPoints[j];
      if (nxt.cycleId !== pt.cycleId) break;
      if (nxt.capturedAtMs - pt.capturedAtMs <= 2 * 60_000 && nxt.usedPct > pt.usedPct + 0.05) {
        return false;
      }
    }
    return true;
  });
  const usingExact = exactPoints.length > 0;
  const points = usingExact ? exactPoints : allPoints;
  let estimate = null;

  if (points.length > 0) {
    // Weighted least squares through origin: usd = Q * (usedPct / 100)
    // Weighting by u^2 naturally gives deeper usage points much higher weight than shallow points.
    let numUsd = 0;
    let numTok = 0;
    let den = 0;
    let deepest = points[0];
    for (const pt of points) {
      const u = pt.usedPct / 100;
      numUsd += u * pt.usd;
      numTok += u * pt.totalTokens;
      den += u * u;
      if (pt.usedPct > deepest.usedPct || (pt.usedPct === deepest.usedPct && pt.capturedAtMs > deepest.capturedAtMs)) {
        deepest = pt;
      }
    }

    const estTotalUsd = den > 0 ? numUsd / den : 0;
    const estTotalTokens = den > 0 ? Math.round(numTok / den) : 0;

    let lowUsd = estTotalUsd;
    let highUsd = estTotalUsd;
    let relErrPct = 10;
    let precision = '样本偏少';
    let confidenceTier = 'low';

    if (usingExact) {
      // Exact floating-point remainingFraction still carries ~±1.2–2.0% server-side jitter/bounce
      // plus pricing-weight variance across models/cache ratios. Reflect both empirical scatter
      // and a realistic noise floor so shallow samples (<10% used) never claim false high confidence.
      const baseBand = deepest.usedPct >= 15 ? 0.06 : deepest.usedPct >= 10 ? 0.10 : 0.14;
      const noiseFloor = Math.min(0.45, 1.2 / Math.max(1.5, deepest.usedPct));
      let empBand = 0;
      if (points.length >= 2 && estTotalUsd > 0) {
        let weightedDev = 0;
        let wSum = 0;
        for (const pt of points) {
          const u = pt.usedPct / 100;
          if (u <= 0) continue;
          const ptQ = pt.usd / u;
          const relDev = Math.abs(ptQ - estTotalUsd) / estTotalUsd;
          weightedDev += u * relDev;
          wSum += u;
        }
        empBand = wSum > 0 ? weightedDev / wSum : 0;
      }
      const relBand = Math.max(baseBand, noiseFloor, Math.min(0.45, empBand * 1.4));
      lowUsd = estTotalUsd * (1 - relBand);
      highUsd = estTotalUsd * (1 + relBand);
      relErrPct = Math.max(3, Math.round(relBand * 100));
      if (deepest.usedPct >= 10 && relBand <= 0.22 && points.length >= 2) {
        precision = '高置信';
        confidenceTier = 'high';
      } else if (deepest.usedPct >= 3 && relBand <= 0.36) {
        precision = '收敛中';
        confidenceTier = 'mid';
      }
    } else {
      // Legacy integer-percentage quantization uncertainty band from the deepest observed point
      const uLow = Math.max(0.005, (deepest.usedPct - 0.5) / 100);
      const uHigh = Math.min(1, (deepest.usedPct + 1.0) / 100);
      lowUsd = Math.min(estTotalUsd, deepest.usd / uHigh);
      highUsd = Math.max(estTotalUsd, deepest.usd / uLow);
      relErrPct = Math.max(2, Math.round(50 / Math.max(1, deepest.usedPct)));
      if (deepest.usedPct >= 12) {
        precision = '高置信';
        confidenceTier = 'high';
      } else if (deepest.usedPct >= 4) {
        precision = '收敛中';
        confidenceTier = 'mid';
      }
    }

    // Anchor remaining estimate directly to the server's latest real remaining %,
    // subtracting only incremental spend recorded AFTER latest.capturedAtMs.
    // This guarantees projectedLeftPct never contradicts or exceeds latest.leftPct.
    const deltaAfterSample = !expired && latest?.capturedAtMs
      ? sumPoolWindow(invocations, poolKey, latest.capturedAtMs + 1, nowMs + 60_000).usd
      : 0;
    const anchoredLeftPct = expired
      ? 100
      : Math.max(0, Math.min(100, latest.leftPct - (estTotalUsd > 0 ? (deltaAfterSample / estTotalUsd) * 100 : 0)));
    const projectedLeftPct =
      !expired && deltaAfterSample > 0 && estTotalUsd > 0
        ? Number(anchoredLeftPct.toFixed(2))
        : null;

    estimate = {
      status: 'estimated',
      estTotalUsd: Number(estTotalUsd.toFixed(2)),
      lowUsd: Number(lowUsd.toFixed(2)),
      highUsd: Number(highUsd.toFixed(2)),
      estTotalTokens,
      estRemainingUsd: Number(Math.max(0, estTotalUsd * (anchoredLeftPct / 100)).toFixed(2)),
      projectedLeftPct,
      maxUsedPctObserved: Number(deepest.usedPct.toFixed(2)),
      pointCount: points.length,
      exactFraction: usingExact,
      precision,
      confidenceTier,
      relErrPct,
      method: points.length >= 2 ? 'wls' : 'single'
    };
  } else if (!expired && maxZeroPctUsd > 0) {
    // Still at 100% left at sample time while having real spend -> airtight lower bound
    estimate = {
      status: 'lower_bound',
      minBoundUsd: Number((maxZeroPctUsd / 0.01).toFixed(2)),
      pointCount: 0,
      precision: '仅下界'
    };
  }

  return {
    sampled: true,
    windowType,
    sampleCount: entries.length,
    expired,
    windowStartMs: liveUsage?.firstCallMs || (latest.resetAtMs ? latest.resetAtMs - windowMs : null),
    latest: {
      capturedAtMs: latest.capturedAtMs,
      leftPct: latest.leftPct,
      usedPct: latest.usedPct,
      exactFraction: latest.exactFraction,
      resetAtMs: latest.resetAtMs,
      remainingMs: latest.resetAtMs ? Math.max(0, latest.resetAtMs - nowMs) : null
    },
    liveUsage,
    estimate
  };
}

export function getQuotaAnalytics(optionsOrNow = Date.now()) {
  const isObj = optionsOrNow && typeof optionsOrNow === 'object';
  const nowMs = isObj
    ? (Number.isFinite(Number(optionsOrNow.nowMs)) ? Number(optionsOrNow.nowMs) : Date.now())
    : (Number.isFinite(Number(optionsOrNow)) ? Number(optionsOrNow) : Date.now());
  const force = Boolean(isObj && optionsOrNow.force);

  const sampleStamp = getFileStamp(QUOTA_SAMPLES_FILE);
  if (
    !force &&
    cachedSummary.value &&
    cachedSummary.stamp === sampleStamp &&
    nowMs - cachedSummary.computedAtMs < SUMMARY_CACHE_TTL_MS
  ) {
    return cachedSummary.value;
  }

  const samples = loadQuotaSamples();
  if (!samples.length) {
    const empty = {
      hasSamples: false,
      sampleCount: 0,
      lastSampledAtMs: null,
      revision: 'quota:0',
      pools: {
        gemini: { label: 'Gemini Models', fiveHour: { sampled: false }, weekly: { sampled: false } },
        claude_gpt: { label: 'Claude & GPT', fiveHour: { sampled: false }, weekly: { sampled: false } }
      }
    };
    cachedSummary = { stamp: sampleStamp, computedAtMs: nowMs, value: empty };
    return empty;
  }

  // Determine tight earliest DB window needed across all samples (cap lookback to 21 days for speed)
  let earliestNeeded = Infinity;
  for (const s of samples) {
    for (const pk of ['gemini', 'claude_gpt']) {
      const w = s.pools?.[pk]?.weekly;
      if (w?.resetAtMs) {
        earliestNeeded = Math.min(earliestNeeded, w.resetAtMs - WEEKLY_MS - 2 * 3600_000);
      }
      const f = s.pools?.[pk]?.fiveHour;
      if (f?.resetAtMs) {
        earliestNeeded = Math.min(earliestNeeded, f.resetAtMs - FIVE_HOUR_MS - 10 * 60_000);
      }
    }
  }
  if (!Number.isFinite(earliestNeeded)) {
    earliestNeeded = nowMs - FIVE_HOUR_MS;
  }
  earliestNeeded = Math.max(earliestNeeded, nowMs - 21 * 24 * 3600_000);

  const invocations = collectPoolInvocations(earliestNeeded);
  const gemini = {
    label: 'Gemini Models',
    fiveHour: analyzePoolWindow('gemini', 'fiveHour', samples, invocations, nowMs),
    weekly: analyzePoolWindow('gemini', 'weekly', samples, invocations, nowMs)
  };
  const claude_gpt = {
    label: 'Claude & GPT',
    fiveHour: analyzePoolWindow('claude_gpt', 'fiveHour', samples, invocations, nowMs),
    weekly: analyzePoolWindow('claude_gpt', 'weekly', samples, invocations, nowMs)
  };

  const lastSampledAtMs = samples[samples.length - 1]?.capturedAtMs || null;
  const revParts = [
    'q',
    samples.length,
    lastSampledAtMs || 0,
    gemini.fiveHour.latest?.leftPct ?? '-',
    Math.round((gemini.fiveHour.liveUsage?.usd || 0) * 100),
    gemini.weekly.latest?.leftPct ?? '-',
    Math.round((gemini.weekly.liveUsage?.usd || 0) * 100),
    claude_gpt.fiveHour.latest?.leftPct ?? '-',
    Math.round((claude_gpt.fiveHour.liveUsage?.usd || 0) * 100),
    claude_gpt.weekly.latest?.leftPct ?? '-',
    Math.round((claude_gpt.weekly.liveUsage?.usd || 0) * 100)
  ];

  const result = {
    hasSamples: true,
    sampleCount: samples.length,
    lastSampledAtMs,
    revision: revParts.join(':'),
    pools: { gemini, claude_gpt }
  };
  cachedSummary = { stamp: sampleStamp, computedAtMs: nowMs, value: result };
  return result;
}

function randomIdleDelayMs() {
  return Math.round(IDLE_REFRESH_MIN_MS + Math.random() * (IDLE_REFRESH_MAX_MS - IDLE_REFRESH_MIN_MS));
}

function getLatestConversationActivityMs() {
  let maxMs = 0;
  try {
    const names = fs.readdirSync(CONVERSATIONS_DIR);
    for (const name of names) {
      if (!name.endsWith('.db') && !name.endsWith('.db-wal')) continue;
      try {
        const mt = fs.statSync(path.join(CONVERSATIONS_DIR, name)).mtimeMs || 0;
        if (mt > maxMs) maxMs = mt;
      } catch {}
    }
  } catch {}
  return maxMs;
}

export function parseQuotaSummaryRpcResponse(json, capturedAtMs = Date.now()) {
  const groups = json?.response?.groups || json?.groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  const pools = {};
  for (const grp of groups) {
    const grpLabel = String(grp?.displayName || '');
    const buckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
    for (const b of buckets) {
      const probe = `${grpLabel} ${b?.bucketId || ''} ${b?.displayName || ''}`.toLowerCase();
      const poolKey = /claude|gpt|\b3p\b/.test(probe) ? 'claude_gpt' : 'gemini';
      const winProbe = `${b?.window || ''} ${b?.bucketId || ''} ${b?.displayName || ''}`.toLowerCase();
      const winKey = winProbe.includes('5h') || winProbe.includes('five') ? 'fiveHour' : 'weekly';
      const frac = Number(b?.remainingFraction);
      if (!Number.isFinite(frac) || frac < 0 || frac > 1) continue;
      const untouched = frac >= 0.999999 && !String(b?.description || '').trim();
      const parsedReset = !untouched && b?.resetTime ? Date.parse(String(b.resetTime)) : NaN;
      const resetAtMs = Number.isFinite(parsedReset) && parsedReset > 0 ? Math.round(parsedReset) : null;
      const resetInMs = resetAtMs ? Math.max(0, resetAtMs - capturedAtMs) : null;
      if (!pools[poolKey]) pools[poolKey] = {};
      pools[poolKey][winKey] = {
        remainingFraction: frac,
        leftPct: Math.round(frac * 1000000) / 10000,
        exactFraction: true,
        resetAtMs,
        resetInMs,
        resetLabel: b?.window || ''
      };
    }
  }
  if (!Object.keys(pools).length) return null;
  return { capturedAtMs, source: 'ls_rpc', pools };
}

export async function fetchQuotaFromLanguageServer(opts = {}) {
  if (rpcFetchInFlight) return rpcFetchInFlight;
  const work = (async () => {
    const now = Date.now();
    schedulerState.lastAttemptAtMs = now;
    const ep = loadLsEndpoint();
    if (!ep?.lsAddress || !ep?.csrfToken) {
      schedulerState.lastError = 'ls_endpoint unavailable';
      return { ok: false, error: 'ls_endpoint unavailable' };
    }
    const url = `http://${ep.lsAddress}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': ep.csrfToken
        },
        body: JSON.stringify({ forceRefresh: true }),
        signal: controller.signal
      });
      if (!res.ok) {
        const msg = `HTTP ${res.status}`;
        schedulerState.lastError = msg;
        return { ok: false, error: msg };
      }
      const json = await res.json();
      const sample = parseQuotaSummaryRpcResponse(json, Date.now());
      if (!sample) {
        schedulerState.lastError = 'empty quota groups';
        return { ok: false, error: 'empty quota groups' };
      }
      sample.source = typeof opts.source === 'string' ? opts.source : 'ls_rpc';
      if (opts.force) sample.force = true;
      const recorded = recordQuotaSample(sample);
      schedulerState.lastFetchAtMs = Date.now();
      schedulerState.nextIdleDelayMs = randomIdleDelayMs();
      schedulerState.lastError = '';
      return { ok: true, recorded, sample };
    } catch (err) {
      const msg = String(err?.message || err);
      schedulerState.lastError = msg;
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  })();
  rpcFetchInFlight = work;
  work.finally(() => {
    rpcFetchInFlight = null;
  });
  return work;
}

export function startQuotaAutoRefreshScheduler() {
  if (schedulerState.started) return;
  schedulerState.started = true;
  schedulerState.nextIdleDelayMs = randomIdleDelayMs();

  const existing = loadQuotaSamples();
  const lastRpc = [...existing].reverse().find((s) => String(s.source || '').includes('rpc'));
  if (lastRpc?.capturedAtMs) {
    schedulerState.lastFetchAtMs = lastRpc.capturedAtMs;
  }

  const checkDue = () => {
    if (rpcFetchInFlight) return;
    const now = Date.now();
    // Avoid tight retry loops if LS is temporarily unreachable
    if (now - schedulerState.lastAttemptAtMs < 60_000) return;

    const lastAt = schedulerState.lastFetchAtMs || 0;
    if (!lastAt) {
      void fetchQuotaFromLanguageServer({ source: 'auto_rpc' });
      return;
    }

    const elapsed = now - lastAt;
    const latestActivityMs = getLatestConversationActivityMs();
    const hasActivity = latestActivityMs > lastAt + 5_000;
    const dueMs = hasActivity ? ACTIVE_REFRESH_MS : (schedulerState.nextIdleDelayMs || randomIdleDelayMs());
    if (elapsed >= dueMs) {
      void fetchQuotaFromLanguageServer({ source: 'auto_rpc' });
    }
  };

  // Initial fetch shortly after sidecar boot (only if no exact RPC sample or overdue)
  const bootTimer = setTimeout(checkDue, 3000);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();

  schedulerState.timer = setInterval(checkDue, 60_000);
  if (typeof schedulerState.timer.unref === 'function') schedulerState.timer.unref();
}
