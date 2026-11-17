import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getConversationModelsFromDb,
  listRecentConversations,
  getPluginConfig,
  readInflightState,
  estimateInvocationCost,
  getSessionTranscriptAnalytics,
  getFleetHierarchy,
  getGlobalInsights
} from './model_core.mjs';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const CONFIG_ROOT = path.join(os.homedir(), '.gemini', 'config');

function toMs(val, fallbackMs = Date.now()) {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackMs;
}

function normalizeModelId(inv) {
  if (!inv) return 'gemini-3.8-flash';
  return inv.responseModelFull || inv.responseModel || inv.sentModel || inv.actualModelLabel || 'gemini-3.8-flash';
}

function buildRateEntry(modelName, atMs) {
  const est = estimateInvocationCost(modelName, 0, 0, 0, { atMs });
  return {
    provider: est.rate?.provider || 'google',
    model: modelName,
    rate: {
      hit: Number(est.rate?.hit ?? 0.10),
      miss: Number(est.rate?.miss ?? 2.0),
      write: Number(est.rate?.write ?? 0),
      out: Number(est.rate?.out ?? 10.0)
    },
    via: 'direct',
    confidence: est.rate?.confidence || 'high'
  };
}

function buildDshCostAndFaces(invocations = [], fallbackModel = 'gemini-3.8-flash', atMs = Date.now()) {
  const cost = {};
  const faceMap = new Map();
  let totalUsd = 0;

  if (!Array.isArray(invocations) || invocations.length === 0) {
    const entry = buildRateEntry(fallbackModel, atMs);
    cost[entry.provider] = { [fallbackModel]: { off: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } };
    faceMap.set(`${entry.provider}/${fallbackModel}`, entry);
    return { cost, costRead: { usd: 0, ready: true, faces: [entry] } };
  }

  for (const inv of invocations) {
    const mName = normalizeModelId(inv);
    const inTok = Math.max(0, Number(inv.inputTokens || 0));
    const cacheTok = Math.max(0, Number(inv.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(inv.outputTokens || 0));
    const est = estimateInvocationCost(mName, inTok, cacheTok, outTok, { atMs });
    const provider = est.rate?.provider || 'google';
    totalUsd += est.usd || 0;

    if (!cost[provider]) cost[provider] = {};
    if (!cost[provider][mName]) {
      cost[provider][mName] = { off: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
    }
    const bucket = cost[provider][mName].off;
    bucket.uncached += inTok;
    bucket.cacheRead += cacheTok;
    bucket.output += outTok;

    const faceKey = `${provider}/${mName}`;
    if (!faceMap.has(faceKey)) {
      faceMap.set(faceKey, buildRateEntry(mName, atMs));
    }
  }

  return {
    cost,
    costRead: {
      usd: Number(totalUsd.toFixed(6)),
      ready: true,
      faces: [...faceMap.values()]
    }
  };
}

function buildDshNodesAndRequests(summary, analytics, baseMs) {
  const items = Array.isArray(analytics?.browserItems) ? analytics.browserItems : [];
  const invocations = Array.isArray(summary?.invocations) ? summary.invocations : [];
  const buckets = Array.isArray(analytics?.composition?.buckets) ? analytics.composition.buckets : [];
  const bucketMap = Object.fromEntries(buckets.map(b => [b.key, Math.max(0, Number(b.tokens || 0))]));

  const sysTokens = bucketMap.system || 0;
  const toolsTokens = bucketMap.tools || 0;

  // Build ordered timeline nodes matching dsh-context's browser item cats
  // Reserve seq 0 = system/message, seq 1 = request/header so headers & nodes never collide
  const nodes = [];
  const browserItemBySeq = {};
  let systemItem = null;
  let toolsItem = null;
  const seqByStepIndex = new Map();
  let nextSeq = 2;
  let cumUser = 0;
  let cumInject = 0;
  let cumSkill = 0;
  let cumAssistant = 0;
  let cumTool = 0;
  let cumReasoning = 0;
  let cumAnswer = 0;
  let cumCall = 0;
  let prevTime = baseMs - Math.max(1, items.length) * 1000;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.cat === 'system') {
      systemItem = it;
      continue;
    }
    if (it.cat === 'tools') {
      toolsItem = it;
      continue;
    }
    const seq = nextSeq++;
    browserItemBySeq[seq] = it;
    const t = Math.max(prevTime + 10, toMs(it.createdAt, prevTime + 500));
    prevTime = t;
    const tok = Math.max(1, Math.round(Number(it.estTokens || 0)));
    const cat = ['user', 'inject', 'skill', 'assistant', 'tool'].includes(it.cat) ? it.cat : 'inject';

    if (cat === 'user') cumUser += tok;
    else if (cat === 'inject') cumInject += tok;
    else if (cat === 'skill') cumSkill += tok;
    else if (cat === 'assistant') {
      cumAssistant += tok;
      if (it.thinkingText) cumReasoning += Math.round(tok * 0.25);
      if (Array.isArray(it.toolNames) && it.toolNames.length > 0) cumCall += Math.round(tok * 0.2);
      cumAnswer += Math.max(0, tok - (it.thinkingText ? Math.round(tok * 0.25) : 0));
    } else if (cat === 'tool') {
      cumTool += tok;
    }

    const node = {
      seq,
      cat,
      time: t,
      tokens: tok
    };
    if (it.previewText) node.text = String(it.previewText).slice(0, 1200);
    if (cat === 'assistant' && Array.isArray(it.toolNames) && it.toolNames.length > 0) {
      node.calls = it.toolNames;
    }
    if (cat === 'tool') {
      if (Array.isArray(it.toolNames) && it.toolNames[0]) node.tool = it.toolNames[0];
      if (it.status === 'error') node.err = true;
    }
    if (cat === 'skill' && it.skillName) {
      node.skill = it.skillName;
      node.form = 'context';
    }
    if (cat === 'inject') {
      node.form = it.type === 'SYSTEM_MESSAGE' ? 'notice' : 'context';
    }
    if (typeof it.stepIndex === 'number' && it.stepIndex >= 0) {
      seqByStepIndex.set(it.stepIndex, seq);
    }
    node._rawStep = it.stepIndex;
    node._cum = {
      user: cumUser,
      inject: cumInject,
      skill: cumSkill,
      assistant: cumAssistant,
      tool: cumTool
    };
    nodes.push(node);
  }

  // Fallback nodes if transcript is missing or empty while invocations exist
  if (nodes.length === 0 && invocations.length > 0) {
    for (let i = 0; i < invocations.length; i++) {
      const inv = invocations[i];
      const uSeq = nextSeq++;
      const aSeq = nextSeq++;
      const ts = baseMs - (invocations.length - i) * 2000;
      const inTok = Math.max(100, (inv.inputTokens || 0) + (inv.cacheReadTokens || 0));
      const outTok = Math.max(10, inv.outputTokens || 50);
      nodes.push({
        seq: uSeq,
        cat: 'user',
        time: ts - 500,
        tokens: Math.round(inTok * 0.15),
        text: summary?.title || 'User turn',
        _cum: { user: Math.round(inTok * 0.15), inject: 0, skill: 0, assistant: outTok * i, tool: 0 }
      });
      nodes.push({
        seq: aSeq,
        cat: 'assistant',
        time: ts,
        tokens: outTok,
        text: `${inv.responseModel || inv.sentModel || 'model'} (${inv.tps || 0} tok/s)`,
        _cum: { user: Math.round(inTok * 0.15), inject: 0, skill: 0, assistant: outTok * (i + 1), tool: 0 }
      });
    }
  }

  const trends = Array.isArray(analytics?.trends) ? analytics.trends : [];
  const assistantNodes = nodes.filter(n => n.cat === 'assistant');

  // Construct monotonic requests paired to assistant node seqs so Zu() finds opener/inputs/response
  const requests = [];
  let lastReqSeq = -1;
  let lastReqTime = baseMs - 60000;

  const sourceList = trends.length > 0 ? trends : invocations.map((inv, idx) => ({
    stepIndex: Array.isArray(inv.stepIndices) && inv.stepIndices[0] != null ? inv.stepIndices[0] : (idx + 1),
    turn: idx + 1,
    step: 1,
    contextTokens: inv.estimatedContextTokens || ((inv.inputTokens || 0) + (inv.cacheReadTokens || 0)),
    inputTokens: inv.inputTokens || 0,
    cacheReadTokens: inv.cacheReadTokens || 0,
    outputTokens: inv.outputTokens || 0,
    ttftSeconds: inv.ttftSeconds || 0,
    streamingSeconds: inv.streamingSeconds || 0,
    model: normalizeModelId(inv)
  }));

  for (let i = 0; i < sourceList.length; i++) {
    const tr = sourceList[i];
    const trStep = typeof tr.stepIndex === 'number' ? tr.stepIndex : tr.step;
    let targetNode = null;
    if (typeof trStep === 'number' && seqByStepIndex.has(trStep)) {
      const s = seqByStepIndex.get(trStep);
      targetNode = nodes.find(n => n.seq === s) || null;
    }
    if (!targetNode && assistantNodes[i]) {
      targetNode = assistantNodes[i];
    }
    if (!targetNode && nodes.length > 0) {
      targetNode = nodes[Math.min(nodes.length - 1, i)];
    }

    let reqSeq = targetNode ? targetNode.seq : (lastReqSeq + 2);
    if (reqSeq <= lastReqSeq) reqSeq = lastReqSeq + 1;
    lastReqSeq = reqSeq;

    const reqTime = targetNode ? Math.max(lastReqTime + 10, targetNode.time) : (lastReqTime + 1000);
    lastReqTime = reqTime;

    const cum = targetNode?._cum || {
      user: bucketMap.user || 0,
      inject: bucketMap.inject || 0,
      skill: bucketMap.skill || 0,
      assistant: bucketMap.assistant || 0,
      tool: bucketMap.tool || 0
    };
    const promptActual = Math.max(0, Number(tr.inputTokens || 0) + Number(tr.cacheReadTokens || 0));
    const ctxTarget = Math.max(promptActual, Number(tr.contextTokens || 0));
    const msgSum = cum.user + cum.inject + cum.skill + cum.assistant + cum.tool;
    const scale = msgSum > 0 && ctxTarget > (sysTokens + toolsTokens)
      ? (ctxTarget - sysTokens - toolsTokens) / msgSum
      : 1;

    const u = Math.max(0, Math.round(cum.user * scale));
    const inj = Math.max(0, Math.round(cum.inject * scale));
    const sk = Math.max(0, Math.round(cum.skill * scale));
    const as = Math.max(0, Math.round(cum.assistant * scale));
    const tl = Math.max(0, Math.round(cum.tool * scale));
    const total = sysTokens + toolsTokens + u + inj + sk + as + tl;

    const inv = invocations[i] || null;
    const activeMs = inv
      ? Math.max(100, Math.round(((inv.ttftSeconds || 0) + (inv.streamingSeconds || 0)) * 1000))
      : Math.max(100, Math.round(((tr.ttftSeconds || 0) + (tr.streamingSeconds || 0)) * 1000));

    requests.push({
      seq: reqSeq,
      time: reqTime,
      turn: Math.max(1, Number(tr.turn || (i + 1))),
      step: Math.max(1, Number(tr.step || 1)),
      system: sysTokens,
      tools: toolsTokens,
      user: u,
      inject: inj,
      skill: sk,
      assistant: as,
      tool: tl,
      total,
      prompt: promptActual > 0 ? promptActual : undefined,
      output: Number(tr.outputTokens || 0) > 0 ? Number(tr.outputTokens) : undefined,
      cacheRead: Number(tr.cacheReadTokens || 0) > 0 ? Number(tr.cacheReadTokens) : undefined,
      activeMs
    });
  }

  // Strip internal scratch keys from nodes
  const cleanNodes = nodes.map(({ _rawStep, _cum, ...rest }) => rest);

  // Events
  const rawEvents = Array.isArray(analytics?.contextEvents) ? analytics.contextEvents : [];
  let lastEvSeq = 0;
  const events = rawEvents.map((ev, idx) => {
    const matchedSeq = typeof ev.step === 'number' && seqByStepIndex.has(ev.step)
      ? seqByStepIndex.get(ev.step)
      : (cleanNodes[Math.min(cleanNodes.length - 1, idx)]?.seq ?? (idx + 1));
    const seq = Math.max(lastEvSeq + 1, matchedSeq);
    lastEvSeq = seq;
    const kind = ['inject', 'compaction', 'prune', 'model', 'mode'].includes(ev.kind) ? ev.kind : 'inject';
    const out = {
      seq,
      time: toMs(ev.time, baseMs),
      kind,
      turn: Math.max(1, Number(ev.turn || 1)),
      step: Math.max(1, Number(ev.step || 1))
    };
    if (ev.sub) out.sub = ev.sub;
    if (ev.form) out.form = ev.form;
    if (ev.name) out.name = ev.name;
    if (ev.from) out.from = ev.from;
    if (ev.to) out.to = ev.to;
    if (ev.detail) out.detail = String(ev.detail).slice(0, 120);
    if (Number(ev.tokens || 0) > 0) out.tokens = Number(ev.tokens);
    if (Number(ev.count || 0) > 0) out.count = Number(ev.count);
    return out;
  });

  // FileOps: flat array of { seq, path, tool, kind, added, removed, time }
  const files = Array.isArray(analytics?.activitySummary?.files) ? analytics.activitySummary.files : [];
  const fileOps = [];
  let opSeqFallback = cleanNodes.length + 1000;
  for (const f of files) {
    const ops = Array.isArray(f.ops) ? f.ops : [];
    for (const op of ops) {
      const seq = typeof op.stepIndex === 'number' && seqByStepIndex.has(op.stepIndex)
        ? seqByStepIndex.get(op.stepIndex)
        : opSeqFallback++;
      const kind = op.kind === 'write' || op.kind === 'search' ? op.kind : 'read';
      fileOps.push({
        seq,
        path: String(f.path || op.path || 'unknown'),
        tool: String(op.tool || (kind === 'write' ? 'edit_file' : kind === 'search' ? 'grep_search' : 'read_file')),
        kind,
        added: Math.max(0, Number(op.added || 0)),
        removed: Math.max(0, Number(op.removed || 0)),
        time: toMs(op.time, baseMs),
        err: Boolean(op.err)
      });
    }
  }
  fileOps.sort((a, b) => a.seq - b.seq);

  // Commands: array of CommandRecord passing $p(e) validator
  const rawCmds = Array.isArray(analytics?.activitySummary?.recentCommands)
    ? [...analytics.activitySummary.recentCommands].reverse()
    : [];
  const commands = rawCmds.map((c, idx) => {
    const mappedSeq = typeof c.stepIndex === 'number' && seqByStepIndex.has(c.stepIndex)
      ? seqByStepIndex.get(c.stepIndex)
      : (cleanNodes.length + idx + 1);
    const resultSeq = typeof c.resultStepIndex === 'number' && seqByStepIndex.has(c.resultStepIndex)
      ? seqByStepIndex.get(c.resultStepIndex)
      : mappedSeq;
    const t = toMs(c.createdAt, baseMs);
    const dur = Math.max(10, Number(c.durationMs || 50));
    const status = c.status === 'failed' ? 'failed' : c.status === 'running' ? 'running' : 'completed';
    const rec = {
      seq: c.seq || (idx + 1),
      time: t,
      tool: 'pwsh',
      cmd: String(c.command || c.summary || 'pwsh'),
      start: t,
      status,
      err: Boolean(c.err),
      resultSeq,
      turn: Math.max(1, Number(c.turn || 1)),
      step: Math.max(1, Number(c.stepIndex || 1))
    };
    if (status !== 'running') rec.end = t + dur;
    if (typeof c.exitCode === 'number') rec.exit = c.exitCode;
    if (typeof c.outChars === 'number' && c.outChars >= 0) rec.outChars = c.outChars;
    if (c.summary) rec.description = String(c.summary).slice(0, 120);
    if (c.background) rec.background = true;
    return rec;
  });

  // Synthetic detail map for command output inspection
  const commandDetailsBySeq = {};
  for (let i = 0; i < rawCmds.length; i++) {
    const rc = rawCmds[i];
    const dc = commands[i];
    if (dc?.resultSeq != null && rc?.outputPreview) {
      commandDetailsBySeq[dc.resultSeq] = {
        kind: 'tool-result',
        seq: dc.resultSeq,
        call: { name: 'run_command', argsRaw: JSON.stringify({ CommandLine: rc.command || '' }) },
        content: [{ type: 'text', text: String(rc.outputPreview) }],
        isError: Boolean(rc.err)
      };
    }
  }

  return {
    sysTokens,
    toolsTokens,
    cumReasoning,
    cumAnswer,
    cumCall,
    nodes: cleanNodes,
    requests,
    events,
    fileOps,
    commands,
    commandDetailsBySeq,
    browserItemBySeq,
    systemItem,
    toolsItem
  };
}

function buildDshTimingAndSpans(summary, analytics, cfg, baseMs) {
  const ss = analytics?.sessionStats || {};
  const invocations = Array.isArray(summary?.invocations) ? summary.invocations : [];
  const totals = summary?.totals || {};

  let sumTtftSec = 0;
  let sumStreamSec = 0;
  for (const inv of invocations) {
    if (inv?.ttftSeconds > 0) sumTtftSec += inv.ttftSeconds;
    if (inv?.streamingSeconds > 0) sumStreamSec += inv.streamingSeconds;
  }
  const ttftMs = Math.max(0, Number(ss.ttftMs || totals.ttftMs || Math.round(sumTtftSec * 1000) || 0));
  const genMs = Math.max(0, Number(ss.streamingMs || totals.streamingMs || Math.round(sumStreamSec * 1000) || 0));
  const toolsMs = Math.max(0, Number(ss.toolMs || 0));
  const calls = Math.max(0, Number(summary?.invocationCount || invocations.length || 0));
  const toolCalls = Math.max(0, Number(ss.totalToolCalls || 0));
  const wallMs = Math.max(1, ttftMs + genMs + toolsMs, Number(ss.llmMs || 0));

  const toolsMap = {};
  const toolCounts = Array.isArray(analytics?.activitySummary?.toolCounts) ? analytics.activitySummary.toolCounts : [];
  const totalCallsSum = toolCounts.reduce((a, b) => a + (b.count || 0), 0);
  for (const tc of toolCounts) {
    if (!tc?.name) continue;
    const shareMs = totalCallsSum > 0 ? Math.round((tc.count / totalCallsSum) * toolsMs) : 0;
    toolsMap[tc.name] = { calls: Math.max(0, Number(tc.count || 0)), ms: shareMs };
  }

  // Respect tpsMode ('decode' vs 'e2e') so dsh-context Timing card TPS stays synced with Composer pill!
  const isE2e = cfg?.tpsMode === 'e2e';
  const decodeTps = Number(totals.avgTps || 0);
  const e2eTps = Number(totals.avgE2eTps || 0);

  const speedTokens = Math.max(0, Number(totals.outputTokens || 0));
  let speedMs = 0;
  if (isE2e) {
    speedMs = e2eTps > 0 && speedTokens > 0
      ? Math.max(1, Math.round((speedTokens / e2eTps) * 1000))
      : Math.max(1, ttftMs + genMs);
  } else {
    speedMs = decodeTps > 0 && speedTokens > 0
      ? Math.max(1, Math.round((speedTokens / decodeTps) * 1000))
      : Math.max(1, genMs);
  }

  const timing = {
    wallMs,
    ttftMs,
    genMs,
    calls,
    toolsMs,
    toolCalls,
    tools: toolsMap,
    reasoningMs: Math.round(genMs * ((totals.thinkingTokens || 0) / Math.max(1, totals.outputTokens || 1))),
    textMs: Math.round(genMs * ((totals.responseOutputTokens || 0) / Math.max(1, totals.outputTokens || 1))),
    speedTokens,
    speedMs
  };

  // Build spans for the horizontal timeline strip
  const spans = [];
  let cursor = baseMs - wallMs;
  if (invocations.length > 0) {
    const perToolMs = invocations.length > 0 ? Math.round(toolsMs / invocations.length) : 0;
    for (const inv of invocations) {
      const tMs = Math.max(0, Math.round((inv.ttftSeconds || 0) * 1000));
      const gMs = Math.max(0, Math.round((inv.streamingSeconds || 0) * 1000));
      if (tMs > 0) {
        spans.push({ kind: 'ttft', start: cursor, end: cursor + tMs });
        cursor += tMs;
      }
      if (gMs > 0) {
        const thinkShare = inv.outputTokens > 0 ? (inv.thinkingOutputTokens || 0) / inv.outputTokens : 0;
        const rMs = Math.round(gMs * thinkShare);
        const txtMs = Math.max(0, gMs - rMs);
        if (rMs > 0) {
          spans.push({ kind: 'reasoning', start: cursor, end: cursor + rMs });
          cursor += rMs;
        }
        if (txtMs > 0) {
          spans.push({ kind: 'text', start: cursor, end: cursor + txtMs });
          cursor += txtMs;
        }
      }
      if (perToolMs > 0) {
        spans.push({ kind: 'tools', start: cursor, end: cursor + perToolMs });
        cursor += perToolMs;
      }
    }
  } else if (wallMs > 0) {
    if (ttftMs > 0) spans.push({ kind: 'ttft', start: cursor, end: cursor + ttftMs });
    if (genMs > 0) spans.push({ kind: 'text', start: cursor + ttftMs, end: cursor + ttftMs + genMs });
    if (toolsMs > 0) spans.push({ kind: 'tools', start: cursor + ttftMs + genMs, end: cursor + wallMs });
  }

  return { timing, spans };
}

const headSnapshotCache = new Map();
const HEAD_SNAPSHOT_CACHE_MAX = 24;

export function buildDshHeadSnapshot(conversationId, cfg = getPluginConfig(), summary = null, analytics = null) {
  if (!conversationId) return null;
  const sum = summary || getConversationModelsFromDb(conversationId);
  if (!sum) return null;
  const an = analytics || getSessionTranscriptAnalytics(conversationId, sum, { includeBrowser: true });
  const tpsMode = cfg?.tpsMode || 'decode';
  const useCache = analytics === null;
  if (useCache) {
    const cached = headSnapshotCache.get(conversationId);
    if (cached && cached.sumRef === sum && cached.anRef === an && cached.tpsMode === tpsMode) {
      headSnapshotCache.delete(conversationId);
      headSnapshotCache.set(conversationId, cached);
      return cached.result;
    }
  }
  const lm = sum.latestModel || null;
  const tot = sum.totals || {};
  const baseMs = toMs(sum.updatedAtMs, Date.now());
  const activeModel = normalizeModelId(lm);

  const built = buildDshNodesAndRequests(sum, an, baseMs);
  const { cost, costRead } = buildDshCostAndFaces(sum.invocations, activeModel, baseMs);
  const { timing, spans } = buildDshTimingAndSpans(sum, an, cfg, baseMs);

  const buckets = Array.isArray(an?.composition?.buckets) ? an.composition.buckets : [];
  const bMap = Object.fromEntries(buckets.map(b => [b.key, Math.max(0, Number(b.tokens || 0))]));
  const totalEstCtx = (bMap.system || 0) + (bMap.tools || 0) + (bMap.user || 0) +
    (bMap.inject || 0) + (bMap.skill || 0) + (bMap.assistant || 0) + (bMap.tool || 0);

  const toolTally = {};
  for (const tc of (an?.activitySummary?.toolCounts || [])) {
    if (tc?.name && tc.count > 0) toolTally[tc.name] = tc.count;
  }
  const programTally = {};
  for (const pg of (an?.activitySummary?.programTally || [])) {
    if (pg?.name && pg.calls > 0) programTally[pg.name] = pg.calls;
  }

  const cmdStats = an?.activitySummary?.commandStats || {};
  const ss = an?.sessionStats || {};
  const compCount = built.events.filter(e => e.kind === 'compaction').length;
  const pruneCount = built.events.filter(e => e.kind === 'prune').length;
  const injectCount = built.events.filter(e => e.kind === 'inject').length;

  const firstUserNode = built.nodes.find(n => n.cat === 'user');
  const lastUserNode = [...built.nodes].reverse().find(n => n.cat === 'user');
  const lastReq = built.requests.length > 0 ? built.requests[built.requests.length - 1] : null;
  const contextWindow = Math.max(32768, Number(lm?.maxContextTokens || an?.composition?.maxTokens || 1048576));

  const asstTotal = bMap.assistant || 0;
  const splitDenom = Math.max(1, built.cumReasoning + built.cumAnswer + built.cumCall);

  const head = {
    ok: true,
    provider: estimateInvocationCost(activeModel, 0, 0, 0, { atMs: baseMs }).rate?.provider || 'google',
    model: activeModel,
    contextWindow,
    maxOutputTokens: Number(an?.composition?.reserve?.outputTokens || 65536),
    current: {
      system: bMap.system || 0,
      tools: bMap.tools || 0,
      user: bMap.user || 0,
      inject: bMap.inject || 0,
      skill: bMap.skill || 0,
      assistant: asstTotal,
      assistantReasoning: Math.round(asstTotal * (built.cumReasoning / splitDenom)),
      assistantAnswerTokens: Math.round(asstTotal * (built.cumAnswer / splitDenom)),
      assistantCallTokens: Math.round(asstTotal * (built.cumCall / splitDenom)),
      tool: bMap.tool || 0,
      total: totalEstCtx
    },
    systems: built.sysTokens > 0 ? [{ seq: 0, time: baseMs - timing.wallMs, tokens: built.sysTokens }] : [],
    requests: built.requests,
    events: built.events,
    nodes: built.nodes,
    droppedNodes: 0,
    archive: [],
    fileOps: built.fileOps,
    commands: built.commands,
    commandStats: {
      runs: Number(cmdStats.runs || built.commands.length || 0),
      failed: Number(cmdStats.failed || 0),
      ms: Number(cmdStats.totalMs || 0),
      bg: Number(cmdStats.background || 0)
    },
    spans,
    images: 0,
    generatedReasoning: Number(tot.thinkingTokens || 0),
    generatedAnswerTokens: Number(tot.responseOutputTokens || 0),
    generatedCallTokens: 0,
    toolCalls: Number(ss.totalToolCalls || 0),
    ...(Object.keys(toolTally).length > 0 ? { toolTally } : {}),
    ...(Object.keys(programTally).length > 0 ? { programTally } : {}),
    humanInputs: Number(ss.turns || 1),
    answers: Number(ss.answers || 1),
    ...(lastUserNode?.text ? { lastUser: String(lastUserNode.text).slice(0, 200) } : {}),
    counts: {
      turns: Number(ss.turns || 1),
      steps: Number(ss.steps || built.requests.length || 1),
      injects: injectCount,
      compactions: compCount,
      prunes: pruneCount,
      skills: Number(ss.skillLoadCount || 0)
    },
    ...(lastReq ? { last: { seq: lastReq.seq, total: lastReq.total, ...(lastReq.prompt !== undefined ? { prompt: lastReq.prompt } : {}) } } : {}),
    cost,
    costRead,
    timing
  };

  const toolDefinitions = built.toolsItem?.declarations || [];
  const headerToolNames = toolDefinitions.map(tool => tool.name);
  const totalToolsBudget = Math.max(headerToolNames.length * 180, built.toolsTokens || 0);
  const perToolTok = Math.max(120, Math.round(totalToolsBudget / Math.max(1, headerToolNames.length)));
  const headerTools = headerToolNames.map((name, idx) => ({
    name,
    tokens: idx === 0
      ? Math.max(120, totalToolsBudget - perToolTok * Math.max(0, headerToolNames.length - 1))
      : perToolTok
  }));
  const headerStartMs = Math.max(0, baseMs - timing.wallMs);

  const result = {
    head,
    summary: sum,
    analytics: an,
    commandDetailsBySeq: built.commandDetailsBySeq,
    browserItemBySeq: built.browserItemBySeq,
    systemItem: built.systemItem,
    toolsItem: built.toolsItem,
    headerTools,
    toolDefinitions,
    headerStartMs,
    firstUserPrompt: firstUserNode?.text || ''
  };
  if (useCache) {
    if (headSnapshotCache.has(conversationId)) headSnapshotCache.delete(conversationId);
    while (headSnapshotCache.size >= HEAD_SNAPSHOT_CACHE_MAX) {
      headSnapshotCache.delete(headSnapshotCache.keys().next().value);
    }
    headSnapshotCache.set(conversationId, { sumRef: sum, anRef: an, tpsMode, result });
  }
  return result;
}

export function buildDshBootstrap(conversationId, cfg = getPluginConfig(), preloadedRecent = null) {
  const recent = Array.isArray(preloadedRecent) ? preloadedRecent : listRecentConversations(100);
  const targetId = conversationId || recent[0]?.conversationId || '';
  const inflight = targetId ? readInflightState(targetId) : null;
  const built = targetId ? buildDshHeadSnapshot(targetId, cfg) : null;
  const sum = built?.summary || (targetId ? getConversationModelsFromDb(targetId) : null);
  const fleet = targetId ? getFleetHierarchy(targetId) : { rootId: '', currentId: '', nodes: [], delegations: [], comms: [], recentMultiAgentSessions: [] };

  const byId = {};
  const registerSession = (cid, info = {}) => {
    if (!cid || byId[cid]) return;
    const isCurrent = cid === targetId;
    const nodeSummary = info.summary || (isCurrent ? sum : null);
    const lm = nodeSummary?.latestModel || info.lm || null;
    const tot = nodeSummary?.totals || {};
    const nodeHead = isCurrent && built?.head ? built.head : null;
    const activeCtx = nodeHead?.current?.total || info.contextUsed || lm?.estimatedContextTokens || ((lm?.inputTokens || 0) + (lm?.cacheReadTokens || 0));
    const maxCtx = nodeHead?.contextWindow || info.contextMax || lm?.maxContextTokens || 1048576;
    const sysTok = nodeHead?.current?.system || Math.round(activeCtx * 0.12);
    const toolsTok = nodeHead?.current?.tools || Math.round(activeCtx * 0.18);
    const nodeHeaderTools = isCurrent && built?.headerTools?.length
      ? built.headerTools
      : [];
    const nodeStartMs = isCurrent && built?.headerStartMs
      ? built.headerStartMs
      : toMs(nodeSummary?.createdAtMs, Math.max(1, toMs(info.updatedAtMs || nodeSummary?.updatedAtMs, Date.now()) - 60000));

    byId[cid] = {
      id: cid,
      title: info.title || nodeSummary?.title || cid.slice(0, 8),
      displayTitle: info.title || nodeSummary?.title || cid.slice(0, 8),
      cwd: info.cwd || nodeSummary?.cwd || 'f:\\AI\\Gemini-Play',
      updatedAt: toMs(info.updatedAtMs || nodeSummary?.updatedAtMs, Date.now()),
      running: Boolean(isCurrent && inflight && !inflight.completed) || String(info.status || '').toUpperCase().includes('RUNNING'),
      blank: false,
      ...(info.parentConversationId ? { parentId: info.parentConversationId, origin: 'subagent' } : {}),
      projectionValues: {
        ...(nodeHead ? { contextTimeline: nodeHead } : {}),
        contextHeaders: {
          headers: [{
            seq: 1,
            time: nodeStartMs,
            systemTokens: sysTok,
            tools: nodeHeaderTools
          }]
        },
        contextPressure: {
          pressureTokens: activeCtx,
          projectedTokens: activeCtx,
          contextWindow: maxCtx
        },
        contextBreakdown: {
          systemTokens: sysTok,
          toolsTokens: toolsTok,
          messageTokens: nodeHead ? Math.max(0, nodeHead.current.total - nodeHead.current.system - nodeHead.current.tools) : Math.round(activeCtx * 0.70)
        },
        tokenUsage: {
          uncachedInputTokens: Number(info.inputTokens ?? tot.inputTokens ?? 0),
          outputTokens: Number(info.outputTokens ?? tot.outputTokens ?? 0),
          cacheReadTokens: Number(info.cacheReadTokens ?? tot.cacheReadTokens ?? 0),
          cacheWriteTokens: 0
        },
        ...(info.parentConversationId ? {
          subagent: {
            mode: 'one-shot',
            label: info.role || info.title || cid.slice(0, 8)
          }
        } : {})
      }
    };
  };

  for (const fn of (fleet.nodes || [])) {
    registerSession(fn.conversationId, fn);
  }
  if (targetId && !byId[targetId]) {
    registerSession(targetId, { summary: sum });
  }
  for (const rc of recent) {
    registerSession(rc.conversationId, {
      title: rc.title,
      cwd: rc.cwd || '',
      updatedAtMs: rc.updatedAtMs,
      parentConversationId: rc.parentConversationId || '',
      summary: {
        latestModel: rc.latestModel,
        totals: rc.totals,
        title: rc.title,
        cwd: rc.cwd || '',
        createdAtMs: rc.createdAtMs,
        updatedAtMs: rc.updatedAtMs
      }
    });
  }

  const fleetUsage = built?.analytics?.fleetUsage || null;
  const headNodes = built?.head?.nodes || [];
  const lastSeq = headNodes.length > 0 ? headNodes[headNodes.length - 1].seq : 0;
  const revision = [
    targetId,
    sum?.invocationCount || 0,
    sum?.updatedAtMs || 0,
    lastSeq,
    fleetUsage?.subagentCount || 0,
    fleetUsage?.team?.totalTokens || 0,
    inflight && !inflight.completed ? `run:${inflight.startedAtMs || 0}` : 'idle',
    cfg?.tpsMode || 'decode',
    cfg?.badgeMode || 'on_reply',
    recent.length
  ].join(':');

  return {
    revision,
    targetId,
    config: cfg,
    inflight,
    summary: sum ? { ...sum, invocations: undefined } : null,
    head: built?.head || null,
    fleet,
    fleetUsage,
    byId,
    recent: recent.map(r => ({
      conversationId: r.conversationId,
      title: r.title,
      updatedAt: r.updatedAt,
      updatedAtMs: r.updatedAtMs,
      invocationCount: r.invocationCount,
      actualModel: r.latestModel?.actualModelLabel || 'N/A',
      responseModel: r.latestModel?.responseModel || 'N/A',
      avgTps: r.totals?.avgTps || 0,
      avgE2eTps: r.totals?.avgE2eTps || 0,
      totalSessionTokens: r.totals?.totalSessionTokens || 0
    }))
  };
}

export function handleDshDetail(body = {}, cfg = getPluginConfig()) {
  const sid = String(body.sessionId || '');
  const built = buildDshHeadSnapshot(sid, cfg);
  if (!built) {
    return body.head ? { head: null } : { rev: 1, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] };
  }
  if (body.head) {
    return { head: built.head };
  }
  const h = built.head;
  return {
    rev: Math.max(1, h.requests.length),
    head: h,
    requests: h.requests,
    events: h.events,
    nodes: h.nodes,
    droppedNodes: 0,
    archive: [],
    fileOps: h.fileOps,
    commands: h.commands,
    commandStats: h.commandStats,
    spans: h.spans
  };
}

export function handleDshHeads(body = {}, cfg = getPluginConfig()) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const out = {};
  for (const id of ids.slice(0, 64)) {
    if (!id) continue;
    const built = buildDshHeadSnapshot(String(id), cfg);
    out[id] = { head: built?.head || null };
  }
  return out;
}

export function handleDshCommands(body = {}, cfg = getPluginConfig()) {
  const sid = String(body.sessionId || '');
  const beforeSeq = typeof body.beforeSeq === 'number' ? body.beforeSeq : Infinity;
  const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : 200;
  const built = buildDshHeadSnapshot(sid, cfg);
  const allCmds = built?.head?.commands || [];
  const filtered = allCmds.filter(c => c.seq < beforeSeq);
  const slice = filtered.slice(-limit);
  return {
    commands: slice,
    atStart: filtered.length <= limit,
    total: allCmds.length
  };
}

function buildFleetAgentDetail(targetId, allFleet, cfg) {
  const node = (allFleet.nodes || []).find(n => n.conversationId === targetId);
  const messages = [];
  let seq = 1;
  for (const c of (allFleet.comms || [])) {
    if (c.to === targetId || c.from === targetId) {
      messages.push({
        seq: seq++,
        time: toMs(c.time, Date.now()),
        kind: c.kind === 'settled' ? 'settled' : 'relay',
        from: c.from || undefined,
        text: String(c.text || '').slice(0, 1200)
      });
    }
  }
  const delegations = [];
  let dSeq = 1;
  for (const d of (allFleet.delegations || [])) {
    if (d.from === targetId) {
      delegations.push({
        seq: dSeq++,
        time: toMs(d.time, Date.now()),
        to: d.to,
        mode: 'one-shot',
        ...(d.role ? { label: String(d.role) } : {})
      });
    }
  }
  const built = buildDshHeadSnapshot(targetId, cfg);
  const lastAssistant = [...(built?.head?.nodes || [])].reverse().find(n => n.cat === 'assistant');
  return {
    ...(node && !node.isRoot ? {
      descriptor: {
        mode: 'one-shot',
        label: node.role || node.title,
        provider: estimateInvocationCost(node.actualModelLabel || node.requestedModel || '', 0, 0, 0).rate?.provider || 'google',
        agentModel: node.actualModelLabel || node.requestedModel || undefined
      }
    } : {}),
    ...(node?.promptBrief || built?.firstUserPrompt ? { initialPrompt: (node?.promptBrief || built?.firstUserPrompt || '').slice(0, 1200) } : {}),
    ...(lastAssistant?.text ? { lastReply: { time: lastAssistant.time, text: String(lastAssistant.text).slice(0, 800) } } : {}),
    delegations,
    messages,
    truncated: false
  };
}

export function handleDshFleet(body = {}, cfg = getPluginConfig()) {
  const sid = String(body.sessionId || body.batch?.rootId || '');
  const fleet = sid ? getFleetHierarchy(sid) : { rootId: '', nodes: [], delegations: [], comms: [] };

  if (body.summary) {
    const rootId = fleet.rootId || sid || 'unknown';
    const counts = {};
    const members = (fleet.nodes || []).map(n => {
      counts[n.conversationId] = {
        readAt: Date.now(),
        messagesTotal: (fleet.comms || []).filter(c => c.to === n.conversationId).length,
        delegationsCount: (fleet.delegations || []).filter(d => d.from === n.conversationId).length
      };
      return {
        id: n.conversationId,
        mode: 'one-shot',
        label: n.role || n.title,
        name: n.title,
        description: n.promptBrief || ''
      };
    });
    return {
      rootId,
      rootCreatedAt: Date.now() - 60000,
      detail: buildFleetAgentDetail(rootId, fleet, cfg),
      members,
      familySize: Math.max(1, members.length),
      counts
    };
  }

  if (body.batch && Array.isArray(body.batch.ids)) {
    const rows = {};
    const missing = [];
    for (const id of body.batch.ids) {
      if (!id) continue;
      rows[id] = buildFleetAgentDetail(id, fleet, cfg);
    }
    return {
      rows,
      missing,
      total: Object.keys(rows).length
    };
  }

  return buildFleetAgentDetail(sid, fleet, cfg);
}

function getScopeCutoffMs(scope = {}) {
  const r = scope.range;
  const now = Date.now();
  if (!r || r === 'all') return { start: null, end: null };
  if (typeof r === 'object' && r !== null) {
    return {
      start: typeof r.start === 'number' ? r.start : null,
      end: typeof r.end === 'number' ? r.end : null
    };
  }
  if (r === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { start: d.getTime(), end: null };
  }
  if (r === '7d') return { start: now - 7 * 864e5, end: null };
  if (r === '30d') return { start: now - 30 * 864e5, end: null };
  return { start: null, end: null };
}

function localDayStartMs(dk) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dk || ''));
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

function localDayEndMs(dk) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dk || ''));
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
}

function toLocalDayKeyBridge(ms) {
  const d = new Date(ms || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function handleDshOverview(body = {}, currentCid = '') {
  const insights = getGlobalInsights(0);
  const allSessions = insights.sessions || [];
  const allRootSessions = allSessions.filter(s => !s.isSubagent);
  const scope = body.scope || {};
  const { start, end } = getScopeCutoffMs(scope);
  const cov = scope.coverage || 'all';
  const dayFilter = scope.day || null;
  const query = String(scope.query || '').trim().toLowerCase();
  const groupFilter = scope.group || null;
  const rev = `rev-v2-${insights.globalKpis?.totalTokens || 0}-${allSessions.length}`;

  if (cov === 'archived') {
    const allFiltered = [];
    if (body.part === 'summary') {
      return {
        revision: rev,
        pricingReady: true,
        summary: {
          sessions: 0,
          sessionsTotal: allRootSessions.length,
          sessionsArchived: 0,
          archivedScoped: 0,
          tokens: 0,
          turns: 0,
          costUsd: 0,
          costSessions: 0,
          usageSessions: 0,
          cacheHit: '0.0',
          tokenParts: [],
          timing: null,
          windowTiming: { calls: 0, toolCalls: 0, toolsMs: 0, wallMs: 0 },
          coverage: { complete: true, running: false, remaining: 0, failed: 0, total: 0, covered: 0, unsupported: 0 }
        }
      };
    }
    if (body.part === 'days') return { revision: rev, pricingReady: true, days: [] };
    if (body.part === 'page') return { revision: rev, pricingReady: true, page: { items: allFiltered, index: 0, count: 1, total: 0, scopeTotal: 0, groups: [] } };
    if (body.part === 'tally') return { revision: rev, pricingReady: true, tally: { field: body.tally || 'skills', stats: [] } };
  }

  const hasWindow = start !== null || end !== null || Boolean(dayFilter);
  const inWindow = (tsMs, dk) => {
    if (dayFilter && dk !== dayFilter) return false;
    if (start !== null && tsMs < start) return false;
    if (end !== null && tsMs > end) return false;
    return true;
  };
  const dayKeyOverlapsWindow = (dk) => {
    if (!dk) return !hasWindow;
    if (dayFilter && dk !== dayFilter) return false;
    if (start !== null && localDayEndMs(dk) < start) return false;
    if (end !== null && localDayStartMs(dk) > end) return false;
    return true;
  };

  const matchedSlicesByCid = new Map();
  const windowSessions = [];
  const activeRootIds = new Set();

  for (const s of allSessions) {
    const slices = Array.isArray(s.invSlices) ? s.invSlices : [];
    const matched = hasWindow
      ? slices.filter(sl => inWindow(sl.ts, sl.dk))
      : slices;
    matchedSlicesByCid.set(s.conversationId, matched);
    const isActive = matched.length > 0 || (slices.length === 0 && inWindow(s.updatedAtMs || 0, s.dayKey));
    if (isActive) {
      windowSessions.push(s);
      activeRootIds.add(s.rootConversationId || s.conversationId);
    }
  }

  const scopedHintsCache = new Map();
  const getScopedSessionHints = (s) => {
    const cached = scopedHintsCache.get(s.conversationId);
    if (cached) return cached;
    const matchedSlices = matchedSlicesByCid.get(s.conversationId) || [];
    let maxMatchedSliceTs = 0;
    for (const sl of matchedSlices) {
      if (sl.ts > maxMatchedSliceTs) maxMatchedSliceTs = sl.ts;
    }
    const rawUpdatedTs = toMs(s.updatedAtMs, Date.now());
    const fallbackLastTs = hasWindow
      ? (maxMatchedSliceTs || (dayFilter ? localDayEndMs(dayFilter) : rawUpdatedTs))
      : rawUpdatedTs;

    if (!hasWindow) {
      const fullRes = {
        turns: Math.max(0, Number(s.turns || 0)),
        skills: s.skillCounts || {},
        tools: s.toolCounts || {},
        cmds: s.cmdCounts || {},
        skillLastTs: s.skillLastTs || {},
        toolLastTs: s.toolLastTs || {},
        cmdLastTs: s.cmdLastTs || {},
        fallbackLastTs
      };
      scopedHintsCache.set(s.conversationId, fullRes);
      return fullRes;
    }

    const clampLastMap = (srcMap, countsMap, lastHintDk) => {
      const outMap = {};
      const capFallback = maxMatchedSliceTs || (lastHintDk ? Math.min(rawUpdatedTs, localDayEndMs(lastHintDk)) : fallbackLastTs);
      for (const name of Object.keys(countsMap)) {
        const rawTs = Number(srcMap?.[name] || 0);
        if (rawTs > 0 && inWindow(rawTs, toLocalDayKeyBridge(rawTs))) {
          outMap[name] = rawTs;
        } else {
          outMap[name] = capFallback;
        }
      }
      return outMap;
    };

    const byDay = s.hintsByDay || {};
    const dayKeys = Object.keys(byDay).sort();
    if (dayKeys.length === 0) {
      const emptyOrFallback = dayKeyOverlapsWindow(s.dayKey)
        ? {
            turns: Math.max(0, Number(s.turns || 0)),
            skills: s.skillCounts || {},
            tools: s.toolCounts || {},
            cmds: s.cmdCounts || {},
            skillLastTs: clampLastMap(s.skillLastTs, s.skillCounts || {}, s.dayKey),
            toolLastTs: clampLastMap(s.toolLastTs, s.toolCounts || {}, s.dayKey),
            cmdLastTs: clampLastMap(s.cmdLastTs, s.cmdCounts || {}, s.dayKey),
            fallbackLastTs
          }
        : { turns: 0, skills: {}, tools: {}, cmds: {}, skillLastTs: {}, toolLastTs: {}, cmdLastTs: {}, fallbackLastTs };
      scopedHintsCache.set(s.conversationId, emptyOrFallback);
      return emptyOrFallback;
    }

    let turns = 0;
    const skills = {};
    const tools = {};
    const cmds = {};
    let lastHintDk = '';
    for (const dk of dayKeys) {
      if (!dayKeyOverlapsWindow(dk)) continue;
      const slot = byDay[dk];
      if (!slot) continue;
      if (dk > lastHintDk) lastHintDk = dk;
      turns += Number(slot.turns || 0);
      for (const [k, v] of Object.entries(slot.skills || {})) skills[k] = (skills[k] || 0) + Number(v || 0);
      for (const [k, v] of Object.entries(slot.tools || {})) tools[k] = (tools[k] || 0) + Number(v || 0);
      for (const [k, v] of Object.entries(slot.cmds || {})) cmds[k] = (cmds[k] || 0) + Number(v || 0);
    }

    const res = {
      turns,
      skills,
      tools,
      cmds,
      skillLastTs: clampLastMap(s.skillLastTs, skills, lastHintDk),
      toolLastTs: clampLastMap(s.toolLastTs, tools, lastHintDk),
      cmdLastTs: clampLastMap(s.cmdLastTs, cmds, lastHintDk),
      fallbackLastTs: maxMatchedSliceTs || (lastHintDk ? Math.min(rawUpdatedTs, localDayEndMs(lastHintDk)) : fallbackLastTs)
    };
    scopedHintsCache.set(s.conversationId, res);
    return res;
  };

  let sessions = windowSessions;
  let rootSessions = allRootSessions.filter(s => activeRootIds.has(s.conversationId));

  if (body.pick && typeof body.pick === 'object') {
    const pField = body.pick.field;
    const pVal = String(body.pick.name ?? body.pick.value ?? '').trim();
    if (pVal && (pField === 'skills' || pField === 'tools' || pField === 'cmds')) {
      const pickedRootIds = new Set();
      for (const s of sessions) {
        const sh = getScopedSessionHints(s);
        const countsObj = pField === 'skills' ? sh.skills : pField === 'tools' ? sh.tools : sh.cmds;
        if (Number(countsObj?.[pVal] || 0) > 0) {
          pickedRootIds.add(s.rootConversationId || s.conversationId);
        }
      }
      sessions = sessions.filter(s => pickedRootIds.has(s.rootConversationId || s.conversationId));
      rootSessions = rootSessions.filter(s => pickedRootIds.has(s.conversationId));
    }
  }

  if (body.part === 'summary') {
    let tokIn = 0;
    let tokCache = 0;
    let tokThink = 0;
    let tokOut = 0;
    let turns = 0;
    let costUsd = 0;
    let llmMs = 0;
    let ttftMs = 0;
    let genMs = 0;
    let calls = 0;
    let toolCalls = 0;
    const toolsTimingMap = {};

    for (const s of sessions) {
      const matched = matchedSlicesByCid.get(s.conversationId) || [];
      if (matched.length > 0) {
        for (const sl of matched) {
          tokIn += sl.inTok || 0;
          tokCache += sl.cacheTok || 0;
          tokThink += sl.thinkTok || 0;
          tokOut += sl.outTok || 0;
          costUsd += sl.cost || 0;
          llmMs += sl.llmMs || 0;
          ttftMs += sl.ttftMs || 0;
          genMs += sl.genMs || 0;
          calls += 1;
        }
      } else if ((s.invSlices?.length || 0) === 0) {
        tokIn += s.inputTokens || 0;
        tokCache += s.cacheReadTokens || 0;
        tokThink += s.thinkingTokens || 0;
        tokOut += s.outputTokens || 0;
        costUsd += s.estimatedCostUsd || 0;
        llmMs += s.llmMs || 0;
        ttftMs += s.ttftMs || 0;
        genMs += s.streamingMs || 0;
        calls += s.invocationCount || 0;
      }

      const sh = getScopedSessionHints(s);
      for (const [tName, cnt] of Object.entries(sh.tools || {})) {
        const nCnt = Number(cnt || 0);
        if (nCnt <= 0) continue;
        toolCalls += nCnt;
        if (!toolsTimingMap[tName]) toolsTimingMap[tName] = { calls: 0, ms: 0 };
        toolsTimingMap[tName].calls += nCnt;
        toolsTimingMap[tName].ms += nCnt * 180;
      }
    }
    for (const rs of rootSessions) {
      const sh = getScopedSessionHints(rs);
      turns += Math.max(1, Number(sh.turns || 0));
    }

    const bodyOut = Math.max(0, tokOut - tokThink);
    const totalTokens = tokIn + tokCache + tokOut;
    const billedIn = tokIn + tokCache;
    const cacheHit = billedIn > 0 ? ((tokCache / billedIn) * 100).toFixed(1) : '0.0';

    const toolsMs = toolCalls > 0 ? Math.max(toolCalls * 120, Math.round(llmMs * 0.22)) : 0;
    const effTtftMs = ttftMs > 0 ? ttftMs : Math.round(llmMs * 0.35);
    const effGenMs = genMs > 0 ? genMs : Math.max(1, llmMs - effTtftMs);
    const wallMs = Math.max(1, effTtftMs + effGenMs + toolsMs, llmMs);
    for (const entry of Object.values(toolsTimingMap)) {
      if (toolCalls > 0) entry.ms = Math.round((entry.calls / toolCalls) * toolsMs);
    }

    // Populate all 8 DSH overview token donut buckets proportionally
    const sysPart = Math.round(billedIn * 0.04);
    const toolsDefPart = Math.round(billedIn * 0.09);
    const userPart = Math.round(billedIn * 0.03);
    const injectPart = Math.round(billedIn * 0.05);
    const skillPart = Math.round(billedIn * 0.04);
    const toolResPart = Math.max(0, billedIn - sysPart - toolsDefPart - userPart - injectPart - skillPart);

    const reasoningMs = Math.round(effGenMs * (tokThink / Math.max(1, tokOut)));
    const textMs = Math.max(0, effGenMs - reasoningMs);

    return {
      revision: rev,
      pricingReady: true,
      summary: {
        sessions: rootSessions.length,
        sessionsTotal: allRootSessions.length,
        sessionsArchived: 0,
        archivedScoped: 0,
        tokens: totalTokens,
        turns,
        costUsd: Number(costUsd.toFixed(4)),
        costSessions: rootSessions.length,
        usageSessions: rootSessions.length,
        cacheHit,
        tokenParts: [
          { key: 'system', value: sysPart },
          { key: 'tools', value: toolsDefPart },
          { key: 'user', value: userPart },
          { key: 'inject', value: injectPart },
          { key: 'skill', value: skillPart },
          { key: 'toolCalls', value: toolResPart },
          { key: 'thinking', value: tokThink },
          { key: 'answers', value: bodyOut }
        ],
        timing: {
          wallMs,
          ttftMs: effTtftMs,
          genMs: effGenMs,
          reasoningMs,
          textMs,
          calls,
          toolsMs,
          toolBusyMs: toolsMs,
          toolCalls,
          speedMs: effGenMs,
          speedTokens: bodyOut,
          tools: toolsTimingMap
        },
        windowTiming: {
          calls,
          toolCalls,
          toolsMs,
          wallMs
        },
        coverage: {
          complete: true,
          running: false,
          remaining: 0,
          failed: 0,
          total: rootSessions.length,
          covered: rootSessions.length,
          unsupported: 0
        }
      }
    };
  }

  if (body.part === 'days') {
    const days = (insights.allDays || insights.heatmap56d || []).map(d => ({
      key: d.dayKey || d.date,
      tokens: Number(d.totalTokens ?? d.tokens ?? 0),
      sessions: Number(d.sessions || 0),
      costUsd: d.costUsd != null ? Number(d.costUsd) : null
    }));
    return { revision: rev, pricingReady: true, days };
  }

  if (body.part === 'page') {
    const preGroupList = query
      ? rootSessions.filter(s =>
          String(s.title || '').toLowerCase().includes(query) ||
          String(s.cwd || '').toLowerCase().includes(query) ||
          String(s.group || '').toLowerCase().includes(query) ||
          String(s.lastUserPreview || '').toLowerCase().includes(query) ||
          String(s.responseModel || '').toLowerCase().includes(query)
        )
      : [...rootSessions];

    const scopeTotal = preGroupList.length;
    const groupCounts = new Map();
    for (const s of preGroupList) {
      const gKey = s.group || 'Gemini-Play';
      groupCounts.set(gKey, (groupCounts.get(gKey) || 0) + 1);
    }
    const groups = [...groupCounts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ key, count }));

    let list = groupFilter
      ? preGroupList.filter(s => (s.group || 'Gemini-Play') === groupFilter)
      : preGroupList;

    const sort = body.sort || 'recent';
    if (sort === 'tokens') list.sort((a, b) => (b.teamTotalTokens ?? b.totalTokens ?? 0) - (a.teamTotalTokens ?? a.totalTokens ?? 0));
    else if (sort === 'context') list.sort((a, b) => (b.contextUsed || 0) - (a.contextUsed || 0));
    else list.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));

    const pageSize = 12;
    const total = list.length;
    const count = Math.max(1, Math.ceil(total / pageSize));
    const idx = Math.max(0, Math.min(count - 1, Number(body.page || 0)));
    const pageRows = list.slice(idx * pageSize, (idx + 1) * pageSize);

    const items = pageRows.map(s => {
      const thinkTok = s.thinkingTokens || 0;
      const bodyTok = Math.max(0, (s.outputTokens || 0) - thinkTok);
      const ctxMax = s.contextMax || 1048576;
      const ctxTotal = Math.max(0, s.contextUsed || Math.min(s.totalTokens || 0, ctxMax));
      const pSys = Math.round(ctxTotal * 0.10);
      const pTools = Math.round(ctxTotal * 0.14);
      const pUser = Math.round(ctxTotal * 0.08);
      const pInject = Math.round(ctxTotal * 0.06);
      const pSkill = (s.skills && s.skills.length > 0) ? Math.round(ctxTotal * 0.07) : 0;
      const pAsst = Math.max(0, Math.min(Math.round(ctxTotal * 0.30), thinkTok + bodyTok || Math.round(ctxTotal * 0.25)));
      const pTool = Math.max(0, ctxTotal - pSys - pTools - pUser - pInject - pSkill - pAsst);
      return {
        id: s.conversationId,
        title: s.title || s.conversationId.slice(0, 8),
        cwd: s.cwd || 'f:\\AI\\Gemini-Play',
        group: s.group || 'Gemini-Play',
        updatedAt: toMs(s.updatedAtMs, Date.now()),
        running: false,
        archived: false,
        tokens: s.teamTotalTokens ?? s.totalTokens ?? 0,
        turns: Math.max(1, s.turns || 1),
        steps: s.steps || s.invocationCount || 0,
        parts: [
          { key: 'system', value: pSys },
          { key: 'tools', value: pTools },
          { key: 'user', value: pUser },
          ...(pInject > 0 ? [{ key: 'inject', value: pInject }] : []),
          ...(pSkill > 0 ? [{ key: 'skill', value: pSkill }] : []),
          { key: 'assistant', value: pAsst },
          { key: 'tool', value: pTool }
        ],
        total: ctxTotal,
        contextWindow: ctxMax,
        model: s.responseModel || s.primaryModel || 'gemini',
        ...(s.lastUserPreview ? { lastUser: String(s.lastUserPreview).slice(0, 200) } : {}),
        costUsd: s.teamEstimatedCostUsd ?? s.estimatedCostUsd ?? 0,
        createdDay: s.createdDay || s.dayKey || undefined
      };
    });

    return {
      revision: rev,
      pricingReady: true,
      page: {
        items,
        index: idx,
        count,
        total,
        scopeTotal,
        groups
      }
    };
  }

  if (body.part === 'tally') {
    const field = ['skills', 'tools', 'cmds'].includes(body.tally) ? body.tally : 'skills';
    const map = new Map();
    for (const s of sessions) {
      const sh = getScopedSessionHints(s);
      const countsObj = field === 'skills' ? sh.skills : field === 'tools' ? sh.tools : sh.cmds;
      const lastMap = field === 'skills' ? sh.skillLastTs : field === 'tools' ? sh.toolLastTs : sh.cmdLastTs;
      const rootId = s.rootConversationId || s.conversationId;
      const fallbackTs = sh.fallbackLastTs || toMs(s.updatedAtMs, Date.now());
      if (countsObj && typeof countsObj === 'object') {
        for (const [rawName, rawCnt] of Object.entries(countsObj)) {
          const name = String(rawName || '').trim();
          const cnt = Number(rawCnt || 0);
          if (!name || cnt <= 0) continue;
          const ts = Math.max(0, Number(lastMap?.[name] || 0)) || fallbackTs;
          let entry = map.get(name);
          if (!entry) {
            entry = { name, n: 0, sessions: 0, last: 0, _roots: new Set() };
            map.set(name, entry);
          }
          entry.n += cnt;
          if (!entry._roots.has(rootId)) {
            entry._roots.add(rootId);
            entry.sessions += 1;
          }
          if (ts > entry.last) entry.last = ts;
        }
      }
    }
    const stats = [...map.values()]
      .map(({ _roots, ...rest }) => rest)
      .sort((a, b) => (b.n - a.n) || (b.last - a.last));
    return {
      revision: rev,
      pricingReady: true,
      tally: { field, stats }
    };
  }

  return { revision: rev, pricingReady: true };
}

export function handleDshSkills() {
  const skills = [];
  const roots = [
    { dir: path.join(CONFIG_ROOT, 'skills'), source: 'user-dsh' },
    { dir: path.join(os.homedir(), '.gemini', 'antigravity', 'builtin', 'skills'), source: 'bundled' }
  ];
  for (const r of roots) {
    if (!fs.existsSync(r.dir)) continue;
    try {
      for (const ent of fs.readdirSync(r.dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const smPath = path.join(r.dir, ent.name, 'SKILL.md');
        if (!fs.existsSync(smPath)) continue;
        let desc = '';
        try {
          const raw = fs.readFileSync(smPath, 'utf8').slice(0, 1200);
          const m = raw.match(/description:\s*(.+)/);
          if (m?.[1]) desc = m[1].trim().replace(/^['"]|['"]$/g, '');
        } catch {}
        skills.push({ name: ent.name, description: desc, path: smPath, source: r.source });
      }
    } catch {}
  }
  return { skills };
}

export function handleDshPage(body = {}, cfg = getPluginConfig()) {
  const addr = body.address;
  const sid = typeof addr === 'string'
    ? addr
    : (addr?.childSessionId || addr?.sessionId || '');
  const throughSeq = typeof body.throughSeq === 'number' ? body.throughSeq : null;
  const built = sid ? buildDshHeadSnapshot(sid, cfg) : null;
  if (!built) return { records: [] };

  const records = [];
  if (throughSeq === 0) {
    const sysText = built.systemItem?.previewText
      || `Antigravity 系统提示词与规则底座（≈ ${built.head?.current?.system || 0} tokens）`;
    records.push({
      seq: 0,
      type: 'system/message',
      data: { message: { content: [{ type: 'text', text: sysText }] } }
    });
    return { records };
  }

  if (throughSeq === 1) {
    const toolEntries = (built.toolDefinitions || []).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchemaString ? JSON.parse(tool.jsonSchemaString) : {},
      ...(tool.responseJsonSchemaString ? {responseSchema: JSON.parse(tool.responseJsonSchemaString)} : {})
    }));
    records.push({
      seq: 1,
      type: 'request/header',
      data: { header: { tools: toolEntries } }
    });
    return { records };
  }

  if (throughSeq !== null && built.commandDetailsBySeq[throughSeq]) {
    records.push({ seq: throughSeq, event: { type: 'tool/result', seq: throughSeq, data: { message: built.commandDetailsBySeq[throughSeq] } } });
    return { records };
  }

  const itemMap = built.browserItemBySeq || {};
  for (const n of (built.head?.nodes || [])) {
    if (throughSeq !== null && n.seq !== throughSeq) continue;
    const rich = itemMap[n.seq] || null;
    const fullText = rich?.previewText || n.text || '';
    if (n.cat === 'user' || n.cat === 'inject') {
      records.push({ seq: n.seq, type: 'user/message', data: { content: [{ type: 'text', text: fullText }] } });
    } else if (n.cat === 'assistant') {
      const content = [];
      if (rich?.thinkingText) content.push({ type: 'reasoning', text: rich.thinkingText });
      if (fullText) content.push({ type: 'text', text: fullText });
      let parsedCalls = [];
      if (rich?.toolCallsJson) {
        try {
          const arr = JSON.parse(rich.toolCallsJson);
          if (Array.isArray(arr)) parsedCalls = arr;
        } catch {}
      }
      if (parsedCalls.length > 0) {
        for (const pc of parsedCalls) {
          content.push({
            type: 'tool-call',
            name: pc?.name || 'tool',
            arguments: typeof pc?.args === 'string' ? pc.args : JSON.stringify(pc?.args || {}, null, 2)
          });
        }
      } else {
        for (const c of (n.calls || [])) content.push({ type: 'tool-call', name: c, arguments: '{}' });
      }
      records.push({ seq: n.seq, type: 'assistant/message', data: { message: { content } } });
    } else if (n.cat === 'tool' || n.cat === 'skill') {
      const tName = n.tool || (rich?.toolNames?.[0]) || (n.skill ? `skill:${n.skill}` : 'tool');
      const callId = `c-${n.seq}`;
      records.push({
        seq: n.seq,
        type: 'tool/call',
        data: {
          callId,
          name: tName,
          arguments: rich?.toolCallsJson || '{}'
        }
      });
      records.push({
        seq: n.seq,
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId },
            content: [{ type: 'text', text: fullText }],
            isError: Boolean(n.err)
          }
        }
      });
    }
  }
  return { records };
}
