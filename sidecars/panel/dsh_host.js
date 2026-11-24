(function () {
  'use strict';

  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const h = React.createElement;

  // ── Stable Reference Constants (Never Re-allocated Per Call) ──────────────
  const EMPTY_OBJ = Object.freeze({});
  const EMPTY_ARR = Object.freeze([]);
  const EMPTY_CHAT_STATE = Object.freeze({
    legacy: Object.freeze({ nodes: EMPTY_ARR })
  });

  // ── Formatters & Dual-Layer Helpers ───────────────────────────────────────
  function isModelRouteMismatch(sentModel, responseModel) {
    const norm = (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      if (!s || s === 'n/a' || s === 'unknown') return '';
      return s
        .replace(/^models\//, '')
        .replace(/-(xhigh|high|medium|med|low|minimal|thinking|none)$/i, '')
        .replace(/@.*$/, '')
        .trim();
    };
    const a = norm(sentModel);
    const b = norm(responseModel);
    return Boolean(a && b && a !== b);
  }

  function parseModelAndEffort(sentModel, responseModel) {
    const rawSent = String(sentModel || '').trim();
    const rawResp = String(responseModel || '').trim();
    const effortRe = /-(xhigh|high|medium|med|low|minimal|thinking|none)$/i;
    const mSent = rawSent.match(effortRe);
    const mResp = rawResp.match(effortRe);
    const effort = (mSent?.[1] || mResp?.[1] || '').toLowerCase();
    const primary = rawResp && rawResp !== 'N/A' ? rawResp : rawSent;
    const base = primary.replace(effortRe, '') || rawSent || 'N/A';
    return { base, effort };
  }

  function fmtInt(n) {
    return Math.round(Number(n || 0)).toLocaleString('en-US');
  }

  function fmtCompact(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return '0';
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }

  function fmtDurZh(ms) {
    const s = Math.max(0, Number(ms || 0)) / 1000;
    if (s < 1) return Math.round(s * 1000) + '毫秒';
    if (s < 60) return s.toFixed(1).replace(/\.0$/, '') + '秒';
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    if (m < 60) return m + '分' + (rem > 0 ? rem + '秒' : '');
    const hr = Math.floor(m / 60);
    const rm = m % 60;
    return hr + '小时' + (rm > 0 ? rm + '分' : '');
  }

  function fmtClockHms(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function fmtFullDateTime(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const yyyy = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}`;
  }

  function buildPagerItems(page, totalPages) {
    const total = Math.max(1, Number(totalPages || 1));
    const cur = Math.min(total, Math.max(1, Number(page || 1)));
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = new Set([1, total, cur - 1, cur, cur + 1]);
    if (cur <= 3) { pages.add(2); pages.add(3); pages.add(4); }
    if (cur >= total - 2) { pages.add(total - 1); pages.add(total - 2); pages.add(total - 3); }
    const sorted = [...pages].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const p of sorted) {
      if (prev > 0 && p - prev > 1) out.push('...');
      out.push(p);
      prev = p;
    }
    return out;
  }

  function DualToken({ value, unit = '', inline = false, badge = null }) {
    const num = Math.max(0, Number(value || 0));
    const compact = fmtCompact(num) + (unit ? ' ' + unit : '');
    const exact = fmtInt(num) + (unit ? ' ' + unit : '');
    if (inline) {
      return h('span', { className: 'agy-dual-inline' },
        h('span', { className: 'agy-dual-main' }, compact),
        num >= 1000 ? h('span', { className: 'agy-dual-exact-inline' }, ` (${exact})`) : null
      );
    }
    return h('div', { className: 'agy-dual-tok' },
      badge
        ? h('div', { className: 'agy-dual-head' },
            h('span', { className: 'agy-dual-main' }, compact),
            badge
          )
        : h('div', { className: 'agy-dual-main' }, compact),
      h('div', { className: 'agy-dual-sub' }, exact)
    );
  }

  // ── react/jsx-runtime Shim for dsh-context-client.js ──────────────────────
  function jsxShim(type, props, key) {
    if (!props || typeof props !== 'object') {
      return key !== undefined ? h(type, { key }) : h(type, null);
    }
    const { children, ...rest } = props;
    const finalProps = key !== undefined ? { ...rest, key } : rest;
    if (children === undefined) return h(type, finalProps);
    if (Array.isArray(children)) return h(type, finalProps, ...children);
    return h(type, finalProps, children);
  }

  // ── Complete @deepseek-ai/dsh-client-ui-primitives Polyfill ───────────────
  function renderIconPaths(kind) {
    if (kind.includes('ChevronDown')) return h('path', { d: 'M4 6l4 4 4-4' });
    if (kind.includes('ChevronUp')) return h('path', { d: 'M4 10l4-4 4 4' });
    if (kind.includes('Search')) {
      return [h('circle', { key: 'a', cx: 7, cy: 7, r: 4.5 }), h('path', { key: 'b', d: 'M10.5 10.5L14 14' })];
    }
    if (kind.includes('Close')) return h('path', { d: 'M4 4l8 8M12 4l-8 8' });
    if (kind.includes('Copy')) {
      return [h('rect', { key: 'a', x: 5.5, y: 5.5, width: 7.5, height: 7.5, rx: 1.5 }), h('path', { key: 'b', d: 'M3.5 10.5V3.5A1.5 1.5 0 0 1 5 2h7' })];
    }
    if (kind.includes('Checklist')) {
      return [h('path', { key: 'a', d: 'M2.5 5l1.5 1.5L6.5 4M8.5 5.25H13.5M2.5 10.5l1.5 1.5L6.5 9.5M8.5 10.75H13.5' })];
    }
    if (kind.includes('Check')) return h('path', { d: 'M3.2 8.4l3 3.1 6.6-7' });
    if (kind.includes('Clock')) {
      return [h('circle', { key: 'a', cx: 8, cy: 8, r: 6 }), h('path', { key: 'b', d: 'M8 4.5v3.7l2.5 1.5' })];
    }
    if (kind.includes('Database')) {
      return [
        h('ellipse', { key: 'a', cx: 8, cy: 4, rx: 5, ry: 2 }),
        h('path', { key: 'b', d: 'M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.24 2 5 2s5-.9 5-2' })
      ];
    }
    if (kind.includes('Settings')) {
      return [
        h('circle', { key: 'a', cx: 8, cy: 8, r: 2.2 }),
        h('path', { key: 'b', d: 'M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.76 3.76l1.1 1.1M11.14 11.14l1.1 1.1M12.24 3.76l-1.1 1.1M4.86 11.14l-1.1 1.1' })
      ];
    }
    if (kind.includes('Branch')) {
      return [
        h('circle', { key: 'a', cx: 4.5, cy: 4, r: 1.5 }),
        h('circle', { key: 'b', cx: 11.5, cy: 5, r: 1.5 }),
        h('circle', { key: 'c', cx: 4.5, cy: 12, r: 1.5 }),
        h('path', { key: 'd', d: 'M4.5 5.5v5M4.5 9.2c0-1.9 7-1.2 7-2.7' })
      ];
    }
    if (kind.includes('WorkspaceTree')) {
      return [
        h('rect', { key: 'a', x: 2.5, y: 2.5, width: 4, height: 3.5, rx: 0.8 }),
        h('rect', { key: 'b', x: 9.5, y: 3, width: 4, height: 3, rx: 0.8 }),
        h('rect', { key: 'c', x: 9.5, y: 9.5, width: 4, height: 3.5, rx: 0.8 }),
        h('path', { key: 'd', d: 'M4.5 6v5.2h5M4.5 8.2h5' })
      ];
    }
    if (kind.includes('Gauge')) {
      return [
        h('path', { key: 'a', d: 'M2.5 11.5a6 6 0 1 1 11 0' }),
        h('path', { key: 'b', d: 'M8 8.5l2.8-2.8' }),
        h('circle', { key: 'c', cx: 8, cy: 9.5, r: 0.9 })
      ];
    }
    if (kind.includes('Data')) {
      return h('path', { d: 'M3 13V9M6.5 13V6M10 13V8M13.5 13V3.5' });
    }
    if (kind.includes('Plus')) return h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' });
    if (kind.includes('Share')) {
      return [
        h('circle', { key: 'a', cx: 12, cy: 3.5, r: 1.5 }),
        h('circle', { key: 'b', cx: 4, cy: 8, r: 1.5 }),
        h('circle', { key: 'c', cx: 12, cy: 12.5, r: 1.5 }),
        h('path', { key: 'd', d: 'M5.3 7.2l5.4-2.9M5.3 8.8l5.4 2.9' })
      ];
    }
    if (kind.includes('CompareSplit')) {
      return [
        h('rect', { key: 'a', x: 2.5, y: 3, width: 11, height: 10, rx: 1.5 }),
        h('path', { key: 'b', d: 'M8 3v10' })
      ];
    }
    if (kind.includes('Browse')) {
      return [
        h('path', { key: 'a', d: 'M2 4.5h12M2 8h8M2 11.5h10' }),
        h('circle', { key: 'b', cx: 12.5, cy: 10.5, r: 2 })
      ];
    }
    if (kind.includes('ContextInjection')) {
      return [
        h('rect', { key: 'a', x: 3, y: 2.5, width: 10, height: 11, rx: 1.5 }),
        h('path', { key: 'b', d: 'M8 5.5v5M5.8 8l2.2 2.2L10.2 8' })
      ];
    }
    if (kind.includes('FolderOpen')) {
      return h('path', { d: 'M2.2 4.5A1.3 1.3 0 0 1 3.5 3.2h3l1.3 1.5h4.7A1.2 1.2 0 0 1 13.7 6v5.5a1.3 1.3 0 0 1-1.3 1.3H3.5a1.3 1.3 0 0 1-1.3-1.3V4.5z' });
    }
    if (kind.includes('Api')) {
      return h('path', { d: 'M5 5.2L2.5 8 5 10.8M11 5.2L13.5 8 11 10.8M8.8 4L7.2 12' });
    }
    if (kind.includes('Inspect')) {
      return [
        h('path', { key: 'a', d: 'M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z' }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.6 })
      ];
    }
    if (kind.includes('PanelLeft')) {
      return [
        h('rect', { key: 'a', x: 2.2, y: 2.8, width: 11.6, height: 10.4, rx: 1.5 }),
        h('path', { key: 'b', d: 'M6 2.8v10.4' })
      ];
    }
    if (kind.includes('Plugin')) {
      return [
        h('circle', { key: 'a', cx: 8, cy: 8, r: 1.8 }),
        h('path', { key: 'b', d: 'M8 2.2v3.6M13.8 8H10.2M8 13.8V10.2M2.2 8h3.6' })
      ];
    }
    if (kind.includes('RightUp')) {
      return h('path', { d: 'M4.5 11.5L11.5 4.5M6 4.5h5.5V10' });
    }
    if (kind.includes('Send')) {
      return h('path', { d: 'M13.5 2.5L7 9M13.5 2.5L9.5 13.5 7 9 2.5 6.5 13.5 2.5z' });
    }
    if (kind.includes('Skill')) {
      return h('path', { d: 'M9 2L4 9h4l-1 5 5-7H8l1-5z' });
    }
    return [h('circle', { key: 'a', cx: 8, cy: 8, r: 5.5 }), h('path', { key: 'b', d: 'M8 5.5v5M5.5 8h5' })];
  }

  function createIconComponent(kind) {
    return function PrimitiveIcon(props) {
      const size = props?.size ?? 14;
      const cls = props?.className || '';
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.45,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: cls,
        'aria-hidden': 'true'
      }, renderIconPaths(kind));
    };
  }

  const iconCache = new Map();
  function getIcon(name) {
    if (!iconCache.has(name)) iconCache.set(name, createIconComponent(name));
    return iconCache.get(name);
  }

  function useDismissOnOutsidePointer(ref, active, onDismiss) {
    const dismissRef = React.useRef(onDismiss);
    dismissRef.current = onDismiss;
    React.useEffect(() => {
      if (!active) return undefined;
      const onDown = (e) => {
        const target = e?.target;
        const refs = Array.isArray(ref) ? ref : [ref];
        for (const r of refs) {
          const el = r && typeof r === 'object' && 'current' in r ? r.current : r;
          if (el && target instanceof Node && el.contains(target)) return;
        }
        if (typeof dismissRef.current === 'function') dismissRef.current();
      };
      document.addEventListener('pointerdown', onDown, true);
      return () => document.removeEventListener('pointerdown', onDown, true);
    }, [ref, active]);
  }

  function StateDot({ state = 'idle', size = 10, className = '' }) {
    const colorMap = {
      ongoing: '#38bdf8',
      running: '#38bdf8',
      done: '#22c55e',
      completed: '#22c55e',
      warning: '#eab308',
      error: '#ef4444',
      failed: '#ef4444',
      idle: '#71717a'
    };
    const color = colorMap[state] || '#71717a';
    return h('span', {
      className: `agy-state-dot ${state === 'ongoing' || state === 'running' ? 'is-pulse ' : ''}${className}`,
      style: {
        display: 'inline-block',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '999px',
        backgroundColor: color,
        flexShrink: 0
      }
    });
  }

  function MarkdownText({ text = '' }) {
    return h('div', {
      className: 'agy-md-text',
      style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', lineHeight: '1.55' }
    }, String(text || ''));
  }

  function JsonNodeView({ name, val, depth = 0 }) {
    const [open, setOpen] = React.useState(depth < 1);
    const isObj = val !== null && typeof val === 'object';
    if (!isObj) {
      const strVal = typeof val === 'string' ? JSON.stringify(val) : String(val);
      return h('div', {
        role: 'treeitem',
        style: { paddingLeft: `${depth * 14}px`, fontSize: '11px', fontFamily: 'var(--font-mono)' }
      },
        name !== undefined ? h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, `${name}: `) : null,
        h('span', { style: { color: typeof val === 'string' ? 'var(--color-green-500)' : 'var(--color-amber-500)' } }, strVal)
      );
    }
    const entries = Array.isArray(val) ? val.map((v, i) => [String(i), v]) : Object.entries(val);
    return h('div', { role: 'treeitem', 'aria-expanded': open, style: { paddingLeft: `${depth * 14}px` } },
      h('button', {
        type: 'button',
        'data-json-expander': 'true',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen(o => !o),
        style: {
          background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
          padding: '1px 2px', fontFamily: 'var(--font-mono)', fontSize: '11px'
        }
      }, `${open ? '▾' : '▸'} ${name !== undefined ? name + ': ' : ''}${Array.isArray(val) ? `[${entries.length}]` : `{${entries.length}}`}`),
      open ? entries.map(([k, v]) => h(JsonNodeView, { key: k, name: k, val: v, depth: depth + 1 })) : null
    );
  }

  function JsonTree({ data, label }) {
    return h('div', { role: 'tree', 'aria-label': label || 'JSON', className: 'agy-json-tree' },
      h(JsonNodeView, { val: data, depth: 0 })
    );
  }

  function Menu({ open, onClose, items = [], selectedId, onSelect, anchor, align = 'end', portal = false }) {
    const wrapRef = React.useRef(null);
    const popupRef = React.useRef(null);
    const [pos, setPos] = React.useState(null);
    const refs = React.useMemo(() => [wrapRef, popupRef], []);
    useDismissOnOutsidePointer(refs, Boolean(open), onClose);

    React.useLayoutEffect(() => {
      if (!open || !wrapRef.current) {
        setPos(null);
        return;
      }
      const rect = wrapRef.current.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 240, rect.bottom + 6);
      const next = align === 'start'
        ? { top: Math.max(8, top), left: Math.max(8, rect.left) }
        : { top: Math.max(8, top), right: Math.max(8, window.innerWidth - rect.right) };
      setPos(next);
    }, [open, align]);

    const popup = open
      ? h('div', {
          ref: popupRef,
          role: 'menu',
          className: 'agy-menu-popup',
          style: pos
            ? { position: 'fixed', ...pos, zIndex: 320 }
            : { position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 320 },
          onClick: (e) => e.stopPropagation()
        },
          items.map((it) => h('button', {
            key: it.id,
            type: 'button',
            role: 'menuitem',
            className: `agy-menu-item${it.id === selectedId ? ' is-selected' : ''}`,
            onClick: () => { onSelect?.(it.id); onClose?.(); }
          }, it.label || it.id))
        )
      : null;

    const portalNode = portal && popup && document.body
      ? ReactDOM.createPortal(popup, document.body)
      : popup;

    return h('div', {
      ref: wrapRef,
      className: 'agy-menu-wrap',
      style: { position: 'relative', display: 'inline-flex', alignItems: 'center' }
    }, anchor || null, portalNode);
  }

  function FileTypeIcon({ path: filePath = '', size = 14 }) {
    const ext = String(filePath).split('.').pop()?.toLowerCase() || '';
    const color = ext === 'js' || ext === 'mjs' ? '#eab308' : ext === 'ts' ? '#3b82f6' : ext === 'json' ? '#22c55e' : '#94a3b8';
    return h('span', {
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: `${size}px`, height: `${size}px`, fontSize: '9px', fontWeight: 700,
        borderRadius: '3px', border: `1px solid ${color}`, color, flexShrink: 0
      }
    }, ext.slice(0, 2).toUpperCase() || 'F');
  }

  function Tooltip({ content, title, children }) {
    const tipText = typeof content === 'string' ? content : (typeof title === 'string' ? title : undefined);
    if (tipText && React.isValidElement(children)) {
      return React.cloneElement(children, { title: children.props.title || tipText });
    }
    return h(React.Fragment, null, children);
  }

  async function writeClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(text || ''));
        return true;
      }
    } catch {}
    return false;
  }

  function useCodeHighlighter() {
    return () => undefined;
  }

  const DSH_ICON_NAMES = [
    'IconChecklistOutlineRegular',
    'IconPanelLeftOutlineRegular',
    'IconRightUpOutlineRegular',
    'IconSendOutlineRegular',
    'IconWorkspaceTreeOutlineRegular',
    'IconBranchOutlineRegular',
    'IconPlusOutlineRegular',
    'IconCheckOutlineRegular',
    'IconCopyOutlineRegular',
    'IconCloseOutlineRegular',
    'IconSettingsOutlineMedium',
    'IconChevronDownOutlineMedium',
    'IconChevronUpOutlineMedium',
    'IconSearchOutlineRegular',
    'IconShareOutlineRegular',
    'IconDataOutlineRegular',
    'IconDatabaseOutlineRegular',
    'IconClockOutlineRegular',
    'IconGaugeOutlineRegular',
    'IconCompareSplitOutlineRegular',
    'IconBrowseOutlineRegular',
    'IconContextInjectionOutlineRegular',
    'IconFolderOpenOutlineRegular',
    'IconApiOutlineRegular',
    'IconInspectOutlineRegular',
    'IconPluginPinwheelOutlineRegular',
    'IconSkillOutlineRegular'
  ];

  const basePrimitives = {
    StateDot,
    MarkdownText,
    JsonTree,
    Menu,
    FileTypeIcon,
    Tooltip,
    writeClipboard,
    useCodeHighlighter,
    useDismissOnOutsidePointer
  };
  for (const iconName of DSH_ICON_NAMES) {
    basePrimitives[iconName] = getIcon(iconName);
  }

  const primitivesProxy = new Proxy(basePrimitives, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('Icon')) return getIcon(prop);
      return () => null;
    }
  });

  // ── Module Loader Hook ────────────────────────────────────────────────────
  let capturedBundle = null;
  window.__ModuleLoader__ = {
    load(mod) {
      capturedBundle = mod;
    }
  };

  function requireShim(name) {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
    if (name === 'react/jsx-runtime') return { Fragment: React.Fragment, jsx: jsxShim, jsxs: jsxShim };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesProxy;
    return {};
  }

  // ── Theme Persistence ─────────────────────────────────────────────────────
  const themeKey = 'agy.dshContext.theme';
  function applyDomTheme(mode) {
    const isDark = mode !== 'light';
    try {
      if (document.body) document.body.toggleAttribute('data-ds-dark-theme', isDark);
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    } catch {}
  }
  const initialTheme = (() => {
    try {
      return localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  })();
  applyDomTheme(initialTheme);

  // ── Shared State & Cached Referentially-Stable External Snapshots ─────────
  const initialCid = new URLSearchParams(window.location.search).get('conversationId') || '';

  const appState = {
    conversationId: initialCid,
    bootstrap: null,
    lastRevision: '',
    activeTab: 'context',
    theme: initialTheme,
    modalOpenFallback: false,
    popover: null, // null | 'stats' | 'tokens' | 'quota'
    tpsSwitching: false,
    quotaRefreshing: false,
    updateChecking: false,
    updateCmdCopied: false,
    loading: true,
    error: null
  };

  const storeListeners = new Set();
  function subscribeStore(fn) {
    storeListeners.add(fn);
    return () => storeListeners.delete(fn);
  }

  // Cached Snapshots (NEVER allocate new objects inside getSnapshot()!)
  let cachedSessionsSnap = Object.freeze({ byId: EMPTY_OBJ, current: initialCid });
  function rebuildSessionsSnapshot() {
    cachedSessionsSnap = Object.freeze({
      byId: appState.bootstrap?.byId || EMPTY_OBJ,
      current: appState.conversationId || appState.bootstrap?.targetId || ''
    });
  }

  let cachedLocaleSnap = Object.freeze({ active: 'zh' });
  const localeSubs = new Set();
  function setActiveLocale(next) {
    const target = next === 'en' ? 'en' : 'zh';
    if (cachedLocaleSnap.active === target) return;
    cachedLocaleSnap = Object.freeze({ active: target });
    for (const fn of localeSubs) fn();
    notifyStore();
  }

  const dshSettingsKey = 'agy.dshContext.settings';
  const defaultDshSettings = {
    status: 'ready',
    writable: true,
    placement: 'all',
    insightsEntry: 'show',
    fleetTab: 'show',
    granularity: 'step',
    mode: 'total',
    durationCurve: 'show',
    overviewAutoSteps: '100',
    deltaBase: 'step',
    toolSort: 'count',
    fileSort: 'count',
    overviewRange: '30d',
    promptPrefix: '',
    promptSuffix: ''
  };
  function normalizeDshSettings(raw) {
    const merged = raw && typeof raw === 'object' ? { ...defaultDshSettings, ...raw } : { ...defaultDshSettings };
    merged.status = 'ready';
    merged.writable = true;
    if (typeof merged.durationCurve === 'boolean') {
      merged.durationCurve = merged.durationCurve ? 'show' : 'hide';
    } else if (merged.durationCurve !== 'show' && merged.durationCurve !== 'hide') {
      merged.durationCurve = 'show';
    }
    if (!['100', '200', '300', 'off'].includes(String(merged.overviewAutoSteps))) {
      merged.overviewAutoSteps = '100';
    } else {
      merged.overviewAutoSteps = String(merged.overviewAutoSteps);
    }
    return merged;
  }
  function toConfigFormRaw(s) {
    return Object.freeze({
      defaultPlacement: s.placement,
      insightsEntry: s.insightsEntry,
      fleetTab: s.fleetTab,
      defaultGranularity: s.granularity,
      defaultTrendMode: s.mode,
      defaultDurationCurve: s.durationCurve,
      overviewAutoSteps: s.overviewAutoSteps,
      defaultDeltaBase: s.deltaBase,
      defaultToolSort: s.toolSort,
      defaultFileSort: s.fileSort,
      defaultOverviewRange: s.overviewRange,
      promptPrefix: s.promptPrefix,
      promptSuffix: s.promptSuffix
    });
  }

  let dshSettingsState = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(dshSettingsKey) || 'null');
      return normalizeDshSettings(saved);
    } catch {
      return { ...defaultDshSettings };
    }
  })();

  let cachedConfigFormSnap = Object.freeze({
    status: 'ready',
    value: toConfigFormRaw(dshSettingsState),
    writable: true
  });
  function rebuildConfigFormSnapshot() {
    cachedConfigFormSnap = Object.freeze({
      status: 'ready',
      value: toConfigFormRaw(dshSettingsState),
      writable: true
    });
  }

  const settingsListeners = new Set();
  function subscribeSettings(fn) {
    settingsListeners.add(fn);
    return () => settingsListeners.delete(fn);
  }
  function notifySettings() {
    rebuildConfigFormSnapshot();
    for (const fn of settingsListeners) fn();
  }

  const cachedConfigScope = {
    getSnapshot() { return cachedConfigFormSnap; },
    subscribe: subscribeSettings,
    async set(k, v) { updateDshSetting(k, v); }
  };

  function notifyStore() {
    if (appState.conversationId) {
      try {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: appState.conversationId }));
      } catch {}
    }
    rebuildSessionsSnapshot();
    for (const fn of storeListeners) fn();
  }

  // Track captured dsh-context slots
  const registeredSlots = {
    contextView: null,
    fleetView: null,
    insightsView: null,
    contextModal: null,
    contextModalInject: null,
    settingsView: null,
    settingsInject: null
  };

  // Localization runtime for dsh-context
  const localeDicts = new Map();
  function formatTemplate(str, params) {
    if (!params) return str;
    return String(str).replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
  }

  function makeCordisContext() {
    const cleanups = [];
    const services = {
      locale: {
        register(ns, dicts) {
          localeDicts.set(ns, dicts);
          return () => localeDicts.delete(ns);
        },
        bind(ns) {
          return (key, params) => {
            const d = localeDicts.get(ns);
            const active = d?.[cachedLocaleSnap.active] || d?.zh || d?.en || {};
            const fallback = d?.en || {};
            const tpl = active[key] ?? fallback[key] ?? key;
            return formatTemplate(tpl, params);
          };
        },
        getLocale() {
          return cachedLocaleSnap;
        },
        subscribe(cb) {
          localeSubs.add(cb);
          return () => localeSubs.delete(cb);
        }
      },
      slots: {
        _list: new Map(),
        entries(name) {
          return services.slots._list.get(name) || [];
        },
        register(spec, comp) {
          const arr = services.slots._list.get(spec.name) || [];
          arr.push({ options: spec, component: comp });
          services.slots._list.set(spec.name, arr);
          if (spec.name === 'conversation.view' && spec.id === 'context') registeredSlots.contextView = comp;
          else if (spec.name === 'conversation.view' && spec.id === 'fleet') registeredSlots.fleetView = comp;
          else if (spec.name === 'main' && spec.key === 'dsh-context') registeredSlots.insightsView = comp;
          else if (spec.name === 'conversation.input.overlay' && spec.id === 'context-modal') {
            registeredSlots.contextModal = comp;
            registeredSlots.contextModalInject = spec.inject;
          } else if (spec.name === 'plugins.bundle.config' && spec.key === 'dsh-context') {
            registeredSlots.settingsView = comp;
            registeredSlots.settingsInject = spec.inject;
          }
          return () => {};
        },
        inject(_slotName, fn) {
          if (typeof fn === 'function') {
            try { fn(); } catch {}
          }
          return () => {};
        }
      },
      sessions: {
        getSnapshot() { return cachedSessionsSnap; },
        subscribe: subscribeStore,
        scope(sid) {
          return { sessionId: sid, bail() {} };
        },
        subagentAddress(sid) {
          const entry = cachedSessionsSnap.byId[sid];
          if (entry?.origin === 'subagent' && entry?.parentId) {
            return {
              kind: 'subagent',
              parentSessionId: entry.parentId,
              childSessionId: sid,
              mode: entry.projectionValues?.subagent?.mode || 'one-shot'
            };
          }
          return { kind: 'session', sessionId: sid };
        },
        list: {
          getSnapshot() { return cachedSessionsSnap; },
          subscribe: subscribeStore,
          async refreshSubagents() {}
        }
      },
      uiWorkspace: {
        openSession(sid) {
          if (sid && sid !== appState.conversationId) {
            switchConversation(sid);
          }
        }
      },
      pluginNavigation: {
        openBundle() {
          appState.activeTab = 'settings';
          notifyStore();
        }
      },
      sidebarRight: {
        openTab(id) {
          if (id === 'context' || id === 'fleet') {
            appState.activeTab = id;
            notifyStore();
          }
        },
        openResource() { return false; }
      },
      uiConversation: {
        imageUrl() { return ''; }
      },
      remote: {
        session: {
          async page(req) {
            const res = await fetch('api/dsh-context/page', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(req || {})
            });
            return res.json();
          }
        }
      },
      connection: { isLoopback: false },
      inputTriggers: {
        registerSource() { return () => {}; }
      },
      configForms: {
        get(_id) { return cachedConfigScope; },
        whileServed(_ids, fn) {
          if (typeof fn === 'function') {
            try { return fn() || (() => {}); } catch {}
          }
          return () => {};
        }
      }
    };

    const ctx = {
      locale: services.locale,
      slots: services.slots,
      effect(fn) {
        try {
          const disp = fn();
          if (typeof disp === 'function') cleanups.push(disp);
        } catch (err) {
          console.warn('[dsh_host] effect warn:', err);
        }
      },
      get(name) { return services[name]; },
      inject(_deps, cb) {
        const arg = { ...services, get: (k) => services[k], effect: ctx.effect };
        try {
          const disp = cb(arg);
          if (typeof disp === 'function') cleanups.push(disp);
        } catch (err) {
          console.warn('[dsh_host] inject warn:', err);
        }
      }
    };
    return ctx;
  }

  // ── Stable React 18 Hooks Injected Into Genuine dsh-context Views ─────────
  function makeStoreSelectorHook(store) {
    return function useStoreSeat(selector) {
      const selRef = React.useRef(selector);
      selRef.current = selector;
      const cacheRef = React.useRef(null);
      const getSel = React.useCallback(() => {
        const snap = store.getSnapshot();
        const sel = selRef.current;
        if (cacheRef.current && Object.is(cacheRef.current.snap, snap) && cacheRef.current.sel === sel) {
          return cacheRef.current.val;
        }
        const val = typeof sel === 'function' ? sel(snap) : snap;
        cacheRef.current = { snap, sel, val };
        return val;
      }, [store]);
      return React.useSyncExternalStore(store.subscribe, getSel);
    };
  }

  const wrappedHookCache = new WeakMap();
  function storeToSelectorHook(store, fallbackHook) {
    if (typeof store === 'function') return store;
    if (!store || typeof store.subscribe !== 'function' || typeof store.getSnapshot !== 'function') {
      return fallbackHook;
    }
    let fn = wrappedHookCache.get(store);
    if (!fn) {
      fn = makeStoreSelectorHook(store);
      wrappedHookCache.set(store, fn);
    }
    return fn;
  }

  function useProjectionHook(key) {
    const getSnap = React.useCallback(() => {
      const sid = cachedSessionsSnap.current || appState.conversationId;
      return cachedSessionsSnap.byId?.[sid]?.projectionValues?.[key] ?? null;
    }, [key]);
    return React.useSyncExternalStore(subscribeStore, getSnap);
  }

  function useChatHook(selector) {
    const selRef = React.useRef(selector);
    selRef.current = selector;
    const cacheRef = React.useRef(null);
    const getSnap = React.useCallback(() => {
      const sel = selRef.current;
      if (cacheRef.current && cacheRef.current.sel === sel) {
        return cacheRef.current.val;
      }
      const val = typeof sel === 'function' ? sel(EMPTY_CHAT_STATE) : EMPTY_CHAT_STATE;
      cacheRef.current = { sel, val };
      return val;
    }, []);
    return React.useSyncExternalStore(subscribeStore, getSnap);
  }

  function useSessionsHook(selector) {
    const selRef = React.useRef(selector);
    selRef.current = selector;
    const cacheRef = React.useRef(null);
    const getSnap = React.useCallback(() => {
      const snap = cachedSessionsSnap;
      const sel = selRef.current;
      if (cacheRef.current && Object.is(cacheRef.current.snap, snap) && cacheRef.current.sel === sel) {
        return cacheRef.current.val;
      }
      const val = typeof sel === 'function' ? sel(snap) : snap;
      cacheRef.current = { snap, sel, val };
      return val;
    }, []);
    return React.useSyncExternalStore(subscribeStore, getSnap);
  }

  function useContextModalFallbackHook(selector) {
    const getSnap = React.useCallback(() => {
      const v = appState.modalOpenFallback;
      return typeof selector === 'function' ? selector(v) : v;
    }, [selector]);
    return React.useSyncExternalStore(subscribeStore, getSnap);
  }

  function useContextSettingsFallbackHook(selector) {
    const selRef = React.useRef(selector);
    selRef.current = selector;
    const cacheRef = React.useRef(null);
    const getSnap = React.useCallback(() => {
      const snap = dshSettingsState;
      const sel = selRef.current;
      if (cacheRef.current && Object.is(cacheRef.current.snap, snap) && cacheRef.current.sel === sel) {
        return cacheRef.current.val;
      }
      const val = typeof sel === 'function' ? sel(snap) : snap;
      cacheRef.current = { snap, sel, val };
      return val;
    }, []);
    return React.useSyncExternalStore(subscribeSettings, getSnap);
  }

  function updateDshSetting(key, val) {
    const fieldMap = {
      defaultPlacement: 'placement',
      defaultGranularity: 'granularity',
      defaultTrendMode: 'mode',
      defaultDeltaBase: 'deltaBase',
      defaultToolSort: 'toolSort',
      defaultFileSort: 'fileSort',
      defaultDurationCurve: 'durationCurve',
      defaultOverviewRange: 'overviewRange'
    };
    const mapped = fieldMap[key] || key;
    dshSettingsState = normalizeDshSettings({ ...dshSettingsState, [mapped]: val });
    try { localStorage.setItem(dshSettingsKey, JSON.stringify(dshSettingsState)); } catch {}
    notifySettings();
  }

  // ── Network Actions ───────────────────────────────────────────────────────
  async function fetchBootstrap(targetCid = appState.conversationId, silent = false) {
    try {
      const params = new URLSearchParams();
      if (targetCid) params.set('conversationId', targetCid);
      if (silent && appState.lastRevision && appState.bootstrap && (!targetCid || targetCid === appState.conversationId)) {
        params.set('sinceRevision', appState.lastRevision);
      }
      const qStr = params.toString();
      const qs = qStr ? `?${qStr}` : '';
      const res = await fetch(`/api/dsh-bootstrap${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (silent && (data.unchanged || (data.revision && data.revision === appState.lastRevision)) && appState.bootstrap) {
        return;
      }
      appState.bootstrap = data;
      if (data?.updateStatus?.currentVersion) {
        window.__AGY_PLUGIN_VERSION__ = data.updateStatus.currentVersion;
      }
      appState.lastRevision = data.revision || '';
      if (!appState.conversationId && data.targetId) {
        appState.conversationId = data.targetId;
      }
      appState.loading = false;
      appState.error = null;
      notifyStore();
    } catch (err) {
      appState.loading = false;
      if (!appState.bootstrap) {
        appState.error = err?.message || String(err);
      }
      notifyStore();
    }
  }

  function switchConversation(cid) {
    appState.conversationId = cid;
    appState.popover = null;
    appState.lastRevision = '';
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('conversationId', cid);
      window.history.replaceState({}, '', u.toString());
    } catch {}
    notifyStore();
    fetchBootstrap(cid, false);
  }

  async function toggleTpsMode() {
    if (appState.tpsSwitching) return;
    const cur = appState.bootstrap?.config?.tpsMode || 'decode';
    const next = cur === 'e2e' ? 'decode' : 'e2e';
    appState.tpsSwitching = true;
    if (appState.bootstrap?.config) {
      appState.bootstrap = { ...appState.bootstrap, config: { ...appState.bootstrap.config, tpsMode: next } };
    }
    notifyStore();
    try {
      await fetch(`/api/set-config?tpsMode=${encodeURIComponent(next)}`);
      appState.lastRevision = '';
      await fetchBootstrap(appState.conversationId, false);
    } finally {
      appState.tpsSwitching = false;
      notifyStore();
    }
  }

  async function triggerQuotaRefresh() {
    if (appState.quotaRefreshing) return;
    appState.quotaRefreshing = true;
    notifyStore();
    try {
      const res = await fetch('/api/quota-refresh', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data?.quota && appState.bootstrap) {
          appState.bootstrap = { ...appState.bootstrap, quota: data.quota };
          notifyStore();
        }
      }
      appState.lastRevision = '';
      await fetchBootstrap(appState.conversationId, false);
    } catch {} finally {
      appState.quotaRefreshing = false;
      notifyStore();
    }
  }

  async function triggerUpdateCheck() {
    if (appState.updateChecking) return;
    appState.updateChecking = true;
    notifyStore();
    try {
      const res = await fetch('/api/update-check', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data?.updateStatus && appState.bootstrap) {
          appState.bootstrap = { ...appState.bootstrap, updateStatus: data.updateStatus };
          notifyStore();
        }
      }
      appState.lastRevision = '';
      await fetchBootstrap(appState.conversationId, false);
    } catch {} finally {
      appState.updateChecking = false;
      notifyStore();
    }
  }

  async function updateQuotaBarConfig(patch) {
    const prevCfg = appState.bootstrap?.config || {};
    const prevQb = {
      enabled: true,
      gemini5h: true,
      geminiWeekly: false,
      claude5h: false,
      claudeWeekly: false,
      ...(prevCfg.quotaBar || {})
    };
    const nextQb = { ...prevQb, ...patch };
    if (appState.bootstrap) {
      appState.bootstrap = {
        ...appState.bootstrap,
        config: { ...prevCfg, quotaBar: nextQb }
      };
      notifyStore();
    }
    try {
      const res = await fetch('/api/set-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotaBar: nextQb })
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.config && appState.bootstrap) {
          appState.bootstrap = { ...appState.bootstrap, config: data.config };
          notifyStore();
        }
      }
      appState.lastRevision = '';
    } catch {}
  }

  function toggleTheme() {
    const next = appState.theme === 'dark' ? 'light' : 'dark';
    appState.theme = next;
    applyDomTheme(next);
    try { localStorage.setItem(themeKey, next); } catch {}
    notifyStore();
  }

  // ── Error Boundary ────────────────────────────────────────────────────────
  class SlotErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
      return { error };
    }
    componentDidUpdate(prevProps) {
      if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
        this.setState({ error: null });
      }
    }
    render() {
      if (this.state.error) {
        return h('div', { className: 'agy-slot-error' },
          h('strong', null, 'dsh-context 视图渲染异常：'),
          h('code', null, this.state.error?.message || String(this.state.error)),
          h('button', {
            type: 'button',
            className: 'agy-btn',
            onClick: () => this.setState({ error: null })
          }, '重试')
        );
      }
      return this.props.children;
    }
  }

  // ── Lazy / Paged Fleet-Aware Invocations Table Tab ────────────────────────
  const AGENT_FLEET_HUES = ['#4d6bfe', '#ef4444', '#10b981', '#a855f7', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16', '#6366f1'];

  function readInvPref(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  function writeInvPref(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  }

  function formatStepRange(stepIndices, lastStepIndex) {
    const nums = Array.isArray(stepIndices)
      ? [...new Set(stepIndices.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
      : [];
    if (nums.length === 0) {
      const fallback = lastStepIndex ?? '-';
      return { text: String(fallback), title: String(fallback) };
    }
    if (nums.length === 1) {
      const single = String(nums[0]);
      return { text: single, title: single };
    }
    return { text: `${nums[0]}-${nums[nums.length - 1]}`, title: nums.join(',') };
  }

  function InvocationsTableTab({ conversationId, summary, fleetUsage, config }) {
    const [mode, setMode] = React.useState(() => (readInvPref('agy.invTable.mode', 'lazy') === 'paged' ? 'paged' : 'lazy'));
    const [pageSize, setPageSize] = React.useState(() => {
      const n = Number(readInvPref('agy.invTable.pageSize', '50'));
      return [20, 50, 100, 200].includes(n) ? n : 50;
    });
    const [manualRefresh, setManualRefresh] = React.useState(() => readInvPref('agy.invTable.manualRefresh', '1') !== '0');
    const [scope, setScope] = React.useState('fleet');
    const [search, setSearch] = React.useState('');
    const [debouncedSearch, setDebouncedSearch] = React.useState('');
    const [onlyMismatch, setOnlyMismatch] = React.useState(false);
    const [page, setPage] = React.useState(1);
    const [refreshNonce, setRefreshNonce] = React.useState(0);

    const [data, setData] = React.useState(() => ({
      items: [],
      total: 0,
      totalUnfiltered: 0,
      selfCount: 0,
      fleetCount: 0,
      hasSubagents: false,
      agents: [],
      fetchedAtMs: 0,
      loadedCid: ''
    }));
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [error, setError] = React.useState('');
    const [hoverTimeTip, setHoverTimeTip] = React.useState(null);

    React.useEffect(() => {
      setHoverTimeTip(null);
    }, [conversationId, page, scope, mode, debouncedSearch, onlyMismatch, pageSize, refreshNonce]);

    React.useEffect(() => {
      if (!hoverTimeTip) return undefined;
      const clearTip = () => setHoverTimeTip(null);
      window.addEventListener('scroll', clearTip, true);
      window.addEventListener('resize', clearTip);
      return () => {
        window.removeEventListener('scroll', clearTip, true);
        window.removeEventListener('resize', clearTip);
      };
    }, [Boolean(hoverTimeTip)]);

    const panelRef = React.useRef(null);
    const sentinelRef = React.useRef(null);
    const loadMoreCtrlRef = React.useRef(null);
    const pendingScrollTopRef = React.useRef(false);
    const baselineLiveRef = React.useRef(null);

    const isE2e = config?.tpsMode === 'e2e';
    const syncedBootstrap = Boolean(conversationId && (!summary?.conversationId || summary.conversationId === conversationId));
    const liveTotal = syncedBootstrap
      ? (scope === 'self'
          ? Number(summary?.invocationCount || 0)
          : Number(fleetUsage?.team?.invocationCount ?? summary?.invocationCount ?? 0))
      : null;
    const liveStateRef = React.useRef({ syncedBootstrap, liveTotal });
    liveStateRef.current = { syncedBootstrap, liveTotal };

    React.useEffect(() => {
      const timer = setTimeout(() => {
        setDebouncedSearch(search);
        setPage(1);
      }, 180);
      return () => clearTimeout(timer);
    }, [search]);

    React.useEffect(() => {
      setScope(prev => (prev.startsWith('agent:') ? 'fleet' : prev));
      setPage(1);
      baselineLiveRef.current = null;
    }, [conversationId]);

    const abortLoadMore = React.useCallback(() => {
      if (loadMoreCtrlRef.current) {
        try { loadMoreCtrlRef.current.abort(); } catch {}
        loadMoreCtrlRef.current = null;
      }
      setLoadingMore(false);
    }, []);

    React.useEffect(() => () => abortLoadMore(), [abortLoadMore]);

    React.useEffect(() => {
      if (!conversationId) {
        setData({
          items: [],
          total: 0,
          totalUnfiltered: 0,
          selfCount: 0,
          fleetCount: 0,
          hasSubagents: false,
          agents: [],
          fetchedAtMs: 0,
          loadedCid: ''
        });
        setLoading(false);
        setError('');
        return undefined;
      }
      abortLoadMore();
      const ctrl = new AbortController();
      const offset = mode === 'paged' ? (page - 1) * pageSize : 0;
      const qs = new URLSearchParams({
        conversationId,
        scope,
        offset: String(offset),
        limit: String(pageSize)
      });
      if (debouncedSearch.trim()) qs.set('search', debouncedSearch.trim());
      if (onlyMismatch) qs.set('onlyMismatch', '1');

      setLoading(true);
      setError('');

      fetch(`/api/invocations?${qs.toString()}`, { cache: 'no-store', signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((res) => {
          if (ctrl.signal.aborted) return;
          const total = Math.max(0, Number(res?.total || 0));
          const nextItems = Array.isArray(res?.items) ? res.items : [];
          if (mode === 'paged' && total > 0 && nextItems.length === 0 && page > 1) {
            const clampedPage = Math.max(1, Math.ceil(total / pageSize));
            if (clampedPage !== page) {
              setPage(clampedPage);
              return;
            }
          }
          baselineLiveRef.current = liveStateRef.current.syncedBootstrap ? liveStateRef.current.liveTotal : null;
          setData({
            items: nextItems,
            total,
            totalUnfiltered: Number(res?.totalUnfiltered || 0),
            selfCount: Number(res?.selfCount || 0),
            fleetCount: Number(res?.fleetCount || 0),
            hasSubagents: Boolean(res?.hasSubagents),
            agents: Array.isArray(res?.agents) ? res.agents : [],
            fetchedAtMs: Number(res?.fetchedAtMs || Date.now()),
            loadedCid: conversationId
          });
          setLoading(false);
          setError('');
          if (pendingScrollTopRef.current) {
            pendingScrollTopRef.current = false;
            panelRef.current?.closest('[data-conversation-scroll]')?.scrollTo({ top: 0, behavior: 'smooth' });
          }
        })
        .catch((err) => {
          if (ctrl.signal.aborted || err?.name === 'AbortError') return;
          setLoading(false);
          setError(err?.message || String(err));
        });

      return () => ctrl.abort();
    }, [conversationId, scope, debouncedSearch, onlyMismatch, pageSize, mode, page, refreshNonce, abortLoadMore]);

    if (data.loadedCid === conversationId && syncedBootstrap && liveTotal !== null && baselineLiveRef.current === null) {
      baselineLiveRef.current = liveTotal;
    }
    const pendingNew = data.loadedCid === conversationId && syncedBootstrap && liveTotal !== null && baselineLiveRef.current !== null && !loading && !loadingMore
      ? Math.max(0, liveTotal - baselineLiveRef.current)
      : 0;

    React.useEffect(() => {
      if (!manualRefresh && pendingNew > 0 && !loading && !loadingMore) {
        setRefreshNonce(n => n + 1);
      }
    }, [manualRefresh, pendingNew, loading, loadingMore]);

    const loadMoreLazy = React.useCallback(() => {
      if (mode !== 'lazy' || !conversationId || loading || loadingMore) return;
      if (data.items.length >= data.total) return;

      abortLoadMore();
      const ctrl = new AbortController();
      loadMoreCtrlRef.current = ctrl;
      setLoadingMore(true);

      const qs = new URLSearchParams({
        conversationId,
        scope,
        offset: String(data.items.length),
        limit: String(pageSize)
      });
      if (debouncedSearch.trim()) qs.set('search', debouncedSearch.trim());
      if (onlyMismatch) qs.set('onlyMismatch', '1');

      fetch(`/api/invocations?${qs.toString()}`, { cache: 'no-store', signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((res) => {
          if (ctrl.signal.aborted || loadMoreCtrlRef.current !== ctrl) return;
          loadMoreCtrlRef.current = null;
          const batch = Array.isArray(res?.items) ? res.items : [];
          setData((prev) => {
            if (prev.loadedCid !== conversationId) return prev;
            const seen = new Set(prev.items.map(r => `${r.agentId || ''}:${r.seqNum}`));
            const merged = [...prev.items];
            for (const item of batch) {
              const k = `${item.agentId || ''}:${item.seqNum}`;
              if (!seen.has(k)) {
                seen.add(k);
                merged.push(item);
              }
            }
            return {
              ...prev,
              items: merged,
              total: Number(res?.total ?? prev.total),
              totalUnfiltered: Number(res?.totalUnfiltered ?? prev.totalUnfiltered),
              selfCount: Number(res?.selfCount ?? prev.selfCount),
              fleetCount: Number(res?.fleetCount ?? prev.fleetCount),
              hasSubagents: Boolean(res?.hasSubagents ?? prev.hasSubagents),
              agents: Array.isArray(res?.agents) ? res.agents : prev.agents,
              fetchedAtMs: Number(res?.fetchedAtMs || Date.now())
            };
          });
          setLoadingMore(false);
        })
        .catch((err) => {
          if (ctrl.signal.aborted || err?.name === 'AbortError') return;
          if (loadMoreCtrlRef.current === ctrl) loadMoreCtrlRef.current = null;
          setLoadingMore(false);
          setError(err?.message || String(err));
        });
    }, [mode, conversationId, loading, loadingMore, data.items.length, data.total, scope, pageSize, debouncedSearch, onlyMismatch, abortLoadMore]);

    React.useEffect(() => {
      if (mode !== 'lazy' || loading || loadingMore || data.items.length >= data.total || data.items.length === 0) {
        return undefined;
      }
      const el = sentinelRef.current;
      if (!el || typeof IntersectionObserver !== 'function') return undefined;
      const rootEl = el.closest('[data-conversation-scroll]') || null;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some(e => e.isIntersecting)) {
            loadMoreLazy();
          }
        },
        { root: rootEl, rootMargin: '0px 0px 240px 0px' }
      );
      observer.observe(el);
      return () => observer.disconnect();
    }, [mode, loading, loadingMore, data.items.length, data.total, loadMoreLazy]);

    const switchMode = (nextMode) => {
      if (nextMode === mode) return;
      abortLoadMore();
      writeInvPref('agy.invTable.mode', nextMode);
      setMode(nextMode);
      setPage(1);
    };

    const toggleManualRefresh = () => {
      const next = !manualRefresh;
      writeInvPref('agy.invTable.manualRefresh', next ? '1' : '0');
      setManualRefresh(next);
      if (!next && pendingNew > 0) {
        setRefreshNonce(n => n + 1);
      }
    };

    const handleManualRefresh = () => {
      abortLoadMore();
      setRefreshNonce(n => n + 1);
    };

    const handlePageSizeChange = (nextSize) => {
      const n = Number(nextSize);
      if (![20, 50, 100, 200].includes(n) || n === pageSize) return;
      abortLoadMore();
      writeInvPref('agy.invTable.pageSize', n);
      setPageSize(n);
      setPage(1);
    };

    const goToPage = (nextPage) => {
      const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
      const clamped = Math.min(totalPages, Math.max(1, nextPage));
      if (clamped === page) return;
      pendingScrollTopRef.current = true;
      setPage(clamped);
    };

    const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
    const subCountSum = Math.max(0, data.fleetCount - data.selfCount);
    const updatedClock = fmtClockHms(data.fetchedAtMs);
    const summaryText = data.hasSubagents
      ? `真实模型调用全表（编队共 ${fmtInt(data.fleetCount)} 次 · 主会话 ${fmtInt(data.selfCount)} / 子代理 ${fmtInt(subCountSum)}）`
      : `真实模型调用全表（共 ${fmtInt(data.totalUnfiltered || data.fleetCount)} 次 gen_metadata 调用）`;

    const rangeStart = data.total > 0 ? (page - 1) * pageSize + 1 : 0;
    const rangeEnd = data.total > 0 ? Math.min(data.total, (page - 1) * pageSize + data.items.length) : 0;
    const hasMoreLazy = mode === 'lazy' && data.items.length < data.total;

    return h('div', { ref: panelRef, className: 'agy-inv-panel' },
      h('div', { className: 'agy-inv-toolbar' },
        h('div', { className: 'agy-inv-title' },
          h('b', null, summaryText),
          h('span', { className: 'agy-inv-sub' },
            `${isE2e ? '端到端 TPS（含首字等待 TTFT）' : '纯解码 TPS（总输出 Token ÷ 流式解码时长）'}${updatedClock ? ` · 更新于 ${updatedClock}` : ''}`
          )
        ),
        h('div', { className: 'agy-inv-controls' },
          data.hasSubagents || scope !== 'fleet'
            ? h('select', {
                className: 'agy-inv-select',
                value: scope,
                'aria-label': 'Agent 范围筛选',
                title: '选择查看整个编队、仅主会话或指定子代理',
                onChange: (e) => {
                  abortLoadMore();
                  setScope(e.target.value);
                  setPage(1);
                }
              },
                h('option', { value: 'fleet' }, `全部编队 (${fmtInt(data.fleetCount)})`),
                h('option', { value: 'self' }, `仅主会话 (${fmtInt(data.selfCount)})`),
                data.agents.length > 1
                  ? data.agents.map(a => h('option', { key: a.id, value: `agent:${a.id}` }, `[${a.badge}] ${a.label} (${fmtInt(a.count)})`))
                  : null
              )
            : null,
          h('input', {
            type: 'search',
            className: 'agy-search-input',
            placeholder: '按模型 / 枚举 / Agent 过滤…',
            value: search,
            onChange: (e) => setSearch(e.target.value)
          }),
          h('button', {
            type: 'button',
            className: `agy-btn${onlyMismatch ? ' is-active' : ''}`,
            onClick: () => {
              abortLoadMore();
              setOnlyMismatch(v => !v);
              setPage(1);
            }
          }, onlyMismatch ? '仅看路由不一致 ✓' : '仅看路由不一致'),
          h('div', { className: 'agy-seg-group', title: '在懒加载与分页浏览之间切换' },
            h('button', {
              type: 'button',
              className: `agy-seg-btn${mode === 'lazy' ? ' is-on' : ''}`,
              onClick: () => switchMode('lazy')
            }, '懒加载'),
            h('button', {
              type: 'button',
              className: `agy-seg-btn${mode === 'paged' ? ' is-on' : ''}`,
              onClick: () => switchMode('paged')
            }, '分页')
          ),
          h('button', {
            type: 'button',
            className: `agy-btn${manualRefresh ? ' is-active' : ''}`,
            onClick: toggleManualRefresh,
            title: manualRefresh
              ? '当前为手动刷新模式（浏览/翻页不被打断）；点击切回自动跟随刷新'
              : '当前为自动刷新模式（有新调用时自动更新列表）；点击切为手动刷新'
          }, manualRefresh ? '● 手动刷新' : '● 自动刷新'),
          h('button', {
            type: 'button',
            className: `agy-btn${manualRefresh && pendingNew > 0 ? ' has-new' : ''}`,
            disabled: loading,
            onClick: handleManualRefresh,
            title: pendingNew > 0 ? `后台新增 ${pendingNew} 次调用，点击立即刷新` : '立即拉取最新调用记录'
          }, loading ? '↻ 刷新中…' : (manualRefresh && pendingNew > 0 ? `↻ 刷新 (+${pendingNew})` : '↻ 刷新'))
        )
      ),
      error
        ? h('div', { className: 'agy-slot-error' },
            h('span', null, `加载调用列表失败: ${error}`),
            h('button', { type: 'button', className: 'agy-btn', onClick: handleManualRefresh }, '重试')
          )
        : loading && data.items.length === 0
          ? h('div', { className: 'agy-empty-box' }, '正在按需加载模型调用记录…')
          : data.items.length === 0
            ? h('div', { className: 'agy-empty-box' }, '当前会话没有符合条件的模型调用记录')
            : h('div', { className: 'agy-table-wrap' },
                h('table', { className: 'agy-inv-table' },
                  h('thead', null,
                    h('tr', null,
                      h('th', null, data.hasSubagents ? '# / Agent' : '#'),
                      h('th', { className: 'agy-col-step' }, 'Step'),
                      h('th', null, '模型'),
                      h('th', null, 'TTFT / 流式'),
                      h('th', null, isE2e ? '含TTFT TPS' : '纯Decode TPS'),
                      h('th', null, '输入 (未缓存 / 缓存)'),
                      h('th', null, '输出 (正文 / 思考)'),
                      h('th', null, '上下文估算')
                    )
                  ),
                  h('tbody', null,
                    data.items.map((inv, i) => {
                      const sent = inv.sentModel || 'N/A';
                      const resp = inv.responseModelFull || inv.responseModel || 'N/A';
                      const mismatch = isModelRouteMismatch(inv.sentModel, inv.responseModelFull || inv.responseModel);
                      const tpsVal = isE2e ? Number(inv.e2eTps || 0) : Number(inv.tps || 0);
                      const isApprox = !isE2e && Boolean(inv.tpsApprox);
                      const timeStr = fmtClockHms(inv.timestampMs);
                      const fullTimeStr = fmtFullDateTime(inv.timestampMs);
                      const seqLabel = `#${inv.seqNum || (i + 1)}`;
                      const isFocusedAgent = Boolean(inv.agentId && scope === `agent:${inv.agentId}`);
                      const hue = AGENT_FLEET_HUES[(Number(inv.agentHueIndex) || 0) % AGENT_FLEET_HUES.length];
                      const stepInfo = formatStepRange(inv.stepIndices, inv.lastStepIndex);
                      return h('tr', { key: `${inv.agentId || 'self'}-${inv.seqNum || i}-${inv.requestId || i}` },
                        h('td', {
                          className: `mono dim agy-col-seq${fullTimeStr ? ' has-time' : ''}`,
                          onMouseEnter: fullTimeStr
                            ? (e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setHoverTimeTip({
                                  seq: seqLabel,
                                  fullTime: fullTimeStr,
                                  left: Math.max(8, Math.min(window.innerWidth - 220, Math.round(rect.right + 8))),
                                  top: Math.max(22, Math.min(window.innerHeight - 22, Math.round(rect.top + rect.height / 2)))
                                });
                              }
                            : undefined,
                          onMouseLeave: fullTimeStr ? () => setHoverTimeTip(null) : undefined
                        },
                          data.hasSubagents
                            ? h('div', { className: 'agy-seq-agent-row' },
                                h('button', {
                                  type: 'button',
                                  className: `agy-agent-mini${isFocusedAgent ? ' is-focused' : ''}`,
                                  style: { '--ag-c': hue },
                                  title: `[${inv.agentBadge || '主'}] ${inv.agentLabel || '主会话'} (${String(inv.agentId || '').slice(0, 8)})${isFocusedAgent ? ' · 点击恢复全部编队' : ' · 点击仅看此 Agent'}`,
                                  onClick: () => {
                                    if (!inv.agentId) return;
                                    abortLoadMore();
                                    setScope(isFocusedAgent ? 'fleet' : `agent:${inv.agentId}`);
                                    setPage(1);
                                  }
                                }, inv.agentBadge || '主'),
                                h('span', null, seqLabel)
                              )
                            : h('div', null, seqLabel),
                          timeStr ? h('div', { className: 'agy-sub-label' }, timeStr) : null
                        ),
                        h('td', { className: 'mono agy-col-step' },
                          h('span', { className: 'agy-step-text', title: stepInfo.title }, stepInfo.text)
                        ),
                        (() => {
                          const { base, effort } = parseModelAndEffort(sent, resp);
                          const routeTip = [
                            inv.modelDisplayName ? `显示名: ${inv.modelDisplayName}` : '',
                            `发往上游: ${sent}`,
                            `SSE 返回: ${resp}`,
                            effort ? `思考强度: ${effort}` : '',
                            inv.modelEnum ? `枚举: ${inv.modelEnum}` : ''
                          ].filter(Boolean).join('\n');
                          return h('td', { className: 'mono agy-col-route' },
                            h('div', { className: 'agy-route-stack', title: routeTip },
                              mismatch
                                ? [
                                    h('span', { key: 's', className: 'agy-route-sent' }, sent),
                                    h('span', { key: 'r', className: 'agy-route-resp-line' },
                                      h('span', { className: 'agy-route-branch', 'aria-hidden': 'true' }, '↳'),
                                      h('span', { className: 'agy-route-resp-chip is-warn' },
                                        resp,
                                        h('span', { className: 'agy-route-warn-tag' }, ' · 不一致')
                                      )
                                    )
                                  ]
                                : [
                                    h('span', { key: 'b', className: 'agy-route-resp-chip is-match' }, base),
                                    effort
                                      ? h('span', { key: 'e', className: 'agy-route-resp-line' },
                                          h('span', { className: 'agy-route-branch', 'aria-hidden': 'true' }, '↳'),
                                          h('span', { className: 'agy-route-effort' }, effort)
                                        )
                                      : null
                                  ]
                            )
                          );
                        })(),
                        h('td', { className: 'mono' },
                          h('div', null, `${Number(inv.ttftSeconds || 0).toFixed(2)}s TTFT`),
                          h('div', { className: 'agy-sub-label' }, `${Number(inv.streamingSeconds || 0).toFixed(2)}s decode`)
                        ),
                        h('td', { className: 'mono' },
                          isApprox
                            ? h('span', { className: 'agy-tps-approx', title: inv.tpsApproxReason || '解码采样极短 (<0.6s) 或极高脉冲，可能不准' }, `~${tpsVal.toFixed(1)} tok/s · 可能不准`)
                            : h('span', { className: 'agy-tps-ok' }, `${tpsVal.toFixed(1)} tok/s`)
                        ),
                        (() => {
                          const totalIn = (inv.inputTokens || 0) + (inv.cacheReadTokens || 0);
                          const hitPct = totalIn > 0 ? ((inv.cacheReadTokens || 0) / totalIn) * 100 : null;
                          const hitCls = hitPct === null ? '' : (hitPct >= 80 ? ' is-high' : hitPct >= 30 ? ' is-mid' : ' is-low');
                          const hitBadge = hitPct !== null
                            ? h('span', {
                                className: `agy-cache-pct${hitCls}`,
                                title: `本步缓存命中率 ${hitPct.toFixed(1)}% (${fmtInt(inv.cacheReadTokens)} / ${fmtInt(totalIn)})`
                              }, `${hitPct.toFixed(1)}%`)
                            : null;
                          return h('td', null,
                            h(DualToken, { value: totalIn, unit: 'in', badge: hitBadge }),
                            h('div', { className: 'agy-sub-label mono' }, `miss ${fmtInt(inv.inputTokens)} · hit ${fmtInt(inv.cacheReadTokens)}`)
                          );
                        })(),
                        h('td', null,
                          h(DualToken, { value: inv.outputTokens || 0, unit: 'out' }),
                          h('div', { className: 'agy-sub-label mono' }, `正文 ${fmtInt(inv.bodyOutputTokens ?? inv.responseOutputTokens)} · 思考 ${fmtInt(inv.thinkingOutputTokens)}`)
                        ),
                        h('td', null,
                          h(DualToken, { value: inv.estimatedContextTokens || 0 }),
                          inv.maxContextTokens ? h('div', { className: 'agy-sub-label mono' }, `/ ${fmtCompact(inv.maxContextTokens)}`) : null
                        )
                      );
                    })
                  )
                )
              ),
      mode === 'lazy' && data.items.length > 0
        ? h('div', { ref: sentinelRef, className: 'agy-inv-sentinel', 'aria-hidden': 'true' })
        : null,
      h('div', { className: 'agy-inv-footer' },
        h('div', null,
          mode === 'paged'
            ? (data.total > 0 ? `显示第 ${fmtInt(rangeStart)}–${fmtInt(rangeEnd)} 条 · 共 ${fmtInt(data.total)} 条` : '共 0 条记录')
            : `已加载 ${fmtInt(data.items.length)} / 共 ${fmtInt(data.total)} 条`
        ),
        mode === 'paged'
          ? h('div', { className: 'agy-pager' },
              h('button', {
                type: 'button',
                className: 'agy-page-btn',
                disabled: loading || page <= 1,
                onClick: () => goToPage(page - 1)
              }, '上一页'),
              buildPagerItems(page, totalPages).map((item, idx) =>
                item === '...'
                  ? h('span', { key: `dots-${idx}`, className: 'agy-page-ellipsis' }, '…')
                  : h('button', {
                      key: `p-${item}`,
                      type: 'button',
                      className: `agy-page-btn${item === page ? ' is-active' : ''}`,
                      disabled: loading,
                      onClick: () => goToPage(item)
                    }, String(item))
              ),
              h('button', {
                type: 'button',
                className: 'agy-page-btn',
                disabled: loading || page >= totalPages,
                onClick: () => goToPage(page + 1)
              }, '下一页'),
              h('span', { className: 'agy-page-meta' }, `第 ${page} / ${totalPages} 页`)
            )
          : h('div', { className: 'agy-pager' },
              loadingMore
                ? h('span', { className: 'dim' }, '正在加载更多…')
                : hasMoreLazy
                  ? h('button', {
                      type: 'button',
                      className: 'agy-btn',
                      onClick: loadMoreLazy
                    }, `加载更多 (+${Math.min(pageSize, data.total - data.items.length)})`)
                  : (data.items.length > 0 ? h('span', { className: 'dim' }, `已加载全部 ${fmtInt(data.total)} 条`) : null)
            ),
        h('label', { className: 'agy-page-size-wrap' },
          h('span', null, '每页显示'),
          h('select', {
            className: 'agy-page-size-select',
            value: String(pageSize),
            onChange: (e) => handlePageSizeChange(e.target.value)
          },
            [20, 50, 100, 200].map(n => h('option', { key: n, value: String(n) }, `${n} 条`))
          )
        )
      ),
      hoverTimeTip
        ? (ReactDOM?.createPortal
            ? ReactDOM.createPortal(
                h('div', {
                  className: 'agy-time-float',
                  role: 'tooltip',
                  style: { left: `${hoverTimeTip.left}px`, top: `${hoverTimeTip.top}px` }
                },
                  h('span', { className: 'agy-time-float-seq mono' }, hoverTimeTip.seq),
                  h('span', { className: 'agy-time-float-val mono' }, hoverTimeTip.fullTime)
                ),
                document.body
              )
            : h('div', {
                className: 'agy-time-float',
                role: 'tooltip',
                style: { left: `${hoverTimeTip.left}px`, top: `${hoverTimeTip.top}px` }
              },
                h('span', { className: 'agy-time-float-seq mono' }, hoverTimeTip.seq),
                h('span', { className: 'agy-time-float-val mono' }, hoverTimeTip.fullTime)
              ))
        : null
    );
  }

  // ── Bottom-Docked Composer StatsPills Bar & Upward Popovers ────────────────
  function ComposerDock({ bootstrap }) {
    const sum = bootstrap?.summary;
    const head = bootstrap?.head;
    const cfg = bootstrap?.config || { tpsMode: 'decode' };
    const tot = sum?.totals || {};
    const lm = sum?.latestModel || null;
    const isE2e = cfg.tpsMode === 'e2e';
    const quota = bootstrap?.quota || null;

    const sentModel = lm?.sentModel || lm?.actualModelLabel || 'N/A';
    const respModel = lm?.responseModel || 'N/A';
    const mismatch = isModelRouteMismatch(lm?.sentModel, lm?.responseModelFull || lm?.responseModel);

    const shownTps = isE2e ? Number(tot.avgE2eTps || 0) : Number(tot.avgTps || 0);
    const tpsApprox = !isE2e && Boolean(tot.avgTpsApprox);
    const latestTps = isE2e ? Number(lm?.e2eTps || 0) : Number(lm?.tps || 0);
    const ownTokens = Number(tot.totalSessionTokens || 0);
    const fleetUsage = bootstrap?.fleetUsage || null;
    const subCount = Number(fleetUsage?.subagentCount || 0);
    const subTokens = Number(fleetUsage?.subagents?.totalTokens || 0);
    const totalTokens = subCount > 0 ? Number(fleetUsage?.team?.totalTokens ?? (ownTokens + subTokens)) : ownTokens;
    const cacheHitPct = Number(tot.cacheHitPct || 0);

    const turns = Number(head?.counts?.turns || 1);
    const steps = Number(head?.counts?.steps || sum?.invocationCount || 0);
    const samples = Number(tot.decodeSamples || sum?.invocationCount || 0);
    const llmMs = (Number(head?.timing?.ttftMs || 0) + Number(head?.timing?.genMs || 0)) || Number(tot.llmMs || 0);
    const toolsMs = Number(head?.timing?.toolsMs || 0);
    const bodyOut = Number(tot.responseOutputTokens || 0);
    const thinkOut = Number(tot.thinkingTokens || 0);
    const inputUncached = Number(tot.inputTokens || 0);
    const cacheRead = Number(tot.cacheReadTokens || 0);
    const totalCtx = Number(head?.current?.total || lm?.estimatedContextTokens || 0);
    const maxCtx = Number(head?.contextWindow || lm?.maxContextTokens || 1048576);

    const openPop = appState.popover;
    const togglePop = (name) => {
      appState.popover = openPop === name ? null : name;
      notifyStore();
    };

    const modelProbe = `${sentModel} ${respModel} ${lm?.modelDisplayName || ''} ${lm?.apiProvider || ''}`.toLowerCase();
    const modelBrand = /claude|anthropic/.test(modelProbe)
      ? 'claude'
      : /gpt|openai/.test(modelProbe)
        ? 'openai'
        : 'gemini';
    const renderModelBrandSvg = () => {
      if (modelBrand === 'claude') {
        return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': 'true' },
          h('path', { d: 'M8 2v12M2.8 5l10.4 6M13.2 5L2.8 11' })
        );
      }
      if (modelBrand === 'openai') {
        return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinejoin: 'round', 'aria-hidden': 'true' },
          h('polygon', { points: '8,1.8 13.4,4.9 13.4,11.1 8,14.2 2.6,11.1 2.6,4.9' }),
          h('circle', { cx: 8, cy: 8, r: 2.1 })
        );
      }
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
        h('path', { d: 'M8 1.2C8.35 5.1 10.9 7.65 14.8 8C10.9 8.35 8.35 10.9 8 14.8C7.65 10.9 5.1 8.35 1.2 8C5.1 7.65 7.65 5.1 8 1.2Z' })
      );
    };
    const modelLogoTitle = [
      `模型: ${sentModel !== 'N/A' ? sentModel : respModel}`,
      mismatch ? `⚠ 路由不一致: ${sentModel} → ${respModel}` : (respModel !== 'N/A' ? `SSE 返回: ${respModel}` : ''),
      lm?.modelDisplayName && lm.modelDisplayName !== 'N/A' ? `显示名: ${lm.modelDisplayName}` : '',
      lm?.modelEnum && lm.modelEnum !== 'N/A' ? `枚举: ${lm.modelEnum}` : ''
    ].filter(Boolean).join('\n');

    return h('div', { className: 'dsh-composer-bar', onClick: (e) => e.stopPropagation() },
      h('div', { className: 'dsh-pills-left' },
        h('span', {
          className: `dsh-model-logo is-${modelBrand}${mismatch ? ' is-warn' : ''}`,
          title: modelLogoTitle,
          'aria-label': sentModel !== 'N/A' ? sentModel : respModel
        }, renderModelBrandSvg())
      ),
      h('div', { className: 'dsh-pills-right' },
        // Pill 1: TPS + Upward Session Stats Popover
        h('div', { className: 'dsh-pill-anchor' },
          h('button', {
            type: 'button',
            className: `dsh-pill dsh-pill-btn${openPop === 'stats' ? ' is-open' : ''}${tpsApprox ? ' is-approx' : ''}`,
            onClick: () => togglePop('stats'),
            title: '点击展开「会话统计」浮层'
          },
            h(getIcon('IconGaugeOutlineRegular'), { size: 13 }),
            h('span', { className: 'dsh-pill-val' },
              tpsApprox ? `~${shownTps.toFixed(1)} tok/s · 可能不准` : `${shownTps.toFixed(1)} tok/s`
            ),
            isE2e ? h('span', { className: 'dsh-mode-tag' }, '含TTFT') : null
          ),
          openPop === 'stats' ? h('div', { className: 'dsh-popover', role: 'dialog', 'aria-label': '会话统计' },
            h('div', { className: 'dsh-pop-head' },
              h('div', { className: 'dsh-pop-title' },
                h(getIcon('IconGaugeOutlineRegular'), { size: 15 }),
                h('span', null, '会话统计')
              ),
              h('span', { className: 'dsh-pop-sub' }, `${turns}轮 ${steps}步 · ${samples} 次采样`)
            ),
            h('div', { className: 'dsh-pop-divider' }),
            h('div', { className: 'dsh-pop-rows' },
              h('div', { className: 'dsh-pop-row' },
                h('span', { className: 'k' }, '模型调用用时'),
                h('span', { className: 'v' }, fmtDurZh(llmMs))
              ),
              h('div', { className: 'dsh-pop-row' },
                h('span', { className: 'k' }, '工具调用用时'),
                h('span', { className: 'v' }, fmtDurZh(toolsMs))
              ),
              h('div', { className: 'dsh-pop-row' },
                h('span', { className: 'k' }, '首 token 平均（TTFT）'),
                h('span', { className: 'v' }, `${Number(tot.avgTtftSeconds || 0).toFixed(2)} 秒`)
              ),
              h('div', { className: 'dsh-pop-row' },
                h('span', { className: 'k' }, isE2e ? '会话输出速率（含TTFT）' : '会话输出速率（TPS）'),
                h('span', { className: `v${tpsApprox ? ' is-approx' : ''}` },
                  tpsApprox ? `~${shownTps.toFixed(1)} tok/s（可能不准）` : `${shownTps.toFixed(1)} tok/s`
                )
              ),
              h('div', { className: 'dsh-pop-row' },
                h('span', { className: 'k' }, '最近一次请求'),
                h('span', { className: 'v' }, `${latestTps.toFixed(1)} tok/s`)
              ),
              h('div', { className: 'dsh-pop-row' },
                h('span', { className: 'k' }, '正文 / 思考输出'),
                h('div', { className: 'v' },
                  h('div', null, `${fmtCompact(bodyOut)} / ${fmtCompact(thinkOut)} tok`),
                  h('div', { className: 'agy-pop-exact' }, `${fmtInt(bodyOut)} / ${fmtInt(thinkOut)} tok`)
                )
              )
            ),
            h('div', { className: 'dsh-pop-divider' }),
            h('div', { className: 'dsh-pop-foot' },
              h('div', { className: 'dsh-pop-note' },
                isE2e
                  ? '统计方式：总输出 Token ÷ (TTFT + 流式解码时长)；可一键切回纯 Decode。'
                  : '统计方式：总输出 Token ÷ 流式时长；会话 TPS 按总时长加权。'
              ),
              h('button', {
                type: 'button',
                className: `dsh-pop-toggle${isE2e ? ' is-e2e' : ''}`,
                disabled: appState.tpsSwitching,
                onClick: toggleTpsMode
              }, isE2e ? '⇄ 已计入 TTFT（点击切回 Decode）' : '⇄ 切换为计入 TTFT（E2E）')
            )
          ) : null
        ),

        // One-Click TTFT Toggle Pill
        h('button', {
          type: 'button',
          className: `dsh-pill dsh-pill-toggle${isE2e ? ' is-e2e' : ''}`,
          disabled: appState.tpsSwitching,
          onClick: toggleTpsMode,
          title: '一键切换是否把首字等待时间 (TTFT) 计入 TPS 分母'
        }, isE2e ? '⇄ 计入TTFT ✓' : '⇄ 计入TTFT'),

        // Pill 2: Tokens & Cache Hit + Upward Dual-Layer Popover
        h('div', { className: 'dsh-pill-anchor' },
          h('button', {
            type: 'button',
            className: `dsh-pill dsh-pill-btn${openPop === 'tokens' ? ' is-open' : ''}`,
            onClick: () => togglePop('tokens'),
            title: '点击展开「Token 用量」双层精确视图'
          },
            h(getIcon('IconDatabaseOutlineRegular'), { size: 13 }),
            h('span', { className: 'dsh-pill-val' }, `${fmtCompact(totalTokens)} tok`),
            h('span', { className: 'dsh-pill-sep' }, '·'),
            h('span', { className: 'dsh-pill-cache' }, `缓存命中 ${cacheHitPct.toFixed(1)}%`)
          ),
          openPop === 'tokens' ? h('div', { className: 'dsh-popover dsh-popover-wide', role: 'dialog', 'aria-label': 'Token 用量' },
            h('div', { className: 'dsh-pop-head' },
              h('div', { className: 'dsh-pop-title' },
                h(getIcon('IconDatabaseOutlineRegular'), { size: 15 }),
                h('span', null, 'Token 用量（缩写 + 完整精确值）')
              ),
              h('span', { className: 'dsh-pop-sub' }, `缓存命中率 ${cacheHitPct.toFixed(1)}%`)
            ),
            h('div', { className: 'dsh-pop-divider' }),
            h('div', { className: 'agy-token-grid' },
              h('div', { className: 'agy-token-cell' },
                h('span', { className: 'lbl' }, subCount > 0 ? '编队总计费 Token (含子代理)' : '会话总计费 Token'),
                h(DualToken, { value: totalTokens, unit: 'tok' })
              ),
              ...(subCount > 0 ? [
                h('div', { className: 'agy-token-cell' },
                  h('span', { className: 'lbl' }, '当前 Agent'),
                  h(DualToken, { value: ownTokens, unit: 'tok' })
                ),
                h('div', { className: 'agy-token-cell' },
                  h('span', { className: 'lbl' }, `子 Agent × ${subCount}`),
                  h(DualToken, { value: subTokens, unit: 'tok' })
                )
              ] : []),
              h('div', { className: 'agy-token-cell' },
                h('span', { className: 'lbl' }, '当前上下文占用'),
                h(DualToken, { value: totalCtx, unit: 'tok' }),
                h('span', { className: 'sub' }, `窗口上限 ${fmtCompact(maxCtx)} (${fmtInt(maxCtx)})`)
              ),
              h('div', { className: 'agy-token-cell' },
                h('span', { className: 'lbl' }, '缓存读取 (Cache Hit)'),
                h(DualToken, { value: cacheRead, unit: 'tok' })
              ),
              h('div', { className: 'agy-token-cell' },
                h('span', { className: 'lbl' }, '未缓存输入 (Uncached In)'),
                h(DualToken, { value: inputUncached, unit: 'tok' })
              ),
              h('div', { className: 'agy-token-cell' },
                h('span', { className: 'lbl' }, '模型正文输出'),
                h(DualToken, { value: bodyOut, unit: 'tok' })
              ),
              h('div', { className: 'agy-token-cell' },
                h('span', { className: 'lbl' }, '思考推理 (Thinking)'),
                h(DualToken, { value: thinkOut, unit: 'tok' })
              )
            )
          ) : null
        ),

        // Pill 3: 5h / Weekly Quota Estimator + Upward Popover
        (() => {
          const fmtShortUsd = (v) => {
            const n = Number(v || 0);
            if (!(n > 0)) return '$0';
            if (n >= 100) return `$${Math.round(n)}`;
            if (n >= 10) return `$${n.toFixed(1)}`;
            return `$${n.toFixed(2)}`;
          };
          const fmtCountdown = (ms) => {
            const totalMin = Math.max(0, Math.round(Number(ms || 0) / 60000));
            if (totalMin < 1) return '即将重置';
            const d = Math.floor(totalMin / 1440);
            const h2 = Math.floor((totalMin % 1440) / 60);
            const m = totalMin % 60;
            if (d > 0) return h2 > 0 ? `${d}d ${h2}h 后重置` : `${d}d 后重置`;
            if (h2 > 0) return m > 0 ? `${h2}h ${m}m 后重置` : `${h2}h 后重置`;
            return `${m}m 后重置`;
          };
          const fmtAgo = (ms) => {
            const sec = Math.max(0, Math.round((Date.now() - Number(ms || 0)) / 1000));
            if (sec < 60) return '刚刚更新';
            const min = Math.floor(sec / 60);
            if (min < 60) return `${min}分钟前更新`;
            const hr = Math.floor(min / 60);
            if (hr < 24) return `${hr}小时前更新`;
            return `${Math.floor(hr / 24)}天前更新`;
          };
          const modelProbe = [lm?.sentModel, lm?.responseModel, lm?.modelDisplayName, lm?.apiProvider].filter(Boolean).join(' ').toLowerCase();
          const activePoolKey = /claude|anthropic|gpt|openai/.test(modelProbe) ? 'claude_gpt' : 'gemini';
          const otherPoolKey = activePoolKey === 'gemini' ? 'claude_gpt' : 'gemini';
          const activePool = quota?.pools?.[activePoolKey] || quota?.pools?.gemini || null;
          const otherPool = quota?.pools?.[otherPoolKey] || null;
          const qb = {
            enabled: cfg?.quotaBar?.enabled !== false,
            gemini5h: cfg?.quotaBar?.gemini5h !== undefined ? Boolean(cfg.quotaBar.gemini5h) : true,
            geminiWeekly: Boolean(cfg?.quotaBar?.geminiWeekly),
            claude5h: Boolean(cfg?.quotaBar?.claude5h),
            claudeWeekly: Boolean(cfg?.quotaBar?.claudeWeekly)
          };

          const formatPillText = () => {
            if (!quota?.hasSamples) return appState.quotaRefreshing ? '刷新中…' : '额度推算';
            const gPool = quota?.pools?.gemini;
            const cPool = quota?.pools?.claude_gpt;
            const fmtLeft = (win, expiredText = '重置') => {
              if (!win?.sampled) return '--';
              if (win.expired) return expiredText;
              const v = Number(win.latest?.leftPct ?? 100);
              if (v >= 99.95) return '100%';
              return win.latest?.exactFraction ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
            };
            const pctStr = (win) => fmtLeft(win, '重置');
            const singleWinStr = (prefix, tag, win) => {
              if (!win?.sampled) return `${prefix}${tag} --`;
              const left = fmtLeft(win, '已重置');
              const usd = win.estimate?.status === 'estimated' ? ` · ~${fmtShortUsd(win.estimate.estTotalUsd)}` : '';
              return `${prefix}${tag} ${left}${usd}`;
            };
            const gSel = [qb.gemini5h ? '5h' : '', qb.geminiWeekly ? 'wk' : ''].filter(Boolean);
            const cSel = [qb.claude5h ? '5h' : '', qb.claudeWeekly ? 'wk' : ''].filter(Boolean);
            const totalSel = gSel.length + cSel.length;
            if (totalSel === 0) {
              const pool = quota?.pools?.[activePoolKey] || gPool;
              return singleWinStr(activePoolKey === 'claude_gpt' ? 'C/G ' : '', '5h', pool?.fiveHour);
            }
            if (totalSel === 1) {
              if (qb.gemini5h) return singleWinStr('', '5h', gPool?.fiveHour);
              if (qb.geminiWeekly) return singleWinStr('', '周', gPool?.weekly);
              if (qb.claude5h) return singleWinStr('C/G ', '5h', cPool?.fiveHour);
              return singleWinStr('C/G ', '周', cPool?.weekly);
            }
            if (gSel.length === 2 && cSel.length === 0) {
              return `5h ${pctStr(gPool?.fiveHour)} · 周 ${pctStr(gPool?.weekly)}`;
            }
            if (cSel.length === 2 && gSel.length === 0) {
              return `C/G 5h ${pctStr(cPool?.fiveHour)} · 周 ${pctStr(cPool?.weekly)}`;
            }
            const fmtPoolCompact = (tag, pool, has5h, hasWk) => {
              if (has5h && hasWk) return `${tag} ${pctStr(pool?.fiveHour)}/${pctStr(pool?.weekly)}`;
              if (has5h) return `${tag} 5h ${pctStr(pool?.fiveHour)}`;
              return `${tag} 周 ${pctStr(pool?.weekly)}`;
            };
            const parts = [];
            if (gSel.length) parts.push(fmtPoolCompact('G', gPool, qb.gemini5h, qb.geminiWeekly));
            if (cSel.length) parts.push(fmtPoolCompact('C/G', cPool, qb.claude5h, qb.claudeWeekly));
            return parts.join(' · ');
          };
          const pillText = formatPillText();

          const clockSvg = h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, 'aria-hidden': 'true' },
            h('circle', { cx: 8, cy: 8, r: 6 }),
            h('path', { d: 'M8 4.4V8L10.6 9.6', strokeLinecap: 'round', strokeLinejoin: 'round' })
          );
          const refreshSvg = h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
            h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.45-3.73' }),
            h('path', { d: 'M13.5 2.5v2.75h-2.75' })
          );

          const renderWindow = (title, win) => {
            if (!win || !win.sampled) {
              return h('div', { className: 'agy-quota-row' }, h('span', null, title), h('strong', null, '未采样'));
            }
            const leftPct = win.expired ? 100 : Number(win.latest?.leftPct ?? 100);
            const leftPctLabel = leftPct >= 99.95 ? '100%' : (win.latest?.exactFraction ? `${leftPct.toFixed(1)}%` : `${Math.round(leftPct)}%`);
            const barClass = leftPct <= 15 ? 'is-crit' : leftPct <= 40 ? 'is-warn' : '';
            const resetText = win.expired ? '已重置' : (win.latest?.remainingMs ? fmtCountdown(win.latest.remainingMs) : '尚未计费');
            const usage = win.liveUsage || { usd: 0, totalTokens: 0, calls: 0 };
            const est = win.estimate;
            const prevEst = win.previousCycleEstimate;
            const projText = est?.status === 'estimated' && est.projectedLeftPct !== null && !win.expired && Math.abs(est.projectedLeftPct - leftPct) >= 0.8
              ? ` · 估剩 ${est.projectedLeftPct.toFixed(1)}%`
              : '';
            const spendText = usage.calls > 0
              ? `~${fmtShortUsd(usage.usd)} · ${fmtCompact(usage.totalTokens)} tok (${fmtInt(usage.calls)}次)`
              : '本周期暂无调用';
            const buildEstNode = (e, prefix = '') => {
              if (e?.status === 'estimated') {
                const tier = e.confidenceTier || (e.maxUsedPctObserved >= 10 ? 'high' : e.maxUsedPctObserved >= 3 ? 'mid' : 'low');
                const confLabel = tier === 'high' ? '高置信' : tier === 'mid' ? '收敛中' : '样本偏少';
                const confTip = `${prefix}已观测最高消耗 ${e.maxUsedPctObserved ?? '?'}%，估算误差约 ±${e.relErrPct ?? '?'}%`;
                return [
                  h('span', { key: 'v' }, `~${fmtShortUsd(e.estTotalUsd)} (${fmtShortUsd(e.lowUsd)}–${fmtShortUsd(e.highUsd)})`),
                  h('span', { key: 'b', className: `agy-quota-conf is-${tier}`, title: confTip }, confLabel)
                ];
              }
              if (e?.status === 'lower_bound') {
                return [
                  h('span', { key: 'v' }, `> ${fmtShortUsd(e.minBoundUsd)}`),
                  h('span', { key: 'b', className: 'agy-quota-conf is-low', title: '当前仍为 100% 满额，仅能确定总额下界' }, '仅下界')
                ];
              }
              return '待消耗 ≥1%';
            };
            const hasPrev = prevEst?.status === 'estimated';
            const estNode = buildEstNode(est, hasPrev ? '本周期' : '');
            return h(React.Fragment, null,
              h('div', { className: 'agy-quota-row' },
                h('span', null, title),
                h('strong', null, `剩 ${leftPctLabel}${projText} (${resetText})`)
              ),
              h('div', { className: 'agy-quota-bar' },
                h('i', { className: barClass, style: { width: `${Math.max(0, Math.min(100, leftPct))}%` } })
              ),
              h('div', { className: 'agy-quota-sub' }, h('span', null, '本周期实耗'), h('strong', null, spendText)),
              h('div', { className: 'agy-quota-sub' }, h('span', null, hasPrev ? '本周期推算' : '推算总额度'), h('strong', null, estNode)),
              hasPrev ? h('div', { className: 'agy-quota-sub' }, h('span', null, '上周期推算'), h('strong', null, buildEstNode(prevEst, '上周期'))) : null
            );
          };

          const renderPool = (pool, isActive) => {
            if (!pool || (!pool.fiveHour?.sampled && !pool.weekly?.sampled)) return null;
            return h('div', { className: 'agy-quota-section', key: pool.label },
              h('div', { className: 'agy-quota-pool-title' },
                h('span', null, pool.label || 'Pool'),
                isActive ? h('span', { className: 'agy-quota-badge' }, '当前模型池') : null
              ),
              renderWindow('5h 额度', pool.fiveHour),
              renderWindow('周额度', pool.weekly)
            );
          };

          const footText = appState.quotaRefreshing
            ? '正在自动刷新…'
            : quota?.hasSamples
              ? `活跃 5m / 空闲 30–60m 自动刷新 · ${fmtAgo(quota.lastSampledAtMs)}`
              : '活跃 5m / 空闲 30–60m 自动刷新 · 等待首次更新';

          return h('div', { className: 'dsh-pill-anchor' },
            h('button', {
              type: 'button',
              className: `dsh-pill dsh-pill-btn${openPop === 'quota' ? ' is-open' : ''}`,
              onClick: () => togglePop('quota'),
              title: '点击展开「5h / 周额度反推」'
            },
              clockSvg,
              h('span', { className: 'dsh-pill-val' }, pillText)
            ),
            openPop === 'quota' ? h('div', { className: 'dsh-popover dsh-popover-quota', role: 'dialog', 'aria-label': '5h 与周额度反推及底栏设置' },
              quota?.hasSamples
                ? [renderPool(activePool, true), renderPool(otherPool, false)]
                : h('div', { className: 'dsh-pop-note' }, '正在等待首次额度读取，结合本地调用记录自动反推 5h 与周总额度。'),
              h('div', { className: 'agy-quota-settings' },
                h('div', { className: 'agy-quota-set-head' },
                  h('span', null, '底栏胶囊显示'),
                  h('button', {
                    type: 'button',
                    className: `agy-quota-switch${qb.enabled ? ' is-on' : ''}`,
                    onClick: () => updateQuotaBarConfig({ enabled: !qb.enabled })
                  },
                    h('span', { className: 'dot' }),
                    qb.enabled ? '已显示' : '已隐藏'
                  )
                ),
                h('div', { className: `agy-quota-chip-rows${qb.enabled ? '' : ' is-dim'}` },
                  h('div', { className: 'agy-quota-chip-row' },
                    h('span', { className: 'agy-quota-chip-lbl' }, 'Gemini'),
                    h('button', {
                      type: 'button',
                      className: `agy-quota-chip${qb.gemini5h ? ' is-on' : ''}`,
                      onClick: () => updateQuotaBarConfig({ gemini5h: !qb.gemini5h })
                    }, '5h 额度'),
                    h('button', {
                      type: 'button',
                      className: `agy-quota-chip${qb.geminiWeekly ? ' is-on' : ''}`,
                      onClick: () => updateQuotaBarConfig({ geminiWeekly: !qb.geminiWeekly })
                    }, '周额度')
                  ),
                  h('div', { className: 'agy-quota-chip-row' },
                    h('span', { className: 'agy-quota-chip-lbl' }, 'Claude / GPT'),
                    h('button', {
                      type: 'button',
                      className: `agy-quota-chip${qb.claude5h ? ' is-on' : ''}`,
                      onClick: () => updateQuotaBarConfig({ claude5h: !qb.claude5h })
                    }, '5h 额度'),
                    h('button', {
                      type: 'button',
                      className: `agy-quota-chip${qb.claudeWeekly ? ' is-on' : ''}`,
                      onClick: () => updateQuotaBarConfig({ claudeWeekly: !qb.claudeWeekly })
                    }, '周额度')
                  )
                )
              ),
              h('div', { className: 'agy-quota-foot' },
                h('span', null, footText),
                h('button', {
                  type: 'button',
                  className: `agy-quota-refresh${appState.quotaRefreshing ? ' is-spinning' : ''}`,
                  disabled: appState.quotaRefreshing,
                  title: appState.quotaRefreshing ? '正在刷新…' : '立即刷新',
                  'aria-label': '立即刷新',
                  onClick: triggerQuotaRefresh
                }, refreshSvg)
              )
            ) : null
          );
        })()
      )
    );
  }

  // ── Plugin Version & Update Card (Settings Tab) ───────────────────────────
  function UpdateCard({ updateStatus, locale }) {
    const isEn = locale === 'en';
    const curVer = updateStatus?.currentVersion || '1.3.1';
    const latestVer = updateStatus?.latestVersion || '';
    const hasUpdate = Boolean(updateStatus?.hasUpdate && latestVer);
    const errMsg = updateStatus?.error || '';
    const checkedAtMs = Number(updateStatus?.checkedAtMs || 0);
    const sourceLabel = updateStatus?.source === 'github_release'
      ? 'GitHub Release'
      : updateStatus?.source === 'github_main'
        ? 'GitHub main'
        : '';
    const linkUrl = updateStatus?.releaseUrl || updateStatus?.repoUrl || 'https://github.com/SaigyoujiYusora/agy-context';
    const updateCmd = 'git pull && pwsh ./install.ps1';

    let badgeClass = 'agy-update-badge is-ok';
    let badgeText = isEn ? 'Not checked yet' : '尚未检查';
    if (hasUpdate) {
      badgeClass = 'agy-update-badge is-new';
      badgeText = isEn ? `Update available: v${latestVer}` : `发现新版本 v${latestVer}`;
    } else if (errMsg) {
      badgeClass = 'agy-update-badge is-err';
      badgeText = isEn ? 'Check failed' : '检查失败';
    } else if (checkedAtMs > 0) {
      badgeClass = 'agy-update-badge is-ok';
      badgeText = isEn ? 'Up to date' : '已是最新版本';
    }

    const metaParts = [];
    if (checkedAtMs > 0) {
      const clock = fmtClockHms(checkedAtMs);
      metaParts.push(isEn ? `Last checked ${clock}` : `上次检查 ${clock}`);
    }
    if (sourceLabel) metaParts.push(sourceLabel);
    if (errMsg) metaParts.push(errMsg);
    if (metaParts.length === 0) {
      metaParts.push(isEn ? 'Auto-checks GitHub every 12h' : '每 12 小时自动检测一次 GitHub 更新');
    }

    const handleCopyCmd = () => {
      writeClipboard(updateCmd);
      appState.updateCmdCopied = true;
      notifyStore();
      setTimeout(() => {
        appState.updateCmdCopied = false;
        notifyStore();
      }, 1800);
    };

    return h('section', { className: `agy-update-card${hasUpdate ? ' has-update' : ''}` },
      h('div', { className: 'agy-update-top' },
        h('div', { className: 'agy-update-info' },
          h('div', { className: 'agy-update-title-row' },
            h('span', { className: 'agy-update-title' }, isEn ? 'Update Check' : '检查更新'),
            h('span', { className: 'agy-update-ver' }, `v${curVer}`),
            h('span', { className: badgeClass, title: errMsg || undefined }, badgeText)
          ),
          h('div', { className: 'agy-update-meta' }, metaParts.join(' · '))
        ),
        h('div', { className: 'agy-update-actions' },
          h('button', {
            type: 'button',
            className: 'agy-update-btn',
            disabled: appState.updateChecking,
            onClick: triggerUpdateCheck
          }, appState.updateChecking ? (isEn ? 'Checking…' : '检查中…') : (isEn ? 'Check now' : '立即检查')),
          hasUpdate
            ? h('a', {
                className: 'agy-update-btn is-primary',
                href: linkUrl,
                target: '_blank',
                rel: 'noreferrer'
              }, isEn ? 'View release' : '查看新版本')
            : null
        )
      ),
      hasUpdate && updateStatus?.notes
        ? h('pre', { className: 'agy-update-notes' }, updateStatus.notes)
        : null,
      hasUpdate
        ? h('div', { className: 'agy-update-cmd-row' },
            h('code', null, updateCmd),
            h('button', {
              type: 'button',
              className: 'agy-update-btn',
              onClick: handleCopyCmd
            }, appState.updateCmdCopied ? (isEn ? 'Copied' : '已复制') : (isEn ? 'Copy command' : '复制更新命令'))
          )
        : null
    );
  }

  // ── Root Application ──────────────────────────────────────────────────────
  function App() {
    const [, setTick] = React.useState(0);
    React.useEffect(() => subscribeStore(() => setTick(t => t + 1)), []);

    React.useEffect(() => {
      const onDocClick = () => {
        if (appState.popover !== null) {
          appState.popover = null;
          notifyStore();
        }
      };
      const onKeyDown = (e) => {
        if (e.key === 'Escape' && appState.popover !== null) {
          appState.popover = null;
          notifyStore();
        }
      };
      document.addEventListener('click', onDocClick);
      window.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('click', onDocClick);
        window.removeEventListener('keydown', onKeyDown, true);
      };
    }, []);

    React.useEffect(() => {
      fetchBootstrap(appState.conversationId, false);
      let timer = null;
      let disposed = false;
      const scheduleNext = () => {
        if (disposed) return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (document.visibilityState === 'hidden') {
          return;
        }
        const isInflight = Boolean(appState.bootstrap?.inflight && !appState.bootstrap?.inflight?.completed);
        timer = setTimeout(async () => {
          if (disposed) return;
          if (document.visibilityState !== 'hidden') {
            await fetchBootstrap(appState.conversationId, true);
          }
          scheduleNext();
        }, isInflight ? 2000 : 6000);
      };
      const onVisibilityChange = () => {
        if (disposed || document.visibilityState === 'hidden') return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        fetchBootstrap(appState.conversationId, true).finally(() => {
          if (!disposed) scheduleNext();
        });
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      scheduleNext();
      return () => {
        disposed = true;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (timer) clearTimeout(timer);
      };
    }, []);

    const bs = appState.bootstrap;
    const recent = bs?.recent || EMPTY_ARR;
    const curCid = appState.conversationId || bs?.targetId || '';
    const fleetNodesCount = Array.isArray(bs?.fleet?.nodes) ? bs.fleet.nodes.length : 0;
    const subagentCount = Math.max(0, fleetNodesCount - 1);

    const ContextViewComp = registeredSlots.contextView;
    const InsightsViewComp = registeredSlots.insightsView;
    const FleetViewComp = registeredSlots.fleetView;
    const ContextModalComp = registeredSlots.contextModal;
    const SettingsViewComp = registeredSlots.settingsView;

    // Resolve authentic dsh-context modal & settings inject stores
    const modalInjected = React.useMemo(() => {
      if (typeof registeredSlots.contextModalInject !== 'function') return null;
      try { return registeredSlots.contextModalInject(curCid); } catch { return null; }
    }, [curCid]);
    const realModalStore = modalInjected?.hooks?.contextModal || null;
    const useRealModalHook = React.useMemo(
      () => storeToSelectorHook(realModalStore, useContextModalFallbackHook),
      [realModalStore]
    );

    const settingsInjected = React.useMemo(() => {
      if (typeof registeredSlots.settingsInject !== 'function') return null;
      try { return registeredSlots.settingsInject(); } catch { return null; }
    }, []);
    const useRealSettingsHook = React.useMemo(
      () => storeToSelectorHook(settingsInjected?.hooks?.contextSettings, useContextSettingsFallbackHook),
      [settingsInjected]
    );

    const toggleContextModal = () => {
      if (realModalStore && typeof realModalStore.set === 'function') {
        const curOpen = typeof realModalStore.getSnapshot === 'function' ? realModalStore.getSnapshot() : false;
        realModalStore.set(!curOpen);
      } else {
        appState.modalOpenFallback = !appState.modalOpenFallback;
        notifyStore();
      }
    };

    const commonProps = {
      sessionId: curCid,
      useProjection: useProjectionHook,
      useChat: useChatHook
    };

    const navTabs = [
      { id: 'context', label: '上下文' },
      { id: 'fleet', label: '编队', count: subagentCount > 0 ? subagentCount : null },
      { id: 'insights', label: '上下文洞察' },
      { id: 'invocations', label: '调用全表', count: subagentCount > 0 ? (bs?.fleetUsage?.team?.invocationCount ?? bs?.summary?.invocationCount ?? 0) : (bs?.summary?.invocationCount ?? 0) },
      { id: 'settings', label: '插件设置' }
    ];

    const activeLocaleVal = cachedLocaleSnap.active;

    return h('div', { className: 'agy-shell' },
      // Authentic DSH Session Chrome + Underline Tab Bar
      h('header', { className: 'dsh-chrome-head' },
        h('div', { className: 'dsh-session-row' },
          h('div', { className: 'dsh-session-left' },
            h('div', { className: 'dsh-session-select-wrap' },
              h('select', {
                value: curCid,
                onChange: (e) => switchConversation(e.target.value),
                className: 'dsh-session-select',
                'aria-label': '切换对话',
                title: '切换要透视的 Antigravity 对话'
              },
                recent.length > 0
                  ? recent.map(r => h('option', { key: r.conversationId, value: r.conversationId },
                      `${r.title} (${r.invocationCount} calls · ${fmtCompact(r.totalSessionTokens)})`
                    ))
                  : h('option', { value: curCid }, bs?.summary?.title || curCid || '等待对话数据…')
              ),
              h('span', { className: 'dsh-select-caret', 'aria-hidden': 'true' },
                h(getIcon('IconChevronDownOutlineMedium'), { size: 13 })
              )
            ),
            h('span', { className: 'dsh-meta-chip' },
              h(StateDot, {
                state: bs?.inflight && !bs.inflight.completed ? 'running' : 'done',
                size: 7
              }),
              h('span', null, bs?.inflight && !bs.inflight.completed ? '运行中' : 'Standard mode')
            ),
            subagentCount > 0
              ? h('button', {
                  type: 'button',
                  className: 'dsh-meta-chip is-clickable',
                  onClick: () => { appState.activeTab = 'fleet'; notifyStore(); }
                }, `${subagentCount} subagents`)
              : null
          ),
          h('div', { className: 'dsh-session-right' },
            h('button', {
              type: 'button',
              className: 'dsh-chrome-btn',
              onClick: () => setActiveLocale(activeLocaleVal === 'zh' ? 'en' : 'zh'),
              title: '切换语言 (中文 / English)'
            }, activeLocaleVal === 'zh' ? '中文 / EN' : 'EN / 中文'),
            h('button', {
              type: 'button',
              className: 'dsh-chrome-btn agy-theme-btn',
              onClick: toggleTheme,
              title: '切换深色 / 浅色外观（1:1 对齐 dsh-context 双主题）'
            }, appState.theme === 'dark' ? '🌙 深色' : '☀ 浅色')
          )
        ),

        h('nav', { className: 'dsh-tab-strip', role: 'tablist' },
          navTabs.map(tab => h('button', {
            key: tab.id,
            type: 'button',
            role: 'tab',
            'aria-selected': appState.activeTab === tab.id,
            className: `dsh-tab${appState.activeTab === tab.id ? ' is-active' : ''}`,
            onClick: () => { appState.activeTab = tab.id; notifyStore(); }
          },
            h('span', null, tab.label),
            tab.count != null ? h('span', { className: 'dsh-tab-count' }, tab.count) : null
          ))
        )
      ),

      // Main Scrollable dsh-context Viewport ([data-conversation-scroll])
      h('main', { className: 'agy-scroll-viewport', 'data-conversation-scroll': '' },
        appState.loading && !bs
          ? h('div', { className: 'agy-empty-box' }, '正在加载 Antigravity SQLite & 会话转录数据…')
          : appState.error && !bs
            ? h('div', { className: 'agy-slot-error' }, `加载失败: ${appState.error}`)
            : h(SlotErrorBoundary, { resetKey: `${appState.activeTab}:${curCid}` },
                appState.activeTab === 'context' && ContextViewComp
                  ? h(ContextViewComp, commonProps)
                  : appState.activeTab === 'insights' && InsightsViewComp
                    ? h(InsightsViewComp, { useSessions: useSessionsHook })
                    : appState.activeTab === 'fleet' && FleetViewComp
                      ? h(FleetViewComp, commonProps)
                      : appState.activeTab === 'invocations'
                        ? h(InvocationsTableTab, { conversationId: curCid, summary: bs?.summary, fleetUsage: bs?.fleetUsage, config: bs?.config })
                        : appState.activeTab === 'settings' && SettingsViewComp
                          ? h('div', { className: 'agy-settings-wrap' },
                              h(UpdateCard, { updateStatus: bs?.updateStatus, locale: activeLocaleVal }),
                              h(SettingsViewComp, {
                                useContextSettings: useRealSettingsHook,
                                set: settingsInjected?.set || updateDshSetting
                              })
                            )
                          : h('div', { className: 'agy-empty-box' }, '未注册对应视图组件')
              )
      ),

      // Bottom-Docked Composer StatsPills Bar
      h(ComposerDock, { bootstrap: bs }),

      // Genuine /context Modal Gate (connected to modalStoreOf)
      ContextModalComp
        ? h(SlotErrorBoundary, { resetKey: `modal:${curCid}` },
            h(ContextModalComp, {
              sessionId: curCid,
              warm: false,
              useContextModal: useRealModalHook,
              useProjection: useProjectionHook,
              useChat: useChatHook
            })
          )
        : null
    );
  }

  let hostInitialized = false;
  function initHost() {
    if (hostInitialized) return;
    hostInitialized = true;
    try {
      const ctx = makeCordisContext();
      if (capturedBundle && typeof capturedBundle.factory === 'function') {
        const plugin = capturedBundle.factory(requireShim);
        if (plugin && typeof plugin.apply === 'function') {
          plugin.apply(ctx);
        }
      }
    } catch (err) {
      console.error('[dsh_host] Failed to initialize dsh-context bundle:', err);
    }

    const rootEl = document.getElementById('app-root');
    if (rootEl && ReactDOM?.createRoot) {
      ReactDOM.createRoot(rootEl).render(h(App));
    } else if (rootEl && ReactDOM?.render) {
      ReactDOM.render(h(App), rootEl);
    }
  }

  window.__AGY_DSH_HOST__ = {
    registeredSlots,
    appState,
    fetchBootstrap,
    initHost,
    App
  };
})();
