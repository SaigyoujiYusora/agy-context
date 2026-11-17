import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_DATA_DIR,
  HISTORY_FILE,
  ensurePluginDataDir,
  getConversationModelsFromDb,
  writeInflightState,
  isDesktopAppSurface,
  isSubagentConversation,
  syncConversationRulesSnapshot
} from './model_core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.resolve(__dirname, '..', 'rules', 'AGENTS.md');
const STATE_FILE = path.join(PLUGIN_DATA_DIR, 'badged_state.json');
const ACTIVE_CONVO_FILE = path.join(PLUGIN_DATA_DIR, 'active_conversation.json');

function loadBadgedState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveBadgedState(state) {
  try {
    ensurePluginDataDir();
    const keys = Object.keys(state);
    if (keys.length > 80) {
      for (const k of keys.slice(0, keys.length - 80)) {
        delete state[k];
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim();
} catch {
  process.stdout.write('{}\n');
  process.exit(0);
}

if (!raw) {
  process.stdout.write('{}\n');
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.stdout.write('{}\n');
  process.exit(0);
}

if (!isDesktopAppSurface(payload)) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const conversationId = String(payload?.conversationId || '');
if (!conversationId || isSubagentConversation(conversationId)) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const configuredModelEnum = String(payload?.modelName || '');
const summary = getConversationModelsFromDb(conversationId);
const invCount = summary?.invocationCount || 0;
const latest = summary?.latestModel;

try {
  ensurePluginDataDir();
  fs.writeFileSync(
    ACTIVE_CONVO_FILE,
    JSON.stringify(
      {
        conversationId,
        configuredModelEnum,
        inFlight: false,
        preDbCount: invCount,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );
} catch {}

writeInflightState(conversationId, {
  inFlight: false,
  preDbCount: invCount,
  configuredModelEnum,
  updatedAtMs: Date.now()
});

syncConversationRulesSnapshot(RULES_FILE);

if (!latest) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const state = loadBadgedState();
const convoState = state[conversationId] || { lastLoggedReqId: '' };
const currentReqKey = latest.requestId || `${conversationId}-${invCount}`;

// Append new invocation telemetry to history.jsonl (never emit `metadata` maps on stdout — avoids Go `proto_utils.go:34` panic)
if (convoState.lastLoggedReqId !== currentReqKey) {
  try {
    ensurePluginDataDir();
    const record = {
      timestamp: new Date().toISOString(),
      conversationId,
      title: summary.title,
      invocationNum: invCount,
      configuredModelName: configuredModelEnum,
      ...latest
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
    convoState.lastLoggedReqId = currentReqKey;
    state[conversationId] = convoState;
    saveBadgedState(state);
  } catch {}
}

process.stdout.write('{}\n');
process.exit(0);
