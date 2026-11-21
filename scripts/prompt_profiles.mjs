import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {readStoredSystemPrompt} from './stored_prompt.mjs';

const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini/antigravity');
const PLUGIN_DATA_DIR = path.join(APP_DATA_DIR, 'plugin_data/agy-model-inspector');

const STORE = path.join(PLUGIN_DATA_DIR, 'prompt_profiles.json');
const RULES = path.resolve(import.meta.dirname, '../rules/AGENTS.md');
const BUILTIN_TEMPLATES_FILE = path.resolve(import.meta.dirname, '../assets/builtin-system-templates.json');
const BASE = '# AGY Context\n\n- Model badges and usage statistics are rendered by the desktop runtime overlay. Do not append model footers or badge images to responses.\n';
const sourceCache = new Map();
const promptSourcesCache = new Map();
const PROMPT_SOURCES_CACHE_MAX = 8;
let templatesCache = { stamp: '', templates: [] };
let rulesCache = { stamp: '', text: '' };

function statStamp(filePath, includeWal = false) {
  let base = '0:0';
  try {
    const st = fs.statSync(filePath);
    base = `${st.mtimeMs}:${st.size}`;
  } catch {}
  if (!includeWal) return base;
  let wal = '0:0';
  try {
    const wst = fs.statSync(`${filePath}-wal`);
    wal = `${wst.mtimeMs}:${wst.size}`;
  } catch {}
  return `${base}:${wal}`;
}

export function getPromptSourcesRevision(conversationId) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId || '')) return 'invalid';
  const dbFile = path.join(APP_DATA_DIR, 'conversations', `${conversationId}.db`);
  const capFile = path.join(PLUGIN_DATA_DIR, 'native_captures', `by-conversation-${conversationId}.json`);
  const transcript = path.join(APP_DATA_DIR, 'brain', conversationId, '.system_generated/logs/transcript_full.jsonl');
  return [
    statStamp(dbFile, true),
    statStamp(capFile, false),
    statStamp(transcript, false),
    statStamp(BUILTIN_TEMPLATES_FILE, false),
    statStamp(RULES, false)
  ].join('|');
}

export function getNativePromptState() {
  let status = { ready: false, captureVerified: false, rewriteAllowed: false };
  try { status = { ...status, ...JSON.parse(fs.readFileSync(path.join(PLUGIN_DATA_DIR, 'native_prompt_status.json'), 'utf8')) }; } catch {}
  const age = Date.now() - Date.parse(status.updatedAt);
  let configured = false;
  try { configured = Boolean(JSON.parse(fs.readFileSync(path.join(PLUGIN_DATA_DIR, 'config.json'), 'utf8')).nativePromptPython); } catch {}
  const fresh = Number.isFinite(age) && age >= 0 && age < 15000;
  status.ready = Boolean(status.ready && fresh && configured);
  if (!status.ready) {
    status.captureReady = false;
    status.rewriteAllowed = false;
    status.reason = !configured ? '原生采集已停用' : !fresh ? '原生采集状态已过期' : status.error || status.reason || '原生采集尚未就绪';
  }
  let captures = [];
  try { captures = fs.readdirSync(path.join(PLUGIN_DATA_DIR, 'native_captures')).filter(n => /^system-\d+\.json$/.test(n)).sort().reverse().slice(0, 100); } catch {}
  return { status, captures };
}

export function readNativePromptCapture(name) {
  if (!/^system-\d+\.json$/.test(name || '')) throw new Error('Invalid capture name');
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_DATA_DIR, 'native_captures', name), 'utf8'));
}

export function getPromptProfiles() {
  const native = getNativePromptState().status;
  // Legacy bridge health is not proof that the host configuration path works.
  const canRewrite = false;
  const capabilities = { append: canRewrite, replace: canRewrite, native };
  let value = { enabled: false, activeId: '', profiles: [], transport: 'native' };
  try {
    value = { ...value, ...JSON.parse(fs.readFileSync(STORE, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取提示词预设；原文件已保留：' + error.message);
  }
  const active = value.profiles.find(p => p.id === value.activeId);
  const revision = value.revision || value.updatedAt || '';
  const acknowledged = native.ready && native.profileRevision === revision && native.configuredPresetId === value.activeId &&
    native.enabled === value.enabled && (!value.enabled || native.mode === active?.mode);
  const status = !value.enabled ? (acknowledged || !native.ready ? 'disabled' : 'pending') :
    value.transport !== 'native' ? 'migration-required' : !canRewrite ? 'unavailable' : acknowledged ? 'applied' : 'pending';
  return { ...value, capabilities, application: { status, revision, requestedEnabled: value.enabled, activeId: value.activeId, mode: active?.mode || '', reason: status === 'unavailable' ? native.reason || '原生采集尚未就绪' : '' } };
}

export function savePromptProfiles(value) {
  if (!Array.isArray(value.profiles) || value.profiles.length > 50) throw new Error('最多保存 50 个预设');
  const profiles = value.profiles.map(p => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id || '')) throw new Error('预设 ID 无效');
    if (!['append', 'replace'].includes(p.mode)) throw new Error('模式无效');
    if (typeof p.text !== 'string' || Buffer.byteLength(p.text, 'utf8') > 512 * 1024) throw new Error('提示词须为文本，且 UTF-8 大小不能超过 512KB');
    return { id: p.id, name: String(p.name || p.id).slice(0, 100), mode: p.mode, text: p.text };
  });
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('预设 ID 重复');
  const active = profiles.find(p => p.id === value.activeId);
  if (value.enabled && !active) throw new Error('请选择有效预设');
  const nativeAvailable = getPromptProfiles().capabilities.replace;
  if (value.enabled && !nativeAvailable) throw new Error('原生采集尚未就绪；可以先取消启用并保存预设，暂不改写系统提示词');
  const state = { enabled: Boolean(value.enabled), activeId: active?.id || '', profiles, transport: 'native', revision: crypto.randomUUID(), updatedAt: new Date().toISOString() };
  fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  const temporary = STORE + '.' + state.revision + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporary, STORE);
  syncPromptRules();
  return getPromptProfiles();
}

export function syncPromptRules() {
  // Legacy reply-badge rule (rules/AGENTS.md) has been removed for zero context-token overhead.
}

// Local rule files are inspectable, but are not evidence of the complete upstream system message.
export function getPromptSources(conversationId) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId || '')) return { captured: false, sources: [] };
  const rev = getPromptSourcesRevision(conversationId);
  const cachedSources = promptSourcesCache.get(conversationId);
  if (cachedSources && cachedSources.rev === rev) {
    promptSourcesCache.delete(conversationId);
    promptSourcesCache.set(conversationId, cachedSources);
    return cachedSources.value;
  }
  const sources = [];
  const warnings = [];
  let stored = null;
  try {
    stored = readStoredSystemPrompt(APP_DATA_DIR, conversationId);
    if (stored) sources.push(stored);
  } catch (error) { warnings.push('读取宿主请求记录失败：' + error.message); }
  try {
    const name = 'by-conversation-' + conversationId + '.json';
    const record = JSON.parse(fs.readFileSync(path.join(PLUGIN_DATA_DIR, 'native_captures', name), 'utf8'));
    if (record.conversationId === conversationId) sources.push({ source: 'native_captures/' + name, kind: stored ? 'historical-native-capture' : 'captured-system', text: record.appliedSystem, capturedAt: record.capturedAt, mode: record.mode });
  } catch {}
  const transcript = path.join(APP_DATA_DIR, 'brain', conversationId, '.system_generated/logs/transcript_full.jsonl');
  if (!stored) try {
    const stat = fs.statSync(transcript);
    const key = stat.mtimeMs + ':' + stat.size;
    let cached = sourceCache.get(transcript);
    if (cached?.key !== key) {
      const entries = [];
      // The system prefix belongs at the beginning; avoid loading multi-GB transcripts into memory.
      const fd = fs.openSync(transcript, 'r');
      const buf = Buffer.alloc(Math.min(stat.size, 8 * 1024 * 1024));
      try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      let raw = buf.toString('utf8');
      if (stat.size > buf.length) raw = raw.slice(0, raw.lastIndexOf('\n'));
      for (const line of raw.split(/\r?\n/)) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      // Only explicit role=system records qualify; generic injected notices do not.
      if (item.role === 'system' && typeof item.content === 'string') entries.push({ source: transcript, kind: 'captured-system', text: item.content });
      }
      cached = { key, entries };
      if (sourceCache.has(transcript)) sourceCache.delete(transcript);
      while (sourceCache.size >= 8) sourceCache.delete(sourceCache.keys().next().value);
      sourceCache.set(transcript, cached);
    }
    sources.push(...cached.entries);
  } catch {}
  try {
    const tStamp = statStamp(BUILTIN_TEMPLATES_FILE, false);
    if (tStamp !== '0:0') {
      if (templatesCache.stamp !== tStamp) {
        const data = JSON.parse(fs.readFileSync(BUILTIN_TEMPLATES_FILE, 'utf8'));
        templatesCache = {
          stamp: tStamp,
          templates: (data.templates || []).map(item => ({ source: data.source + ' · ' + item.name, kind: 'builtin-static-template-not-final-request', text: item.text }))
        };
      }
      sources.push(...templatesCache.templates);
    }
  } catch {}
  try {
    const rStamp = statStamp(RULES, false);
    if (rStamp !== '0:0') {
      if (rulesCache.stamp !== rStamp) {
        rulesCache = { stamp: rStamp, text: fs.readFileSync(RULES, 'utf8') };
      }
      sources.push({ source: RULES, kind: 'plugin-rules-current', text: rulesCache.text });
    }
  } catch {}
  const result = { captured: sources.some(s => s.kind === 'captured-system'), sources, warnings };
  if (promptSourcesCache.has(conversationId)) promptSourcesCache.delete(conversationId);
  while (promptSourcesCache.size >= PROMPT_SOURCES_CACHE_MAX) {
    promptSourcesCache.delete(promptSourcesCache.keys().next().value);
  }
  promptSourcesCache.set(conversationId, { rev, value: result });
  return result;
}
