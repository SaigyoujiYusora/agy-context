import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_DATA_DIR,
  getConversationModelsFromDb,
  getSessionTranscriptAnalytics,
  listRecentConversations,
  getPluginConfig,
  savePluginConfig,
  syncConversationRulesSnapshot
} from './model_core.mjs';

function formatZhDuration(ms) {
  const secTotal = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (secTotal < 60) return `${secTotal}秒`;
  const m = Math.floor(secTotal / 60);
  const s = secTotal % 60;
  if (m < 60) return s > 0 ? `${m}分${s}秒` : `${m}分0秒`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}小时${rm}分${s}秒`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.resolve(__dirname, '..', 'rules', 'AGENTS.md');

const args = process.argv.slice(2);
function getArg(flag, defaultVal = null) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultVal;
}

let targetId = getArg('--conversation') || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
if (!targetId) {
  try {
    const activeFile = path.join(PLUGIN_DATA_DIR, 'active_conversation.json');
    if (fs.existsSync(activeFile)) {
      const parsed = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      if (parsed?.conversationId) targetId = parsed.conversationId;
    }
  } catch {}
}

const setBadgeMode = getArg('--badge-mode') || getArg('--mode');
const setTpsMode = getArg('--tps-mode');
if ((setBadgeMode && ['on_reply', 'every_step', 'off'].includes(setBadgeMode)) || (setTpsMode && ['decode', 'e2e'].includes(setTpsMode))) {
  const patch = {};
  if (setBadgeMode && ['on_reply', 'every_step', 'off'].includes(setBadgeMode)) patch.badgeMode = setBadgeMode;
  if (setTpsMode && ['decode', 'e2e'].includes(setTpsMode)) patch.tpsMode = setTpsMode;
  const updated = savePluginConfig(patch);
  const cur = targetId ? getConversationModelsFromDb(targetId) : null;
  syncConversationRulesSnapshot(RULES_FILE, targetId, cur?.latestModel || null, updated);
  console.log(`已更新配置: badgeMode=${updated.badgeMode}, tpsMode=${updated.tpsMode}`);
  process.exit(0);
}

const asJson = args.includes('--json');
const recentLimit = Number(getArg('--recent', '15')) || 15;
const rawStepArg = getArg('--steps', 'all');
const stepLimit = rawStepArg === 'all' ? 0 : (Number(rawStepArg) || 0);

const recentList = listRecentConversations(Math.max(recentLimit, 10));
if (!targetId && recentList.length > 0) {
  targetId = recentList[0].conversationId;
}

const current = targetId ? getConversationModelsFromDb(targetId) : null;
const analytics = current ? getSessionTranscriptAnalytics(targetId, current, { includeBrowser: false }) : null;
const cfg = getPluginConfig();

if (asJson) {
  console.log(JSON.stringify({
    config: cfg,
    currentConversation: current,
    analytics,
    recentConversations: recentList.slice(0, recentLimit).map(r => ({
      conversationId: r.conversationId,
      title: r.title,
      updatedAt: r.updatedAt,
      invocationCount: r.invocationCount,
      latestModel: r.latestModel,
      modelBreakdown: r.modelBreakdown,
      totals: r.totals
    }))
  }, null, 2));
  process.exit(0);
}

const lines = [];
lines.push('## 🔍 Antigravity 上下文与模型报告 (AGY Context)');
lines.push('');

if (current && current.latestModel) {
  const lm = current.latestModel;
  const ctxPct = lm.maxContextTokens > 0
    ? `${((lm.estimatedContextTokens / lm.maxContextTokens) * 100).toFixed(1)}% (${lm.estimatedContextTokens.toLocaleString()} / ${lm.maxContextTokens.toLocaleString()})`
    : 'N/A';
  const totalIn = current.totals.inputTokens + current.totals.cacheReadTokens;
  const cacheRate = totalIn > 0
    ? `${((current.totals.cacheReadTokens / totalIn) * 100).toFixed(1)}%`
    : '0.0%';

  lines.push(`### 1. 当前会话最新模型状态 (\`${current.conversationId}\`)`);
  lines.push('');
  lines.push('| 指标项 | 真实观测值 | 说明 |');
  lines.push('| :--- | :--- | :--- |');
  lines.push(`| **发往上游实际模型 ID (\`sentModel\`)** | **\`${lm.sentModel || lm.responseModel}\`** | \`fetchAvailableModels\` 目录键名 / \`streamGenerateContent\` 请求实际 \`model\` |`);
  lines.push(`| **上游响应 \`modelVersion\` (\`responseModel\`)** | **\`${lm.responseModel}\`** | SSE 响应 \`response.modelVersion\` 原始返回值（与 \`sub2api\` \`ObserveGemini\` 一致） |`);
  lines.push(`| **UI 展示名称 (\`modelDisplayName\`)** | \`${lm.modelDisplayName}\` | 客户端模型选择器对应的展示名 |`);
  lines.push(`| **内部模型枚举 (\`model_enum\`)** | \`${lm.modelEnum}\` | Language Server 内部占位/枚举标识 |`);
  const latestTpsLabel = lm.tps > 0
    ? (lm.tpsApprox ? `~${lm.tps.toFixed(1)} tok/s ⚠️ (可能不准)` : `${lm.tps.toFixed(1)} tok/s`)
    : '0.0 tok/s';
  const latestE2eLabel = `${(lm.e2eTps || 0).toFixed(1)} tok/s`;
  const avgTpsLabel = current.totals.avgTpsApprox
    ? `~${current.totals.avgTps || 0} tok/s (估)`
    : `${current.totals.avgTps || 0} tok/s`;
  lines.push(`| **最新首字延迟 (TTFT) / 纯 Decode / 含TTFT TPS** | **\`${lm.ttftSeconds.toFixed(2)}s\`** / **\`${latestTpsLabel}\`** / **\`${latestE2eLabel}\`** | 平均 TTFT: \`${current.totals.avgTtftSeconds}s\` · 平均纯 Decode: \`${avgTpsLabel}\` · 平均含TTFT: \`${current.totals.avgE2eTps || 0} tok/s\` |`);
  lines.push(`| **API 提供方 (\`apiProvider\`)** | \`${lm.apiProvider}\` | 模型路由通道 |`);
  lines.push(`| **当前上下文窗口占用** | \`${ctxPct}\` | 当前会话上下文水位 |`);
  lines.push(`| **本会话调用总次数** | \`${current.invocationCount}\` 次 | 累计入 \`${current.totals.inputTokens.toLocaleString()}\` / 缓存 \`${current.totals.cacheReadTokens.toLocaleString()}\` (${cacheRate}) / 出 \`${current.totals.outputTokens.toLocaleString()}\` |`);
  lines.push(`| **最新请求 Trace / Response ID** | \`${lm.traceId || 'N/A'}\` / \`${lm.responseId || 'N/A'}\` | 请求序号: \`${lm.requestId || 'N/A'}\` |`);
  lines.push(`| **当前配置 (\`badgeMode\` / \`tpsMode\`)** | \`${cfg.badgeMode}\` / \`${cfg.tpsMode || 'decode'}\` | 支持 \`--tps-mode decode\\|e2e\` 一键切换 |`);
  lines.push('');

  if (analytics?.sessionStats) {
    const ss = analytics.sessionStats;
    const isE2e = cfg.tpsMode === 'e2e';
    const sessTpsVal = isE2e ? ss.sessionE2eTps : ss.sessionTps;
    const latestTpsVal = isE2e ? ss.latestE2eTps : ss.latestTps;
    const sessTpsStr = `${(!isE2e && ss.sessionTpsApprox) ? '~' : ''}${Number(sessTpsVal || 0).toFixed(1)} tok/s${(!isE2e && ss.sessionTpsApprox) ? ' ⚠️ (可能不准)' : ''}`;
    const lastTpsStr = `${(!isE2e && ss.latestTpsApprox) ? '~' : ''}${Number(latestTpsVal || 0).toFixed(1)} tok/s${(!isE2e && ss.latestTpsApprox) ? ' ⚠️ (可能不准)' : ''}`;
    lines.push(`### 2. 会话统计 (DSH 口径 · ${ss.turns || 0}轮 ${ss.steps || 0}步 · ${ss.samples || 0} 次采样)`);
    lines.push('');
    lines.push('| 会话统计项 | 数值 | 说明 |');
    lines.push('| :--- | :--- | :--- |');
    lines.push(`| **模型调用用时** | \`${formatZhDuration(ss.llmMs)}\` | 累计模型响应时长 |`);
    lines.push(`| **工具调用用时** | \`${formatZhDuration(ss.toolMs)}\` | 合并时间区间后的工具执行总耗时 |`);
    lines.push(`| **首 token 平均 (TTFT)** | \`${Number(ss.avgTtftSeconds || 0).toFixed(2)} 秒\` | 所有有效请求平均首字延迟 |`);
    lines.push(`| **会话输出速率 (TPS)** | **\`${sessTpsStr}\`** | ${isE2e ? '含 TTFT 总耗时加权' : '总输出 Token ÷ 流式时长（按总时长加权）'} |`);
    lines.push(`| **最近一次请求** | **\`${lastTpsStr}\`** | 最新一次采样输出速度 |`);
    lines.push(`| **正文 / 思考输出** | \`${Number(ss.bodyOutputTokens || 0).toLocaleString()} / ${Number(ss.thinkingOutputTokens || 0).toLocaleString()} tok\` | 总计输出 \`${Number(ss.outputTokens || 0).toLocaleString()} tok\` |`);
    lines.push(`| **总 Token / 缓存命中** | \`${Number(ss.totalTokens || 0).toLocaleString()} tok · ${Number(ss.cacheHitPct || 0).toFixed(1)}%\` | 新增输入 \`${Number(ss.uncachedInputTokens || 0).toLocaleString()}\` · 缓存读取 \`${Number(ss.cacheReadTokens || 0).toLocaleString()}\` |`);
    lines.push('');
    lines.push('> 统计方式: 总输出 Token ÷ 流式时长；会话 TPS 按总时长加权。');
    lines.push('');
  }

  const breakdownEntries = Object.entries(current.modelBreakdown);
  if (breakdownEntries.length > 0) {
    lines.push('### 3. 当前会话模型分布');
    lines.push('');
    for (const [mName, cnt] of breakdownEntries) {
      const pct = ((cnt / current.invocationCount) * 100).toFixed(1);
      lines.push(`- **\`${mName}\`**: 调用 \`${cnt}\` 次 (\`${pct}%\`)`);
    }
    lines.push('');
  }

  const recentInvocations = stepLimit > 0 ? current.invocations.slice(-stepLimit) : current.invocations;
  lines.push(`### 4. 模型调用明细 (${stepLimit > 0 ? `最近 ${recentInvocations.length}` : `全部 ${recentInvocations.length}`} 次)`);
  lines.push('');
  lines.push('| # | 关联 Step | 发往上游 `sentModel` → 响应 `modelVersion` | `model_enum` | 输入 (缓存) | 输出 (思考) | TTFT | 纯 Decode TPS | 含TTFT TPS |');
  lines.push('| :---: | :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: |');
  for (const inv of recentInvocations) {
    const stepsStr = inv.stepIndices.length > 0
      ? (inv.stepIndices.length > 3 ? `${inv.stepIndices[0]}..${inv.stepIndices[inv.stepIndices.length - 1]}` : inv.stepIndices.join(','))
      : '-';
    const inStr = `${inv.inputTokens.toLocaleString()} (${inv.cacheReadTokens.toLocaleString()})`;
    const outStr = `${inv.outputTokens.toLocaleString()} (${inv.thinkingOutputTokens.toLocaleString()})`;
    const shortEnum = (inv.modelEnum || '-').replace(/^MODEL_PLACEHOLDER_/, '');
    const tpsCell = inv.tps > 0
      ? (inv.tpsApprox ? `⚠️ \`~${inv.tps.toFixed(1)}\` *(可能不准)*` : `**\`${inv.tps.toFixed(1)}\`**`)
      : `\`0.0\``;
    const e2eCell = inv.e2eTps > 0 ? `\`${inv.e2eTps.toFixed(1)}\`` : `\`0.0\``;
    lines.push(`| ${inv.idx + 1} | \`${stepsStr}\` | **\`${inv.actualModelLabel || inv.responseModel}\`** | \`${shortEnum}\` | ${inStr} | ${outStr} | \`${inv.ttftSeconds.toFixed(2)}s\` | ${tpsCell} | ${e2eCell} |`);
  }
  lines.push('');
} else {
  lines.push('> 当前未找到指定会话的模型调用记录，以下展示近期活跃会话。');
  lines.push('');
}

if (recentList.length > 0) {
  lines.push(`### 5. 近期活跃会话模型一览 (Top ${Math.min(recentLimit, recentList.length)})`);
  lines.push('');
  lines.push('| 会话 ID | 会话标题/摘要 | 调用次数 | 实际模型 (`sentModel` → `modelVersion`) | `model_enum` | 平均 TTFT | 平均纯 Decode TPS |');
  lines.push('| :--- | :--- | :---: | :--- | :--- | :---: | :---: |');
  for (const r of recentList.slice(0, recentLimit)) {
    const lm = r.latestModel || {};
    const shortTitle = String(r.title || '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ').slice(0, 34);
    const shortEnum = (lm.modelEnum || '-').replace(/^MODEL_PLACEHOLDER_/, '');
    lines.push(`| \`${r.conversationId.slice(0, 8)}\` | ${shortTitle} | ${r.invocationCount} | **\`${lm.actualModelLabel || lm.responseModel || '-'}\`** | \`${shortEnum}\` | ${r.totals.avgTtftSeconds}s | **${r.totals.avgTps || 0} tok/s** |`);
  }
}

console.log(lines.join('\n'));
