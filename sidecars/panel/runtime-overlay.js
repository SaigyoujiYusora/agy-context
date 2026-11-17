/*
 * AGY Model Inspector page overlay.
 *
 * This file is evaluated in the Antigravity conversation renderer through the
 * local Chrome DevTools Protocol. It deliberately uses DOM APIs only: the
 * installed Antigravity app and its app.asar remain untouched.
 */
(function installAgyModelInspectorOverlay() {
  'use strict';

  const VERSION = 'runtime-overlay-v22';
  const BUILD = '20261116-dsh-stats-v2';
  function loopbackApiBase(value) {
    try {
      const parsed = new URL(String(value || 'http://127.0.0.1:18922'));
      const host = parsed.hostname.toLowerCase();
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return 'http://127.0.0.1:18922';
      if (!['http:', 'https:'].includes(parsed.protocol)) return 'http://127.0.0.1:18922';
      return parsed.origin.replace(/\/$/, '');
    } catch {
      return 'http://127.0.0.1:18922';
    }
  }
  const API_BASE = loopbackApiBase(globalThis.__AGY_MODEL_INSPECTOR_RUNTIME_CONFIG__?.apiBase);
  const HOST_ID = 'agy-model-inspector-runtime-overlay';
  const NATIVE_BADGE_RE = /\/api\/(?:badge|fork-badge)\.svg(?:[?#]|$)/i;

  const previousOverlay = globalThis.__AGY_MODEL_INSPECTOR_OVERLAY__;
  if (previousOverlay && (previousOverlay.version !== VERSION || previousOverlay.build !== BUILD)) {
    previousOverlay.stop?.();
    document.getElementById(HOST_ID)?.remove();
    for (const badge of document.querySelectorAll('[data-agy-runtime-reply-badge-bar], [data-agy-runtime-reply-badge], [data-agy-runtime-turn-usage], [data-agy-runtime-fork]')) badge.remove();
  }
  if (previousOverlay?.version === VERSION && previousOverlay?.build === BUILD) {
    previousOverlay.refresh?.();
    return;
  }

  const state = {
    version: VERSION,
    host: null,
    shadow: null,
    footer: null,
    spacingContainer: null,
    previousPaddingBottom: '',
    previousPaddingPriority: '',
    lastRevision: '',
    lastRenderedRevision: '',
    lastPayload: null,
    forkRequests: [],
    forkPending: null,
    stopped: false
  };

  const STYLE = `
    :host {
      display: block;
      flex: 0 0 28px;
      min-width: 0;
      width: 100%;
      height: 28px;
      margin: 8px auto 0;
      align-self: center;
      color: var(--foreground, #e7e8eb);
      font-family: var(--font-sans, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 12px;
      line-height: 1.2;
      contain: layout style;
    }
    .runtime-root {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      height: 100%;
      min-width: 0;
    }
    .runtime-pill-wrap {
      position: relative;
      display: inline-flex;
      flex: 0 1 auto;
      min-width: 0;
      height: 24px;
    }
    .runtime-pill-wrap[data-key="context"] {
      flex: 0 0 auto;
    }
    .runtime-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      box-sizing: border-box;
      height: 24px;
      max-width: 100%;
      min-width: 0;
      padding: 0 10px;
      border: 1px solid color-mix(in srgb, var(--border, #34353b) 78%, transparent);
      border-radius: 7px;
      background: var(--card, #242424);
      color: var(--muted-foreground, #c2c4ca);
      cursor: pointer;
      font: inherit;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .runtime-pill:hover, .runtime-pill:focus-visible, .runtime-pill[aria-expanded="true"] {
      border-color: var(--card-border, var(--border, #444));
      background: color-mix(in srgb, var(--foreground, #fff) 9%, var(--background, #101010));
      color: var(--foreground, #f1f2f6);
      outline: none;
    }
    .runtime-icon {
      display: inline-grid;
      place-items: center;
      width: 13px;
      height: 13px;
      flex: 0 0 13px;
      color: var(--muted-foreground, #a6a6a6);
      font-size: 13px;
      line-height: 1;
    }
    .runtime-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .runtime-popover {
      position: fixed;
      inset: auto;
      margin: 0;
      z-index: 2147483647;
      display: none;
      box-sizing: border-box;
      width: min(308px, calc(100vw - 24px));
      padding: 13px 14px 12px;
      border: 1px solid var(--card-border, var(--border, #3a3a3a));
      border-radius: 14px;
      background: var(--card, #242424);
      box-shadow: 0 12px 34px rgba(0, 0, 0, .44);
      color: var(--foreground, #eee);
      pointer-events: auto;
    }
    .runtime-popover:popover-open { display: block; }
    .runtime-popover-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 9px;
      border-bottom: 1px solid var(--border, #3a3a3a);
      font-size: 14px;
      color: var(--foreground, #eee);
    }
    .runtime-popover-header strong { font-weight: 650; white-space: nowrap; }
    .runtime-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding-top: 9px;
      color: var(--muted-foreground, #a6a6a6);
      font-size: 13px;
    }
    .runtime-row strong { color: var(--foreground, #eee); font-weight: 500; text-align: right; }
    .runtime-progress {
      height: 5px;
      margin: 10px 0 12px;
      overflow: hidden;
      border-radius: 4px;
      background: var(--border, #3a3a3a);
    }
    .runtime-progress-used {
      display: flex;
      height: 100%;
      overflow: hidden;
      border-radius: inherit;
    }
    .runtime-progress-used > i {
      display: block;
      flex-shrink: 0;
      height: 100%;
    }
    .runtime-dot-row {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      padding-top: 7px;
      color: var(--muted-foreground, #aaa);
      font-size: 13px;
    }
    .runtime-dot-row i { width: 10px; height: 10px; border-radius: 2px; }
    .runtime-dot-row strong { color: var(--foreground, #eee); font-weight: 500; }
    .runtime-empty { padding-top: 9px; color: #969aa6; }
    .runtime-error { color: #f0a8a8; }
    @media (max-width: 560px) {
      .runtime-pill { padding: 0 7px; }
    }
    @media (max-width: 420px) {
      .runtime-pill-wrap[data-key="tokens"] { display: none; }
    }
  `;

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function number(...values) {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function formatInteger(value) {
    const n = Math.max(0, Math.round(number(value)));
    return n.toLocaleString('en-US');
  }

  function formatCompact(value) {
    const n = Math.max(0, number(value));
    if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
    return formatInteger(n);
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(number(ms) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return `${hours}时 ${minutes}分`;
    if (minutes) return `${minutes}分 ${seconds}秒`;
    return `${seconds}秒`;
  }

  function formatUsd(value, detailed = false) {
    const n = number(value);
    if (!(n > 0)) return '';
    if (n < 0.0001) return '≈<$0.0001';
    if (n < 0.01) return `≈$${n.toFixed(detailed ? 4 : 3)}`;
    return `≈$${n.toFixed(2)}`;
  }

  function percent(value) {
    const n = Math.max(0, Math.min(100, number(value)));
    return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
  }

  function conversationId() {
    const match = String(location.pathname || '').match(/^\/c\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function normalize(raw) {
    const payload = raw && typeof raw === 'object' ? raw : {};
    const summary = payload.summary || payload.selectedConversation || {};
    const totals = summary.totals || payload.totals || {};
    const latest = payload.latestModel || summary.latestModel || {};
    const analytics = payload.analytics || {};
    const sessionStats = analytics.sessionStats || analytics.session || {};
    const head = payload.head || analytics.head || analytics.sessionStats?.head || {};
    const counts = analytics.counts || sessionStats.counts || head.counts || {};
    const timing = analytics.timing || sessionStats.timing || head.timing || {};
    const composition = analytics.composition || analytics.contextComposition || {};
    const buckets = Array.isArray(composition.buckets)
      ? composition.buckets
      : (Array.isArray(analytics.buckets) ? analytics.buckets : []);
    const invocations = Array.isArray(payload.invocations)
      ? payload.invocations
      : (Array.isArray(summary.invocations) ? summary.invocations : []);
    const current = head.current || analytics.current || {};
    const contextWindow = number(
      composition.maxTokens,
      head.contextWindow,
      analytics.contextWindow,
      sessionStats.contextWindow,
      latest.maxContextTokens,
      payload.contextWindow,
      1048576
    );
    const contextUsed = number(
      composition.totalTokens,
      current.total,
      analytics.contextUsed,
      sessionStats.contextUsed,
      latest.estimatedContextTokens,
      latest.inputTokens + latest.cacheReadTokens
    );
    const cacheRead = number(totals.cacheReadTokens, latest.cacheReadTokens);
    const input = number(totals.inputTokens, latest.inputTokens);
    const cacheHit = number(
      totals.cacheHitPct,
      input + cacheRead > 0 ? cacheRead / (input + cacheRead) * 100 : 0
    );
    const last = invocations.length ? invocations[invocations.length - 1] : latest;
    const output = number(totals.outputTokens, latest.outputTokens);
    const decodeTps = number(
      totals.avgTps,
      totals.avgDecodeTps,
      sessionStats.avgTps,
      sessionStats.avgDecodeTps,
      last?.stepDecodeTps,
      last?.tps,
      latest.tps
    );
    const ownTotalTokens = number(totals.totalSessionTokens, totals.totalTokens, sessionStats.totalTokens, contextUsed + output);
    const ownUsd = number(totals.totalUsd, totals.usd, payload.costUsd, analytics.costUsd, sessionStats.estimatedCostUsd);
    const fleet = analytics.fleetUsage || payload.fleetUsage || null;
    const subagentCount = Math.max(0, Math.round(number(sessionStats.subagentCount, fleet?.subagentCount, 0)));
    const subagentSteps = Math.max(0, Math.round(number(sessionStats.subagentSteps, fleet?.subagents?.invocationCount, 0)));
    const subagentTokens = Math.max(0, number(sessionStats.subagentTokens, fleet?.subagents?.totalTokens, 0));
    const subagentUsd = Math.max(0, number(sessionStats.subagentCostUsd, fleet?.subagents?.estimatedCostUsd, 0));
    const teamTotalTokens = subagentCount > 0
      ? number(sessionStats.teamTotalTokens, fleet?.team?.totalTokens, ownTotalTokens + subagentTokens)
      : ownTotalTokens;
    const teamUsd = subagentCount > 0
      ? number(sessionStats.teamEstimatedCostUsd, fleet?.team?.estimatedCostUsd, ownUsd + subagentUsd)
      : ownUsd;
    const teamInput = subagentCount > 0
      ? number(sessionStats.teamUncachedInputTokens, fleet?.team?.inputTokens, input)
      : input;
    const teamCacheRead = subagentCount > 0
      ? number(sessionStats.teamCacheReadTokens, fleet?.team?.cacheReadTokens, cacheRead)
      : cacheRead;
    const teamOutput = subagentCount > 0
      ? number(sessionStats.teamOutputTokens, fleet?.team?.outputTokens, output)
      : output;
    const teamCacheHit = subagentCount > 0
      ? number(
          sessionStats.teamCacheHitPct,
          fleet?.team?.cacheHitPct,
          teamInput + teamCacheRead > 0 ? teamCacheRead / (teamInput + teamCacheRead) * 100 : cacheHit
        )
      : cacheHit;
    return {
      payload,
      summary,
      totals,
      latest,
      analytics,
      head,
      counts,
      timing,
      sessionStats,
      fleet,
      turns: number(sessionStats.turns, sessionStats.rounds, analytics.turns, counts.turns, counts.rounds, summary.turns),
      steps: number(sessionStats.steps, analytics.steps, counts.steps, summary.steps),
      toolMs: number(timing.toolsMs, timing.toolMs, analytics.toolMs, sessionStats.toolMs),
      llmMs: number(timing.wallMs, timing.llmMs, sessionStats.llmMs, totals.llmMs),
      ttft: number(totals.avgTtftSeconds, analytics.avgTtftSeconds, sessionStats.avgTtftSeconds, latest.ttftSeconds),
      buckets,
      contextEstimateNote: composition.estimateNote || '',
      invocations,
      contextWindow,
      contextUsed,
      cacheRead,
      input,
      cacheHit,
      output,
      decodeTps,
      ownTotalTokens,
      ownUsd,
      subagentCount,
      subagentSteps,
      subagentTokens,
      subagentUsd,
      teamTotalTokens,
      teamUsd,
      teamInput,
      teamCacheRead,
      teamOutput,
      teamCacheHit,
      usd: teamUsd,
      revision: String(payload.revision || [summary.invocationCount, teamTotalTokens, subagentCount, contextUsed].join(':'))
    };
  }

  function rows(entries) {
    return entries
      .filter((entry) => entry && entry[1] !== '' && entry[1] !== undefined && entry[1] !== null)
      .map(([label, value]) => `<div class="runtime-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`)
      .join('') || '<div class="runtime-empty">暂无统计数据</div>';
  }

  const CONTEXT_CATEGORIES = {
    system: {label:'系统提示词',color:'#b8bec8'},
    tools: {label:'工具定义',color:'#aa8cff'},
    user: {label:'用户消息',color:'#56c88d'},
    inject: {label:'注入内容',color:'#edb866'},
    skill: {label:'技能注入',color:'#ed8bb6'},
    assistant: {label:'对话消息',color:'#6ba6f2'},
    messages: {label:'对话消息',color:'#6ba6f2'},
    tool: {label:'工具结果',color:'#56c4cc'}
  };

  function contextBuckets(model) {
    return model.buckets.map(item => {
      const key = String(item.key || item.name || 'unknown');
      const definition = CONTEXT_CATEGORIES[key] || {label:item.label || key,color:'#9ca3af'};
      return {key,...definition,tokens:Math.max(0,number(item.tokens,item.value))};
    }).filter(item => item.tokens > 0);
  }

  function bucketRows(model) {
    return contextBuckets(model).map(item =>
      `<div class="runtime-dot-row"><i style="background:${item.color}"></i><span>${esc(item.label)}</span><strong>~${esc(formatCompact(item.tokens))}</strong></div>`
    ).join('') || '<div class="runtime-empty">暂无上下文构成数据</div>';
  }

  function contextBar(model, pct) {
    const buckets = contextBuckets(model);
    const total = buckets.reduce((sum,item) => sum + item.tokens,0);
    const segments = buckets.map(item => `<i data-context-category="${esc(item.key)}" style="width:${item.tokens / total * 100}%;background:${item.color}" title="${esc(item.label)}：${formatInteger(item.tokens)} tok"></i>`).join('');
    return `<div class="runtime-progress" role="img" aria-label="上下文已用 ${esc(percent(pct))}，按分类显示"><div class="runtime-progress-used" style="width:${Math.max(0,Math.min(100,pct))}%">${segments}</div></div>`;
  }

  function ensureHost() {
    const input = document.querySelector('[data-testid="agent-input-box"]');
    const anchor = input?.parentElement;
    const mountParent = anchor?.parentElement;
    if (!input || !anchor || !mountParent) return null;
    if (!state.spacingContainer?.contains(input)) {
      restoreFooterSpacing();
      let container = mountParent;
      for (let depth = 0; container && container !== document.body && depth < 8; depth++, container = container.parentElement) {
        const padding = parseFloat(getComputedStyle(container).paddingBottom);
        if (padding >= 12 && padding <= 32) {
          state.spacingContainer = container;
          state.previousPaddingBottom = container.style.getPropertyValue('padding-bottom');
          state.previousPaddingPriority = container.style.getPropertyPriority('padding-bottom');
          break;
        }
      }
    }
    // Match the pill's lower gap to the upper gap measured from the composer's outer ring.
    state.spacingContainer?.style.setProperty('padding-bottom', '7px');
    document.getElementById(`${HOST_ID}-page-style`)?.remove();
    // Keep one node across React parent replacements. A subtree lookup can miss
    // the previous mount and create thousands of copies through its own observer.
    let host = state.host || document.getElementById(HOST_ID);
    for (const duplicate of document.querySelectorAll(`#${HOST_ID}`)) {
      if (duplicate !== host) duplicate.remove();
    }
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-agy-runtime-overlay', VERSION);
    }
    // AGY's outer CSS reset overrides normal :host margins across the shadow boundary.
    host.style.margin = '8px auto 0';
    host.style.alignSelf = 'center';
    if (host.parentElement !== mountParent || host.previousElementSibling !== anchor) {
      mountParent.insertBefore(host, anchor.nextSibling);
    }
    if (!host.shadowRoot) {
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>${STYLE}</style><div class="runtime-root" role="status" aria-label="DSH 会话状态栏">
        <div class="runtime-pill-wrap" data-key="session"><button class="runtime-pill" type="button" aria-expanded="false"><span class="runtime-icon">${GAUGE_ICON}</span><span class="runtime-label" data-field="session-label">会话统计</span></button><div class="runtime-popover" data-popover="session"></div></div>
        <div class="runtime-pill-wrap" data-key="tokens"><button class="runtime-pill" type="button" aria-expanded="false"><span class="runtime-icon">${DATABASE_ICON}</span><span class="runtime-label" data-field="tokens-label">Token 用量</span></button><div class="runtime-popover" data-popover="tokens"></div></div>
        <div class="runtime-pill-wrap" data-key="context"><button class="runtime-pill" type="button" aria-expanded="false"><span class="runtime-icon" data-field="context-ring">${contextRing(0)}</span><span class="runtime-label" data-field="context-label">上下文</span></button><div class="runtime-popover" data-popover="context"></div></div>
      </div>`;
      for (const wrap of shadow.querySelectorAll('.runtime-pill-wrap')) bindPopover(wrap);
      state.shadow = shadow;
    } else {
      const style = host.shadowRoot.querySelector('style');
      if (style && style.textContent !== STYLE) style.textContent = STYLE;
      state.shadow = host.shadowRoot;
    }
    state.host = host;
    state.footer = mountParent;
    return host;
  }

  function bindPopover(wrap) {
    const button = wrap.querySelector('button');
    const popover = wrap.querySelector('.runtime-popover');
    popover.setAttribute('popover', 'manual');
    let closeTimer;
    const close = () => {
      if (popover.matches(':popover-open')) popover.hidePopover();
      button.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      clearTimeout(closeTimer);
      for (const other of wrap.getRootNode().querySelectorAll('.runtime-popover:popover-open')) {
        if (other !== popover) other.hidePopover();
      }
      if (!popover.matches(':popover-open')) popover.showPopover();
      positionPopover(popover, button);
      button.setAttribute('aria-expanded', 'true');
    };
    button.addEventListener('mouseenter', open);
    button.addEventListener('focus', open);
    button.addEventListener('mouseleave', () => { closeTimer = setTimeout(close, 160); });
    popover.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    popover.addEventListener('mouseleave', close);
    button.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    button?.addEventListener('click', () => {
      if (popover.matches(':popover-open') && wrap.dataset.clicked === 'true') { close(); wrap.dataset.clicked = 'false'; }
      else { open(); wrap.dataset.clicked = 'true'; }
    });
  }


  function positionPopover(popover, button) {
    const anchor = button.getBoundingClientRect();
    const size = popover.getBoundingClientRect();
    popover.style.left = Math.max(8, Math.min(innerWidth - size.width - 8, anchor.left + anchor.width / 2 - size.width / 2)) + 'px';
    const below = popover.dataset.placement === 'bottom' && anchor.bottom + size.height + 8 < innerHeight;
    popover.style.top = (below ? anchor.bottom + 8 : Math.max(8, anchor.top - size.height - 10)) + 'px';
  }

  function render(payload) {
    const hadHost = Boolean(state.shadow && state.shadow.host && state.shadow.host.isConnected);
    const host = ensureHost();
    if (!host?.shadowRoot) return;
    if (!hadHost) state.lastRenderedRevision = '';
    const model = normalize(payload);
    state.lastPayload = model;
    state.lastRevision = model.revision;
    if (model.revision && state.lastRenderedRevision === model.revision) {
      hideNativeBadges();
      injectReplyBadges(model);
      return;
    }
    state.lastRenderedRevision = model.revision || '';
    const turns = model.turns;
    const steps = model.steps;
    const toolMs = model.toolMs;
    const llmMs = model.llmMs;
    const ttft = model.ttft;
    const hasSubagents = model.subagentCount > 0;
    const totalTokens = hasSubagents ? model.teamTotalTokens : model.ownTotalTokens;
    const contextPct = model.contextWindow > 0 ? model.contextUsed / model.contextWindow * 100 : 0;
    const latestName = model.latest.modelDisplayName || model.latest.responseModel || model.latest.sentModel || '未识别模型';
    const q = host.shadowRoot;
    const sessionLabel = `${formatInteger(turns)} 轮 ${formatInteger(steps)} 步 · ${formatInteger(model.decodeTps)} tok/s`;
    const compactUsd = formatUsd(model.teamUsd, false);
    const detailedUsd = formatUsd(model.teamUsd, true);
    const shownCacheHit = hasSubagents ? model.teamCacheHit : model.cacheHit;
    const tokenLabel = `${formatCompact(totalTokens)} tok · 缓存命中 ${percent(shownCacheHit)}${compactUsd ? ` · ${compactUsd}` : ''}`;
    const contextLabel = `${percent(contextPct)}`;
    q.querySelector('[data-field="session-label"]').textContent = sessionLabel;
    q.querySelector('[data-field="tokens-label"]').textContent = tokenLabel;
    q.querySelector('[data-field="context-label"]').textContent = contextLabel;
    q.querySelector('[data-field="context-ring"]').innerHTML = contextRing(contextPct);
    const sessionRows = [
      ['模型用时', formatDuration(llmMs)],
      ['工具调用用时', formatDuration(toolMs)],
      ['首 token 平均 (TTFT)', `${ttft.toFixed(2)} 秒`],
      ['输出速度', `${formatInteger(model.decodeTps)} tok/s`],
      ...(hasSubagents ? [['子代理调用', `${formatInteger(model.subagentCount)} 个 (${formatInteger(model.subagentSteps)} 步)`]] : []),
      ['当前模型', latestName]
    ];
    q.querySelector('[data-popover="session"]').innerHTML = `<div class="runtime-popover-header"><span>会话统计</span><strong>${esc(formatInteger(turns))} 轮 ${esc(formatInteger(steps))} 步</strong></div>${rows(sessionRows)}`;
    const ownDetailedUsd = formatUsd(model.ownUsd, true);
    const subDetailedUsd = formatUsd(model.subagentUsd, true);
    const tokenRows = hasSubagents
      ? [
          ['当前 Agent', `${formatCompact(model.ownTotalTokens)} tok${ownDetailedUsd ? ` · ${ownDetailedUsd}` : ''}`],
          [`子 Agent × ${formatInteger(model.subagentCount)}`, `${formatCompact(model.subagentTokens)} tok${subDetailedUsd ? ` · ${subDetailedUsd}` : ''}`],
          ['缓存命中 (合计)', `${percent(model.teamCacheHit)}（主会话 ${percent(model.cacheHit)}）`],
          ['未缓存输入 (合计)', `${formatInteger(model.teamInput)} tok`],
          ['缓存读取 (合计)', `${formatInteger(model.teamCacheRead)} tok`],
          ['输出 (合计)', `${formatInteger(model.teamOutput)} tok`],
          ['估算总费用', detailedUsd || '暂不可用']
        ]
      : [
          ['缓存命中', percent(model.cacheHit)],
          ['未缓存输入', `${formatInteger(model.input)} tok`],
          ['缓存读取', `${formatInteger(model.cacheRead)} tok`],
          ['输出', `${formatInteger(model.output)} tok`],
          ['估算费用', detailedUsd || '暂不可用']
        ];
    q.querySelector('[data-popover="tokens"]').innerHTML = `<div class="runtime-popover-header"><span>${hasSubagents ? 'Token 用量 (含子代理)' : 'Token 用量'}</span><strong>${esc(formatInteger(totalTokens))} tok</strong></div>${rows(tokenRows)}`;
    q.querySelector('[data-popover="context"]').innerHTML = `<div class="runtime-popover-header"><span>上下文用量</span><strong>${esc(percent(contextPct))} · ~${esc(formatCompact(model.contextUsed))} / ${esc(formatCompact(model.contextWindow))}</strong></div>${contextBar(model, contextPct)}${bucketRows(model)}${model.contextEstimateNote ? '<div class="runtime-empty" style="font-size:11px">'+esc(model.contextEstimateNote)+'</div>' : ''}`;
    for (const popover of q.querySelectorAll('.runtime-popover:popover-open')) positionPopover(popover, popover.parentElement.querySelector('button'));
    for (const wrap of q.querySelectorAll('.runtime-pill-wrap')) {
      const button = wrap.querySelector('button');
      button?.setAttribute('title', wrap.dataset.key === 'session' ? '会话统计' : wrap.dataset.key === 'tokens' ? 'Token 用量' : '上下文用量');
    }
    hideNativeBadges();
    injectReplyBadges(model);
  }

  function hideNativeBadges() {
    for (const widget of document.querySelectorAll('[data-testid="agent-response"] button[title="对话分支 (Conversation Fork)"]')) {
      if (widget.dataset.agyNativeWidgetHidden === '1') continue;
      if (/^(?:🌿\s*)?(?:分支|AGY Conversation Fork)$/.test(widget.textContent.trim())) {
        widget.dataset.agyNativeWidgetHidden = '1';
        widget.style.setProperty('display', 'none', 'important');
      }
    }

    for (const img of document.querySelectorAll('img')) {
      const src = String(img.currentSrc || img.src || '');
      if (img.dataset.agyCheckedSrc === src) continue;
      img.dataset.agyCheckedSrc = src;
      if (!NATIVE_BADGE_RE.test(src) && !/AGY (?:Model Inspector|Conversation Fork)/i.test(img.alt || '')) continue;
      if (img.closest('[data-agy-runtime-reply-badge]')) continue;
      // AGY wraps markdown sidecar links in a button with its own purple icon.
      // Hide that entire native widget; the independent bar is appended below.
      const wrapper = img.closest('button') || img.closest('a') || img.closest('span.inline-flex') || img;
      if (wrapper.getAttribute('data-agy-native-badge-hidden') !== 'true') {
        wrapper.setAttribute('data-agy-native-badge-hidden', 'true');
        wrapper.style.setProperty('display', 'none', 'important');
      }
    }
  }

  // Original DSH ICON_SYMBOLS: branch-outline, database-outline, gauge-outline.
  // @deepseek-ai/dsh-web-frontend 0.2.2-rc.2, MIT, Copyright (c) 2026 DeepSeek.
  // See vendor/LICENSE.dsh-icons. Regular icons use a 16px viewBox and 1px stroke.
  const svgIcon = content => '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true">' + content + '</svg>';
  const BRANCH_ICON = svgIcon('<path d="M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564" stroke="currentColor"/><path d="M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944" stroke="currentColor"/><circle cx="12.4502" cy="3.3079" r="1.56962" stroke="currentColor"/><circle cx="12.4502" cy="12.6921" r="1.56962" stroke="currentColor"/>');
  const DATABASE_ICON = svgIcon('<path d="M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z" stroke="currentColor"/><path d="M2 3.80371V11.7848M14 3.80371V11.7848" stroke="currentColor"/><path d="M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396" stroke="currentColor"/><path d="M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847" stroke="currentColor"/>');
  const GAUGE_ICON = svgIcon('<path d="M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096" stroke="currentColor"/><path d="M8 8.49994L11.6114 4.88855" stroke="currentColor"/><path d="M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z" fill="currentColor"/>');

  // DSH ContextMeter.tsx: r=5.5, 14px viewBox, a round-capped 2px arc.
  function contextRing(pct) {
    const circumference = 2 * Math.PI * 5.5;
    const dash = circumference * Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5.5" stroke="var(--border,#444)" stroke-width="2"/><circle data-progress-arc cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + circumference + '" transform="rotate(-90 7 7)"/></svg>';
  }

  function findActionRow(response) {
    const footer = response.nextElementSibling;
    if (!footer) return null;
    const copy = footer.querySelector('button[aria-label="Copy"]');
    const good = footer.querySelector('button[aria-label="Good response"]');
    const bad = footer.querySelector('button[aria-label="Bad response"]');
    if (!copy || !good || !bad) return null;
    // The closest shared row is AGY's native icon group; its outer row also
    // contains the timestamp and must not receive extra standalone controls.
    for (let row = copy.parentElement; row && footer.contains(row); row = row.parentElement) {
      const css = getComputedStyle(row);
      if (row.contains(good) && row.contains(bad) && css.display.includes('flex') && css.flexDirection === 'row') return row;
    }
    return null;
  }

  function injectReplyBadges(model) {
    const responses = [...document.querySelectorAll('[data-testid="agent-response"]')];
    const trends = model.analytics.trends || [];
    const totalTurns = Number(model.analytics.sessionStats?.turns || 0);
    const byIndex = new Map(trends.map(t => [Number(t.idx) - 1, t]));
    for (const [responseIndex, target] of responses.entries()) {
      let row = target._agyActionRow;
      if (!row || !row.isConnected) {
        row = findActionRow(target);
        if (row) target._agyActionRow = row;
      }
      if (!row) continue;
      const legacy = [...target.querySelectorAll('img')].find(img => /\/api\/badge\.svg/.test(img.src));
      const legacyIndex = legacy ? new URL(legacy.src).searchParams.get('idx') : null;
      let turn = legacyIndex !== null ? byIndex.get(Number(legacyIndex))?.turn : null;
      if (!turn && target.parentElement.dataset.turnContent === 'latest') turn = totalTurns;
      if (!turn && responses.length === totalTurns) turn = responseIndex + 1;
      // Avoid assigning a guessed total to a virtualized historical reply.
      if (!turn) continue;
      const records = model.invocations.filter(inv => byIndex.get(Number(inv.idx))?.turn === turn);
      if (!records.length) continue;
      const sum = key => records.reduce((n, inv) => n + Number(inv[key] || 0), 0);
      const input = sum('inputTokens'), cache = sum('cacheReadTokens');
      const output = sum('outputTokens'), thinking = sum('thinkingOutputTokens');
      const total = input + cache + output;
      const hit = input + cache ? cache / (input + cache) * 100 : 0;
      let host = row.querySelector('[data-agy-runtime-turn-usage]');
      if (!host) {
        host = document.createElement('span');
        host.setAttribute('data-agy-runtime-turn-usage', String(turn));
        row.appendChild(host);
        const shadow = host.attachShadow({mode:'open'});
        shadow.innerHTML = '<style>' + STYLE + ':host{display:inline-flex;width:auto;flex:0 0 auto;height:24px;margin-left:2px;contain:none;font-size:12px}.runtime-pill{border:0;background:transparent;padding:0 5px;height:24px;gap:5px;max-width:none;color:var(--secondary-foreground,var(--muted-foreground,#aaa))}.runtime-pill:hover,.runtime-pill[aria-expanded=true]{background:var(--muted,rgba(128,128,128,.13))}.runtime-popover{width:min(520px,calc(100vw - 24px));padding:18px 20px;border-radius:14px}.runtime-row{font-size:14px;align-items:baseline}.runtime-row strong{max-width:74%;overflow-wrap:anywhere;white-space:normal}.runtime-popover-header{font-size:15px}.runtime-popover-header>span{display:flex;align-items:center;gap:8px}</style><span class="runtime-pill-wrap"><button type="button" class="runtime-pill" aria-label="本轮用量" aria-expanded="false">' + DATABASE_ICON + '<span class="runtime-label"></span></button><div popover="manual" class="runtime-popover"></div></span>';
        bindPopover(shadow.querySelector('.runtime-pill-wrap'));
      }
      const boundKey = `${model.revision || ''}:${turn}:${total}:${records.length}`;
      if (host.dataset.agyBoundKey !== boundKey) {
        host.dataset.agyBoundKey = boundKey;
        const providerLabel = value => value === 'API_PROVIDER_GOOGLE_GEMINI' ? 'Google Gemini' : String(value || '').replace(/^API_PROVIDER_/, '').replaceAll('_', ' ');
        const providers = [...new Set(records.map(inv => providerLabel(inv.apiProvider)).filter(Boolean))].join(' / ');
        const models = [...new Set(records.map(inv => inv.responseModelFull || inv.sentModel || inv.responseModel || inv.modelDisplayName).filter(Boolean))].join(' / ');
        const q = host.shadowRoot;
        q.querySelector('.runtime-label').textContent = '用量 ' + formatCompact(total) + ' tok';
        q.querySelector('.runtime-popover').innerHTML = '<div class="runtime-popover-header"><span>' + DATABASE_ICON + '本轮用量</span><strong>' + esc(formatInteger(total)) + ' tok</strong></div>' + rows([
          ['提供方 / 模型', (providers ? providers + ' / ' : '') + models],
          ['缓存命中', hit.toFixed(1) + '%'],
          ['未缓存输入', formatInteger(input) + ' tok'],
          ['缓存读取', formatInteger(cache) + ' tok'],
          ['输出', formatInteger(output) + ' tok' + (thinking ? '（其中推理 ' + formatInteger(thinking) + ' tok）' : '')]
        ]);
        const popup = q.querySelector('.runtime-popover');
        if (popup.matches(':popover-open')) positionPopover(popup, q.querySelector('button'));
      }
      ensureForkButton(row, turn);
    }
  }

  function ensureForkButton(row, turn) {
    let host = row.querySelector('[data-agy-runtime-fork]');
    if (!host) {
      host = document.createElement('span');
      host.setAttribute('data-agy-runtime-fork', String(turn));
      row.insertBefore(host, row.querySelector('[data-agy-runtime-turn-usage]') || row.firstChild);
      const shadow = host.attachShadow({mode:'open'});
      shadow.innerHTML = '<style>' + STYLE + ':host{display:inline-flex;flex:0 0 auto;width:24px;height:24px;contain:none}.runtime-pill{border:0;background:transparent;width:24px;height:24px;padding:4px;justify-content:center;border-radius:6px;color:var(--secondary-foreground,var(--muted-foreground,#aaa))}.runtime-pill:hover{background:var(--muted,rgba(128,128,128,.12))}.runtime-pill:disabled{opacity:.45;cursor:wait}.runtime-popover{width:max-content;max-width:320px;padding:6px 9px;font-size:12px;white-space:normal;border-radius:6px}</style><span class="runtime-pill-wrap"><button type="button" class="runtime-pill" aria-label="在新对话中分支" aria-expanded="false">' + BRANCH_ICON + '</button><div class="runtime-popover" popover="manual" role="tooltip" data-placement="bottom">在新对话中分支</div></span>';
      bindPopover(shadow.querySelector('.runtime-pill-wrap'));
      shadow.querySelector('button').addEventListener('click', () => {
        if (state.forkPending) return;
        const request = {id:crypto.randomUUID(),conversationId:conversationId(),turnNumber:turn,project:new URL(location.href).searchParams.get('project') || ''};
        state.forkPending = request;
        state.forkRequests.push({id:request.id,conversationId:request.conversationId,turnNumber:turn});
        delete host.dataset.error;
        shadow.querySelector('.runtime-popover').textContent = '正在创建分支…';
        for (const item of document.querySelectorAll('[data-agy-runtime-fork]')) item.shadowRoot.querySelector('button').disabled = true;
      });
    }
    // Keep both injected controls within the native copy/feedback icon group.
    const usage = row.querySelector('[data-agy-runtime-turn-usage]');
    if (usage && host.nextElementSibling !== usage) row.insertBefore(host, usage);
    host.shadowRoot.querySelector('button').disabled = Boolean(state.forkPending);
    host.shadowRoot.querySelector('.runtime-popover').textContent = state.forkPending?.turnNumber === turn ? '正在创建分支…' : host.dataset.error || '在新对话中分支';
  }

  function resolveFork(id, reply) {
    const request = state.forkPending;
    if (!request || request.id !== id) return;
    state.forkPending = null;
    for (const host of document.querySelectorAll('[data-agy-runtime-fork]')) host.shadowRoot.querySelector('button').disabled = false;
    const child = reply?.result?.newCascadeId;
    if (reply?.error || !/^[0-9a-f-]{36}$/i.test(child || '')) {
      const host = document.querySelector('[data-agy-runtime-fork="' + request.turnNumber + '"]');
      if (host) {
        host.dataset.error = '分支创建失败：' + String(reply?.error || '未返回新对话').slice(0, 300);
        const popup = host.shadowRoot.querySelector('.runtime-popover');
        popup.textContent = host.dataset.error;
        if (!popup.matches(':popover-open')) popup.showPopover();
        positionPopover(popup, host.shadowRoot.querySelector('button'));
      }
      return;
    }
    if (conversationId() !== request.conversationId) return;
    const destination = new URL('/c/' + child, location.origin);
    const project = reply.result.newProjectId || request.project;
    if (project) destination.searchParams.set('project', project);
    location.assign(destination.href);
  }

  function refresh() {
    ensureHost();
    hideNativeBadges();
  }

  function update(payload) {
    if (state.stopped) return;
    render(payload);
  }

  function tick(expectedRevision) {
    if (state.stopped) return { needUpdate: false };
    if (!state.lastPayload || (expectedRevision && state.lastRevision !== expectedRevision)) {
      return { needUpdate: true };
    }
    render(state.lastPayload);
    return { needUpdate: false };
  }

  function restoreFooterSpacing() {
    const container = state.spacingContainer;
    if (container && container.style.paddingBottom === '7px') {
      if (state.previousPaddingBottom) container.style.setProperty('padding-bottom', state.previousPaddingBottom, state.previousPaddingPriority);
      else container.style.removeProperty('padding-bottom');
    }
    state.spacingContainer = null;
  }

  function stop() {
    state.stopped = true;
    restoreFooterSpacing();
    for (const host of [state.host, ...document.querySelectorAll('[data-agy-runtime-turn-usage], [data-agy-runtime-fork]')]) {
      for (const popover of host?.shadowRoot?.querySelectorAll('.runtime-popover:popover-open') || []) popover.hidePopover();
    }
  }

  // The external injector refreshes on its bounded polling interval. Observing
  // our own DOM insertions is unnecessary and can create a feedback loop.
  globalThis.__AGY_MODEL_INSPECTOR_OVERLAY__ = { version: VERSION, build: BUILD, refresh, update, tick, stop, drainForkRequests: () => state.forkRequests.splice(0), resolveFork };
  refresh();
})();
