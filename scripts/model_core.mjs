import {readVarint, parseProtoFields} from './protobuf.mjs';
export {readVarint, parseProtoFields} from './protobuf.mjs';
import { getPromptSources, getPromptSourcesRevision, syncPromptRules } from './prompt_profiles.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
export const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR
  ? path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR)
  : path.join(USER_HOME, '.gemini', 'antigravity');
export const CONVERSATIONS_DIR = path.join(APP_DATA_DIR, 'conversations');
export const SUMMARIES_DB_PATH = path.join(APP_DATA_DIR, 'conversation_summaries.db');
export const STATE_PBTXT_PATH = path.join(APP_DATA_DIR, 'antigravity_state.pbtxt');
export const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');
export const PLUGIN_DATA_DIR = path.join(APP_DATA_DIR, 'plugin_data', 'agy-model-inspector');
export const INFLIGHT_DIR = path.join(PLUGIN_DATA_DIR, 'inflight');
export const CONFIG_FILE = path.join(PLUGIN_DATA_DIR, 'config.json');
export const ENDPOINT_FILE = path.join(PLUGIN_DATA_DIR, 'ls_endpoint.json');
export const HISTORY_FILE = path.join(PLUGIN_DATA_DIR, 'history.jsonl');
export const BADGE_PORT = 18922;

export function ensurePluginDataDir() {
  try {
    fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  } catch {}
}

export function getPluginConfig() {
  ensurePluginDataDir();
  const defaults = {
    tpsMode: 'decode', // 'decode' (post-TTFT pure decode) | 'e2e' (includes TTFT: outputTokens / (ttft + stream))
    showTokenDetails: true,
    showTTFT: true,
    showInternalEnum: true
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...defaults, ...parsed };
    }
  } catch {}
  return defaults;
}

export function savePluginConfig(partial) {
  const merged = { ...getPluginConfig(), ...partial };
  ensurePluginDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function saveLsEndpoint(lsAddress, csrfToken, sidecarPort = null) {
  if (!lsAddress || !csrfToken) return;
  ensurePluginDataDir();
  try {
    fs.writeFileSync(
      ENDPOINT_FILE,
      JSON.stringify({
        lsAddress,
        csrfToken,
        sidecarPort,
        updatedAt: new Date().toISOString()
      }, null, 2),
      'utf8'
    );
  } catch {}
}

export function loadLsEndpoint() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN
    };
  }
  try {
    if (fs.existsSync(ENDPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

export function readLastSelectedAgentModelEnum() {
  try {
    if (fs.existsSync(STATE_PBTXT_PATH)) {
      const txt = fs.readFileSync(STATE_PBTXT_PATH, 'utf8');
      const m = txt.match(/last_selected_agent_model:\s*([A-Za-z0-9_.-]+)/);
      if (m?.[1]) return m[1].trim();
    }
  } catch {}
  return '';
}

// --- Pure JS Protobuf Wire Decoder for GeneratorMetadata ---

function decodeDurationSeconds(buf) {
  let seconds = 0;
  let nanos = 0;
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNo === 1 && f.wireType === 0) seconds = Number(BigInt.asIntN(64, f.value));
    if (f.fieldNo === 2 && f.wireType === 0) nanos = Number(BigInt.asIntN(32, f.value));
  }
  return seconds + nanos / 1e9;
}

const API_PROVIDERS = {
  0: 'UNSPECIFIED',
  24: 'API_PROVIDER_GOOGLE_GEMINI',
  25: 'API_PROVIDER_VERTEX_GEMINI',
  26: 'API_PROVIDER_ANTHROPIC'
};

export function decodeGeneratorMetadataBlob(rawBuf, rowIdx = 0) {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  const topFields = parseProtoFields(buf);

  const stepIndices = [];
  let executionId = '';
  let chatModelBuf = null;
  let cascadeConfigBuf = null;

  for (const f of topFields) {
    if (f.fieldNo === 1 && f.wireType === 2) {
      chatModelBuf = f.value;
    } else if (f.fieldNo === 2) {
      if (f.wireType === 0) {
        stepIndices.push(Number(f.value));
      } else if (f.wireType === 2) {
        let p = 0;
        while (p < f.value.length) {
          const v = readVarint(f.value, p);
          stepIndices.push(Number(v.value));
          p = v.nextOffset;
        }
      }
    } else if (f.fieldNo === 3 && f.wireType === 2) {
      cascadeConfigBuf = f.value;
    } else if (f.fieldNo === 4 && f.wireType === 2) {
      executionId = f.value.toString('utf8');
    }
  }

  // Extract exact upstream generation model ID from CascadeConfig (f3.f28),
  // matching Antigravity's /v1internal:fetchAvailableModels & streamGenerateContent request `model`
  // (e.g. `gemini-4-carbon-medium`, `gemini-3.8-flash-high`, `claude-opus-5-5-medium`).
  let sentModel = '';
  if (cascadeConfigBuf) {
    for (const cfgField of parseProtoFields(cascadeConfigBuf)) {
      if (cfgField.fieldNo === 28 && cfgField.wireType === 2) {
        const s = cfgField.value.toString('utf8').trim();
        if (s) sentModel = s;
      }
    }
  }

  const info = {
    idx: rowIdx,
    stepIndices,
    executionId,
    sentModel,
    responseModel: '',
    responseModelFull: '',
    modelDisplayName: '',
    modelEnum: '',
    modelIdNumeric: 0,
    apiProvider: '',
    inputTokens: 0,
    outputTokens: 0,
    thinkingOutputTokens: 0,
    responseOutputTokens: 0,
    cacheReadTokens: 0,
    estimatedContextTokens: 0,
    maxContextTokens: 0,
    ttftSeconds: 0,
    streamingSeconds: 0,
    messageId: '',
    responseId: '',
    traceId: '',
    requestId: '',
    lastStepIndex: -1,
    usedClaude: false,
    usedNonGeminiModel: false,
    customMetadata: {}
  };

  if (!chatModelBuf) return info;

  for (const cf of parseProtoFields(chatModelBuf)) {
    if (cf.fieldNo === 3 && cf.wireType === 0) {
      info.modelIdNumeric = Number(cf.value);
    } else if (cf.fieldNo === 4 && cf.wireType === 2) {
      // usage submessage
      for (const uf of parseProtoFields(cf.value)) {
        if (uf.fieldNo === 2 && uf.wireType === 0) info.inputTokens = Number(uf.value);
        if (uf.fieldNo === 3 && uf.wireType === 0) info.outputTokens = Number(uf.value);
        if (uf.fieldNo === 5 && uf.wireType === 0) info.cacheReadTokens = Number(uf.value);
        if (uf.fieldNo === 6 && uf.wireType === 0) {
          const pNum = Number(uf.value);
          info.apiProvider = API_PROVIDERS[pNum] || `API_PROVIDER_${pNum}`;
        }
        if (uf.fieldNo === 7 && uf.wireType === 2) info.messageId = uf.value.toString('utf8');
        if (uf.fieldNo === 9 && uf.wireType === 0) info.thinkingOutputTokens = Number(uf.value);
        if (uf.fieldNo === 10 && uf.wireType === 0) info.responseOutputTokens = Number(uf.value);
        if (uf.fieldNo === 11 && uf.wireType === 2) info.responseId = uf.value.toString('utf8');
      }
    } else if (cf.fieldNo === 9 && cf.wireType === 2) {
      // chatStartMetadata
      for (const sf of parseProtoFields(cf.value)) {
        if (sf.fieldNo === 10 && sf.wireType === 2) {
          for (const wf of parseProtoFields(sf.value)) {
            if (wf.fieldNo === 1 && wf.wireType === 0) info.estimatedContextTokens = Number(wf.value);
            if (wf.fieldNo === 4 && wf.wireType === 0) info.maxContextTokens = Number(wf.value);
          }
        }
      }
    } else if (cf.fieldNo === 11 && cf.wireType === 2) {
      info.ttftSeconds = decodeDurationSeconds(cf.value);
    } else if (cf.fieldNo === 12 && cf.wireType === 2) {
      info.streamingSeconds = decodeDurationSeconds(cf.value);
    } else if (cf.fieldNo === 17 && cf.wireType === 2) {
      // retryInfos
      for (const rf of parseProtoFields(cf.value)) {
        if (rf.fieldNo === 4 && rf.wireType === 2) {
          info.traceId = rf.value.toString('utf8');
        }
      }
    } else if (cf.fieldNo === 19 && cf.wireType === 2) {
      info.responseModel = cf.value.toString('utf8').trim();
    } else if (cf.fieldNo === 20 && cf.wireType === 2) {
      // customMetadata map entry
      let k = '';
      let v = '';
      for (const mf of parseProtoFields(cf.value)) {
        if (mf.fieldNo === 1 && mf.wireType === 2) k = mf.value.toString('utf8');
        if (mf.fieldNo === 2 && mf.wireType === 2) v = mf.value.toString('utf8');
      }
      if (k) {
        info.customMetadata[k] = v;
      }
    } else if (cf.fieldNo === 21 && cf.wireType === 2) {
      info.modelDisplayName = cf.value.toString('utf8').trim();
    } else if (cf.fieldNo === 22 && cf.wireType === 2) {
      // response_model_full (ChatModelMetadata field 22)
      info.responseModelFull = cf.value.toString('utf8').trim();
    }
  }

  if (info.responseModelFull) {
    info.responseModel = info.responseModelFull;
  }

  info.modelEnum = info.customMetadata.model_enum || (info.modelIdNumeric ? `MODEL_ENUM_${info.modelIdNumeric}` : '');
  info.requestId = info.customMetadata.request_id || '';
  if (info.customMetadata.last_step_index !== undefined) {
    info.lastStepIndex = Number(info.customMetadata.last_step_index);
  }
  info.usedClaude = info.customMetadata.used_claude === 'true';
  info.usedNonGeminiModel = info.customMetadata.used_non_gemini_model === 'true';

  const totalGenSec = (info.ttftSeconds || 0) + (info.streamingSeconds || 0);
  const bodyTokens = info.responseOutputTokens > 0
    ? info.responseOutputTokens
    : Math.max(0, (info.outputTokens || 0) - (info.thinkingOutputTokens || 0));
  info.bodyOutputTokens = bodyTokens;
  info.e2eTps = totalGenSec > 0.02 && info.outputTokens > 0
    ? Number((info.outputTokens / totalGenSec).toFixed(1))
    : 0;

  // Streaming TPS (总输出 Token ÷ 流式时长), aligned with E2E numerator (`info.outputTokens`):
  // - Never hide or mask TPS as "缓冲".
  // - When streamingSeconds >= 0.05s and bodyTokens > 0, divide bodyTokens by streamingSeconds.
  //   Mark `tpsApprox = true` (amber + "可能不准") when the streaming window < 0.6s or burst >= 600 tok/s.
  // - Else when outputTokens > 0 && e2eTps > 0 (single-packet delivery or pure-thinking tool step),
  //   fall back to e2eTps and mark `tpsApprox = true`.
  if (info.outputTokens > 0) {
    if (info.streamingSeconds >= 0.05) {
      const rawDecodeTps = info.outputTokens / info.streamingSeconds;
      info.tps = Number(rawDecodeTps.toFixed(1));
      if (info.streamingSeconds < 0.6 || info.tps >= 600) {
        info.tpsApprox = true;
        info.tpsApproxReason = info.streamingSeconds < 0.6
          ? `流式窗口较短 (${info.streamingSeconds.toFixed(2)}s)，受 SSE 分块缓冲影响可能不准`
          : `高速突发 (${info.tps.toFixed(1)} tok/s)，受分块缓冲影响可能偏高`;
      } else {
        info.tpsApprox = false;
        info.tpsApproxReason = '';
      }
    } else if (info.e2eTps > 0) {
      info.tps = info.e2eTps;
      info.tpsApprox = true;
      info.tpsApproxReason = bodyTokens === 0
        ? '纯思考/工具调用步 (无流式正文)，按总耗时估算'
        : `单包一次性返回 (流式窗口 ${(info.streamingSeconds * 1000).toFixed(1)}ms)，按端到端耗时估算，可能不准`;
    } else {
      info.tps = 0;
      info.tpsApprox = false;
      info.tpsApproxReason = '';
    }
  } else {
    info.tps = 0;
    info.tpsApprox = false;
    info.tpsApproxReason = '';
  }
  info.isBuffered = false;

  return info;
}

export function formatActualModelTag(inv) {
  if (!inv) return 'unknown';
  const sent = String(inv.sentModel || '').trim();
  const resp = String(inv.responseModelFull || inv.responseModel || '').trim();
  if (sent && resp) {
    return sent.toLowerCase() === resp.toLowerCase() ? resp : `${sent} → ${resp}`;
  }
  return sent || resp || 'unknown';
}

let summariesTableCache = { stamp: '', map: new Map(), childrenMap: new Map() };
const dbSummaryCache = new Map();
const DB_SUMMARY_CACHE_MAX = 120;
const fleetHierarchyCache = new Map();
const FLEET_CACHE_MAX = 32;
let recentSortedEntriesCache = { ts: 0, entries: [] };
let recentConversationsCache = { ts: 0, limit: 0, summariesStamp: '', results: [] };
const RECENT_SCAN_TTL_MS = 3000;

function getFileStamp(filePath) {
  let mtimeMs = 0;
  let size = 0;
  try {
    const st = fs.statSync(filePath);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {}
  let walMtimeMs = 0;
  let walSize = 0;
  try {
    const wst = fs.statSync(`${filePath}-wal`);
    walMtimeMs = wst.mtimeMs;
    walSize = wst.size;
  } catch {}
  return `${mtimeMs}:${size}:${walMtimeMs}:${walSize}`;
}

function decodeProtoTimestampMs(buf) {
  if (!buf || !buf.length) return 0;
  let sec = 0;
  let nanos = 0;
  for (const tf of parseProtoFields(buf)) {
    if (tf.fieldNo === 1 && tf.wireType === 0) sec = Number(tf.value);
    else if (tf.fieldNo === 2 && tf.wireType === 0) nanos = Number(tf.value);
  }
  if (sec > 946684800 && sec < 4102444800) {
    return Math.round(sec * 1000 + nanos / 1e6);
  }
  return 0;
}

function parseIsoTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 946684800000 ? raw : 0;
  }
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  const parsed = Date.parse(raw.trim());
  return Number.isFinite(parsed) && parsed > 946684800000 ? parsed : 0;
}

function parseWorkspaceFromUris(rawUris) {
  let uris = [];
  if (Array.isArray(rawUris)) {
    uris = rawUris;
  } else if (typeof rawUris === 'string' && rawUris.trim()) {
    try {
      const parsed = JSON.parse(rawUris);
      if (Array.isArray(parsed)) uris = parsed;
    } catch {}
  }
  const paths = [];
  for (const u of uris) {
    if (typeof u !== 'string' || !u.trim()) continue;
    try {
      const fsPath = u.startsWith('file://') ? fileURLToPath(u) : u;
      if (fsPath) paths.push(fsPath);
    } catch {}
  }
  if (paths.length === 0) return { cwd: '', group: '' };
  const preferred = paths.find(p =>
    !/[\\/]\.gemini([\\/]|$)/i.test(p) &&
    !/[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)/i.test(p)
  ) || paths[0];
  const group = path.basename(preferred) || preferred;
  return { cwd: preferred, group };
}

function resolveRootConversationId(conversationId, map = ensureSummariesTableCache().map) {
  let cur = String(conversationId || '').trim();
  if (!cur) return '';
  const seen = new Set([cur]);
  for (let i = 0; i < 16; i++) {
    const parentId = String(map.get(cur)?.parent_conversation_id || '').trim();
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    cur = parentId;
  }
  return cur;
}

function ensureSummariesTableCache() {
  if (!fs.existsSync(SUMMARIES_DB_PATH)) return summariesTableCache;
  const stamp = getFileStamp(SUMMARIES_DB_PATH);
  if (stamp !== summariesTableCache.stamp) {
    let sdb;
    try {
      sdb = new DatabaseSync(SUMMARIES_DB_PATH, { readOnly: true });
      const rows = sdb.prepare(
        'SELECT conversation_id, title, preview, workspace_uris, status, parent_conversation_id, last_modified_time, last_user_input_time, raw_summary FROM conversation_summaries'
      ).all();
      const map = new Map();
      const childrenMap = new Map();
      for (const r of rows) {
        if (!r?.conversation_id) continue;
        const lastModifiedMs = parseIsoTimestampMs(r.last_modified_time);
        let createdAtMs = 0;
        if (r.raw_summary && r.raw_summary.length) {
          try {
            const rf = parseProtoFields(r.raw_summary);
            const f7 = rf.find(x => x.fieldNo === 7 && x.wireType === 2);
            if (f7) createdAtMs = decodeProtoTimestampMs(f7.value);
          } catch {}
        }
        r.lastModifiedMs = lastModifiedMs;
        r.createdAtMs = createdAtMs || lastModifiedMs;
        const ws = parseWorkspaceFromUris(r.workspace_uris);
        r.cwd = ws.cwd;
        r.group = ws.group;
        map.set(r.conversation_id, r);
        const pid = String(r.parent_conversation_id || '').trim();
        if (pid) {
          let list = childrenMap.get(pid);
          if (!list) {
            list = [];
            childrenMap.set(pid, list);
          }
          list.push(r.conversation_id);
        }
      }
      summariesTableCache = { stamp, map, childrenMap };
    } catch {
      return summariesTableCache;
    } finally {
      try { sdb?.close(); } catch {}
    }
  }
  return summariesTableCache;
}

function getSummaryMetaFromSummariesDb(conversationId) {
  return ensureSummariesTableCache().map.get(conversationId) || null;
}

function readTranscriptFirstLine(transcriptFile) {
  let fd;
  try {
    fd = fs.openSync(transcriptFile, 'r');
    const buf = Buffer.allocUnsafe(16384);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytes <= 0) return '';
    const chunk = buf.toString('utf8', 0, bytes);
    const nl = chunk.search(/\r?\n/);
    return nl >= 0 ? chunk.slice(0, nl) : chunk;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function getConversationModelsFromDb(conversationId, precomputedDbStamp = '', precomputedSummariesStamp = '') {
  const dbPath = path.join(CONVERSATIONS_DIR, `${conversationId}.db`);
  if (!precomputedDbStamp && !fs.existsSync(dbPath)) return null;

  const dbStamp = `${precomputedDbStamp || getFileStamp(dbPath)}|${precomputedSummariesStamp || getFileStamp(SUMMARIES_DB_PATH)}`;
  const cached = dbSummaryCache.get(conversationId);
  if (cached && cached.stamp === dbStamp) {
    dbSummaryCache.delete(conversationId);
    dbSummaryCache.set(conversationId, cached);
    return cached.summary;
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT idx, size, data FROM gen_metadata ORDER BY idx ASC').all();
    const invocations = rows.map(r => decodeGeneratorMetadataBlob(r.data, Number(r.idx)));

    // CascadeConfig (f3.f28 = sentModel) is recorded on turn-start rows of gen_metadata
    // and omitted on tool-continuation steps within the same turn. Carry it forward per modelEnum,
    // and if still absent, infer from displayName tier suffix (e.g. "Gemini 4 Carbon (Medium)" -> "gemini-4-carbon-medium")
    // when responseModel is a bare family name.
    const sentByEnum = new Map();
    for (const inv of invocations) {
      if (inv.sentModel && inv.modelEnum) {
        sentByEnum.set(inv.modelEnum, inv.sentModel);
      } else if (!inv.sentModel && inv.modelEnum && sentByEnum.has(inv.modelEnum)) {
        inv.sentModel = sentByEnum.get(inv.modelEnum);
      }
      if (!inv.sentModel && inv.responseModel && inv.modelDisplayName) {
        const tierMatch = inv.modelDisplayName.match(/\((Low|Medium|High|Extra Low)\)\s*$/i);
        if (tierMatch) {
          const tierSlug = tierMatch[1].toLowerCase().replace(/\s+/g, '-');
          if (!inv.responseModel.toLowerCase().endsWith(`-${tierSlug}`)) {
            inv.sentModel = `${inv.responseModel}-${tierSlug}`;
          }
        }
      }
      inv.actualModelLabel = formatActualModelTag(inv);
    }

    let title = '';
    const sumMeta = getSummaryMetaFromSummariesDb(conversationId);
    if (sumMeta && (sumMeta.title || sumMeta.preview)) {
      title = String(sumMeta.title || sumMeta.preview).trim().slice(0, 70);
    }

    if (!title) {
      const transcriptFile = path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(transcriptFile)) {
        try {
          const firstLine = readTranscriptFirstLine(transcriptFile);
          if (firstLine) {
            const parsed = JSON.parse(firstLine);
            if (parsed.content) {
              title = String(parsed.content)
                .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
                .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
                .replace(/<\/?USER_REQUEST>/g, '')
                .trim()
                .slice(0, 70);
            }
          }
        } catch {}
      }
    }

    const stepTsMap = new Map();
    let firstStepMs = 0;
    let lastStepMs = 0;
    try {
      const stepRows = db.prepare('SELECT idx, substr(metadata, 1, 24) AS m FROM steps ORDER BY idx ASC').all();
      for (const sr of stepRows) {
        if (!sr?.m) continue;
        for (const pf of parseProtoFields(sr.m)) {
          if (pf.fieldNo === 1 && pf.wireType === 2) {
            const ms = decodeProtoTimestampMs(pf.value);
            if (ms > 0) {
              stepTsMap.set(Number(sr.idx), ms);
              if (!firstStepMs || ms < firstStepMs) firstStepMs = ms;
              if (ms > lastStepMs) lastStepMs = ms;
            }
            break;
          }
        }
      }
    } catch {}

    const stat = fs.statSync(dbPath);
    let walMtimeMs = 0;
    let walSize = 0;
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      try {
        const walStat = fs.statSync(walPath);
        walSize = Number(walStat.size || 0);
        if (walSize > 0) walMtimeMs = walStat.mtimeMs;
      } catch {}
    }

    const sumModMs = sumMeta?.lastModifiedMs || 0;
    const effectiveUpdatedAtMs = walSize > 0
      ? Math.max(lastStepMs, sumModMs, stat.mtimeMs, walMtimeMs)
      : (lastStepMs || sumModMs || stat.mtimeMs);
    const birthMs = stat.birthtimeMs > 946684800000 ? stat.birthtimeMs : 0;
    const effectiveCreatedAtMs = firstStepMs || sumMeta?.createdAtMs || birthMs || effectiveUpdatedAtMs;

    let prevInvMs = firstStepMs || effectiveUpdatedAtMs;
    for (const inv of invocations) {
      let tsMs = 0;
      const sIndices = Array.isArray(inv.stepIndices) ? inv.stepIndices : [];
      for (let i = sIndices.length - 1; i >= 0; i--) {
        if (stepTsMap.has(sIndices[i])) {
          tsMs = stepTsMap.get(sIndices[i]);
          break;
        }
      }
      if (!tsMs && inv.lastStepIndex >= 0 && stepTsMap.has(inv.lastStepIndex)) {
        tsMs = stepTsMap.get(inv.lastStepIndex);
      }
      if (tsMs > 0) {
        prevInvMs = tsMs;
      } else {
        tsMs = prevInvMs || effectiveUpdatedAtMs;
      }
      inv.timestampMs = tsMs;
    }

    const summary = buildConversationSummary(conversationId, title, effectiveUpdatedAtMs, invocations, sumMeta, {
      createdAtMs: effectiveCreatedAtMs,
      cwd: sumMeta?.cwd || '',
      group: sumMeta?.group || ''
    });
    dbSummaryCache.delete(conversationId);
    if (dbSummaryCache.size >= DB_SUMMARY_CACHE_MAX) {
      const oldestKey = dbSummaryCache.keys().next().value;
      if (oldestKey !== undefined) dbSummaryCache.delete(oldestKey);
    }
    dbSummaryCache.set(conversationId, { stamp: dbStamp, summary });
    return summary;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function buildConversationSummary(conversationId, title, updatedAtMs, invocations, sumMeta = null, extraMeta = {}) {
  const latest = invocations.length > 0 ? invocations[invocations.length - 1] : null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalBodyOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalTtftSeconds = 0;
  let totalStreamingSeconds = 0;
  let ttftCount = 0;
  let llmSeconds = 0;
  let decodeBodyTokens = 0;
  let decodeStreamSeconds = 0;
  let decodeSamples = 0;
  let allOutTokens = 0;
  let allE2eSeconds = 0;
  let lastValidDecodeTps = 0;
  const modelCounts = {};

  for (const inv of invocations) {
    totalInputTokens += inv.inputTokens || 0;
    totalOutputTokens += inv.outputTokens || 0;
    totalThinkingTokens += inv.thinkingOutputTokens || 0;
    const bodyTok = inv.bodyOutputTokens !== undefined
      ? (inv.bodyOutputTokens || 0)
      : (inv.responseOutputTokens > 0 ? inv.responseOutputTokens : Math.max(0, (inv.outputTokens || 0) - (inv.thinkingOutputTokens || 0)));
    totalBodyOutputTokens += bodyTok;
    totalCacheReadTokens += inv.cacheReadTokens || 0;
    const e2eSec = (inv.ttftSeconds || 0) + (inv.streamingSeconds || 0);
    llmSeconds += e2eSec;

    if (inv.ttftSeconds > 0) {
      totalTtftSeconds += inv.ttftSeconds;
      ttftCount++;
    }
    if (inv.streamingSeconds > 0) {
      totalStreamingSeconds += inv.streamingSeconds;
    }
    if (inv.outputTokens > 0) {
      if (e2eSec > 0.02) {
        allOutTokens += inv.outputTokens;
        allE2eSeconds += e2eSec;
      }
      if (inv.streamingSeconds >= 0.05) {
        decodeBodyTokens += inv.outputTokens;
        decodeStreamSeconds += inv.streamingSeconds;
        decodeSamples++;
      }
      if (inv.tps > 0) {
        lastValidDecodeTps = inv.tps;
      }
    }
    const key = inv.actualModelLabel || inv.sentModel || inv.responseModel || inv.modelDisplayName || inv.modelEnum || 'unknown';
    modelCounts[key] = (modelCounts[key] || 0) + 1;
  }

  const avgE2eTps = allE2eSeconds > 0
    ? Number((allOutTokens / allE2eSeconds).toFixed(1))
    : 0;

  // Duration-weighted session decode TPS (sum(outputTokens) / sum(streamingSeconds))
  let avgDecodeTps = 0;
  let avgTpsApprox = false;
  if (decodeStreamSeconds > 0 && decodeBodyTokens > 0) {
    avgDecodeTps = Number((decodeBodyTokens / decodeStreamSeconds).toFixed(1));
    avgTpsApprox = decodeStreamSeconds < 0.6;
  } else if (avgE2eTps > 0) {
    avgDecodeTps = avgE2eTps;
    avgTpsApprox = true;
  }

  const billedInput = totalInputTokens + totalCacheReadTokens;
  const totalSessionTokens = billedInput + totalOutputTokens;
  const cacheHitPct = billedInput > 0
    ? Number(((totalCacheReadTokens / billedInput) * 100).toFixed(1))
    : 0;
  const llmMs = Math.round(llmSeconds * 1000);
  const ttftMs = Math.round(totalTtftSeconds * 1000);
  const streamingMs = Math.round(totalStreamingSeconds * 1000);

  const latestResp = latest ? (latest.responseModelFull || latest.responseModel || 'N/A') : 'N/A';
  const latestSent = latest ? (latest.sentModel || latestResp) : 'N/A';

  return {
    conversationId,
    parentConversationId: String(sumMeta?.parent_conversation_id || '').trim(),
    status: sumMeta?.status ?? null,
    title: title || conversationId.slice(0, 8),
    createdAt: new Date(extraMeta?.createdAtMs || updatedAtMs || Date.now()).toISOString(),
    createdAtMs: extraMeta?.createdAtMs || updatedAtMs || Date.now(),
    cwd: extraMeta?.cwd || sumMeta?.cwd || '',
    group: extraMeta?.group || sumMeta?.group || '',
    updatedAt: new Date(updatedAtMs || Date.now()).toISOString(),
    updatedAtMs: updatedAtMs || Date.now(),
    invocationCount: invocations.length,
    latestModel: latest ? {
      sentModel: latestSent,
      responseModel: latestResp,
      responseModelFull: latest.responseModelFull || '',
      actualModelLabel: formatActualModelTag(latest),
      modelMismatch: Boolean(latest.sentModel && latestResp && latestResp !== 'N/A' && latest.sentModel.toLowerCase() !== latestResp.toLowerCase()),
      modelDisplayName: latest.modelDisplayName || 'N/A',
      modelEnum: latest.modelEnum || 'N/A',
      apiProvider: latest.apiProvider || 'N/A',
      inputTokens: latest.inputTokens,
      outputTokens: latest.outputTokens,
      thinkingOutputTokens: latest.thinkingOutputTokens,
      responseOutputTokens: latest.responseOutputTokens,
      bodyOutputTokens: latest.bodyOutputTokens ?? 0,
      cacheReadTokens: latest.cacheReadTokens,
      estimatedContextTokens: latest.estimatedContextTokens,
      maxContextTokens: latest.maxContextTokens,
      ttftSeconds: Number(latest.ttftSeconds.toFixed(2)),
      streamingSeconds: Number(latest.streamingSeconds.toFixed(2)),
      tps: latest.tps || 0,
      tpsApprox: Boolean(latest.tpsApprox),
      tpsApproxReason: latest.tpsApproxReason || '',
      stepDecodeTps: latest.tps || 0,
      isBuffered: false,
      e2eTps: latest.e2eTps || 0,
      requestId: latest.requestId,
      responseId: latest.responseId,
      messageId: latest.messageId,
      traceId: latest.traceId,
      stepIndices: latest.stepIndices
    } : null,
    totals: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      thinkingTokens: totalThinkingTokens,
      responseOutputTokens: totalBodyOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      totalSessionTokens,
      cacheHitPct,
      llmMs,
      ttftMs,
      streamingMs,
      decodeSamples,
      avgTtftSeconds: ttftCount > 0 ? Number((totalTtftSeconds / ttftCount).toFixed(2)) : 0,
      avgTps: avgDecodeTps,
      avgTpsApprox,
      avgE2eTps,
      lastValidDecodeTps
    },
    modelBreakdown: modelCounts,
    invocations
  };
}

export function listRecentConversations(limit = 20) {
  if (!fs.existsSync(CONVERSATIONS_DIR)) return [];
  const now = Date.now();
  const requestedLimit = limit > 0 ? limit : Infinity;
  const summariesCache = ensureSummariesTableCache();
  const summariesStamp = getFileStamp(SUMMARIES_DB_PATH);
  if (
    (now - recentConversationsCache.ts) < RECENT_SCAN_TTL_MS &&
    recentConversationsCache.limit >= requestedLimit &&
    recentConversationsCache.summariesStamp === summariesStamp &&
    recentConversationsCache.results.length > 0
  ) {
    const headId = recentConversationsCache.results[0].conversationId;
    const refreshed = getConversationModelsFromDb(headId, '', summariesStamp);
    if (refreshed && refreshed.invocationCount > 0) {
      recentConversationsCache.results[0] = refreshed;
    }
    return limit > 0 ? recentConversationsCache.results.slice(0, limit) : recentConversationsCache.results;
  }

  let entries = recentSortedEntriesCache.entries;
  if (
    !entries.length ||
    (now - recentSortedEntriesCache.ts) >= RECENT_SCAN_TTL_MS ||
    recentConversationsCache.summariesStamp !== summariesStamp
  ) {
    entries = fs.readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const id = f.slice(0, -3);
        const dbFull = path.join(CONVERSATIONS_DIR, f);
        const walFull = `${dbFull}-wal`;
        let mtimeMs = 0;
        let dbMtime = 0;
        let dbSize = 0;
        let walMtime = 0;
        let walSize = 0;
        let hasDb = false;
        try {
          const st = fs.statSync(dbFull);
          dbMtime = st.mtimeMs;
          dbSize = st.size;
          mtimeMs = dbMtime;
          hasDb = true;
        } catch {}
        try {
          const wm = fs.statSync(walFull);
          walMtime = wm.mtimeMs;
          walSize = wm.size;
          if (walSize > 0 && walMtime > mtimeMs) mtimeMs = walMtime;
        } catch {}
        if (walSize === 0) {
          const sumRow = summariesCache.map.get(id);
          if (sumRow?.lastModifiedMs > 0) {
            mtimeMs = sumRow.lastModifiedMs;
          }
        }
        return {
          id,
          mtimeMs,
          stamp: hasDb ? `${dbMtime}:${dbSize}:${walMtime}:${walSize}` : ''
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    recentSortedEntriesCache = { ts: now, entries };
  }

  const results = [];
  const targetEntries = limit > 0 ? entries.slice(0, limit) : entries;
  for (const item of targetEntries) {
    const summary = getConversationModelsFromDb(item.id, item.stamp || '', summariesStamp);
    if (summary && summary.invocationCount > 0) {
      results.push(summary);
    }
  }
  recentConversationsCache = { ts: now, limit: requestedLimit, summariesStamp, results };
  return results;
}

export function writeInflightState(conversationId, stateObj) {
  if (!conversationId) return;
  try {
    fs.mkdirSync(INFLIGHT_DIR, { recursive: true });
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(INFLIGHT_DIR, `${safeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      conversationId,
      ...stateObj,
      updatedAtMs: stateObj?.updatedAtMs || Date.now()
    }, null, 2), 'utf8');
  } catch {}
}

export function readInflightState(conversationId) {
  if (!conversationId) return null;
  try {
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(INFLIGHT_DIR, `${safeId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {}
  return null;
}

export function isDesktopAppSurface(payload = {}) {
  const paths = [
    String(payload?.transcriptPath || ''),
    String(payload?.artifactDirectoryPath || ''),
    String(process.env.PLUGIN_DATA || ''),
    String(process.env.ANTIGRAVITY_APP_DATA_DIR || '')
  ].map(s => s.replace(/\\/g, '/').toLowerCase());

  if (paths.some(p => p.includes('/antigravity-cli/') || p.endsWith('/antigravity-cli'))) {
    return false;
  }

  const userPrompt = String(payload?.lastUserInput || payload?.prompt || '');
  if (/create a concise title for an ai coding-assistant session/i.test(userPrompt)) {
    return false;
  }

  return paths.some(p => p.includes('/.gemini/antigravity/') || p.includes('/.gemini/antigravity-ide/'));
}

export function isSubagentConversation(conversationId) {
  if (!conversationId) return false;
  try {
    const meta = getSummaryMetaFromSummariesDb(conversationId);
    if (meta && String(meta.parent_conversation_id || '').trim() !== '') {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Scans `transcript.jsonl` from the latest explicit `USER_INPUT` step to the end of the file
 * and returns `true` if there is any unfinished non-daemon background task (`run_command` / `schedule`)
 * or active subagent request (`invoke_subagent` / `send_message`) that has not yet reported back via `SYSTEM_MESSAGE`.
 *
 * When `true`, any model text output in the upcoming invocation is an intermediate progress checkpoint
 * ("正在等待后台打包 / 浏览器子代理...") rather than the final turn-ending reply, so `PreInvocation` suppresses the badge directive.
 */
export function syncConversationRulesSnapshot() {
  syncPromptRules();
}

// =============================================================================
// DSH Session Stats, Context Composition/Trends, Context Browser, Fleet & Insights
// =============================================================================

const transcriptAnalyticsCache = new Map();
let globalInsightsCache = { ts: 0, limit: 0, data: null };

function fmtCompactTokensDsh(n) {
  const v = Number(n || 0);
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function estTokensFromChars(charCount) {
  const n = Number(charCount || 0);
  if (n <= 0) return 0;
  return Math.max(1, Math.ceil(n / 3.4));
}

function unquoteArg(val) {
  if (val === null || val === undefined) return '';
  let s = String(val).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function stripPromptWrapperTags(text) {
  return String(text || '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<\/?USER_REQUEST>/g, '')
    .trim();
}

function countLinesCount(str) {
  const s = String(str || '');
  if (!s) return 0;
  let c = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) c++;
  }
  return s.endsWith('\n') ? Math.max(1, c - 1) : c;
}

function parseProgramFromCommand(cmdLine) {
  const raw = String(cmdLine || '').trim();
  if (!raw) return 'shell';
  const stripped = raw
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, '')
    .replace(/^(?:\$env:[A-Za-z0-9_]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)\s*;\s*)+/i, '')
    .trim();
  const m = stripped.match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/);
  const token = (m?.[1] || m?.[2] || m?.[3] || 'shell').replace(/\\/g, '/');
  const base = (token.split('/').pop() || token).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  return base || 'shell';
}

function extractSkillNameFromPath(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  if (!norm) return '';
  if (!/(?:^|\/)SKILL\.md$/i.test(norm) && !/\/skills\/[^/]+\//i.test(norm)) return '';
  const m = norm.match(/\/skills\/([^/]+)(?:\/|$)/i) || norm.match(/\/([^/]+)\/SKILL\.md$/i);
  if (m?.[1]) return m[1];
  const parts = norm.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : 'skill';
}

const GEMINI_4_PROMO_END_MS = Date.UTC(2026, 11, 1); // 2026-12-01T00:00:00Z
const GEMINI_38_FLASH_PROMO_END_MS = Date.UTC(2027, 0, 1); // 2027-01-01T00:00:00Z

export function lookupModelPricingRate(modelName, options = {}) {
  const m = String(modelName || '').trim().toLowerCase();
  const promptTokens = Math.max(0, Number(options?.promptTokens || 0));
  const ts = (typeof options?.atMs === 'number' && Number.isFinite(options.atMs) && options.atMs > 0) ? options.atMs : Date.now();

  // 1. GPT-OSS (Vertex MaaS)
  if (m.includes('gpt-oss-120b') || m.includes('gpt_oss_120b')) {
    return { provider: 'openai', miss: 0.09, hit: 0.09, write: 0, out: 0.36, label: 'GPT-OSS 120B', key: 'gpt-oss-120b', confidence: 'high' };
  }
  if (m.includes('gpt-oss-20b') || m.includes('gpt_oss_20b')) {
    return { provider: 'openai', miss: 0.04, hit: 0.04, write: 0, out: 0.15, label: 'GPT-OSS 20B', key: 'gpt-oss-20b', confidence: 'medium' };
  }
  if (m.includes('gpt-oss') || m.includes('gpt_oss')) {
    return { provider: 'openai', miss: 0.09, hit: 0.09, write: 0, out: 0.36, label: 'GPT-OSS', key: 'gpt-oss', confidence: 'medium' };
  }

  // 2. Claude Opus
  if (m.includes('opus-5-5') || m.includes('opus-5.5') || m.includes('opus_5_5') || /\bm401\b/.test(m)) {
    return { provider: 'anthropic', miss: 4.0, hit: 0.20, write: 5.0, out: 20.0, label: 'Claude Opus 5.5', key: 'claude-opus-5.5', confidence: 'high' };
  }
  if (m.includes('opus-4-6') || m.includes('opus-4.6') || m.includes('opus-4-5') || m.includes('opus-4.5')) {
    return { provider: 'anthropic', miss: 5.0, hit: 0.50, write: 6.25, out: 25.0, label: 'Claude Opus 4.5/4.6', key: 'claude-opus-4.6', confidence: 'high' };
  }
  if (m.includes('opus-4-1') || m.includes('opus-4.1') || m.includes('opus-4-0') || m.includes('claude-3-opus') || /\bm(26|35)\b/.test(m)) {
    return { provider: 'anthropic', miss: 15.0, hit: 1.50, write: 18.75, out: 75.0, label: 'Claude Opus (Legacy)', key: 'claude-opus-legacy', confidence: 'high' };
  }
  if (m.includes('opus')) {
    return { provider: 'anthropic', miss: 4.0, hit: 0.20, write: 5.0, out: 20.0, label: 'Claude Opus 5.5', key: 'claude-opus-5.5', confidence: 'high' };
  }

  // 3. Claude Sonnet
  if (m.includes('sonnet-5') || m.includes('sonnet_5')) {
    return { provider: 'anthropic', miss: 2.0, hit: 0.10, write: 2.50, out: 10.0, label: 'Claude Sonnet 5.5', key: 'claude-sonnet-5.5', confidence: 'high' };
  }
  if (m.includes('sonnet-4') || m.includes('sonnet-3') || m.includes('3-5-sonnet') || m.includes('3-7-sonnet')) {
    return { provider: 'anthropic', miss: 3.0, hit: 0.30, write: 3.75, out: 15.0, label: 'Claude Sonnet 4.x', key: 'claude-sonnet-4', confidence: 'high' };
  }
  if (m.includes('sonnet')) {
    return { provider: 'anthropic', miss: 2.0, hit: 0.10, write: 2.50, out: 10.0, label: 'Claude Sonnet 5.5', key: 'claude-sonnet-5.5', confidence: 'high' };
  }

  // 4. Claude Haiku
  if (m.includes('haiku-4-5') || m.includes('haiku-4.5')) {
    return { provider: 'anthropic', miss: 1.0, hit: 0.10, write: 1.25, out: 5.0, label: 'Claude Haiku 4.5', key: 'claude-haiku-4.5', confidence: 'high' };
  }
  if (m.includes('haiku')) {
    if (promptTokens > 100000) {
      return { provider: 'anthropic', miss: 0.50, hit: 0.05, write: 0.625, out: 2.50, label: 'Claude Haiku 5.5 (>100k)', key: 'claude-haiku-5.5-long', confidence: 'high' };
    }
    return { provider: 'anthropic', miss: 0.10, hit: 0.01, write: 0.125, out: 0.50, label: 'Claude Haiku 5.5', key: 'claude-haiku-5.5', confidence: 'high' };
  }

  // 5. Gemini 4 family (check neon/argon before orchestrator/carbon)
  if (m.includes('neon') || /\bm53[2345]\b/.test(m)) {
    return { provider: 'google', miss: 3.0, hit: 0.15, write: 0, out: 15.0, label: 'Gemini 4 Neon', key: 'gemini-4-neon', confidence: 'high' };
  }
  if (m.includes('argon') || /\bm41[78]\b/.test(m)) {
    if (ts >= GEMINI_4_PROMO_END_MS) {
      return { provider: 'google', miss: 4.0, hit: 0.20, write: 0, out: 20.0, label: 'Gemini 4 Argon', key: 'gemini-4-argon', confidence: 'high' };
    }
    return { provider: 'google', miss: 2.0, hit: 0.10, write: 0, out: 10.0, label: 'Gemini 4 Argon', key: 'gemini-4-argon', confidence: 'high' };
  }
  if (m.includes('carbon') || m.includes('orchestrator') || /\bm43[67]\b/.test(m)) {
    if (ts >= GEMINI_4_PROMO_END_MS) {
      return { provider: 'google', miss: 4.0, hit: 0.20, write: 0, out: 20.0, label: 'Gemini 4 Carbon', key: 'gemini-4-carbon', confidence: 'high' };
    }
    return { provider: 'google', miss: 2.0, hit: 0.10, write: 0, out: 10.0, label: 'Gemini 4 Carbon', key: 'gemini-4-carbon', confidence: 'high' };
  }
  if (m.includes('hydrogen')) {
    return { provider: 'google', miss: 1.50, hit: 0.075, write: 0, out: 7.50, label: 'Gemini 4 Hydrogen', key: 'gemini-4-hydrogen', confidence: 'high' };
  }

  // 6. Gemini Flash-Lite & Flash
  if (m.includes('flash-lite') || m.includes('flash_lite')) {
    if (m.includes('2.5') || m.includes('2-5') || m.includes('2.0') || m.includes('2-0')) {
      return { provider: 'google', miss: 0.10, hit: 0.01, write: 0, out: 0.40, label: 'Gemini 2.5 Flash-Lite', key: 'gemini-2.5-flash-lite', confidence: 'high' };
    }
    return { provider: 'google', miss: 0.25, hit: 0.025, write: 0, out: 1.50, label: 'Gemini Flash-Lite', key: 'gemini-flash-lite', confidence: 'high' };
  }
  if (m.includes('2.5-flash') || m.includes('2-5-flash')) {
    return { provider: 'google', miss: 0.30, hit: 0.03, write: 0, out: 2.50, label: 'Gemini 2.5 Flash', key: 'gemini-2.5-flash', confidence: 'high' };
  }
  if (m.includes('flash') || /\bm3(18|19|20)\b/.test(m)) {
    if (ts >= GEMINI_38_FLASH_PROMO_END_MS) {
      return { provider: 'google', miss: 1.50, hit: 0.15, write: 0, out: 7.50, label: 'Gemini 3.8 Flash', key: 'gemini-3.8-flash', confidence: 'high' };
    }
    return { provider: 'google', miss: 0.75, hit: 0.075, write: 0, out: 3.75, label: 'Gemini 3.8 Flash', key: 'gemini-3.8-flash', confidence: 'high' };
  }

  // 7. Gemini Pro (3.1 Pro / 2.5 Pro / generic Pro)
  if (m.includes('3.1-pro') || m.includes('3-1-pro') || m.includes('3-pro') || m.includes('3.0-pro')) {
    if (promptTokens > 200000) {
      return { provider: 'google', miss: 4.0, hit: 0.40, write: 0, out: 18.0, label: 'Gemini 3.1 Pro (>200k)', key: 'gemini-3.1-pro-long', confidence: 'high' };
    }
    return { provider: 'google', miss: 2.0, hit: ts >= GEMINI_4_PROMO_END_MS ? 0.20 : 0.10, write: 0, out: 12.0, label: 'Gemini 3.1 Pro', key: 'gemini-3.1-pro', confidence: 'high' };
  }
  if (m.includes('2.5-pro') || m.includes('2-5-pro') || /\bm37\b/.test(m)) {
    if (promptTokens > 200000) {
      return { provider: 'google', miss: 2.50, hit: 0.25, write: 0, out: 15.0, label: 'Gemini 2.5 Pro (>200k)', key: 'gemini-2.5-pro-long', confidence: 'high' };
    }
    return { provider: 'google', miss: 1.25, hit: 0.125, write: 0, out: 10.0, label: 'Gemini 2.5 Pro', key: 'gemini-2.5-pro', confidence: 'high' };
  }
  if (m.includes('pro')) {
    if (ts >= GEMINI_4_PROMO_END_MS) {
      return { provider: 'google', miss: 4.0, hit: 0.20, write: 0, out: 20.0, label: 'Gemini Pro', key: 'gemini-pro', confidence: 'medium' };
    }
    return { provider: 'google', miss: 2.0, hit: 0.10, write: 0, out: 10.0, label: 'Gemini Pro', key: 'gemini-pro', confidence: 'medium' };
  }

  // 8. Default Fallback
  if (ts >= GEMINI_4_PROMO_END_MS) {
    return { provider: 'google', miss: 4.0, hit: 0.20, write: 0, out: 20.0, label: 'Frontier Reference', key: 'default', confidence: 'low' };
  }
  return { provider: 'google', miss: 2.0, hit: 0.10, write: 0, out: 10.0, label: 'Frontier Reference', key: 'default', confidence: 'low' };
}

export function estimateInvocationCost(modelName, inputTokens, cacheReadTokens, outputTokens, options = {}) {
  const inTok = Math.max(0, Number(inputTokens || 0));
  const hitTok = Math.max(0, Number(cacheReadTokens || 0));
  const outTok = Math.max(0, Number(outputTokens || 0));
  const rate = lookupModelPricingRate(modelName, { ...options, promptTokens: options?.promptTokens ?? (inTok + hitTok) });
  const usd = ((inTok * rate.miss) + (hitTok * rate.hit) + (outTok * rate.out)) / 1e6;
  return { usd, rate };
}

export function computeSummaryCostUsd(summary) {
  if (!summary || !Array.isArray(summary.invocations) || summary.invocations.length === 0) return 0;
  let usd = 0;
  for (const inv of summary.invocations) {
    usd += estimateInvocationCost(
      inv.responseModel || inv.sentModel || inv.modelEnum || inv.actualModelLabel || inv.modelDisplayName || '',
      inv.inputTokens,
      inv.cacheReadTokens,
      inv.outputTokens,
      { atMs: inv.timestampMs || summary.updatedAtMs }
    ).usd;
  }
  return Number(usd.toFixed(6));
}

/**
 * Computes Fleet (coordinator + recursive descendant subagents) token and cost rollup
 * using the in-memory summaries index + cached per-conversation SQLite summaries.
 * Does NOT mutate own-agent metrics so dsh-context Fleet views never double-count.
 */
export function getFleetUsageRollup(conversationId, ownSummary = null, extraChildIds = []) {
  const cache = ensureSummariesTableCache();
  const resolvedOwn = ownSummary || (conversationId ? getConversationModelsFromDb(conversationId) : null);

  const ownTotals = resolvedOwn?.totals || {};
  const ownIn = ownTotals.inputTokens || 0;
  const ownCache = ownTotals.cacheReadTokens || 0;
  const ownOut = ownTotals.outputTokens || 0;
  const ownThink = ownTotals.thinkingTokens || 0;
  const ownBody = ownTotals.responseOutputTokens || Math.max(0, ownOut - ownThink);
  const own = {
    invocationCount: resolvedOwn?.invocationCount || 0,
    inputTokens: ownIn,
    cacheReadTokens: ownCache,
    outputTokens: ownOut,
    thinkingTokens: ownThink,
    bodyOutputTokens: ownBody,
    totalTokens: ownTotals.totalSessionTokens || (ownIn + ownCache + ownOut),
    cacheHitPct: ownTotals.cacheHitPct || 0,
    estimatedCostUsd: computeSummaryCostUsd(resolvedOwn)
  };

  const queue = [];
  const visited = new Set();
  if (conversationId) visited.add(conversationId);
  for (const cid of (cache.childrenMap.get(conversationId) || [])) {
    if (cid && !visited.has(cid)) {
      visited.add(cid);
      queue.push(cid);
    }
  }
  if (Array.isArray(extraChildIds)) {
    for (const cid of extraChildIds) {
      const trimmed = String(cid || '').trim();
      if (trimmed && !visited.has(trimmed)) {
        visited.add(trimmed);
        queue.push(trimmed);
      }
    }
  }

  const descendantIds = [];
  while (queue.length > 0 && descendantIds.length < 128) {
    const cid = queue.shift();
    descendantIds.push(cid);
    for (const grand of (cache.childrenMap.get(cid) || [])) {
      if (grand && !visited.has(grand)) {
        visited.add(grand);
        queue.push(grand);
      }
    }
  }

  const subagents = {
    count: descendantIds.length,
    activeCount: 0,
    invocationCount: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    bodyOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0
  };
  const childStampParts = [];

  for (const childId of descendantIds) {
    const childDbPath = path.join(CONVERSATIONS_DIR, `${childId}.db`);
    const childStamp = fs.existsSync(childDbPath) ? getFileStamp(childDbPath) : '0';
    childStampParts.push(`${childId.slice(0, 8)}:${childStamp}`);
    const childSum = childStamp !== '0'
      ? getConversationModelsFromDb(childId, childStamp, cache.stamp)
      : null;
    if (!childSum) continue;
    const ct = childSum.totals || {};
    const cIn = ct.inputTokens || 0;
    const cCache = ct.cacheReadTokens || 0;
    const cOut = ct.outputTokens || 0;
    const cThink = ct.thinkingTokens || 0;
    const cBody = ct.responseOutputTokens || Math.max(0, cOut - cThink);
    const cTot = ct.totalSessionTokens || (cIn + cCache + cOut);
    if ((childSum.invocationCount || 0) > 0 || cTot > 0) subagents.activeCount++;
    subagents.invocationCount += childSum.invocationCount || 0;
    subagents.inputTokens += cIn;
    subagents.cacheReadTokens += cCache;
    subagents.outputTokens += cOut;
    subagents.thinkingTokens += cThink;
    subagents.bodyOutputTokens += cBody;
    subagents.totalTokens += cTot;
    subagents.estimatedCostUsd += computeSummaryCostUsd(childSum);
  }
  subagents.estimatedCostUsd = Number(subagents.estimatedCostUsd.toFixed(6));

  const teamIn = own.inputTokens + subagents.inputTokens;
  const teamCache = own.cacheReadTokens + subagents.cacheReadTokens;
  const teamOut = own.outputTokens + subagents.outputTokens;
  const teamBilledIn = teamIn + teamCache;
  const team = {
    invocationCount: own.invocationCount + subagents.invocationCount,
    inputTokens: teamIn,
    cacheReadTokens: teamCache,
    outputTokens: teamOut,
    thinkingTokens: own.thinkingTokens + subagents.thinkingTokens,
    bodyOutputTokens: own.bodyOutputTokens + subagents.bodyOutputTokens,
    totalTokens: own.totalTokens + subagents.totalTokens,
    cacheHitPct: teamBilledIn > 0 ? Number(((teamCache / teamBilledIn) * 100).toFixed(1)) : 0,
    estimatedCostUsd: Number((own.estimatedCostUsd + subagents.estimatedCostUsd).toFixed(6))
  };

  const stamp = `${cache.stamp}|${own.invocationCount}:${own.totalTokens}|${childStampParts.join(',')}`;
  return {
    stamp,
    hasSubagents: descendantIds.length > 0,
    subagentCount: descendantIds.length,
    descendantIds,
    own,
    subagents,
    team
  };
}

/**
 * Parses append-only `transcript.jsonl` lines into the surviving active branch,
 * pruning superseded branches whenever `step_index` rewinds or overwrites an earlier index
 * due to prompt recall / edit-and-resend.
 */
export function parseActiveTranscriptEvents(rawLines) {
  const active = [];
  let rawEventCount = 0;
  let rollbackCount = 0;
  if (!Array.isArray(rawLines)) return { active, rawEventCount, rollbackCount };
  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    if (!line) continue;
    let st;
    try {
      st = JSON.parse(line);
    } catch {
      continue;
    }
    rawEventCount++;
    const stepIdx = Number.isFinite(Number(st.step_index)) ? Number(st.step_index) : idx;
    if (active.length > 0 && active[active.length - 1].stepIdx >= stepIdx) {
      rollbackCount++;
      while (active.length > 0 && active[active.length - 1].stepIdx >= stepIdx) {
        active.pop();
      }
    }
    active.push({ st, stepIdx, rawLineIdx: idx });
  }
  return { active, rawEventCount, rollbackCount };
}

function mergeTimeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return 0;
  const sorted = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return 0;
  let total = 0;
  let [curS, curE] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [ns, ne] = sorted[i];
    if (ns <= curE) {
      if (ne > curE) curE = ne;
    } else {
      total += (curE - curS);
      curS = ns;
      curE = ne;
    }
  }
  total += (curE - curS);
  return total;
}

function parseTranscriptStepTimestampHeader(content) {
  const m = String(content || '').match(/^Created At:\s*([^\r\n]+)[\r\n]+Completed At:\s*([^\r\n]+)/);
  if (!m) return null;
  const s = Date.parse(m[1].trim());
  const e = Date.parse(m[2].trim());
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  const dur = e - s;
  if (dur > 3600000) return null;
  return { startMs: s, endMs: e, durationMs: dur };
}

const CAT_DEFS = [
  { key: 'system', label: '系统提示词', color: '#6366f1', cssVar: 'var(--color-indigo-500)' },
  { key: 'tools', label: '工具定义', color: '#f59e0b', cssVar: 'var(--color-amber-500)' },
  { key: 'user', label: '用户消息', color: '#22c55e', cssVar: 'var(--color-green-500)' },
  { key: 'inject', label: '注入内容', color: '#a855f7', cssVar: 'var(--color-purple-500)' },
  { key: 'skill', label: '技能注入', color: '#f97316', cssVar: 'var(--color-orange-500)' },
  { key: 'assistant', label: '助手消息', color: '#3b82f6', cssVar: 'var(--color-blue-500)' },
  { key: 'tool', label: '工具结果', color: '#14b8a6', cssVar: 'var(--color-teal-500)' }
];

function computeTrendsAndEvents({ summary, timelineSnapshots, stepMetaByIdx, sysBaseEst, toolsBaseEst }) {
  const invs = summary?.invocations || [];
  let prevContext = 0;
  let prevCats = null;
  let prevModel = '';

  const contextEvents = [];
  let totalCostUsd = 0;
  const costBreakdownMap = new Map();

  // Map invocation stepIndex to parsed transcript snapshot/brief
  const trends = invs.map((inv, idx) => {
    const stepIndices = Array.isArray(inv.stepIndices) ? inv.stepIndices : [];
    const primaryStep = stepIndices.length > 0
      ? stepIndices[0]
      : (inv.lastStepIndex >= 0 ? inv.lastStepIndex : (idx + 1));

    const promptTokens = (inv.inputTokens || 0) + (inv.cacheReadTokens || 0);
    const contextTokens = inv.estimatedContextTokens > 0 ? inv.estimatedContextTokens : promptTokens;
    const deltaTokens = idx === 0 ? contextTokens : (contextTokens - prevContext);
    const compacted = idx > 0 && prevContext > 30000 && contextTokens < prevContext * 0.78;
    prevContext = contextTokens;

    const modelName = inv.actualModelLabel || inv.sentModel || inv.responseModel || 'unknown';
    const costInfo = estimateInvocationCost(
      inv.responseModel || inv.sentModel || inv.modelEnum || inv.actualModelLabel || '',
      inv.inputTokens,
      inv.cacheReadTokens,
      inv.outputTokens,
      { atMs: inv.timestampMs || summary?.updatedAtMs }
    );
    totalCostUsd += costInfo.usd;
    const cEntry = costBreakdownMap.get(modelName) || {
      model: modelName,
      usd: 0,
      uncached: 0,
      cacheRead: 0,
      output: 0,
      rate: costInfo.rate
    };
    cEntry.usd += costInfo.usd;
    cEntry.uncached += (inv.inputTokens || 0);
    cEntry.cacheRead += (inv.cacheReadTokens || 0);
    cEntry.output += (inv.outputTokens || 0);
    costBreakdownMap.set(modelName, cEntry);

    // Locate closest cumulative snapshot from transcript.jsonl at or before this invocation
    let snap = null;
    for (let s = timelineSnapshots.length - 1; s >= 0; s--) {
      if (timelineSnapshots[s].stepIndex <= primaryStep || s === Math.min(idx, timelineSnapshots.length - 1)) {
        snap = timelineSnapshots[s];
        break;
      }
    }
    if (!snap && timelineSnapshots.length > 0) {
      snap = timelineSnapshots[Math.min(idx, timelineSnapshots.length - 1)];
    }

    const rawCats = {
      system: sysBaseEst,
      tools: toolsBaseEst,
      user: snap ? snap.user : 0,
      inject: snap ? snap.inject : 0,
      skill: snap ? snap.skill : 0,
      assistant: Math.max(snap ? snap.assistant : 0, inv.thinkingOutputTokens || 0),
      tool: snap ? snap.tool : 0
    };
    const rawCatSum = Object.values(rawCats).reduce((a, b) => a + b, 0) || 1;
    const cats = {};
    let maxK = 'system';
    let scaledSum = 0;
    for (const def of CAT_DEFS) {
      const v = Math.round((rawCats[def.key] / rawCatSum) * contextTokens);
      cats[def.key] = v;
      scaledSum += v;
      if (rawCats[def.key] > rawCats[maxK]) maxK = def.key;
    }
    if (contextTokens > 0) {
      cats[maxK] = Math.max(0, cats[maxK] + (contextTokens - scaledSum));
    }

    const catDeltas = {};
    for (const def of CAT_DEFS) {
      catDeltas[def.key] = prevCats ? (cats[def.key] - prevCats[def.key]) : cats[def.key];
    }
    prevCats = cats;

    const sm = stepMetaByIdx.get(primaryStep) || (snap ? stepMetaByIdx.get(snap.stepIndex) : null);
    const turn = sm?.turn || snap?.turn || 1;
    const activeMs = Math.round(((inv.ttftSeconds || 0) + (inv.streamingSeconds || 0)) * 1000) + (sm?.toolDurMs || 0);
    const cacheTotal = (inv.inputTokens || 0) + (inv.cacheReadTokens || 0);
    const cachePct = cacheTotal > 0 ? Number(((inv.cacheReadTokens / cacheTotal) * 100).toFixed(1)) : 0;

    if (prevModel && modelName !== prevModel) {
      contextEvents.push({
        kind: 'model',
        from: prevModel,
        to: modelName,
        turn,
        step: primaryStep,
        idx: inv.idx + 1,
        time: sm?.createdAt || '',
        deltaTokens: 0
      });
    }
    prevModel = modelName;

    if (compacted) {
      contextEvents.push({
        kind: 'compaction',
        detail: `上下文压缩 (${fmtCompactTokensDsh(Math.abs(deltaTokens))})`,
        tokens: deltaTokens,
        turn,
        step: primaryStep,
        idx: inv.idx + 1,
        time: sm?.createdAt || ''
      });
    }

    return {
      idx: inv.idx + 1,
      stepIndex: primaryStep,
      step: primaryStep,
      turn,
      createdAt: sm?.createdAt || '',
      model: modelName,
      sentModel: inv.sentModel || '',
      responseModel: inv.responseModel || '',
      contextTokens,
      deltaTokens,
      cats,
      catDeltas,
      activeMs,
      inputTokens: inv.inputTokens || 0,
      cacheReadTokens: inv.cacheReadTokens || 0,
      cachePct,
      outputTokens: inv.outputTokens || 0,
      thinkingTokens: inv.thinkingOutputTokens || 0,
      bodyTokens: inv.bodyOutputTokens || 0,
      ttftSeconds: Number((inv.ttftSeconds || 0).toFixed(2)),
      streamingSeconds: Number((inv.streamingSeconds || 0).toFixed(2)),
      tps: inv.tps || 0,
      e2eTps: inv.e2eTps || 0,
      tpsApprox: Boolean(inv.tpsApprox),
      compacted,
      estimatedCostUsd: Number(costInfo.usd.toFixed(6)),
      brief: sm?.brief || {
        userText: snap?.lastUserPreview || '',
        inputTools: [],
        replySummary: '',
        replyTools: [],
        browserStepIndex: primaryStep
      }
    };
  });

  return {
    trends,
    modelAndCompactionEvents: contextEvents,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    costBreakdown: Array.from(costBreakdownMap.values())
      .map(c => ({ ...c, usd: Number(c.usd.toFixed(4)) }))
      .sort((a, b) => b.usd - a.usd)
  };
}

/**
 * Computes DSH-style Session Stats (`turns`, `steps`, `toolMs`, `llmMs`, `body/thinking`),
 * 7-category Context Composition, 8-bucket Token Stats Donut, Request Trends + Briefs,
 * Context Events, File Activity (+/- lines & ops), Command Executions, and Context Browser items
 * strictly from compact `transcript.jsonl` + SQLite `summary` (never reads `transcript_full.jsonl`).
 */
export function getSessionTranscriptAnalytics(conversationId, summary = null, options = {}) {
  const includeBrowser = Boolean(options?.includeBrowser);
  const resolvedSummary = summary || (conversationId ? getConversationModelsFromDb(conversationId) : null);
  const transcriptFile = conversationId
    ? path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl')
    : '';

  let stat = null;
  if (transcriptFile && fs.existsSync(transcriptFile)) {
    try { stat = fs.statSync(transcriptFile); } catch {}
  }

  const invCount = resolvedSummary?.invocationCount || 0;
  const fleet = conversationId ? getFleetUsageRollup(conversationId, resolvedSummary) : null;
  const fleetStamp = fleet?.stamp || '';
  const cached = conversationId ? transcriptAnalyticsCache.get(conversationId) : null;
  const promptRevision = getPromptSourcesRevision(conversationId);
  if (
    cached &&
    cached.promptRevision === promptRevision &&
    cached.mtimeMs === (stat?.mtimeMs || 0) &&
    cached.size === (stat?.size || 0) &&
    cached.invCount === invCount &&
    cached.fleetStamp === fleetStamp
  ) {
    transcriptAnalyticsCache.delete(conversationId);
    transcriptAnalyticsCache.set(conversationId, cached);
    return includeBrowser ? cached.data : cached.dataNoBrowser;
  }

  let turns = 0;
  let steps = 0;
  let plannerSteps = 0;
  let cortexSteps = 0;
  let rollbackCount = 0;
  let answers = 0;
  let firstUserTokensEst = 0;
  let cumUser = 0;
  let cumInject = 0;
  let cumSkill = 0;
  let cumAssistant = 0;
  let cumTool = 0;
  let cumAnswerTok = 0;
  let cumThinkingTok = 0;
  let cumCallTok = 0;

  const toolIntervals = [];
  const toolCounts = {};
  const programMap = new Map();
  const fileMap = new Map();
  const skillLoads = [];
  const transcriptEvents = [];
  const commandRecords = [];
  const browserItems = [];
  const timelineSnapshots = [];
  const stepMetaByIdx = new Map();

  let currentTurnUserPreview = '';
  let lastTurnUserStepIdx = -1;

  if (stat && transcriptFile) {
    try {
      const content = fs.readFileSync(transcriptFile, 'utf8');
      const lines = content.split(/\r?\n/);
      const { active: activeEvents, rollbackCount: activeRollbacks } = parseActiveTranscriptEvents(lines);
      rollbackCount = activeRollbacks;
      cortexSteps = activeEvents.length;
      let pendingCallsQueue = [];
      let prevStepInputTools = [];

      for (const { st, stepIdx } of activeEvents) {
        const stType = String(st.type || '');
        const stSource = String(st.source || '');
        const createdAt = st.created_at || '';
        const createdMs = createdAt ? Date.parse(createdAt) : NaN;
        const truncated = Array.isArray(st.truncated_fields) && st.truncated_fields.length > 0;

        if (stType === 'USER_INPUT' && stSource === 'USER_EXPLICIT') {
          turns++;
          pendingCallsQueue = [];
          prevStepInputTools = [];

          const rawText = String(st.content || '');
          const cleanText = stripPromptWrapperTags(rawText);
          const tok = estTokensFromChars(cleanText.length);
          if (turns === 1) firstUserTokensEst = tok;
          cumUser += tok;
          if (rawText.length > cleanText.length) {
            cumInject += estTokensFromChars(rawText.length - cleanText.length);
          }
          currentTurnUserPreview = cleanText.replace(/\s+/g, ' ').slice(0, 140);
          lastTurnUserStepIdx = stepIdx;

          browserItems.push({
            stepIndex: stepIdx,
            turn: turns,
            cat: 'user',
            role: 'user',
            type: stType,
            source: stSource,
            createdAt,
            durationMs: null,
            status: 'ok',
            truncated,
            estTokens: tok,
            toolNames: [],
            previewText: cleanText.slice(0, 3500),
            thinkingText: '',
            toolCallsJson: ''
          });
        } else if (stType === 'PLANNER_RESPONSE') {
          if (st.status !== 'ERROR') plannerSteps++;
          const text = String(st.content || '');
          const thinking = String(st.thinking || '');
          const tcs = Array.isArray(st.tool_calls) ? st.tool_calls : [];
          const tcJson = tcs.length > 0 ? JSON.stringify(tcs, null, 2) : '';

          if (text.trim().length > 0 && tcs.length === 0) {
            answers++;
          }

          const textTok = estTokensFromChars(text.length);
          const thinkTok = estTokensFromChars(thinking.length);
          const tcTok = estTokensFromChars(tcJson.length);
          cumAssistant += textTok + thinkTok + tcTok;
          cumAnswerTok += textTok;
          cumThinkingTok += thinkTok;
          cumCallTok += tcTok;

          const callNames = tcs.map(tc => String(tc?.name || 'tool'));
          const plannerTs = (tcs.length > 0 && Number.isFinite(createdMs)) ? createdMs : 0;
          pendingCallsQueue = [];

          for (const tc of tcs) {
            const tName = String(tc?.name || 'unknown');
            toolCounts[tName] = (toolCounts[tName] || 0) + 1;
            const args = tc?.args || {};

            if (tName === 'enter_plan_mode' || tName === 'exit_plan_mode') {
              transcriptEvents.push({
                kind: 'mode',
                detail: tName === 'enter_plan_mode' ? '进入计划模式 (enter_plan_mode)' : '退出计划模式 (exit_plan_mode)',
                turn: turns || 1,
                step: stepIdx,
                time: createdAt
              });
            }

            if (tName === 'read_file' || tName === 'edit_file' || tName === 'write_file' || tName === 'grep_search' || tName === 'find_by_name') {
              let rawPath = '';
              let kind = 'read';
              let added = 0;
              let removed = 0;
              let opDetail = '';

              if (tName === 'read_file') {
                rawPath = unquoteArg(args.Path || args.path || '');
                kind = 'read';
                const sLine = Number(args.StartLine || 0);
                const eLine = Number(args.EndLine || 0);
                if (sLine > 0 && eLine >= sLine) {
                  opDetail = `L${sLine}–${eLine} (${eLine - sLine + 1} 行)`;
                }
              } else if (tName === 'edit_file') {
                rawPath = unquoteArg(args.Path || args.path || '');
                kind = 'write';
                added = countLinesCount(args.Replacement || '');
                removed = countLinesCount(args.Target || '');
                opDetail = `+${added} / -${removed} 行`;
              } else if (tName === 'write_file') {
                rawPath = unquoteArg(args.Path || args.path || '');
                kind = 'write';
                added = countLinesCount(args.Content || '');
                removed = 0;
                opDetail = `写入 ${added} 行`;
              } else {
                rawPath = unquoteArg(args.SearchPath || args.SearchDirectory || args.Query || args.Pattern || '');
                kind = 'search';
                const q = unquoteArg(args.Query || args.Pattern || '');
                opDetail = q ? `匹配: ${q.slice(0, 60)}` : '目录检索';
              }

              if (rawPath) {
                const normP = rawPath.replace(/\\/g, '/');
                const lastSlash = normP.lastIndexOf('/');
                const basename = lastSlash >= 0 ? normP.slice(lastSlash + 1) : normP;
                const directory = lastSlash >= 0 ? normP.slice(0, lastSlash + 1) : '';
                const dotIdx = basename.lastIndexOf('.');
                const ext = dotIdx > 0 ? basename.slice(dotIdx + 1).toLowerCase() : '';

                const entry = fileMap.get(normP) || {
                  path: normP,
                  basename,
                  directory,
                  ext,
                  reads: 0,
                  writes: 0,
                  searches: 0,
                  added: 0,
                  removed: 0,
                  lastStep: stepIdx,
                  lastTime: createdAt,
                  ops: []
                };
                if (kind === 'read') entry.reads++;
                else if (kind === 'write') entry.writes++;
                else entry.searches++;
                entry.added += added;
                entry.removed += removed;
                entry.lastStep = stepIdx;
                entry.lastTime = createdAt;
                entry.ops.push({
                  stepIndex: stepIdx,
                  turn: turns || 1,
                  kind,
                  tool: tName,
                  added,
                  removed,
                  detail: opDetail,
                  createdAt,
                  err: false
                });
                fileMap.set(normP, entry);
              }
            }

            pendingCallsQueue.push({
              name: tName,
              args,
              stepIndex: stepIdx,
              turn: turns || 1,
              plannerTs,
              createdAt
            });
          }

          stepMetaByIdx.set(stepIdx, {
            turn: turns || 1,
            createdAt,
            toolDurMs: 0,
            brief: {
              userText: currentTurnUserPreview,
              userStepIndex: lastTurnUserStepIdx,
              inputTools: prevStepInputTools.slice(0, 4),
              replySummary: text.replace(/\s+/g, ' ').slice(0, 140),
              replyTools: callNames.slice(0, 4),
              browserStepIndex: stepIdx
            }
          });
          prevStepInputTools = [];

          timelineSnapshots.push({
            stepIndex: stepIdx,
            turn: turns || 1,
            user: cumUser,
            inject: cumInject,
            skill: cumSkill,
            assistant: cumAssistant,
            tool: cumTool,
            lastUserPreview: currentTurnUserPreview
          });

          browserItems.push({
            stepIndex: stepIdx,
            turn: turns || 1,
            cat: 'assistant',
            role: 'assistant',
            type: stType,
            source: stSource,
            createdAt,
            durationMs: null,
            status: st.status === 'ERROR' ? 'error' : 'ok',
            truncated,
            estTokens: textTok + thinkTok + tcTok,
            answerTokens: textTok,
            thinkingTokens: thinkTok,
            callTokens: tcTok,
            toolNames: callNames,
            previewText: text.slice(0, 3500),
            thinkingText: thinking.slice(0, 2500),
            toolCallsJson: tcJson.slice(0, 2500)
          });
        } else if (stType === 'GENERIC') {
          const body = String(st.content || '');
          const tok = estTokensFromChars(body.length);
          const pending = pendingCallsQueue.shift() || null;
          const matchedTool = pending?.name || 'tool';

          let durMs = null;
          const hdrTime = parseTranscriptStepTimestampHeader(body);
          if (hdrTime) {
            durMs = hdrTime.durationMs;
            if (hdrTime.durationMs > 0) {
              toolIntervals.push([hdrTime.startMs, hdrTime.endMs]);
            }
          } else if (pending?.plannerTs > 0 && Number.isFinite(createdMs) && createdMs > pending.plannerTs && (createdMs - pending.plannerTs) < 600000) {
            durMs = createdMs - pending.plannerTs;
            toolIntervals.push([pending.plannerTs, createdMs]);
          }

          if (pending?.stepIndex !== undefined && stepMetaByIdx.has(pending.stepIndex) && durMs) {
            stepMetaByIdx.get(pending.stepIndex).toolDurMs += durMs;
          }

          const exitMatch = body.match(/Command exited with code (\d+)/i);
          const exitCode = exitMatch ? Number(exitMatch[1]) : null;
          const isErr = st.status === 'ERROR' ||
            (exitCode !== null && exitCode !== 0) ||
            /Encountered error in tool execution/i.test(body.slice(0, 800));

          const readPath = pending?.name === 'read_file' ? unquoteArg(pending.args?.Path || pending.args?.path || '') : '';
          const skillName = readPath ? extractSkillNameFromPath(readPath) : '';

          if (skillName) {
            cumSkill += tok;
            skillLoads.push({
              name: skillName,
              path: readPath.replace(/\\/g, '/'),
              stepIndex: stepIdx,
              turn: turns || 1,
              tokens: tok,
              createdAt
            });
            transcriptEvents.push({
              kind: 'inject',
              name: skillName,
              detail: `加载技能 ${skillName}`,
              tokens: tok,
              turn: turns || 1,
              step: stepIdx,
              time: createdAt
            });
          } else {
            cumTool += tok;
          }

          if (matchedTool === 'run_command' && pending?.args) {
            const cmdLine = unquoteArg(pending.args.CommandLine || '');
            const cmdSummary = unquoteArg(pending.args.toolSummary || '');
            const prog = parseProgramFromCommand(cmdLine);
            const isBg = unquoteArg(pending.args.IsDaemon).toLowerCase() === 'true' ||
              Number(pending.args.WaitMsBeforeAsync || 5000) <= 600 ||
              /background task/i.test(body.slice(0, 400));

            const progEntry = programMap.get(prog) || { name: prog, calls: 0, runs: 0 };
            progEntry.calls++;
            progEntry.runs++;
            programMap.set(prog, progEntry);

            commandRecords.push({
              seq: commandRecords.length + 1,
              stepIndex: pending.stepIndex,
              resultStepIndex: stepIdx,
              turn: turns || 1,
              program: prog,
              tool: 'run_command',
              summary: cmdSummary || cmdLine.slice(0, 72),
              command: cmdLine,
              background: isBg,
              durationMs: durMs || 0,
              status: isErr ? 'failed' : 'completed',
              exitCode: exitCode ?? (isErr ? 1 : 0),
              err: isErr,
              outChars: body.length,
              lines: countLinesCount(body),
              outputPreview: body.slice(0, 2200),
              createdAt
            });
          }

          prevStepInputTools.push({
            tool: matchedTool,
            stepIndex: stepIdx,
            err: isErr,
            skill: skillName || '',
            label: skillName ? `skill:${skillName}` : matchedTool
          });

          browserItems.push({
            stepIndex: stepIdx,
            turn: turns || 1,
            cat: skillName ? 'skill' : 'tool',
            skillName: skillName || '',
            role: 'tool_result',
            type: stType,
            source: stSource,
            createdAt,
            durationMs: durMs,
            status: isErr ? 'error' : 'ok',
            truncated,
            estTokens: tok,
            toolNames: matchedTool ? [matchedTool] : [],
            previewText: body.slice(0, 3500),
            thinkingText: '',
            toolCallsJson: pending?.args ? JSON.stringify(pending.args, null, 2).slice(0, 1600) : ''
          });
        } else {
          const body = String(st.content || '');
          const tok = estTokensFromChars(body.length);
          cumInject += tok;
          pendingCallsQueue = [];

          browserItems.push({
            stepIndex: stepIdx,
            turn: turns || 1,
            cat: 'inject',
            role: 'system',
            type: stType || 'SYSTEM',
            source: stSource,
            createdAt,
            durationMs: null,
            status: st.status === 'ERROR' ? 'error' : 'ok',
            truncated,
            estTokens: tok,
            toolNames: [],
            previewText: body.slice(0, 3500),
            thinkingText: '',
            toolCallsJson: ''
          });
        }
      }
    } catch {}
  }

  steps = invCount > 0 ? Math.max(invCount, plannerSteps) : plannerSteps;
  if (turns === 0 && invCount > 0) turns = 1;
  if (answers === 0 && invCount > 0) answers = Math.max(1, turns);

  const toolMs = Math.round(mergeTimeIntervals(toolIntervals));
  const lm = resolvedSummary?.latestModel || null;
  const totals = resolvedSummary?.totals || {};
  const firstInv = resolvedSummary?.invocations?.[0] || null;
  const firstPromptTok = firstInv ? ((firstInv.inputTokens || 0) + (firstInv.cacheReadTokens || 0)) : 0;
  const combinedBaseEst = firstPromptTok > 0
    ? Math.max(6000, firstPromptTok - firstUserTokensEst)
    : 14000;
  // Explicitly distinguish captured system messages, local rules and estimates.
  const promptSources = getPromptSources(conversationId);
  const requestSystem = promptSources.sources.find(s => s.kind === 'captured-system' && s.provenance === 'request-metadata');
  const nativeCapture = promptSources.sources.find(s => s.kind === 'captured-system' && s.source.startsWith('native_captures/'));
  const capturedSystem = requestSystem ? [requestSystem] : nativeCapture ? [nativeCapture] : promptSources.sources.filter(s => s.kind === 'captured-system');
  const systemText = capturedSystem.length
    ? capturedSystem.map(s => s.text).join('\n\n')
    : '【系统提示词原文未捕获】AGY 的本地会话日志没有提供完整 system role。以下是当前可读取的插件规则，不代表本次请求的完整系统提示词。\n\n' + promptSources.sources.map(s => `来源: ${s.source}\n${s.text}`).join('\n\n');
  const sysBaseEst = capturedSystem.length ? estTokensFromChars(systemText.length) : Math.round(combinedBaseEst * 0.58);
  const toolSchemaText = requestSystem ? JSON.stringify(requestSystem.requestTools, null, 2) : '';
  const toolsBaseEst = requestSystem ? (requestSystem.requestTools.length ? estTokensFromChars(toolSchemaText.length) : 0) : Math.max(0, combinedBaseEst - sysBaseEst);
  const requestWeights = requestSystem ? {system: sysBaseEst, tools: toolsBaseEst, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0} : null;
  const skillSteps = new Set(browserItems.filter(item => item.cat === 'skill').map(item => item.stepIndex));
  const requestBrowserItems = (requestSystem?.requestMessages || []).map((message, index) => {
    const cat = skillSteps.has(message.stepIndex) ? 'skill' : message.toolCallId || message.source === 4 ? 'tool' :
      message.source === 1 ? 'user' : message.source === 2 ? 'assistant' : 'inject';
    const toolCallsJson = message.toolCalls.length ? JSON.stringify(message.toolCalls, null, 2) : '';
    const tokens = message.numTokens > 0 ? message.numTokens : estTokensFromChars(message.prompt.length + message.thinking.length + toolCallsJson.length);
    requestWeights[cat] += tokens;
    return {
      stepIndex: message.stepIndex ?? -1000 - index, turn: stepMetaByIdx.get(message.stepIndex)?.turn || 1,
      cat, role: cat, type: 'REQUEST_MESSAGE', source: 'HOST_REQUEST_METADATA', createdAt: '',
      durationMs: null, status: 'ok', truncated: false, contentCaptured: true, tokenEstimate: message.numTokens <= 0,
      estTokens: tokens, toolNames: message.toolCalls.map(call => call.name), previewText: message.prompt,
      thinkingText: message.thinking, toolCallsJson
    };
  });

  // Inject synthetic System & Tool Schema entries at the start of browserItems for 7-category Browser completeness
  const observedToolList = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  const syntheticHeaders = [
    {
      stepIndex: -2,
      turn: 0,
      cat: 'system',
      role: 'system',
      type: 'SYSTEM_PROMPT',
      source: 'HOST_INSTRUCTIONS',
      createdAt: capturedSystem[0]?.capturedAt || browserItems[0]?.createdAt || '',
      durationMs: null,
      status: 'ok',
      truncated: false,
      estTokens: sysBaseEst,
      toolNames: [],
      previewText: systemText,
      contentCaptured: promptSources.captured,
      tokenEstimate: true,
      thinkingText: '',
      toolCallsJson: ''
    },
    {
      stepIndex: -1,
      turn: 0,
      cat: 'tools',
      role: 'tools',
      type: 'TOOL_SCHEMAS',
      declarations: requestSystem?.requestTools || null,
      source: 'HOST_DECLARATIONS',
      createdAt: browserItems[0]?.createdAt || '',
      durationMs: null,
      status: 'ok',
      truncated: false,
      estTokens: toolsBaseEst,
      toolNames: requestSystem ? requestSystem.requestTools.map(tool => tool.name) : observedToolList.map(([n]) => n),
      previewText: requestSystem ? toolSchemaText : observedToolList.length > 0
        ? `已观察到的工具调用 (${observedToolList.length} 个工具):\n` + observedToolList.map(([n, c]) => `• ${n}: ${c} 次调用`).join('\n')
        : '内置工具与 MCP 工具 Schema 声明区',
      thinkingText: '',
      toolCallsJson: requestSystem ? toolSchemaText : observedToolList.length > 0 ? JSON.stringify(Object.fromEntries(observedToolList), null, 2) : ''
    }
  ];
  const fullBrowserItems = [...syntheticHeaders, ...(requestSystem ? requestBrowserItems : browserItems)];

  const effectiveAssistant = Math.max(cumAssistant, totals.thinkingTokens || 0);
  const rawByCat = requestWeights || {
    system: sysBaseEst,
    tools: toolsBaseEst,
    user: cumUser,
    inject: cumInject,
    skill: cumSkill,
    assistant: effectiveAssistant,
    tool: cumTool
  };
  const rawSum = Object.values(rawByCat).reduce((a, b) => a + b, 0);
  const latestCtx = lm
    ? (lm.estimatedContextTokens > 0 ? lm.estimatedContextTokens : ((lm.inputTokens || 0) + (lm.cacheReadTokens || 0)))
    : 0;
  const targetCtx = latestCtx > 0 ? latestCtx : rawSum;
  const maxCtx = lm?.maxContextTokens || 1048576;

  const buckets = CAT_DEFS.map(def => {
    const tokens = rawSum > 0 ? Math.round((rawByCat[def.key] / rawSum) * targetCtx) : 0;
    const pct = targetCtx > 0 ? Number(((tokens / targetCtx) * 100).toFixed(1)) : 0;
    return {
      key: def.key,
      label: def.label,
      color: def.color,
      cssVar: def.cssVar,
      tokens,
      pct
    };
  });
  if (targetCtx > 0 && rawSum > 0) {
    const largest = buckets.reduce((a, b) => a.tokens >= b.tokens ? a : b);
    largest.tokens += targetCtx - buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
    largest.pct = Number((largest.tokens / targetCtx * 100).toFixed(1));
  }

  // Compute DSH Reserve bounds (Headroom 64k + Output Reserve 64k + Trigger line)
  const reserveOutputTokens = Math.min(65536, Math.round(maxCtx * 0.15));
  const reserveHeadroomTokens = Math.min(65536, Math.max(0, maxCtx - reserveOutputTokens));
  const reserveTriggerTokens = Math.min(Math.floor(maxCtx * 0.8), Math.max(0, maxCtx - reserveOutputTokens - reserveHeadroomTokens));

  // Compute DSH 8-bucket Token Stats Donut (billed input+cache scaled across context cats + generated output split)
  const billedIn = (totals.inputTokens || 0) + (totals.cacheReadTokens || 0);
  const billedOut = totals.outputTokens || 0;
  const totalBilled = billedIn + billedOut;
  const scaleIn = rawSum > 0 ? (billedIn / rawSum) : 0;
  const asstSplitTotal = Math.max(1, cumAnswerTok + cumThinkingTok + cumCallTok);
  const inAsstTot = Math.round(rawByCat.assistant * scaleIn);
  const inAsstThink = Math.round(inAsstTot * (cumThinkingTok / asstSplitTotal));
  const inAsstAns = Math.round(inAsstTot * (cumAnswerTok / asstSplitTotal));
  const inAsstCall = Math.max(0, inAsstTot - inAsstThink - inAsstAns);
  const outThink = Math.min(totals.thinkingTokens || 0, billedOut);
  const outRem = Math.max(0, billedOut - outThink);
  const outAns = Math.round(outRem * (cumAnswerTok / Math.max(1, cumAnswerTok + cumCallTok)));
  const outCall = Math.max(0, outRem - outAns);

  const tokenStatsDonut = [
    { key: 'system', label: '系统提示词', color: '#6366f1', value: Math.round(rawByCat.system * scaleIn) },
    { key: 'tools', label: '工具定义', color: '#f59e0b', value: Math.round(rawByCat.tools * scaleIn) },
    { key: 'user', label: '用户消息', color: '#22c55e', value: Math.round(rawByCat.user * scaleIn) },
    { key: 'inject', label: '注入内容', color: '#a855f7', value: Math.round(rawByCat.inject * scaleIn) },
    { key: 'skill', label: '技能注入', color: '#f97316', value: Math.round(rawByCat.skill * scaleIn) },
    { key: 'toolCalls', label: '工具调用与结果', color: '#14b8a6', value: Math.round(rawByCat.tool * scaleIn) + inAsstCall + outCall },
    { key: 'thinking', label: '模型思考', color: '#8b5cf6', value: inAsstThink + outThink },
    { key: 'answers', label: '模型回复', color: '#ec4899', value: inAsstAns + outAns }
  ].map(b => ({
    ...b,
    pct: totalBilled > 0 ? Number(((b.value / totalBilled) * 100).toFixed(1)) : 0
  }));

  const sortedTools = observedToolList.map(([name, count]) => ({ name, count }));

  const fileListAll = Array.from(fileMap.values()).map(f => ({
    ...f,
    ops: [...f.ops].reverse()
  }));
  const fileTotals = {
    readFiles: fileListAll.filter(f => f.reads > 0).length,
    readOps: fileListAll.reduce((a, f) => a + f.reads, 0),
    writeFiles: fileListAll.filter(f => f.writes > 0).length,
    writeOps: fileListAll.reduce((a, f) => a + f.writes, 0),
    searchFiles: fileListAll.filter(f => f.searches > 0).length,
    searchOps: fileListAll.reduce((a, f) => a + f.searches, 0),
    added: fileListAll.reduce((a, f) => a + f.added, 0),
    removed: fileListAll.reduce((a, f) => a + f.removed, 0)
  };
  const sortedFiles = fileListAll
    .sort((a, b) => (b.reads + b.writes + b.searches) - (a.reads + a.writes + a.searches))
    .slice(0, 150);

  const cmdTotalMs = commandRecords.reduce((a, c) => a + (c.durationMs || 0), 0);
  const cmdFailed = commandRecords.filter(c => c.err).length;
  const cmdBg = commandRecords.filter(c => c.background).length;
  const slowestCmd = commandRecords.reduce((best, c) => (!best || c.durationMs > best.durationMs ? c : best), null);
  const sortedProgs = Array.from(programMap.values()).sort((a, b) => b.calls - a.calls);

  const trendBuild = computeTrendsAndEvents({
    summary: resolvedSummary,
    timelineSnapshots,
    stepMetaByIdx,
    sysBaseEst,
    toolsBaseEst
  });

  const allEvents = [...trendBuild.modelAndCompactionEvents, ...transcriptEvents]
    .sort((a, b) => (a.step - b.step) || (String(a.time).localeCompare(String(b.time))));

  const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);

  const subagentCount = fleet?.subagentCount || 0;
  const subagentCostUsd = fleet?.subagents?.estimatedCostUsd || 0;
  const teamEstimatedCostUsd = fleet
    ? Number((trendBuild.totalCostUsd + subagentCostUsd).toFixed(6))
    : trendBuild.totalCostUsd;

  const data = {
    conversationId,
    fleetUsage: fleet,
    sessionStats: {
      turns,
      steps,
      cortexSteps,
      rollbackCount,
      answers,
      skillLoadCount: skillLoads.length,
      totalToolCalls,
      samples: totals.decodeSamples || invCount,
      invocationCount: invCount,
      llmMs: totals.llmMs || 0,
      ttftMs: totals.ttftMs || 0,
      streamingMs: totals.streamingMs || 0,
      toolMs,
      avgTtftSeconds: totals.avgTtftSeconds || 0,
      sessionTps: totals.avgTps || 0,
      sessionTpsApprox: Boolean(totals.avgTpsApprox),
      sessionE2eTps: totals.avgE2eTps || 0,
      latestTps: lm?.tps || 0,
      latestE2eTps: lm?.e2eTps || 0,
      latestTpsApprox: Boolean(lm?.tpsApprox),
      bodyOutputTokens: totals.responseOutputTokens || 0,
      thinkingOutputTokens: totals.thinkingTokens || 0,
      outputTokens: totals.outputTokens || 0,
      uncachedInputTokens: totals.inputTokens || 0,
      cacheReadTokens: totals.cacheReadTokens || 0,
      totalTokens: totals.totalSessionTokens || 0,
      cacheHitPct: totals.cacheHitPct || 0,
      estimatedCostUsd: trendBuild.totalCostUsd,
      costBreakdown: trendBuild.costBreakdown,
      subagentCount,
      subagentSteps: fleet?.subagents?.invocationCount || 0,
      subagentTokens: fleet?.subagents?.totalTokens || 0,
      subagentUncachedInputTokens: fleet?.subagents?.inputTokens || 0,
      subagentCacheReadTokens: fleet?.subagents?.cacheReadTokens || 0,
      subagentOutputTokens: fleet?.subagents?.outputTokens || 0,
      subagentThinkingOutputTokens: fleet?.subagents?.thinkingTokens || 0,
      subagentCostUsd,
      teamSteps: fleet?.team?.invocationCount ?? steps,
      teamTotalTokens: fleet?.team?.totalTokens ?? (totals.totalSessionTokens || 0),
      teamUncachedInputTokens: fleet?.team?.inputTokens ?? (totals.inputTokens || 0),
      teamCacheReadTokens: fleet?.team?.cacheReadTokens ?? (totals.cacheReadTokens || 0),
      teamOutputTokens: fleet?.team?.outputTokens ?? (totals.outputTokens || 0),
      teamThinkingOutputTokens: fleet?.team?.thinkingTokens ?? (totals.thinkingTokens || 0),
      teamCacheHitPct: fleet?.team?.cacheHitPct ?? (totals.cacheHitPct || 0),
      teamEstimatedCostUsd
    },
    composition: {
      source: requestSystem ? 'request-metadata' : 'transcript-estimate',
      invocationIndex: requestSystem?.invocationIndex ?? null,
      estimateNote: requestSystem ? '分类按最近实际请求内容估算，合计使用宿主记录。' : '分类按会话日志估算。',
      totalTokens: targetCtx,
      maxTokens: maxCtx,
      pct: maxCtx > 0 ? Number(((targetCtx / maxCtx) * 100).toFixed(1)) : 0,
      reserve: {
        outputTokens: reserveOutputTokens,
        headroomTokens: reserveHeadroomTokens,
        triggerTokens: reserveTriggerTokens
      },
      buckets,
      tokenStatsDonut
    },
    trends: trendBuild.trends,
    contextEvents: allEvents,
    skillLoads,
    activitySummary: {
      toolCounts: sortedTools,
      files: sortedFiles,
      fileTotals,
      recentCommands: commandRecords.slice(-100).reverse(),
      commandStats: {
        runs: commandRecords.length,
        failed: cmdFailed,
        totalMs: cmdTotalMs,
        background: cmdBg
      },
      programTally: sortedProgs,
      commandAttention: {
        slowest: slowestCmd ? { program: slowestCmd.program, summary: slowestCmd.summary, durationMs: slowestCmd.durationMs } : null,
        topProgram: sortedProgs[0] || null
      }
    },
    browserItems: fullBrowserItems
  };

  const { browserItems: _omit, ...dataNoBrowser } = data;
  if (conversationId) {
    transcriptAnalyticsCache.delete(conversationId);
    if (transcriptAnalyticsCache.size >= 8) {
      const oldestKey = transcriptAnalyticsCache.keys().next().value;
      if (oldestKey !== undefined) transcriptAnalyticsCache.delete(oldestKey);
    }
    transcriptAnalyticsCache.set(conversationId, {
      promptRevision,
      mtimeMs: stat?.mtimeMs || 0,
      size: stat?.size || 0,
      invCount,
      fleetStamp,
      data,
      dataNoBrowser
    });
  }

  return includeBrowser ? data : dataNoBrowser;
}

/**
 * Reconstructs the parent coordinator + child subagents Fleet hierarchy,
 * delegation briefs, inter-agent messages, and per-node context composition.
 */
export function getFleetHierarchy(conversationId) {
  const empty = {
    rootId: conversationId || '',
    currentId: conversationId || '',
    nodes: [],
    delegations: [],
    comms: [],
    recentMultiAgentSessions: []
  };
  if (!conversationId || !fs.existsSync(SUMMARIES_DB_PATH)) return empty;

  const fleetStamp = getFileStamp(SUMMARIES_DB_PATH);
  const cachedFleet = fleetHierarchyCache.get(conversationId);
  if (cachedFleet && cachedFleet.stamp === fleetStamp) {
    fleetHierarchyCache.delete(conversationId);
    fleetHierarchyCache.set(conversationId, cachedFleet);
    return cachedFleet.data;
  }

  let sdb;
  try {
    sdb = new DatabaseSync(SUMMARIES_DB_PATH, { readOnly: true });
    const getRow = sdb.prepare(
      'SELECT conversation_id, parent_conversation_id, title, status FROM conversation_summaries WHERE conversation_id = ?'
    );
    const getChildren = sdb.prepare(
      'SELECT conversation_id, parent_conversation_id, title, status FROM conversation_summaries WHERE parent_conversation_id = ?'
    );

    let rootId = conversationId;
    const seenUp = new Set([rootId]);
    for (let depth = 0; depth < 6; depth++) {
      const r = getRow.get(rootId);
      const pid = String(r?.parent_conversation_id || '').trim();
      if (!pid || seenUp.has(pid)) break;
      seenUp.add(pid);
      rootId = pid;
    }

    const queue = [rootId];
    const visited = new Set([rootId]);
    const rawNodes = [];
    while (queue.length > 0 && rawNodes.length < 128) {
      const cid = queue.shift();
      const row = getRow.get(cid);
      rawNodes.push({
        conversationId: cid,
        parentConversationId: String(row?.parent_conversation_id || '').trim(),
        dbTitle: String(row?.title || '').trim(),
        status: row?.status ?? null
      });
      const kids = getChildren.all(cid);
      for (const k of kids) {
        if (k?.conversation_id && !visited.has(k.conversation_id)) {
          visited.add(k.conversation_id);
          queue.push(k.conversation_id);
        }
      }
    }

    const metaByChildId = new Map();
    const delegations = [];
    const comms = [];

    for (const rn of rawNodes) {
      const tf = path.join(BRAIN_DIR, rn.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(tf)) continue;
      try {
        const lines = fs.readFileSync(tf, 'utf8').split(/\r?\n/);
        let lastInvokeQueue = [];
        for (const l of lines) {
          if (!l || (!l.includes('invoke_subagent') && !l.includes('send_message') && !l.includes('Created the following subagent') && !l.includes('sender='))) continue;
          let st;
          try { st = JSON.parse(l); } catch { continue; }
          if (st.type === 'PLANNER_RESPONSE' && Array.isArray(st.tool_calls)) {
            for (const tc of st.tool_calls) {
              if (tc?.name === 'invoke_subagent') {
                lastInvokeQueue.push({
                  role: unquoteArg(tc.args?.Role || ''),
                  typeName: unquoteArg(tc.args?.TypeName || ''),
                  requestedModel: unquoteArg(tc.args?.Model || ''),
                  prompt: unquoteArg(tc.args?.Prompt || '').slice(0, 1200),
                  time: st.created_at || ''
                });
              } else if (tc?.name === 'send_message') {
                comms.push({
                  kind: 'relay',
                  from: rn.conversationId,
                  to: unquoteArg(tc.args?.Recipient || ''),
                  text: unquoteArg(tc.args?.Message || '').slice(0, 1200),
                  time: st.created_at || ''
                });
              }
            }
          } else if (st.type === 'GENERIC') {
            const c = String(st.content || '');
            const m = c.match(/Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([^"]+)"/i);
            if (m?.[1]) {
              const info = lastInvokeQueue.shift() || {};
              const childCid = m[1].trim();
              metaByChildId.set(childCid, info);
              delegations.push({
                from: rn.conversationId,
                to: childCid,
                role: info.role || 'Subagent',
                prompt: info.prompt || '',
                time: st.created_at || info.time || ''
              });
            }
          } else if (st.type === 'SYSTEM_MESSAGE') {
            const c = String(st.content || '');
            const sm = c.match(/\bsender=([^\s\r\n>]+)/);
            if (sm?.[1]) {
              comms.push({
                kind: 'settled',
                from: sm[1].trim(),
                to: rn.conversationId,
                text: c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200),
                time: st.created_at || ''
              });
            }
          }
        }
      } catch {}
    }

    const nodes = rawNodes.map((rn, idx) => {
      const sum = getConversationModelsFromDb(rn.conversationId);
      const subMeta = metaByChildId.get(rn.conversationId) || null;
      const lm = sum?.latestModel || null;
      const tot = sum?.totals || {};
      const costEst = (sum?.invocations || []).reduce((acc, inv) => {
        return acc + estimateInvocationCost(inv.responseModel || inv.sentModel || inv.modelEnum || inv.modelDisplayName || '', inv.inputTokens, inv.cacheReadTokens, inv.outputTokens, { atMs: sum?.updatedAtMs }).usd;
      }, 0);
      const ctxUsed = lm?.estimatedContextTokens || ((lm?.inputTokens || 0) + (lm?.cacheReadTokens || 0));
      const ctxMax = lm?.maxContextTokens || 1048576;
      return {
        conversationId: rn.conversationId,
        parentConversationId: rn.parentConversationId,
        isRoot: rn.conversationId === rootId,
        isCurrent: rn.conversationId === conversationId,
        hueIndex: idx,
        title: sum?.title || rn.dbTitle || rn.conversationId.slice(0, 8),
        role: subMeta?.role || (rn.conversationId === rootId ? 'Coordinator (主协调器)' : 'Subagent Worker'),
        typeName: subMeta?.typeName || (rn.conversationId === rootId ? 'coordinator' : 'subagent'),
        requestedModel: subMeta?.requestedModel || '',
        promptBrief: subMeta?.prompt || '',
        status: rn.status,
        invocationCount: sum?.invocationCount || 0,
        actualModelLabel: lm?.actualModelLabel || lm?.responseModel || '-',
        modelDisplayName: lm?.modelDisplayName || '-',
        contextUsed: ctxUsed,
        contextMax: ctxMax,
        contextPct: ctxMax > 0 ? Number(((ctxUsed / ctxMax) * 100).toFixed(1)) : 0,
        totalTokens: tot.totalSessionTokens || 0,
        inputTokens: tot.inputTokens || 0,
        cacheReadTokens: tot.cacheReadTokens || 0,
        outputTokens: tot.outputTokens || 0,
        cacheHitPct: tot.cacheHitPct || 0,
        avgTps: tot.avgTps || 0,
        llmMs: tot.llmMs || 0,
        estimatedCostUsd: Number(costEst.toFixed(4)),
        updatedAt: sum?.updatedAt || ''
      };
    });

    const recentMulti = sdb.prepare(`
      SELECT p.conversation_id as conversationId, p.title as title, COUNT(c.conversation_id) as childCount
      FROM conversation_summaries p
      JOIN conversation_summaries c ON c.parent_conversation_id = p.conversation_id
      GROUP BY p.conversation_id
      ORDER BY p.rowid DESC
      LIMIT 8
    `).all();

    const result = {
      rootId,
      currentId: conversationId,
      nodes,
      delegations,
      comms,
      recentMultiAgentSessions: recentMulti.map(r => ({
        conversationId: r.conversationId,
        title: String(r.title || r.conversationId.slice(0, 8)),
        childCount: Number(r.childCount || 0)
      }))
    };
    fleetHierarchyCache.delete(conversationId);
    if (fleetHierarchyCache.size >= FLEET_CACHE_MAX) {
      const oldestKey = fleetHierarchyCache.keys().next().value;
      if (oldestKey !== undefined) fleetHierarchyCache.delete(oldestKey);
    }
    fleetHierarchyCache.set(conversationId, { stamp: fleetStamp, data: result });
    return result;
  } catch {
    return empty;
  } finally {
    try { sdb?.close(); } catch {}
  }
}

/**
 * Paginated, searchable query over model invocations for a conversation and its subagent fleet.
 * Defaults to aggregating the full coordinator + descendant tree newest-first while allowing
 * scoping to self (`'self'`) or any individual member (`'agent:<id>'`).
 */
export function queryConversationInvocations(conversationId, options = {}) {
  const cid = String(conversationId || '').trim();
  const scope = String(options?.scope || 'fleet').trim() || 'fleet';
  const search = String(options?.search || '').trim().toLowerCase();
  const onlyMismatch = Boolean(options?.onlyMismatch);
  const offset = Math.max(0, Math.floor(Number(options?.offset || 0) || 0));
  const limit = Math.min(500, Math.max(10, Math.floor(Number(options?.limit || 50) || 50)));

  if (!cid) {
    return {
      ok: true,
      conversationId: '',
      scope,
      offset,
      limit,
      total: 0,
      totalUnfiltered: 0,
      selfCount: 0,
      fleetCount: 0,
      hasSubagents: false,
      agents: [],
      items: [],
      fetchedAtMs: Date.now()
    };
  }

  const fleet = getFleetHierarchy(cid);
  let rawNodes = Array.isArray(fleet?.nodes) ? fleet.nodes : [];
  if (rawNodes.length === 0) {
    const fallbackSum = getConversationModelsFromDb(cid);
    if (fallbackSum) {
      rawNodes = [{
        conversationId: cid,
        parentConversationId: '',
        isRoot: true,
        isCurrent: true,
        title: fallbackSum.title || cid.slice(0, 8),
        role: 'Coordinator (主协调器)',
        invocationCount: fallbackSum.invocationCount || 0
      }];
    }
  }

  let subIdx = 0;
  const agents = [];
  const summaryById = new Map();
  const cleanLabel = (raw, fallback) => {
    const s = String(raw || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\bThe following is a\b[\s\S]*/i, '')
      .replace(/^\[Message\][\s\S]*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return fallback;
    return s.length > 36 ? `${s.slice(0, 35)}…` : s;
  };

  for (const node of rawNodes) {
    const nid = String(node.conversationId || '').trim();
    if (!nid) continue;
    const sum = getConversationModelsFromDb(nid);
    summaryById.set(nid, sum);
    const isRoot = Boolean(node.isRoot);
    const badge = isRoot ? '主' : `SW${++subIdx}`;
    const hueIndex = isRoot ? 0 : subIdx;
    const rawRole = (node.role && node.role !== 'Subagent Worker') ? node.role : '';
    const label = isRoot
      ? cleanLabel(node.title || sum?.title, '主会话')
      : cleanLabel(rawRole || node.title || sum?.title, node.role || badge);
    const title = cleanLabel(node.title || sum?.title, label);
    const count = sum?.invocationCount || Number(node.invocationCount || 0);
    agents.push({
      id: nid,
      badge,
      hueIndex,
      label,
      title,
      isRoot,
      isCurrent: nid === cid,
      count
    });
  }

  if (agents.length === 0) {
    const sum = getConversationModelsFromDb(cid);
    if (sum) {
      summaryById.set(cid, sum);
      agents.push({
        id: cid,
        badge: '主',
        hueIndex: 0,
        label: cleanLabel(sum.title, '主会话'),
        title: cleanLabel(sum.title, cid.slice(0, 8)),
        isRoot: true,
        isCurrent: true,
        count: sum.invocationCount || 0
      });
    }
  }

  const selfAgent = agents.find(a => a.isCurrent) || agents.find(a => a.isRoot) || agents[0] || null;
  const selfCount = selfAgent ? selfAgent.count : 0;
  const fleetCount = agents.reduce((acc, a) => acc + a.count, 0);

  let targetAgents = agents;
  if (scope === 'self') {
    targetAgents = selfAgent ? [selfAgent] : [];
  } else if (scope.startsWith('agent:')) {
    const targetAgentId = scope.slice(6).trim();
    targetAgents = agents.filter(a => a.id === targetAgentId);
  }

  const rows = [];
  for (const agent of targetAgents) {
    const sum = summaryById.get(agent.id) || getConversationModelsFromDb(agent.id);
    const invs = Array.isArray(sum?.invocations) ? sum.invocations : [];
    const len = invs.length;
    const updatedMs = Number(sum?.updatedAtMs || 0);
    for (let idx = 0; idx < len; idx++) {
      const inv = invs[idx];
      const ts = Number(inv.timestampMs || 0);
      const fallbackTs = updatedMs > 0 ? (updatedMs - (len - 1 - idx)) : (idx + 1);
      rows.push({
        ...inv,
        seqNum: idx + 1,
        agentId: agent.id,
        agentKind: agent.isRoot ? 'root' : 'subagent',
        agentBadge: agent.badge,
        agentHueIndex: agent.hueIndex,
        agentLabel: agent.label,
        agentTitle: agent.title,
        sortTs: ts > 0 ? ts : fallbackTs
      });
    }
  }

  if (targetAgents.length <= 1) {
    rows.reverse();
  } else {
    rows.sort((a, b) =>
      (b.sortTs - a.sortTs) ||
      ((a.agentKind === 'root' ? 0 : 1) - (b.agentKind === 'root' ? 0 : 1)) ||
      (b.seqNum - a.seqNum)
    );
  }

  const totalUnfiltered = rows.length;
  let filtered = rows;
  if (onlyMismatch) {
    filtered = filtered.filter(r =>
      Boolean(r.sentModel && r.responseModel && r.sentModel.toLowerCase() !== r.responseModel.toLowerCase())
    );
  }
  if (search) {
    filtered = filtered.filter(r =>
      String(r.sentModel || '').toLowerCase().includes(search) ||
      String(r.responseModel || '').toLowerCase().includes(search) ||
      String(r.responseModelFull || '').toLowerCase().includes(search) ||
      String(r.modelDisplayName || '').toLowerCase().includes(search) ||
      String(r.modelEnum || '').toLowerCase().includes(search) ||
      String(r.agentLabel || '').toLowerCase().includes(search) ||
      String(r.agentTitle || '').toLowerCase().includes(search) ||
      String(r.agentBadge || '').toLowerCase().includes(search) ||
      String(r.agentId || '').toLowerCase().includes(search)
    );
  }

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  return {
    ok: true,
    conversationId: cid,
    scope,
    offset,
    limit,
    total,
    totalUnfiltered,
    selfCount,
    fleetCount,
    hasSubagents: agents.length > 1,
    agents,
    items,
    fetchedAtMs: Date.now()
  };
}

function toLocalDayKey(ms) {
  const d = new Date(ms || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const sessionHintsCache = new Map();

function extractLightweightSessionHints(conversationId) {
  const tf = path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  const out = { tools: {}, skills: {}, cmds: {}, byDay: {}, toolLastTs: {}, skillLastTs: {}, cmdLastTs: {}, lastUserPreview: '', turns: 0, steps: 0 };
  if (!fs.existsSync(tf)) return out;
  let stamp = '';
  try {
    const stat = fs.statSync(tf);
    stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = sessionHintsCache.get(conversationId);
    if (cached && cached.stamp === stamp) {
      return cached.out;
    }
    if (stat.size > 12 * 1024 * 1024) {
      sessionHintsCache.set(conversationId, { stamp, out });
      return out;
    }
    const lines = fs.readFileSync(tf, 'utf8').split(/\r?\n/);
    const { active } = parseActiveTranscriptEvents(lines);
    for (const { st } of active) {
      const evMs = parseIsoTimestampMs(st.created_at);
      const dk = evMs > 0 ? toLocalDayKey(evMs) : '';
      const daySlot = dk ? (out.byDay[dk] ||= { turns: 0, steps: 0, tools: {}, skills: {}, cmds: {} }) : null;
      if (st.type === 'USER_INPUT' && st.source === 'USER_EXPLICIT') {
        out.turns++;
        if (daySlot) daySlot.turns++;
        const clean = stripPromptWrapperTags(st.content || '').replace(/\s+/g, ' ').trim();
        if (clean) out.lastUserPreview = clean.slice(0, 120);
      } else if (st.type === 'PLANNER_RESPONSE') {
        if (st.status !== 'ERROR') {
          out.steps++;
          if (daySlot) daySlot.steps++;
        }
        if (Array.isArray(st.tool_calls)) {
          for (const tc of st.tool_calls) {
            const name = String(tc?.name || '');
            if (name) {
              out.tools[name] = (out.tools[name] || 0) + 1;
              if (daySlot) daySlot.tools[name] = (daySlot.tools[name] || 0) + 1;
              if (evMs > (out.toolLastTs[name] || 0)) out.toolLastTs[name] = evMs;
            }
            if (name === 'read_file') {
              const p = unquoteArg(tc.args?.Path || tc.args?.path || '');
              const sk = extractSkillNameFromPath(p);
              if (sk) {
                out.skills[sk] = (out.skills[sk] || 0) + 1;
                if (daySlot) daySlot.skills[sk] = (daySlot.skills[sk] || 0) + 1;
                if (evMs > (out.skillLastTs[sk] || 0)) out.skillLastTs[sk] = evMs;
              }
            } else if (name === 'run_command') {
              const prog = parseProgramFromCommand(unquoteArg(tc.args?.CommandLine || ''));
              out.cmds[prog] = (out.cmds[prog] || 0) + 1;
              if (daySlot) daySlot.cmds[prog] = (daySlot.cmds[prog] || 0) + 1;
              if (evMs > (out.cmdLastTs[prog] || 0)) out.cmdLastTs[prog] = evMs;
            }
          }
        }
      }
    }
  } catch {}
  if (stamp) sessionHintsCache.set(conversationId, { stamp, out });
  return out;
}

/**
 * Computes cross-session Context Insights (global KPIs, 7-day Token+Cost chart,
 * 56-day 8-week activity calendar heatmap, 4 tally cards, global composition, and filterable session cards).
 */
export function getGlobalInsights(limit = 0) {
  const now = Date.now();
  if (globalInsightsCache.data && globalInsightsCache.limit === limit && (now - globalInsightsCache.ts) < 10000) {
    return globalInsightsCache.data;
  }

  const summariesCache = ensureSummariesTableCache();
  const recent = listRecentConversations(limit);
  let totalRequests = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  let totalLlmMs = 0;
  let totalCostUsd = 0;
  let subagentCount = 0;

  const modelTokenMap = new Map();
  const globalSkillMap = new Map();
  const globalToolMap = new Map();
  const globalCmdMap = new Map();
  const dayMap = new Map();
  const dayRootSessionSets = new Map();
  const teamActiveDaysByRoot = new Map();

  function ensureDayBucket(dk, refMs) {
    let b = dayMap.get(dk);
    if (!b) {
      const dt = new Date(refMs || Date.now());
      b = {
        dayKey: dk,
        label: dk.slice(5),
        weekday: dt.getDay(),
        month: dt.getMonth() + 1,
        sessions: 0,
        requests: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0
      };
      dayMap.set(dk, b);
    }
    return b;
  }

  // Pre-seed past 90 local days (covers 8-week Sunday-aligned DSH calendar heatmap + 30d/custom ranges)
  for (let i = 89; i >= 0; i--) {
    const ms = now - i * 86400000;
    ensureDayBucket(toLocalDayKey(ms), ms);
  }

  const seenGlobalReqKeys = new Set();
  const sessions = recent.map((r) => {
    const t = r.totals || {};
    const lm = r.latestModel || {};
    const totIn = t.inputTokens || 0;
    const totCache = t.cacheReadTokens || 0;
    const totOut = t.outputTokens || 0;
    const totThink = t.thinkingTokens || 0;
    const totAll = t.totalSessionTokens || (totIn + totCache + totOut);
    const updatedMs = r.updatedAtMs || now;
    const createdMs = r.createdAtMs || updatedMs;
    const dayKey = toLocalDayKey(updatedMs);
    const createdDay = toLocalDayKey(createdMs);
    const rootId = resolveRootConversationId(r.conversationId, summariesCache.map);

    const invSlices = [];
    const ownActiveDays = new Set();
    let sessionCost = 0;
    let uniqueReqs = 0;
    let uniqueIn = 0;
    let uniqueCache = 0;
    let uniqueOut = 0;
    let uniqueThink = 0;
    let uniqueLlmMs = 0;
    let uniqueCost = 0;
    const hasInvs = Array.isArray(r.invocations) && r.invocations.length > 0;
    for (const inv of (r.invocations || [])) {
      const ts = inv.timestampMs || updatedMs;
      const dk = toLocalDayKey(ts);
      const inTok = inv.inputTokens || 0;
      const cacheTok = inv.cacheReadTokens || 0;
      const outTok = inv.outputTokens || 0;
      const thinkTok = inv.thinkingOutputTokens || 0;
      const sliceTokens = inTok + cacheTok + outTok;
      const ttftMs = Math.round((inv.ttftSeconds || 0) * 1000);
      const genMs = Math.round((inv.streamingSeconds || 0) * 1000);
      const llmMs = Math.round(((inv.ttftSeconds || 0) + (inv.streamingSeconds || 0)) * 1000);
      const reqKey = inv.requestId || inv.responseId || inv.messageId || '';
      const isDup = Boolean(reqKey && seenGlobalReqKeys.has(reqKey));
      if (reqKey && !isDup) seenGlobalReqKeys.add(reqKey);

      const invCost = estimateInvocationCost(
        inv.responseModel || inv.sentModel || inv.modelEnum || inv.modelDisplayName || '',
        inTok,
        cacheTok,
        outTok,
        { atMs: ts }
      ).usd;
      sessionCost += invCost;

      if (!isDup) {
        uniqueReqs += 1;
        uniqueIn += inTok;
        uniqueCache += cacheTok;
        uniqueOut += outTok;
        uniqueThink += thinkTok;
        uniqueLlmMs += llmMs;
        uniqueCost += invCost;

        const dBucket = ensureDayBucket(dk, ts);
        dBucket.requests += 1;
        dBucket.inputTokens += inTok;
        dBucket.cacheReadTokens += cacheTok;
        dBucket.outputTokens += outTok;
        dBucket.totalTokens += sliceTokens;
        dBucket.costUsd += invCost;
      }

      let rootSet = dayRootSessionSets.get(dk);
      if (!rootSet) {
        rootSet = new Set();
        dayRootSessionSets.set(dk, rootSet);
      }
      rootSet.add(rootId);

      ownActiveDays.add(dk);
      let teamDays = teamActiveDaysByRoot.get(rootId);
      if (!teamDays) {
        teamDays = new Set();
        teamActiveDaysByRoot.set(rootId, teamDays);
      }
      teamDays.add(dk);

      invSlices.push({
        reqKey,
        ts,
        dk,
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        cost: invCost,
        llmMs,
        ttftMs,
        genMs
      });
    }

    if (r.parentConversationId) subagentCount++;
    totalRequests += hasInvs ? uniqueReqs : (r.invocationCount || 0);
    totalInput += hasInvs ? uniqueIn : totIn;
    totalCacheRead += hasInvs ? uniqueCache : totCache;
    totalOutput += hasInvs ? uniqueOut : totOut;
    totalThinking += hasInvs ? uniqueThink : totThink;
    totalLlmMs += hasInvs ? uniqueLlmMs : (t.llmMs || 0);
    totalCostUsd += hasInvs ? uniqueCost : sessionCost;

    const mKey = lm.responseModel || lm.sentModel || 'unknown';
    const prevM = modelTokenMap.get(mKey) || { name: mKey, requests: 0, tokens: 0, sessions: 0 };
    prevM.requests += hasInvs ? uniqueReqs : (r.invocationCount || 0);
    prevM.tokens += hasInvs ? (uniqueIn + uniqueCache + uniqueOut) : totAll;
    prevM.sessions++;
    modelTokenMap.set(mKey, prevM);

    const hints = extractLightweightSessionHints(r.conversationId);
    const sessionTurns = hints.turns || (r.invocationCount > 0 ? 1 : 0);
    const sessionSteps = r.invocationCount > 0
      ? Math.max(r.invocationCount, hints.steps || 0)
      : (hints.steps || 0);
    const fleet = !r.parentConversationId ? getFleetUsageRollup(r.conversationId, r) : null;

    const skList = Object.keys(hints.skills);
    const tlList = Object.keys(hints.tools);
    const cmList = Object.keys(hints.cmds);
    const totalToolCalls = Object.values(hints.tools).reduce((a, b) => a + b, 0);

    for (const [k, cnt] of Object.entries(hints.skills)) {
      const e = globalSkillMap.get(k) || { name: k, count: 0, sessions: 0 };
      e.count += cnt;
      e.sessions++;
      globalSkillMap.set(k, e);
    }
    for (const [k, cnt] of Object.entries(hints.tools)) {
      const e = globalToolMap.get(k) || { name: k, count: 0, sessions: 0 };
      e.count += cnt;
      e.sessions++;
      globalToolMap.set(k, e);
    }
    for (const [k, cnt] of Object.entries(hints.cmds)) {
      const e = globalCmdMap.get(k) || { name: k, count: 0, sessions: 0 };
      e.count += cnt;
      e.sessions++;
      globalCmdMap.set(k, e);
    }

    const bodyOut = Math.max(0, totOut - totThink);
    const miniParts = [
      { key: 'cache', label: '缓存读取', color: '#3b82f6', value: totCache },
      { key: 'input', label: '未缓存输入', color: '#22c55e', value: totIn },
      { key: 'thinking', label: '模型思考', color: '#8b5cf6', value: totThink },
      { key: 'output', label: '正文输出', color: '#ec4899', value: bodyOut }
    ];

    return {
      conversationId: r.conversationId,
      rootConversationId: rootId,
      parentConversationId: r.parentConversationId || '',
      isSubagent: Boolean(r.parentConversationId),
      title: r.title,
      cwd: r.cwd || '',
      group: r.group || '',
      createdAtMs: createdMs,
      createdDay,
      updatedAt: r.updatedAt,
      updatedAtMs: updatedMs,
      dayKey,
      ownActiveDays: [...ownActiveDays],
      invSlices,
      hintsByDay: hints.byDay || {},
      skillLastTs: hints.skillLastTs || {},
      toolLastTs: hints.toolLastTs || {},
      cmdLastTs: hints.cmdLastTs || {},
      invocationCount: r.invocationCount,
      turns: sessionTurns,
      steps: sessionSteps,
      primaryModel: lm.actualModelLabel || mKey,
      responseModel: mKey,
      modelDisplayName: lm.modelDisplayName || mKey,
      totalTokens: totAll,
      inputTokens: totIn,
      cacheReadTokens: totCache,
      outputTokens: totOut,
      thinkingTokens: totThink,
      cacheHitPct: t.cacheHitPct || 0,
      avgTps: t.avgTps || 0,
      avgE2eTps: t.avgE2eTps || 0,
      avgTtftSeconds: t.avgTtftSeconds || 0,
      llmMs: t.llmMs || 0,
      ttftMs: t.ttftMs || 0,
      streamingMs: t.streamingMs || 0,
      bodyOutputTokens: t.responseOutputTokens || bodyOut,
      estimatedCostUsd: Number(sessionCost.toFixed(4)),
      subagentCount: fleet?.subagentCount || 0,
      subagentTokens: fleet?.subagents?.totalTokens || 0,
      subagentCostUsd: fleet?.subagents?.estimatedCostUsd || 0,
      teamTotalTokens: fleet?.team?.totalTokens ?? totAll,
      teamEstimatedCostUsd: fleet ? Number((sessionCost + (fleet.subagents?.estimatedCostUsd || 0)).toFixed(4)) : Number(sessionCost.toFixed(4)),
      teamSteps: fleet?.team?.invocationCount ?? sessionSteps,
      contextUsed: lm.estimatedContextTokens || 0,
      contextMax: lm.maxContextTokens || 1048576,
      lastUserPreview: hints.lastUserPreview,
      skills: skList,
      tools: tlList,
      cmds: cmList,
      skillCounts: hints.skills,
      toolCounts: hints.tools,
      cmdCounts: hints.cmds,
      totalToolCalls,
      miniParts
    };
  });

  for (const s of sessions) {
    const teamSet = teamActiveDaysByRoot.get(s.rootConversationId);
    s.teamActiveDays = teamSet && teamSet.size > 0 ? [...teamSet] : [s.dayKey];
  }

  for (const [dk, dBucket] of dayMap.entries()) {
    dBucket.sessions = dayRootSessionSets.get(dk)?.size || 0;
    dBucket.costUsd = Number(dBucket.costUsd.toFixed(4));
  }

  const allDays = [...dayMap.keys()].sort().map(dk => dayMap.get(dk));
  const heatmap56d = allDays.slice(-56);
  const dailyUsage7d = allDays.slice(-7);

  const billedIn = totalInput + totalCacheRead;
  const totalTokens = billedIn + totalOutput;
  const cacheHitPct = billedIn > 0 ? Number(((totalCacheRead / billedIn) * 100).toFixed(1)) : 0;
  const bodyTotal = Math.max(0, totalOutput - totalThinking);

  const globalComposition = [
    { key: 'cache', label: '缓存读取 (Cache Read)', color: '#3b82f6', value: totalCacheRead },
    { key: 'input', label: '未缓存输入 (Uncached In)', color: '#22c55e', value: totalInput },
    { key: 'thinking', label: '推理思考 (Thinking)', color: '#8b5cf6', value: totalThinking },
    { key: 'answers', label: '模型正文 (Body Out)', color: '#ec4899', value: bodyTotal }
  ].map(b => ({
    ...b,
    pct: totalTokens > 0 ? Number(((b.value / totalTokens) * 100).toFixed(1)) : 0
  }));

  const modelShare = Array.from(modelTokenMap.values())
    .sort((a, b) => b.tokens - a.tokens)
    .map(m => ({
      ...m,
      model: m.name,
      pct: totalTokens > 0 ? Number(((m.tokens / totalTokens) * 100).toFixed(1)) : 0
    }));

  const result = {
    globalKpis: {
      sessionCount: sessions.length,
      subagentCount,
      totalRequests,
      totalTokens,
      uncachedInputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      outputTokens: totalOutput,
      thinkingTokens: totalThinking,
      cacheHitPct,
      totalLlmMs,
      estimatedCostUsd: Number(totalCostUsd.toFixed(4))
    },
    globalComposition,
    allDays,
    dailyUsage7d,
    heatmap56d,
    heatmap28d: allDays.slice(-28),
    tallies: {
      skillsLoaded: Array.from(globalSkillMap.values()).sort((a, b) => b.count - a.count).slice(0, 30),
      toolCalls: Array.from(globalToolMap.values()).sort((a, b) => b.count - a.count).slice(0, 30),
      commandsExecuted: Array.from(globalCmdMap.values()).sort((a, b) => b.count - a.count).slice(0, 30),
      modelsUsed: modelShare
    },
    modelShare,
    sessions
  };

  globalInsightsCache = { ts: now, limit, data: result };
  return result;
}
