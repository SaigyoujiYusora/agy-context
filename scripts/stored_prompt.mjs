import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseProtoFields} from './protobuf.mjs';

const text = (fields, tag) => fields.find(field => field.fieldNo === tag && field.wireType === 2)?.value.toString('utf8') || '';
const integer = (fields, tag) => Number(fields.find(field => field.fieldNo === tag && field.wireType === 0)?.value || 0);

function decodeToolCall(buffer) {
  const fields = parseProtoFields(buffer);
  return {name: text(fields, 2), argumentsJson: text(fields, 3)};
}

function decodeMessage(buffer) {
  const fields = parseProtoFields(buffer);
  return {
    source: integer(fields, 2), prompt: text(fields, 3), numTokens: integer(fields, 4),
    toolCalls: fields.filter(field => field.fieldNo === 6 && field.wireType === 2).map(field => decodeToolCall(field.value)),
    toolCallId: text(fields, 7), thinking: text(fields, 11) || text(fields, 17),
    stepIndex: fields.some(field => field.fieldNo === 18) ? integer(fields, 18) : null
  };
}

function decodeTool(buffer) {
  const fields = parseProtoFields(buffer);
  return {name: text(fields, 1), description: text(fields, 2), jsonSchemaString: text(fields, 3), responseJsonSchemaString: text(fields, 9)};
}

// ChatModelMetadata.system_prompt is the serialized request text, not a template.
export function readStoredSystemPrompt(dataRoot, conversationId) {
  const file = path.join(dataRoot, 'conversations', conversationId + '.db');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const rows = db.prepare('SELECT idx,data FROM gen_metadata ORDER BY idx DESC').iterate();
    for (const row of rows) {
      const chat = parseProtoFields(Buffer.from(row.data)).find(field => field.fieldNo === 1 && field.wireType === 2);
      if (!chat) continue;
      const fields = parseProtoFields(chat.value);
      const system = fields.find(field => field.fieldNo === 1 && field.wireType === 2);
      if (!system) continue;
      return {
        source: `conversations/${conversationId}.db · gen_metadata[${row.idx}].chatModel.systemPrompt`,
        kind: 'captured-system', provenance: 'request-metadata', invocationIndex: row.idx,
        text: system.value.toString('utf8'), byteLength: system.value.length,
        sectionCount: fields.filter(field => field.fieldNo === 16 && field.wireType === 2).length,
        sectionTitles: fields.filter(field => field.fieldNo === 16 && field.wireType === 2).map(field => text(parseProtoFields(field.value), 1)),
        requestMessages: fields.filter(field => field.fieldNo === 2 && field.wireType === 2).map(field => decodeMessage(field.value)),
        requestTools: fields.filter(field => field.fieldNo === 8 && field.wireType === 2).map(field => decodeTool(field.value))
      };
    }
    return null;
  } finally { db.close(); }
}
