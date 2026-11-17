import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_DATA_DIR,
  ensurePluginDataDir,
  getConversationModelsFromDb,
  writeInflightState,
  isDesktopAppSurface,
  isSubagentConversation,
  syncConversationRulesSnapshot
} from './model_core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.resolve(__dirname, '..', 'rules', 'AGENTS.md');
const ACTIVE_CONVO_FILE = path.join(PLUGIN_DATA_DIR, 'active_conversation.json');

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

syncConversationRulesSnapshot(RULES_FILE);

// Hard gate: NEVER run Desktop App tracking or badge server inside `agy` CLI (`antigravity-cli`) or title-generator sessions
if (!isDesktopAppSurface(payload)) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const conversationId = String(payload?.conversationId || '');
const configuredModelEnum = String(payload?.modelName || '');

if (!conversationId || isSubagentConversation(conversationId)) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const summary = getConversationModelsFromDb(conversationId);
const preDbCount = summary?.invocationCount || 0;

try {
  ensurePluginDataDir();
  fs.writeFileSync(
    ACTIVE_CONVO_FILE,
    JSON.stringify(
      {
        conversationId,
        configuredModelEnum,
        inFlight: true,
        preDbCount,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );
} catch {}

writeInflightState(conversationId, {
  inFlight: true,
  preDbCount,
  configuredModelEnum,
  updatedAtMs: Date.now()
});

// Rendering belongs to the runtime overlay; no model-generated badge directives.
process.stdout.write('{}\n');
process.exit(0);
