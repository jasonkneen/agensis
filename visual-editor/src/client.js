/* visual-dev-editor — browser client.
 *
 * Plain non-module script, zero dependencies. Builds its entire UI inside one
 * Shadow-DOM host so editor CSS can never leak into the page (or vice versa).
 * Edits hit the real DOM first for instant feedback, then POST to
 * /__visual-editor/edit so the server patches the HTML source file on disk.
 *
 * UI: Navigator (left) — searchable element tree with per-type icons,
 * keyboard navigation and drag-reordering. Inspector (right) — Design tab
 * (layout / spacing box-model / size / position / typography / background /
 * border / effects, all computed-style aware, committed as inline styles via
 * setStyle) and Element tab (id, class chips, attributes, text, raw inline
 * CSS). Breadcrumb strip along the bottom. All edits are undoable (Cmd/Ctrl+Z).
 *
 * Teardown: window.__visualEditor.disable()
 */
(function () {
  'use strict';
  if (!document.body) return;
  if (window.__visualEditor) return; // already active

  var API = '/__visual-editor/edit';
  var MAX_DEPTH = 25;
  var MAX_CHILDREN = 30;
  // Held to momentarily invert select mode (see onModeKeyDown).
  var MODE_KEY = 'Alt';           // Option on macOS
  var MODE_KEY_LABEL = 'Alt/⌥';

  // -------------------------------------------------------------------------
  // Small DOM helper
  // -------------------------------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
        else el.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  // -------------------------------------------------------------------------
  // Inline SVG icons — tiny, stroke-based, inherit currentColor.
  // -------------------------------------------------------------------------
  var ICONS = {
    box: 'M2.5 2.5h11v11h-11z',
    text: 'M3 4h10M8 4v8.5',
    image: 'M2.5 3.5h11v9h-11zM3 11l3.2-3 2.6 2.4 2-1.8 2.7 2.4M6 6.6a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z',
    pointer: 'M4.5 2.5l7.5 6.5-3.7.6 2.3 3.7-1.7 1-2.2-3.8-2.2 2.5z',
    table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 3.5v9',
    list: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.8 4.5h.01M2.8 8h.01M2.8 11.5h.01',
    dot: 'M8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
    eye: 'M1.5 8s2.5-4.2 6.5-4.2S14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8zM8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
    eyeoff: 'M3 13L13 3M6.2 11.7c.6.3 1.2.5 1.8.5 4 0 6.5-4.2 6.5-4.2a13 13 0 0 0-2.3-2.5M9.9 4.1A6.7 6.7 0 0 0 8 3.8C4 3.8 1.5 8 1.5 8s.9 1.5 2.4 2.7',
    chevR: 'M6 4l4 4-4 4',
    chevD: 'M4 6l4 4 4-4',
    search: 'M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM10 10l3.8 3.8',
    unfold: 'M4 5.5L8 2l4 3.5M4 10.5L8 14l4-3.5',
    fold: 'M4 2.5L8 6l4-3.5M4 13.5L8 10l4 3.5',
    crosshair: 'M8 3.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2zM8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15',
    arrowUp: 'M8 13V3M4 7l4-4 4 4',
    arrowDown: 'M8 3v10M4 9l4 4 4-4',
    trash: 'M3 4.5h10M5.5 4.5V3h5v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
    undo: 'M3.5 6.5h6a3.5 3.5 0 1 1 0 7H6M3.5 6.5l3-3M3.5 6.5l3 3',
    x: 'M4 4l8 8M12 4l-8 8',
    dock: 'M2.5 3.5h11v9h-11zM10.5 3.5v9',
    plus: 'M8 3v10M3 8h10',
    live: 'M2.5 2.5h11v3h-11zM2.5 10.5h11v3h-11zM5.8 8h4.4M8 5.8v4.4',
    jStart: 'M3 3v10M5.5 5h2.5v6H5.5zM9.5 5H12v6H9.5z',
    jCenter: 'M5 5h2.5v6H5zM8.8 5h2.5v6H8.8z',
    jBetween: 'M2.5 3v10M13.5 3v10M4.5 5H7v6H4.5zM9.3 5h2.5v6H9.3z',
    jEnd: 'M13 3v10M4 5h2.5v6H4zM8 5h2.5v6H8z',
    aStart: 'M3 3h10M5 5.5h6V8H5z',
    aCenter: 'M3 8h2M11 8h2M5 5.5h6v5H5z',
    aStretch: 'M3 3h10M3 13h10M5 5.5h6v5H5z',
    aEnd: 'M3 13h10M5 8h6v2.5H5z',
    alignL: 'M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7',
    alignC: 'M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7',
    alignR: 'M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7',
    alignJ: 'M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h11',
    row: 'M2 8h10M9 5l3 3-3 3',
    col: 'M8 2v10M5 9l3 3 3-3',
  };

  /** Give a non-<button> control real button semantics: reachable by Tab and
   * activated by Enter/Space, not mouse-only. */
  function pressable(el, onActivate) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', onActivate);
    el.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      ev.preventDefault();
      ev.stopPropagation();
      onActivate(ev);
    });
    return el;
  }

  function svgIcon(name, cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name] || ICONS.dot);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.4');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  // Element category → icon + tint, used by the Navigator.
  var TAG_CATS = [
    { cls: 'c-media', icon: 'image', tags: 'img svg video audio canvas picture iframe embed object' },
    { cls: 'c-inter', icon: 'pointer', tags: 'a button select input textarea form option optgroup datalist fieldset' },
    { cls: 'c-table', icon: 'table', tags: 'table thead tbody tfoot tr td th caption colgroup col' },
    { cls: 'c-list', icon: 'list', tags: 'ul ol dl menu' },
    { cls: 'c-text', icon: 'text', tags: 'h1 h2 h3 h4 h5 h6 p span em strong b i u small blockquote pre code label li dt dd figcaption cite abbr mark time sub sup' },
    { cls: 'c-box', icon: 'box', tags: 'div section article aside header footer nav main figure details summary dialog template hr br' },
  ];
  var TAG_CAT = {};
  TAG_CATS.forEach(function (c) {
    c.tags.split(' ').forEach(function (t) { TAG_CAT[t] = c; });
  });
  function catFor(el) {
    return TAG_CAT[el.tagName.toLowerCase()] || { cls: 'c-box', icon: 'dot' };
  }

  // -------------------------------------------------------------------------
  // Element path — element-only child indices from <html>, matching the
  // server's parse5 walk exactly (text/comment nodes are skipped, and so is
  // the editor's own host element, which never exists in the source).
  // -------------------------------------------------------------------------
  function isOurs(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === host || host.contains(el)) return true;
    // The drag ghost AND its cloned contents — closest(), not hasAttribute(),
    // or the clone's descendants count as page elements and inflate the
    // Navigator's element tally for the duration of every drag.
    if (el.closest && el.closest('[data-ve-editor-el]')) return true;
    if (!el.closest && el.hasAttribute('data-ve-editor-el')) return true;
    // The serve-time injected client script exists in the DOM but not in the
    // source file — never count it in element paths.
    if (el.tagName === 'SCRIPT' && /\/__visual-editor\/client\.js$/.test(el.src || '')) return true;
    return false;
  }

  function pageChildren(el) {
    return Array.prototype.filter.call(el.children, function (c) { return !isOurs(c); });
  }

  function elementPath(el) {
    var path = [];
    var node = el;
    while (node && node !== document.documentElement) {
      var parent = node.parentElement;
      if (!parent) return null;
      var sibs = pageChildren(parent);
      var idx = sibs.indexOf(node);
      if (idx === -1) return null;
      path.unshift(idx);
      node = parent;
    }
    return node === document.documentElement ? path : null;
  }

  function elementFromPath(path) {
    var node = document.documentElement;
    for (var i = 0; i < path.length; i++) {
      if (!node) return null;
      var sibs = pageChildren(node);
      if (path[i] >= sibs.length) return null;
      node = sibs[path[i]];
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // File attribution — the served page maps 1:1 to a file under root, so the
  // source file is just the current pathname ("/" → "index.html").
  // An element (or ancestor) may override with data-ve-file for setups where
  // one page is assembled from several source files.
  // -------------------------------------------------------------------------
  function pageFile() {
    var p = decodeURIComponent(location.pathname);
    if (p.endsWith('/')) p += 'index.html';
    return p.replace(/^\/+/, '');
  }

  function fileFor(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      if (node.getAttribute && node.getAttribute('data-ve-file')) {
        return node.getAttribute('data-ve-file');
      }
      node = node.parentElement;
    }
    return pageFile();
  }

  // -------------------------------------------------------------------------
  // Host + shadow root + styles
  // -------------------------------------------------------------------------
  var host = document.createElement('div');
  host.id = '__visual-editor-host';
  host.setAttribute('data-ve-ignore', '');
  var shadow = host.attachShadow({ mode: 'open' });

  var DEFAULT_LEFT_W = 264, DEFAULT_RIGHT_W = 320, BAR_H = 46, CRUMB_H = 28;
  // Panel resize limits. CANVAS_MIN keeps a usable strip of page between them
  // no matter how wide the user drags either side.
  var PANEL_MIN = 190, PANEL_MAX = 720, CANVAS_MIN = 220;

  // -------------------------------------------------------------------------
  // Persisted preferences (panel widths + live layout preview)
  // -------------------------------------------------------------------------
  var PREFS_KEY = 'visual-dev-editor:prefs';
  var prefs = { leftW: DEFAULT_LEFT_W, rightW: DEFAULT_RIGHT_W, livePreview: true };
  try {
    var savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (typeof savedPrefs.leftW === 'number') prefs.leftW = savedPrefs.leftW;
    if (typeof savedPrefs.rightW === 'number') prefs.rightW = savedPrefs.rightW;
    if (typeof savedPrefs.livePreview === 'boolean') prefs.livePreview = savedPrefs.livePreview;
  } catch (e) { /* private mode / blocked storage — defaults are fine */ }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  function clampLeftW(w) {
    var room = window.innerWidth - prefs.rightW - CANVAS_MIN;
    return Math.round(Math.max(PANEL_MIN, Math.min(w, Math.min(PANEL_MAX, Math.max(PANEL_MIN, room)))));
  }
  function clampRightW(w) {
    var room = window.innerWidth - prefs.leftW - CANVAS_MIN;
    return Math.round(Math.max(PANEL_MIN, Math.min(w, Math.min(PANEL_MAX, Math.max(PANEL_MIN, room)))));
  }

  shadow.appendChild(h('style', {
    text: [
      ':host { all: initial; }',
      '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }',
      ':host {',
      '  --bg: rgba(11,13,18,.96); --bg2: #07090c; --bg3: #10151d;',
      '  --line: #1c212c; --line2: #242b38;',
      '  --tx: #e8e6e1; --tx2: #8b909c; --tx3: #565d6b;',
      '  --blue: #4f9cf9; --mint: #55e6a5; --amber: #f2b94b; --red: #ff6b6b; --purple: #b48ef7;',
      '  --ring: 0 0 0 2px rgba(79,156,249,.28);',
      '  --leftw: ' + DEFAULT_LEFT_W + 'px; --rightw: ' + DEFAULT_RIGHT_W + 'px;',
      '}',
      '.ve { position: fixed; z-index: 2147483000; background: var(--bg); color: var(--tx);',
      '  -webkit-backdrop-filter: blur(14px) saturate(1.15); backdrop-filter: blur(14px) saturate(1.15);',
      '  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
      '  border: 0 solid var(--line); }',
      '.ve, .ve * { scrollbar-width: thin; scrollbar-color: #232a36 transparent; }',
      '.ve ::-webkit-scrollbar { width: 8px; height: 8px; }',
      '.ve ::-webkit-scrollbar-thumb { background: #232a36; border-radius: 4px; }',
      '.ve ::-webkit-scrollbar-thumb:hover { background: #2e3745; }',
      '.ic { width: 12px; height: 12px; flex: none; display: block; }',
      '[role=button]:focus-visible, button:focus-visible, .tab:focus-visible {',
      '  outline: 2px solid var(--blue); outline-offset: 1px; border-radius: 4px; }',
      '',
      '/* ---- panel chrome ---- */',
      '#left { left: 0; top: 0; bottom: ' + BAR_H + 'px; width: var(--leftw);',
      '  border-right-width: 1px; display: flex; flex-direction: column; }',
      '#right { right: 0; top: 0; bottom: ' + BAR_H + 'px; width: var(--rightw);',
      '  border-left-width: 1px; display: flex; flex-direction: column; }',
      '.phead { flex: none; display: flex; align-items: center; gap: 6px; height: 34px;',
      '  padding: 0 10px; border-bottom: 1px solid var(--line); }',
      '.ptitle { font: 600 9.5px/1 system-ui, sans-serif; letter-spacing: .14em; color: var(--tx2); }',
      '#treecount { font-size: 9px; color: var(--tx3); background: var(--bg3); border-radius: 7px;',
      '  padding: 1px 6px; line-height: 13px; }',
      '.pgrow { flex: 1; }',
      '/* panel resize grips */',
      '.pgrip { position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize; z-index: 3; }',
      '.pgrip::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px;',
      '  background: transparent; transition: background .12s; }',
      '.pgrip:hover::after, .pgrip.on::after { background: var(--blue); box-shadow: 0 0 6px rgba(79,156,249,.7); }',
      '#left .pgrip { right: -3px; }',
      '#right .pgrip { left: -3px; }',
      '.ibtn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;',
      '  background: transparent; color: var(--tx2); border: 1px solid transparent; border-radius: 5px; cursor: pointer; }',
      '.ibtn:hover { background: var(--bg3); color: var(--tx); border-color: var(--line2); }',
      '.pbody { flex: 1; overflow: auto; overscroll-behavior: contain; }',
      '',
      '/* ---- navigator search ---- */',
      '#searchwrap { flex: none; position: relative; padding: 7px 8px; border-bottom: 1px solid var(--line); }',
      '#searchwrap > .ic { position: absolute; left: 15px; top: 50%; transform: translateY(-50%); color: var(--tx3); pointer-events: none; }',
      '#search { width: 100%; height: 24px; padding: 0 24px; background: var(--bg2); color: var(--tx);',
      '  border: 1px solid var(--line); border-radius: 6px; font: inherit; outline: none; transition: border-color .12s, box-shadow .12s; }',
      '#search::placeholder { color: var(--tx3); }',
      '#search:focus { border-color: var(--blue); box-shadow: var(--ring); }',
      '#searchclear { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); display: none;',
      '  width: 18px; height: 18px; }',
      '#searchwrap.has #searchclear { display: inline-flex; }',
      '',
      '/* ---- navigator tree ---- */',
      '#tree { padding: 4px 0 12px; }',
      '.trow { display: flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer;',
      '  height: 22px; padding: 0 8px 0 6px; position: relative; }',
      '.trow:hover { background: #141924; }',
      '.trow.sel { background: linear-gradient(90deg, rgba(79,156,249,.17), rgba(79,156,249,.03)); }',
      '.trow.sel::before { content: ""; position: absolute; left: 0; top: 2px; bottom: 2px; width: 2px;',
      '  background: var(--blue); border-radius: 0 2px 2px 0; }',
      '.trow.hit::after { content: ""; position: absolute; left: 1px; top: 9px; width: 3px; height: 3px;',
      '  border-radius: 50%; background: var(--amber); }',
      '.trow.hid { opacity: .45; }',
      '.trow .caret { width: 12px; height: 12px; flex: none; display: inline-flex; align-items: center;',
      '  justify-content: center; color: var(--tx3); border-radius: 3px; }',
      '.trow .caret:hover { color: var(--tx); background: var(--bg3); }',
      '.trow .caret .ic { width: 9px; height: 9px; }',
      '.trow .cat { flex: none; display: inline-flex; }',
      '.trow .cat.c-box { color: #6f87b3; } .trow .cat.c-text { color: #9aa3b2; }',
      '.trow .cat.c-media { color: var(--mint); } .trow .cat.c-inter { color: var(--amber); }',
      '.trow .cat.c-table { color: var(--purple); } .trow .cat.c-list { color: #7fb8c9; }',
      '.trow .cat .ic { width: 11px; height: 11px; }',
      '.trow .tag { color: #7ab3fa; }',
      '.trow.sel .tag { color: #cfe4ff; }',
      '.trow .id { color: var(--amber); }',
      '.trow .cls { color: var(--mint); opacity: .85; }',
      '.trow .snip { color: var(--tx3); overflow: hidden; text-overflow: ellipsis; font-style: italic; }',
      '.trow .flex1 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
      '.trow .nbadge { flex: none; font-size: 9px; color: var(--tx3); background: var(--bg3);',
      '  border-radius: 7px; padding: 0 5px; line-height: 13px; }',
      '.trow .rbtn { flex: none; display: none; align-items: center; justify-content: center;',
      '  width: 16px; height: 16px; color: var(--tx3); border-radius: 4px; }',
      '.trow:hover .rbtn { display: inline-flex; }',
      '.trow .rbtn:hover { color: var(--tx); background: #1d2430; }',
      '.trow .rbtn.on { display: inline-flex; color: var(--tx3); }',
      '.tmore { color: var(--tx3); padding: 2px 8px 2px 24px; cursor: pointer; font-size: 10px; }',
      '.tmore:hover { color: var(--blue); }',
      '.tempty { color: var(--tx3); padding: 18px 14px; text-align: center; font: 11px system-ui, sans-serif; }',
      '',
      '/* ---- palette ---- */',
      '#palette { flex: none; display: none; flex-direction: column; max-height: 46%;',
      '  border-bottom: 1px solid var(--line); }',
      '#palette.show { display: flex; }',
      '#palbody { overflow: auto; overscroll-behavior: contain; padding: 4px 0 8px; }',
      '.palgroup { font: 600 9px/1 system-ui, sans-serif; letter-spacing: .13em; color: var(--tx3);',
      '  padding: 8px 10px 4px; display: flex; align-items: center; gap: 6px; }',
      '.palgroup .n { color: var(--tx3); opacity: .7; font-weight: 400; letter-spacing: 0; }',
      '.palitem { display: flex; align-items: center; gap: 6px; padding: 3px 10px; cursor: pointer;',
      '  white-space: nowrap; }',
      '.palitem:hover { background: #141924; }',
      '.palitem .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--tx); }',
      '.palitem .meta { flex: none; font-size: 9px; color: var(--tx3); }',
      '.palitem.off { opacity: .45; cursor: not-allowed; }',
      '.palitem.off:hover { background: transparent; }',
      '.palnote { color: var(--tx3); font-size: 9.5px; padding: 2px 10px 6px; line-height: 1.45;',
      '  white-space: normal; }',
      '',
      '/* ---- inspector ---- */',
      '#eltag { display: flex; align-items: baseline; gap: 5px; min-width: 0; font-size: 12px;',
      '  white-space: nowrap; overflow: hidden; }',
      '#eltag .dims { flex: none; }',
      '#eltag .id, #eltag .cls { overflow: hidden; text-overflow: ellipsis; min-width: 3ch; flex-shrink: 1; }',
      '#eltag .tag { color: #7ab3fa; font-weight: 600; }',
      '#eltag .id { color: var(--amber); } #eltag .cls { color: var(--mint); opacity: .8; }',
      '#eltag .dims { color: var(--tx3); font-size: 10px; margin-left: 2px; white-space: nowrap; }',
      '#filechip { flex: none; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '  font-size: 9px; color: var(--tx3); background: var(--bg3); border-radius: 4px; padding: 1px 6px; }',
      '#tabs { flex: none; display: flex; border-bottom: 1px solid var(--line); }',
      '.tab { flex: 1; height: 28px; background: none; border: none; color: var(--tx2); font: 600 10px/1 system-ui, sans-serif;',
      '  letter-spacing: .1em; cursor: pointer; position: relative; }',
      '.tab:hover { color: var(--tx); }',
      '.tab.on { color: var(--tx); }',
      '.tab.on::after { content: ""; position: absolute; left: 22%; right: 22%; bottom: -1px; height: 2px;',
      '  background: var(--blue); border-radius: 2px 2px 0 0; }',
      '.sec { border-bottom: 1px solid var(--line); }',
      '.sechead { display: flex; align-items: center; gap: 6px; height: 27px; padding: 0 10px; cursor: pointer;',
      '  user-select: none; }',
      '.sechead:hover { background: #12161f; }',
      '.sechead .ic { width: 9px; height: 9px; color: var(--tx3); transition: transform .12s; }',
      '.sec.open .sechead .ic { transform: rotate(90deg); }',
      '.sechead .t { font: 600 9.5px/1 system-ui, sans-serif; letter-spacing: .13em; color: var(--tx2); }',
      '.sechead:hover .t { color: var(--tx); }',
      '.secbody { display: none; padding: 2px 10px 12px; }',
      '.sec.open .secbody { display: block; }',
      '',
      '/* ---- inspector controls ---- */',
      'input, textarea, select { background: var(--bg2); color: var(--tx); border: 1px solid var(--line);',
      '  border-radius: 5px; padding: 0 7px; font: inherit; width: 100%; height: 24px; outline: none;',
      '  transition: border-color .12s, box-shadow .12s; }',
      'input::placeholder, textarea::placeholder { color: var(--tx3); }',
      'input:focus, textarea:focus, select:focus { border-color: var(--blue); box-shadow: var(--ring); }',
      'textarea { height: auto; min-height: 52px; padding: 5px 7px; resize: vertical; line-height: 1.45; }',
      'select { appearance: none; -webkit-appearance: none; padding-right: 18px;',
      "  background-image: url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='6'><path d='M1 1l3 3 3-3' fill='none' stroke='%238b909c' stroke-width='1.4' stroke-linecap='round'/></svg>\");",
      '  background-repeat: no-repeat; background-position: right 6px center; }',
      '.prow { display: flex; align-items: center; gap: 6px; margin-top: 6px; }',
      '.plabel { flex: none; width: 58px; color: var(--tx2); font-size: 10px; overflow: hidden;',
      '  text-overflow: ellipsis; white-space: nowrap; cursor: ew-resize; user-select: none; }',
      '.plabel.nodrag { cursor: default; }',
      '.prow.set .plabel { color: var(--blue); }',
      '.prow.set .plabel::after { content: "•"; margin-left: 3px; }',
      '.prow .reset { flex: none; display: none; width: 16px; height: 16px; align-items: center;',
      '  justify-content: center; color: var(--tx3); border-radius: 4px; cursor: pointer; }',
      '.prow.set .reset { display: inline-flex; }',
      '.prow .reset:hover { color: var(--red); background: var(--bg3); }',
      '.prow .reset .ic { width: 8px; height: 8px; }',
      '.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; }',
      '.grid2 .plabel { width: 34px; }',
      '',
      '/* segmented control */',
      '.seg { display: flex; background: var(--bg2); border: 1px solid var(--line); border-radius: 6px;',
      '  padding: 2px; gap: 2px; flex: 1; min-width: 0; }',
      '.seg button { flex: 1; min-width: 0; height: 20px; display: inline-flex; align-items: center;',
      '  justify-content: center; gap: 3px; background: transparent; border: none; border-radius: 4px;',
      '  color: var(--tx2); font: 10px ui-monospace, monospace; cursor: pointer; padding: 0 2px; }',
      '.seg button:hover { color: var(--tx); background: #131924; }',
      '.seg button.on { color: var(--blue); background: #16233a; box-shadow: inset 0 0 0 1px rgba(79,156,249,.35); }',
      '.seg button .ic { width: 11px; height: 11px; }',
      '',
      '/* color control */',
      '.swatch { flex: none; width: 24px; height: 24px; border-radius: 5px; border: 1px solid var(--line2);',
      '  position: relative; overflow: hidden; cursor: pointer;',
      '  background-image: conic-gradient(#3a3f4a 25%, #262b33 0 50%, #3a3f4a 0 75%, #262b33 0); background-size: 8px 8px; }',
      '.swatch .fill { position: absolute; inset: 0; }',
      '.swatch input[type=color] { position: absolute; inset: -4px; width: 200%; height: 200%; opacity: 0; cursor: pointer; }',
      '',
      '/* slider */',
      'input[type=range] { -webkit-appearance: none; appearance: none; height: 4px; padding: 0;',
      '  background: linear-gradient(90deg, var(--blue) var(--fill, 100%), #222835 var(--fill, 100%));',
      '  border: none; border-radius: 2px; }',
      'input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px;',
      '  border-radius: 50%; background: #dfe6f2; border: none; box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer; }',
      '',
      '/* box model */',
      '.bm { position: relative; margin-top: 8px; border: 1px dashed #3a352a; border-radius: 6px;',
      '  padding: 20px 40px; background: rgba(242,185,75,.045); }',
      '.bm-pad { position: relative; border: 1px dashed #24382f; border-radius: 5px; padding: 20px 40px;',
      '  background: rgba(85,230,165,.05); }',
      '.bm-core { height: 30px; display: flex; align-items: center; justify-content: center; gap: 4px;',
      '  background: rgba(79,156,249,.12); border: 1px solid rgba(79,156,249,.35); border-radius: 4px;',
      '  color: #cfe4ff; font-size: 10px; white-space: nowrap; overflow: hidden; }',
      '.bm-tag { position: absolute; top: 3px; left: 7px; font: 600 7.5px/1 system-ui, sans-serif;',
      '  letter-spacing: .12em; color: #8a7748; pointer-events: none; }',
      '.bm-pad > .bm-tag { color: #4e7a63; }',
      '.bm-n { position: absolute; color: var(--tx2); font-size: 10px; cursor: ew-resize; user-select: none;',
      '  padding: 1px 4px; border-radius: 3px; line-height: 1.2; }',
      '.bm-n:hover { color: var(--tx); background: rgba(255,255,255,.07); }',
      '.bm-n.set { color: var(--blue); }',
      '.bm-n.n-top { top: 2px; left: 50%; transform: translateX(-50%); }',
      '.bm-n.n-bottom { bottom: 2px; left: 50%; transform: translateX(-50%); }',
      '.bm-n.n-left { left: 2px; top: 50%; transform: translateY(-50%); }',
      '.bm-n.n-right { right: 2px; top: 50%; transform: translateY(-50%); }',
      '.bm-n input { width: 42px; height: 16px; padding: 0 3px; font-size: 10px; border-radius: 3px; }',
      '',
      '/* class chips */',
      '.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }',
      '.chip { display: inline-flex; align-items: center; gap: 4px; background: rgba(85,230,165,.1);',
      '  border: 1px solid rgba(85,230,165,.28); color: var(--mint); border-radius: 10px;',
      '  padding: 1px 4px 1px 8px; font-size: 10px; line-height: 16px; }',
      '.chip .rm { display: inline-flex; width: 13px; height: 13px; align-items: center; justify-content: center;',
      '  border-radius: 50%; cursor: pointer; color: rgba(85,230,165,.7); }',
      '.chip .rm:hover { background: rgba(255,107,107,.2); color: var(--red); }',
      '.chip .rm .ic { width: 7px; height: 7px; }',
      '.mini { height: 22px; padding: 0 9px; background: var(--bg3); color: var(--tx2); border: 1px solid var(--line2);',
      '  border-radius: 5px; font: inherit; font-size: 10px; cursor: pointer; width: auto; }',
      '.mini:hover { color: var(--tx); border-color: #344054; background: #161c26; }',
      '.hint { color: var(--tx3); font-size: 10px; margin-top: 6px; line-height: 1.4; overflow: hidden;',
      '  text-overflow: ellipsis; white-space: nowrap; }',
      '.empty-state { padding: 30px 18px; text-align: center; color: var(--tx3); font: 11px system-ui, sans-serif; line-height: 1.7; }',
      '.empty-state .ic { width: 22px; height: 22px; margin: 0 auto 8px; color: #2e3646; }',
      '.empty-state kbd { background: var(--bg3); border: 1px solid var(--line2); border-radius: 4px;',
      '  padding: 1px 5px; font: 10px ui-monospace, monospace; color: var(--tx2); }',
      '',
      '/* ---- breadcrumbs ---- */',
      '#crumbs { left: var(--leftw); right: var(--rightw); bottom: ' + BAR_H + 'px; height: ' + CRUMB_H + 'px;',
      '  display: none; align-items: center; gap: 2px; padding: 0 10px; overflow-x: auto; overflow-y: hidden;',
      '  border-top-width: 1px; scrollbar-width: none; }',
      '#crumbs::-webkit-scrollbar { display: none; }',
      '#crumbs.show { display: flex; }',
      '.crumb { flex: none; display: inline-flex; align-items: baseline; gap: 2px; padding: 2px 6px;',
      '  border-radius: 4px; cursor: pointer; color: var(--tx2); }',
      '.crumb:hover { background: var(--bg3); color: var(--tx); }',
      '.crumb .id { color: var(--amber); font-size: 10px; }',
      '.crumb.cur { color: #cfe4ff; background: rgba(79,156,249,.14); }',
      '.crumbsep { flex: none; color: var(--tx3); font-size: 9px; }',
      '',
      '/* ---- toolbar ---- */',
      '#bar { left: 0; right: 0; bottom: 0; height: ' + BAR_H + 'px; display: flex; align-items: center;',
      '  gap: 6px; padding: 0 10px; border-top-width: 1px; }',
      '#bar .group { display: flex; align-items: center; gap: 4px; padding-right: 8px; margin-right: 2px;',
      '  border-right: 1px solid var(--line); }',
      '#bar button { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px;',
      '  background: transparent; color: var(--tx2); border: 1px solid transparent; border-radius: 6px;',
      '  font: inherit; cursor: pointer; transition: background .12s, color .12s; }',
      '#bar button:hover { background: var(--bg3); color: var(--tx); border-color: var(--line2); }',
      '#bar button.on { background: #16233a; color: var(--blue); border-color: rgba(79,156,249,.4); }',
      '#status { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; color: var(--tx2);',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }',
      '#status .dotp { width: 6px; height: 6px; border-radius: 50%; background: #3a4150; flex: none; }',
      '#status.ok { color: var(--mint); } #status.ok .dotp { background: var(--mint); }',
      '#status.err { color: var(--red); } #status.err .dotp { background: var(--red); }',
      '#status.saving { color: var(--amber); } #status.saving .dotp { background: var(--amber);',
      '  animation: vepulse 1s ease-in-out infinite; }',
      '@keyframes vepulse { 50% { opacity: .3; } }',
      '',
      '/* ---- canvas overlays ---- */',
      '.ov { position: fixed; z-index: 2147483002; pointer-events: none; }',
      '#ov-hover { border: 1px dashed rgba(79,156,249,.85); background: rgba(79,156,249,.07);',
      '  border-radius: 1px; display: none; }',
      '#ov-hover-label, #ov-label { background: #101623; color: #cfe4ff; border: 1px solid rgba(79,156,249,.5);',
      '  padding: 1px 7px; font: 10px ui-monospace, monospace; border-radius: 4px; display: none;',
      '  box-shadow: 0 2px 10px rgba(0,0,0,.5); white-space: nowrap; }',
      '#ov-sel { border: 1.5px solid var(--blue); border-radius: 1px; display: none;',
      '  box-shadow: 0 0 0 1px rgba(79,156,249,.25), 0 0 14px rgba(79,156,249,.25); }',
      '#ov-margin { border-style: solid; border-color: rgba(242,185,75,.22); display: none; }',
      '#ov-padding { border-style: solid; border-color: rgba(85,230,165,.2); display: none; }',
      '#ov-line { background: var(--blue); display: none; border-radius: 1px;',
      '  box-shadow: 0 0 8px rgba(79,156,249,.8); }',
      '#ov-line.bad { background: var(--red); box-shadow: 0 0 8px rgba(255,92,92,.8); }',
      '#ov-inside { border: 2px solid var(--blue); background: rgba(79,156,249,.1); display: none; border-radius: 2px; }',
      '#ov-inside.bad { border-color: var(--red); background: rgba(255,92,92,.1); }',
      '#ov-drop-label { background: var(--blue); color: #fff; padding: 0 6px; font-size: 10px;',
      '  border-radius: 3px; display: none; white-space: nowrap; }',
      '#ov-drop-label.bad { background: var(--red); }',
    ].join('\n'),
  }));

  // -------------------------------------------------------------------------
  // Panel skeletons
  // -------------------------------------------------------------------------

  // Left — Navigator
  var searchIn = h('input', { id: 'search', placeholder: 'Find tag, #id, .class, text…', spellcheck: 'false' });
  var searchClear = h('span', { class: 'ibtn', id: 'searchclear', title: 'Clear (Esc)' }, [svgIcon('x')]);
  var searchWrap = h('div', { id: 'searchwrap' }, [svgIcon('search'), searchIn, searchClear]);
  var treeBox = h('div', { class: 'pbody', id: 'tree' });
  var addBtn = h('button', { class: 'ibtn', title: 'Insert an element or component' }, [svgIcon('plus')]);
  var palBody = h('div', { id: 'palbody' });
  var paletteBox = h('div', { id: 'palette' }, [palBody]);
  var expandAllBtn = h('button', { class: 'ibtn', title: 'Expand all' }, [svgIcon('unfold')]);
  var collapseAllBtn = h('button', { class: 'ibtn', title: 'Collapse all' }, [svgIcon('fold')]);
  var treeCount = h('span', { id: 'treecount' });
  var leftGrip = h('div', { class: 'pgrip', title: 'Drag to resize — double-click to reset' });
  var rightGrip = h('div', { class: 'pgrip', title: 'Drag to resize — double-click to reset' });
  var leftPanel = h('div', { class: 've', id: 'left' }, [
    h('div', { class: 'phead' }, [
      h('span', { class: 'ptitle', text: 'NAVIGATOR' }),
      treeCount,
      h('span', { class: 'pgrow' }),
      addBtn, expandAllBtn, collapseAllBtn,
    ]),
    paletteBox,
    searchWrap,
    treeBox,
    leftGrip,
  ]);

  // Right — Inspector
  var elTag = h('div', { id: 'eltag' });
  var fileChip = h('span', { id: 'filechip' });
  var designTabBtn = h('button', { class: 'tab on', text: 'DESIGN' });
  var elementTabBtn = h('button', { class: 'tab', text: 'ELEMENT' });
  var tabsRow = h('div', { id: 'tabs' }, [designTabBtn, elementTabBtn]);
  var propsBox = h('div', { class: 'pbody', id: 'props' });
  var rightPanel = h('div', { class: 've', id: 'right' }, [
    rightGrip,
    h('div', { class: 'phead' }, [elTag, h('span', { class: 'pgrow' }), fileChip]),
    tabsRow,
    propsBox,
  ]);

  // Bottom — breadcrumbs + toolbar
  var crumbsBar = h('div', { class: 've', id: 'crumbs' });
  var statusTx = h('span', { id: 'statustx', text: 'idle' });
  var statusEl = h('span', { id: 'status' }, [h('span', { class: 'dotp' }), statusTx]);
  var selectBtn = h('button', { title: 'Toggle select mode (V) — off lets the page respond to clicks. Hold ' + MODE_KEY_LABEL + ' to momentarily invert.' }, [svgIcon('crosshair'), 'Select']);
  var upBtn = h('button', { title: 'Move before previous sibling' }, [svgIcon('arrowUp')]);
  var downBtn = h('button', { title: 'Move after next sibling' }, [svgIcon('arrowDown')]);
  var delBtn = h('button', { title: 'Delete element (⌫)' }, [svgIcon('trash')]);
  var undoBtn = h('button', { title: 'Undo (⌘Z)' }, [svgIcon('undo'), 'Undo']);
  var liveBtn = h('button', {
    title: 'Live layout preview: while dragging, reflow the page around where the element would land',
  }, [svgIcon('live')]);
  var dockBtn = h('button', { title: 'Dock: push the page aside instead of overlapping it' }, [svgIcon('dock')]);
  var closeBtn = h('button', { title: 'Close editor' }, [svgIcon('x')]);
  var bar = h('div', { class: 've', id: 'bar' }, [
    h('div', { class: 'group' }, [selectBtn]),
    h('div', { class: 'group' }, [upBtn, downBtn, delBtn]),
    h('div', { class: 'group' }, [undoBtn]),
    liveBtn,
    dockBtn,
    statusEl,
    closeBtn,
  ]);

  var ovHover = h('div', { class: 'ov', id: 'ov-hover' });
  var ovHoverLabel = h('div', { class: 'ov', id: 'ov-hover-label' });
  var ovMargin = h('div', { class: 'ov', id: 'ov-margin' });
  var ovPadding = h('div', { class: 'ov', id: 'ov-padding' });
  var ovSel = h('div', { class: 'ov', id: 'ov-sel' });
  var ovLabel = h('div', { class: 'ov', id: 'ov-label' });
  var ovLine = h('div', { class: 'ov', id: 'ov-line' });
  var ovInside = h('div', { class: 'ov', id: 'ov-inside' });
  var ovDropLabel = h('div', { class: 'ov', id: 'ov-drop-label' });

  [leftPanel, rightPanel, crumbsBar, bar,
    ovMargin, ovPadding, ovHover, ovHoverLabel, ovSel, ovLabel, ovLine, ovInside, ovDropLabel]
    .forEach(function (el) { shadow.appendChild(el); });
  document.body.appendChild(host);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  var state = {
    selected: null,       // currently selected page element
    selectMode: false,    // persistent toggle (toolbar button / V)
    modeKeyHeld: false,   // MODE_KEY held → momentarily inverts selectMode
    open: new WeakMap(),  // element → explicit expanded/collapsed (default: depth < 2)
    childLimit: new WeakMap(), // element → raised child render cap
    filter: '',
    tab: 'design',
    sections: {},         // section title → open?
    navOrder: [],         // elements in rendered tree order (keyboard nav)
    dirty: false,
    docked: false,
  };

  var DEFAULT_OPEN_SECTIONS = {
    Layout: true, Spacing: true, Size: true, Typography: true,
    Identity: true, Classes: true, Text: true, Attributes: true,
  };

  function isOpen(el, depth) {
    return state.open.has(el) ? state.open.get(el) : depth < 2;
  }

  // -------------------------------------------------------------------------
  // Save status + server round-trip + undo stack
  // -------------------------------------------------------------------------
  // Every edit ships with DOM closures: `undo` reverts the local mutation,
  // `redo` re-applies it. A server {ok:false} rolls the DOM back immediately
  // so page and source never diverge; a success pushes {file, undo, redo}
  // onto the undo stack (mirrored by the server's per-file source stack).
  var undoStack = [];
  var statusTimer = null;

  function setStatus(text, cls) {
    statusTx.textContent = text;
    statusEl.className = cls || '';
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (cls === 'ok') {
      statusTimer = setTimeout(function () { statusTx.textContent = 'idle'; statusEl.className = ''; }, 2200);
    }
  }

  function refreshAll() {
    rebuildTree(); rebuildProps(); rebuildCrumbs(); refreshOverlays();
  }

  // Edits are serialized. Two in-flight requests can complete out of order,
  // which would push onto this stack in a different order than the server
  // pushed onto its per-file stack — and a later undo would then revert one
  // edit in the DOM while the server restored a different one.
  var editChain = Promise.resolve();

  function sendEdit(op, dom) {
    setStatus('saving…', 'saving');
    state.dirty = true;
    editChain = editChain.then(function () {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          state.dirty = false;
          if (res && res.ok) {
            if (dom) {
              undoStack.push({ file: op.file, undo: dom.undo, redo: dom.redo });
              if (undoStack.length > 50) undoStack.shift();
            }
            setStatus('saved', 'ok');
          } else {
            if (dom) { dom.undo(); refreshAll(); }
            setStatus('error: ' + ((res && res.error) || 'unknown'), 'err');
          }
        })
        .catch(function (err) {
          state.dirty = false;
          if (dom) { dom.undo(); refreshAll(); }
          setStatus('error: ' + err.message, 'err');
        });
    });
  }

  function doUndo() {
    var top = undoStack.pop();
    if (!top) { setStatus('nothing to undo'); return; }
    top.undo();
    refreshAll();
    setStatus('saving…', 'saving');
    // Same queue as sendEdit: an undo must not overtake an edit that is still
    // in flight, or it would pop a server stack entry that isn't there yet.
    editChain = editChain.then(function () {
      return fetch('/__visual-editor/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: top.file }),
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.ok) {
            setStatus('undone', 'ok');
          } else {
            // Server has no matching entry — re-apply the DOM so it stays
            // consistent with the untouched file.
            top.redo();
            refreshAll();
            setStatus('error: ' + ((res && res.error) || 'undo failed'), 'err');
          }
        })
        .catch(function (err) {
          top.redo();
          refreshAll();
          setStatus('error: ' + err.message, 'err');
        });
    });
  }

  /** attrInverse captures the pre-edit state of one attribute. */
  function attrInverse(el, name) {
    var had = el.hasAttribute(name);
    var old = had ? el.getAttribute(name) : null;
    return {
      undo: function () { if (had) el.setAttribute(name, old); else el.removeAttribute(name); },
    };
  }

  /** moveInverse captures position so a moved element can be put back. */
  function moveInverse(el) {
    var parent = el.parentElement;
    var sibs = pageChildren(parent);
    var next = sibs[sibs.indexOf(el) + 1] || null;
    return {
      undo: function () { parent.insertBefore(el, next || (parent === document.body ? host : null)); },
    };
  }

  function opFor(el, extra) {
    var op = extra || {};
    var file = fileFor(el);
    if (file) op.file = file;
    op.path = elementPath(el);
    return op;
  }

  // -------------------------------------------------------------------------
  // Style helpers — inline vs computed, commit sessions
  // -------------------------------------------------------------------------
  function inlineVal(el, prop) { return el.style.getPropertyValue(prop); }
  function computedVal(el, prop) {
    try { return getComputedStyle(el).getPropertyValue(prop); } catch (e) { return ''; }
  }

  /** Commit one declaration as a setStyle op. beforeAttr = style attribute
   * captured BEFORE any live preview touched it (undo restores it wholesale,
   * matching the server's whole-file restore). */
  function commitStyle(el, prop, value, beforeAttr) {
    var redo = function () {
      if (value == null || value === '') {
        el.style.removeProperty(prop);
        // The server drops an emptied style attribute entirely — mirror that.
        if (el.style.length === 0) el.removeAttribute('style');
      } else {
        el.style.setProperty(prop, value);
      }
    };
    var undo = function () {
      if (beforeAttr == null) el.removeAttribute('style');
      else el.setAttribute('style', beforeAttr);
    };
    redo();
    if (fileFor(el)) {
      sendEdit(opFor(el, { op: 'setStyle', property: prop, value: (value == null || value === '') ? null : value }),
        { undo: undo, redo: redo });
    }
    refreshOverlays();
  }

  /** Per-control edit session: capture pre-state on first touch, preview
   * freely, then commit exactly once (or cancel back to the captured state). */
  function styleSession(el) {
    var before = null, active = false;
    return {
      start: function () {
        if (!active) { before = el.hasAttribute('style') ? el.getAttribute('style') : null; active = true; }
      },
      preview: function (prop, v) {
        this.start();
        if (v == null || v === '') el.style.removeProperty(prop);
        else el.style.setProperty(prop, v);
        refreshOverlays();
      },
      commit: function (prop, v) {
        this.start();
        commitStyle(el, prop, v, before);
        active = false;
      },
      cancel: function () {
        if (!active) return;
        if (before == null) el.removeAttribute('style');
        else el.setAttribute('style', before);
        active = false;
        refreshOverlays();
      },
      isActive: function () { return active; },
    };
  }

  /** "12px" + delta → "13px"; keeps whatever unit suffix is present. */
  function stepValue(v, delta) {
    var m = /^(-?\d*\.?\d+)(.*)$/.exec(String(v).trim());
    if (!m) return null;
    var n = parseFloat(m[1]) + delta;
    n = Math.round(n * 100) / 100;
    return n + m[2];
  }

  function normalizeCss(v, addPx) {
    var t = String(v).trim();
    if (t === '') return '';
    if (addPx && /^-?\d*\.?\d+$/.test(t)) return t + 'px';
    return t;
  }

  /** Draft guard: a non-empty value must be valid CSS for the property before
   * it is committed to source (half-typed "1." or "#zz" never lands on disk).
   * Fails open where CSS.supports is unavailable. */
  function cssValueOk(prop, v) {
    if (!v) return true;
    try {
      if (window.CSS && CSS.supports) return CSS.supports(prop, v);
    } catch (e) { /* fall through */ }
    return true;
  }

  function pxNum(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 10) / 10;
  }

  // rgb()/rgba() → #rrggbb for the native color picker.
  function toHexColor(v) {
    var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v || '');
    if (!m) return /^#([0-9a-fA-F]{6})$/.test(v || '') ? v : '#000000';
    function hx(x) { return ('0' + (+x).toString(16)).slice(-2); }
    return '#' + hx(m[1]) + hx(m[2]) + hx(m[3]);
  }

  // -------------------------------------------------------------------------
  // Highlight overlays (selection gets devtools-style margin/padding rings)
  // -------------------------------------------------------------------------
  function elLabel(el, withDims) {
    var name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    else {
      var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
      if (cls) name += '.' + cls;
    }
    if (withDims) {
      var r = el.getBoundingClientRect();
      name += '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    }
    return name;
  }

  function placeBox(ov, left, top, width, height) {
    ov.style.display = 'block';
    ov.style.clipPath = '';
    ov.style.left = left + 'px';
    ov.style.top = top + 'px';
    ov.style.width = Math.max(0, width) + 'px';
    ov.style.height = Math.max(0, height) + 'px';
  }

  /** Height of the editor chrome along the bottom edge. The breadcrumb strip
   * only exists while something is selected (#crumbs is display:none without
   * .show), so reserving its height unconditionally would clip 28px of live
   * canvas for nothing. */
  function bottomChromeH() {
    return BAR_H + (state.selected ? CRUMB_H : 0);
  }

  /** The visible canvas strip between the panels. When docked the page is
   * pushed aside so overlays never overlap the panels — no clip needed. */
  function canvasBounds() {
    if (state.docked) return null;
    return {
      left: prefs.leftW,
      top: 0,
      right: window.innerWidth - prefs.rightW,
      bottom: window.innerHeight - bottomChromeH(),
    };
  }

  /** placeBox clipped to the canvas strip — overlays must never paint across
   * the side panels / bottom bars. The box keeps its TRUE geometry and is
   * clipped visually: these overlays draw their margin/padding rings as CSS
   * borders, so shrinking the box would slide those bands inward and report
   * margins at the panel edge instead of at the element's edge. Returns false
   * (and hides the overlay) when nothing of the box is visible. */
  function placeBoxClipped(ov, left, top, width, height) {
    var b = canvasBounds();
    if (!b) { placeBox(ov, left, top, width, height); return true; }
    var w = Math.max(0, width), hgt = Math.max(0, height);
    var x1 = Math.max(left, b.left), y1 = Math.max(top, b.top);
    var x2 = Math.min(left + w, b.right), y2 = Math.min(top + hgt, b.bottom);
    if (x2 <= x1 || y2 <= y1) { ov.style.display = 'none'; return false; }
    placeBox(ov, left, top, w, hgt);
    ov.style.clipPath = 'inset(' +
      (y1 - top) + 'px ' + (left + w - x2) + 'px ' + (top + hgt - y2) + 'px ' + (x1 - left) + 'px)';
    return true;
  }

  function placeLabel(labelOv, rect, text) {
    labelOv.style.display = 'block';
    labelOv.textContent = text;
    // Keep the label inside the canvas strip between the two panels.
    var minX = prefs.leftW + 6, maxX = window.innerWidth - prefs.rightW - 140;
    labelOv.style.left = Math.min(Math.max(rect.left, minX), Math.max(minX, maxX)) + 'px';
    var top = rect.top - 22;
    if (top < 2) top = rect.bottom + 4;
    // …and above the breadcrumb/tool bars.
    var maxY = window.innerHeight - bottomChromeH() - 20;
    if (top > maxY) top = Math.max(2, maxY);
    labelOv.style.top = top + 'px';
  }

  function hideSelOverlays() {
    [ovSel, ovLabel, ovMargin, ovPadding].forEach(function (o) { o.style.display = 'none'; });
  }

  /** Take everything the editor paints on top of the page back off it. Drag
   * markers survive an in-flight drag — that drag is still happening. */
  function clearCanvasOverlays() {
    hideSelOverlays();
    hoverClear();
    if (!drag) {
      ovLine.style.display = 'none';
      ovInside.style.display = 'none';
      ovDropLabel.style.display = 'none';
    }
  }

  function refreshOverlays() {
    var el = state.selected;
    // Out of select mode the canvas belongs to the page: the selection still
    // exists (panels, breadcrumbs, keyboard nav all keep working) but nothing
    // is painted over the page. Without this the next scroll or style commit
    // would put the selection box straight back.
    if (!selMode()) { hideSelOverlays(); updateDims(); return; }
    if (!el || !el.getBoundingClientRect || !el.isConnected) { hideSelOverlays(); return; }
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { hideSelOverlays(); return; }
    var cs = getComputedStyle(el);
    var mt = pxNum(cs.marginTop), mr = pxNum(cs.marginRight), mb = pxNum(cs.marginBottom), ml = pxNum(cs.marginLeft);
    var pt = pxNum(cs.paddingTop), pr = pxNum(cs.paddingRight), pb = pxNum(cs.paddingBottom), pl = pxNum(cs.paddingLeft);
    var bt = pxNum(cs.borderTopWidth), br = pxNum(cs.borderRightWidth), bb = pxNum(cs.borderBottomWidth), bl = pxNum(cs.borderLeftWidth);

    if (!placeBoxClipped(ovSel, r.left, r.top, r.width, r.height)) {
      // Fully behind the panels — keep the margin/padding rings hidden too.
      ovMargin.style.display = 'none';
      ovPadding.style.display = 'none';
      placeLabel(ovLabel, r, elLabel(el, true));
      updateDims();
      return;
    }
    // Margin ring: a border-drawn frame around the margin box.
    if (mt || mr || mb || ml) {
      placeBoxClipped(ovMargin, r.left - ml, r.top - mt, r.width + ml + mr, r.height + mt + mb);
      ovMargin.style.borderWidth = mt + 'px ' + mr + 'px ' + mb + 'px ' + ml + 'px';
    } else ovMargin.style.display = 'none';
    // Padding ring: drawn inside the border box.
    if (pt || pr || pb || pl) {
      placeBoxClipped(ovPadding, r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);
      ovPadding.style.borderWidth = pt + 'px ' + pr + 'px ' + pb + 'px ' + pl + 'px';
    } else ovPadding.style.display = 'none';
    placeLabel(ovLabel, r, elLabel(el, true));
    updateDims();
  }

  function hoverHighlight(el) {
    if (!el || isOurs(el) || !el.getBoundingClientRect) { hoverClear(); return; }
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { hoverClear(); return; }
    if (!placeBoxClipped(ovHover, r.left, r.top, r.width, r.height)) {
      ovHoverLabel.style.display = 'none';
      return;
    }
    placeLabel(ovHoverLabel, r, elLabel(el, true));
  }
  function hoverClear() { ovHover.style.display = 'none'; ovHoverLabel.style.display = 'none'; }

  // -------------------------------------------------------------------------
  // Tree (left panel — Navigator)
  // -------------------------------------------------------------------------
  var treeRows = new WeakMap(); // element → its rendered row (for scrollIntoView)
  var filterKeep = null;        // WeakMap el → {keep, match} while filtering

  function shortText(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 26 ? t.slice(0, 26) + '…' : t;
  }

  function matchesFilter(el, q) {
    if (el.tagName.toLowerCase().indexOf(q) !== -1) return true;
    if (el.id && ('#' + el.id).toLowerCase().indexOf(q) !== -1) return true;
    var cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (cls && ('.' + cls).toLowerCase().indexOf(q) !== -1) return true;
    if (pageChildren(el).length === 0) {
      var t = (el.textContent || '').toLowerCase();
      if (t.indexOf(q) !== -1) return true;
    }
    return false;
  }

  var filterMatchCount = 0;

  /** Precompute which elements stay visible under the active filter:
   * keep = matches or has a matching descendant. */
  function computeFilter() {
    filterKeep = null;
    filterMatchCount = 0;
    var q = state.filter.trim().toLowerCase();
    if (!q) return;
    filterKeep = new WeakMap();
    function walk(el, depth) {
      if (depth > MAX_DEPTH || isOurs(el)) return false;
      var match = matchesFilter(el, q);
      if (match) filterMatchCount++;
      var childKeep = false;
      pageChildren(el).forEach(function (c) { if (walk(c, depth + 1)) childKeep = true; });
      var keep = match || childKeep;
      if (keep) filterKeep.set(el, { keep: true, match: match });
      return keep;
    }
    pageChildren(document.body).forEach(function (c) { walk(c, 0); });
  }

  function countPageElements() {
    var all = document.body.querySelectorAll('*');
    var n = 0;
    for (var i = 0; i < all.length; i++) if (!isOurs(all[i])) n++;
    return n;
  }

  function isElHidden(el) {
    try { return getComputedStyle(el).display === 'none'; } catch (e) { return false; }
  }

  function rowLabel(el) {
    var frag = document.createDocumentFragment();
    frag.appendChild(h('span', { class: 'tag', text: el.tagName.toLowerCase() }));
    if (el.id) frag.appendChild(h('span', { class: 'id', text: '#' + el.id }));
    var cls = (typeof el.className === 'string' && el.className)
      ? el.className.trim().split(/\s+/).slice(0, 2) : [];
    if (cls.length && cls[0]) frag.appendChild(h('span', { class: 'cls', text: '.' + cls.join('.') }));
    if (pageChildren(el).length === 0) {
      var s = shortText(el);
      if (s) frag.appendChild(h('span', { class: 'snip', text: ' “' + s + '”' }));
    }
    return frag;
  }

  function buildTreeRow(el, depth) {
    if (isOurs(el)) return null;
    var info = filterKeep ? filterKeep.get(el) : null;
    if (filterKeep && !info) return null;

    var kids = pageChildren(el);
    var hasKids = kids.length > 0;
    var open = filterKeep ? true : (hasKids && isOpen(el, depth));
    var hidden = isElHidden(el);

    var caret = h('span', { class: 'caret' }, hasKids ? [svgIcon(open ? 'chevD' : 'chevR')] : []);
    var cat = catFor(el);
    var row = h('div', {
      class: 'trow' + (el === state.selected ? ' sel' : '') + (hidden ? ' hid' : '') +
        (info && info.match ? ' hit' : ''),
    }, [caret, h('span', { class: 'cat ' + cat.cls }, [svgIcon(cat.icon)]),
      h('span', { class: 'flex1' }, [rowLabel(el)])]);
    row.style.paddingLeft = (6 + depth * 12) + 'px';

    // Right-side adornments: hide/show eye, collapsed child count.
    var inlineHidden = inlineVal(el, 'display') === 'none';
    if (hidden && inlineHidden) {
      var eyeBtn = h('span', { class: 'rbtn on', title: 'Show (removes inline display: none)' }, [svgIcon('eyeoff')]);
      pressable(eyeBtn, function (ev) {
        ev.stopPropagation();
        commitStyle(el, 'display', null, el.getAttribute('style'));
        rebuildTree();
      });
      eyeBtn.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
      row.appendChild(eyeBtn);
    } else if (!hidden) {
      var hideBtn = h('span', { class: 'rbtn', title: 'Hide (inline display: none)' }, [svgIcon('eye')]);
      pressable(hideBtn, function (ev) {
        ev.stopPropagation();
        commitStyle(el, 'display', 'none', el.getAttribute('style'));
        rebuildTree();
      });
      hideBtn.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
      row.appendChild(hideBtn);
    }
    if (hasKids && !open) row.appendChild(h('span', { class: 'nbadge', text: String(kids.length) }));

    treeRows.set(el, row);
    row.__veEl = el; // reverse lookup for tree-internal drag-and-drop
    state.navOrder.push(el);
    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      select(el);
    });
    row.addEventListener('mouseenter', function () { if (!drag) hoverHighlight(el); });
    row.addEventListener('mouseleave', hoverClear);
    // Dragging a tree row moves the element, same as dragging on the page.
    row.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      startPotentialDrag(el, ev.clientX, ev.clientY, true);
    });
    if (hasKids) {
      caret.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.open.set(el, !isOpen(el, depth));
        rebuildTree();
      });
      caret.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    }

    var wrap = h('div', {}, [row]);
    if (hasKids && open && depth < MAX_DEPTH) {
      var box = h('div', {});
      var cap = state.childLimit.get(el) || MAX_CHILDREN;
      var shown = 0;
      for (var i = 0; i < kids.length && shown < cap; i++) {
        var sub = buildTreeRow(kids[i], depth + 1);
        if (sub) { box.appendChild(sub); shown++; }
      }
      if (!filterKeep && kids.length > cap) {
        var more = h('div', { class: 'tmore', text: '… show ' + (kids.length - cap) + ' more' });
        more.addEventListener('click', function (ev) {
          ev.stopPropagation();
          state.childLimit.set(el, Infinity);
          rebuildTree();
        });
        box.appendChild(more);
      }
      wrap.appendChild(box);
    }
    return wrap;
  }

  function rebuildTree() {
    computeFilter();
    var total = countPageElements();
    treeCount.textContent = filterKeep ? filterMatchCount + '/' + total : String(total);
    state.navOrder = [];
    treeBox.textContent = '';
    var frag = document.createDocumentFragment();
    pageChildren(document.body).forEach(function (c) {
      var row = buildTreeRow(c, 0);
      if (row) frag.appendChild(row);
    });
    if (!frag.childNodes.length) {
      frag.appendChild(h('div', {
        class: 'tempty',
        text: state.filter ? 'No elements match “' + state.filter + '”' : 'Empty page',
      }));
    }
    treeBox.appendChild(frag);
  }

  function setAllOpen(value) {
    function walk(el, depth) {
      if (depth > MAX_DEPTH || isOurs(el)) return;
      var kids = pageChildren(el);
      if (kids.length) state.open.set(el, value);
      kids.forEach(function (c) { walk(c, depth + 1); });
    }
    pageChildren(document.body).forEach(function (c) { walk(c, 0); });
    rebuildTree();
  }
  expandAllBtn.addEventListener('click', function () { setAllOpen(true); });
  collapseAllBtn.addEventListener('click', function () { setAllOpen(false); });

  searchIn.addEventListener('input', function () {
    state.filter = searchIn.value;
    searchWrap.classList.toggle('has', !!state.filter);
    rebuildTree();
  });
  searchIn.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      searchIn.value = ''; state.filter = ''; searchWrap.classList.remove('has');
      rebuildTree(); searchIn.blur();
    }
  });
  pressable(searchClear, function () {
    searchIn.value = ''; state.filter = ''; searchWrap.classList.remove('has'); rebuildTree();
  });

  // -------------------------------------------------------------------------
  // Palette — builds itself from the project, never from a hard-coded list.
  //
  // Three sources, in usefulness order:
  //   1. This page. Any structure that appears more than once is, in practice,
  //      a component — so the page's own markup is the most accurate palette
  //      it can have. The first instance becomes the template.
  //   2. Primitives, so an empty page is not a dead end.
  //   3. The host project, via /__visual-editor/palette: shadcn/Radix/AI
  //      Elements/Kibo and the project's own components, discovered from
  //      package.json + components.json + what is actually on disk.
  // -------------------------------------------------------------------------
  var project = null;        // discovery payload, once it arrives
  var paletteOpen = false;

  var PRIMITIVES = [
    { name: 'Section', html: '<section>\n</section>' },
    { name: 'Container', html: '<div></div>' },
    { name: 'Heading', html: '<h2>Heading</h2>' },
    { name: 'Paragraph', html: '<p>Text</p>' },
    { name: 'Button', html: '<button type="button">Button</button>' },
    { name: 'Link', html: '<a href="#">Link</a>' },
    { name: 'Image', html: '<img src="" alt="">' },
    { name: 'List', html: '<ul>\n<li>Item</li>\n</ul>' },
    { name: 'Divider', html: '<hr>' },
  ];

  var MAX_TEMPLATE = 4000;

  function titleCase(s) {
    return String(s).split(/[-_]/).filter(Boolean)
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }

  /** Structures that repeat on this page, most-repeated first. */
  function derivePagePalette() {
    var groups = Object.create(null);
    var all = document.body.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (isOurs(el)) continue;
      var cls = typeof el.className === 'string' ? el.className.trim() : '';
      if (!cls) continue; // unclassed markup is too generic to be a "component"
      var key = el.tagName.toLowerCase() + '.' + cls.split(/\s+/).slice(0, 3).join('.');
      var g = groups[key];
      if (!g) {
        g = groups[key] = { key: key, el: el, count: 0, name: titleCase(cls.split(/\s+/)[0]) };
      }
      g.count++;
      // Prefer the richest instance as the template — a card with content is a
      // better starting point than an empty one.
      if (el.outerHTML.length > g.el.outerHTML.length && el.outerHTML.length <= MAX_TEMPLATE) g.el = el;
    }
    var out = [];
    for (var k in groups) {
      var it = groups[k];
      if (it.count < 2) continue;                        // once is not a pattern
      if (it.el.outerHTML.length > MAX_TEMPLATE) continue;
      out.push(it);
    }
    out.sort(function (a, b) {
      return (b.count - a.count) || (b.el.outerHTML.length - a.el.outerHTML.length);
    });
    return out.slice(0, 20);
  }

  function rootTagOf(html) {
    var m = /^\s*<\s*([a-zA-Z][\w:-]*)/.exec(html);
    return m ? m[1].toLowerCase() : 'div';
  }

  /**
   * Where a new `tag` should land relative to the selection.
   *
   * "Inside whatever can contain it" is the obvious rule and the wrong one:
   * with a card selected, adding a Card nested one card inside another. The
   * intent behind picking a palette item that matches your selection is nearly
   * always "another one of these", so same-tag goes beside, not within.
   */
  function insertTargetFor(tag, sel) {
    var body = document.body;
    if (!sel || !sel.isConnected || sel === body) {
      return { parent: body, index: pageChildren(body).length };
    }
    var selTag = sel.tagName.toLowerCase();
    var kids = pageChildren(sel);
    var hasText = (sel.textContent || '').trim() !== '';
    var isEmpty = kids.length === 0 && !hasText;
    // Go inside only for a genuine container of something else: a populated
    // wrapper (append alongside its children) or an empty one.
    if (selTag !== tag && canContain(selTag, tag) && (kids.length > 0 || isEmpty)) {
      return { parent: sel, index: kids.length };
    }
    var p = sel.parentElement;
    if (p && p !== document.documentElement && canContain(p.tagName.toLowerCase(), tag)) {
      return { parent: p, index: pageChildren(p).indexOf(sel) + 1 };
    }
    return { parent: body, index: pageChildren(body).length };
  }

  /**
   * Insert a snippet next to / inside the selection. The path is captured
   * before the DOM is touched, per the rule the rest of this file follows.
   */
  function insertSnippet(html, label) {
    var tag = rootTagOf(html);
    var target = insertTargetFor(tag, state.selected);
    var parent = target.parent, index = target.index;
    if (!canContain(parent.tagName.toLowerCase(), tag)) {
      setStatus('cannot put <' + tag + '> there', 'err');
      return;
    }

    var parentPath = elementPath(parent);   // BEFORE mutating
    if (!parentPath) { setStatus('cannot resolve insert target', 'err'); return; }

    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var node = tmp.firstElementChild;
    if (!node) { setStatus('nothing to insert', 'err'); return; }

    var sibs = pageChildren(parent);
    var ref = index < sibs.length ? sibs[index] : (parent === document.body ? host : null);
    var redo = function () { parent.insertBefore(node, ref); };
    var undo = function () { if (node.parentNode) node.parentNode.removeChild(node); };
    redo();

    var file = fileFor(parent);
    if (file) {
      sendEdit({ op: 'insert', file: file, parentPath: parentPath, index: index, html: html },
        { undo: undo, redo: redo });
    }
    select(node);
    setStatus('added ' + (label || tag), 'ok');
  }

  function palItem(label, meta, onPick, disabledWhy) {
    var row = h('div', { class: 'palitem' + (disabledWhy ? ' off' : ''), title: disabledWhy || ('Insert ' + label) }, [
      h('span', { class: 'nm', text: label }),
      meta ? h('span', { class: 'meta', text: meta }) : null,
    ]);
    if (!disabledWhy) pressable(row, onPick);
    return row;
  }

  function groupHead(title, n) {
    return h('div', { class: 'palgroup' }, [
      h('span', { text: title }),
      n != null ? h('span', { class: 'n', text: String(n) }) : null,
    ]);
  }

  function rebuildPalette() {
    palBody.textContent = '';

    var page = derivePagePalette();
    if (page.length) {
      palBody.appendChild(groupHead('ON THIS PAGE', page.length));
      page.forEach(function (g) {
        palBody.appendChild(palItem(g.name, '×' + g.count, function () {
          insertSnippet(g.el.outerHTML, g.name);
        }));
      });
    }

    palBody.appendChild(groupHead('ELEMENTS'));
    PRIMITIVES.forEach(function (p) {
      palBody.appendChild(palItem(p.name, null, function () { insertSnippet(p.html, p.name); }));
    });

    if (!project) return;
    // Component libraries only mean something in a file the editor can write
    // components into. Say so plainly rather than offering a dead button.
    var jsxReady = false; // set true when a JSX locator backs the current file
    var why = jsxReady ? null : 'Needs JSX file support — discovered, not yet insertable';

    (project.libraries || []).forEach(function (lib) {
      if (lib.headless || !lib.components || !lib.components.length) return;
      palBody.appendChild(groupHead(lib.label.toUpperCase(), lib.componentCount));
      lib.components.slice(0, 60).forEach(function (c) {
        palBody.appendChild(palItem(c.name, null, function () {}, why));
      });
    });

    var own = project.components || [];
    if (own.length) {
      palBody.appendChild(groupHead('PROJECT COMPONENTS', own.length));
      own.slice(0, 40).forEach(function (c) {
        palBody.appendChild(palItem(c.name, null, function () {}, why));
      });
    }

    var libs = (project.libraries || []).filter(function (l) { return l.headless || !l.componentCount; });
    if (libs.length) {
      palBody.appendChild(groupHead('ALSO INSTALLED'));
      palBody.appendChild(h('div', {
        class: 'palnote',
        text: libs.map(function (l) { return l.label; }).join(' · '),
      }));
    }
  }

  function setPaletteOpen(on) {
    paletteOpen = !!on;
    paletteBox.classList.toggle('show', paletteOpen);
    addBtn.classList.toggle('on', paletteOpen);
    if (paletteOpen) rebuildPalette();
  }
  addBtn.addEventListener('click', function () { setPaletteOpen(!paletteOpen); });

  /** Ask the server what the host project is made of. Entirely optional. */
  function loadProject() {
    fetch('/__visual-editor/palette', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (p) {
        if (!p || !p.ok) return;
        project = p;
        if (paletteOpen) rebuildPalette();
      })
      .catch(function () { /* discovery is a nicety; ignore */ });
  }

  // -------------------------------------------------------------------------
  // Breadcrumbs
  // -------------------------------------------------------------------------
  function rebuildCrumbs() {
    crumbsBar.textContent = '';
    var el = state.selected;
    if (!el || !el.isConnected) { crumbsBar.className = 've'; return; }
    crumbsBar.className = 've show';
    var chain = [];
    for (var n = el; n && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
    chain.forEach(function (node, i) {
      if (i) crumbsBar.appendChild(h('span', { class: 'crumbsep', text: '›' }));
      var c = h('span', { class: 'crumb' + (node === el ? ' cur' : '') }, [
        h('span', { text: node.tagName.toLowerCase() }),
        node.id ? h('span', { class: 'id', text: '#' + node.id }) : null,
      ]);
      c.addEventListener('click', function () { if (node !== document.body) select(node); });
      c.addEventListener('mouseenter', function () { hoverHighlight(node); });
      c.addEventListener('mouseleave', hoverClear);
      crumbsBar.appendChild(c);
    });
    crumbsBar.scrollLeft = crumbsBar.scrollWidth;
  }

  // -------------------------------------------------------------------------
  // Inspector — shared control builders
  // -------------------------------------------------------------------------
  var PROP_NAME_RE = /^[a-zA-Z-][a-zA-Z0-9-]*$/;
  // Mirrors ATTR_NAME_RE in server.cjs — reject locally so the user gets the
  // message immediately instead of an applied-then-rolled-back round trip.
  var ATTR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9\-_:.]*$/;
  // Mirrors RAW_TEXT_TAGS in server.cjs. (strSet is a hoisted declaration.)
  var RAW_TEXT_TAGS = strSet('script style textarea title xmp iframe noembed noframes plaintext');
  var dimsEl = null; // live W×H readout in the header

  function updateDims() {
    if (!dimsEl || !state.selected || !state.selected.isConnected) return;
    var r = state.selected.getBoundingClientRect();
    dimsEl.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
  }

  function section(title, build) {
    var open = title in state.sections ? state.sections[title] : !!DEFAULT_OPEN_SECTIONS[title];
    var body = h('div', { class: 'secbody' });
    var head = h('div', { class: 'sechead' }, [svgIcon('chevR'), h('span', { class: 't', text: title.toUpperCase() })]);
    var sec = h('div', { class: 'sec' + (open ? ' open' : '') }, [head, body]);
    head.addEventListener('click', function () {
      var now = !sec.classList.contains('open');
      sec.classList.toggle('open', now);
      state.sections[title] = now;
    });
    build(body);
    return sec;
  }

  function markSet(input, on) {
    var row = input.closest ? input.closest('.prow') : null;
    if (row) row.classList.toggle('set', !!on);
  }

  /** ±step keyboard handling + live preview + blur-commit for a text input
   * holding a CSS length. */
  function wireNumeric(el, input, session, prop, opts) {
    opts = opts || {};
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        var base = input.value.trim() || input.placeholder.trim();
        var delta = (ev.key === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
        var next = stepValue(base === 'auto' || base === '' || base === '—' ? '0px' : base, delta);
        if (next == null) return;
        ev.preventDefault();
        input.value = next;
        session.preview(prop, normalizeCss(next, opts.px !== false));
        markSet(input, true);
      } else if (ev.key === 'Enter') {
        input.blur();
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        session.cancel();
        input.value = inlineVal(el, prop);
        input.blur();
      }
    });
    input.addEventListener('focus', function () { session.start(); });
    input.addEventListener('input', function () {
      session.preview(prop, normalizeCss(input.value, opts.px !== false));
    });
    input.addEventListener('blur', function () {
      if (!session.isActive()) return;
      var v = normalizeCss(input.value, opts.px !== false);
      // Roll the preview back FIRST — only then does inlineVal read the true
      // pre-edit value the commit must be compared against.
      session.cancel();
      var was = inlineVal(el, prop);
      if (!cssValueOk(prop, v)) {
        setStatus('invalid ' + prop + ': ' + v, 'err');
        input.value = was;
        markSet(input, was !== '');
        return;
      }
      if (v !== was) session.commit(prop, v === '' ? null : v);
      markSet(input, v !== '');
      if (opts.after) opts.after();
    });
  }

  /** Label drag-to-scrub: horizontal drag adjusts the value 1px per px. */
  function makeScrub(label, input, sessionFactory, prop) {
    label.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      var startX = ev.clientX;
      var base = input.value.trim() || input.placeholder.trim();
      if (base === 'auto' || base === '' || base === '—' || stepValue(base, 0) == null) base = '0px';
      var moved = false;
      var session = sessionFactory();
      session.start();
      function onMove(e) {
        var dx = Math.round(e.clientX - startX);
        if (!moved && Math.abs(dx) < 2) return;
        moved = true;
        var next = stepValue(base, dx * (e.shiftKey ? 10 : 1));
        if (next == null) return;
        input.value = next;
        session.preview(prop, normalizeCss(next, true));
        markSet(input, true);
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (moved) session.commit(prop, normalizeCss(input.value, true));
        else session.cancel();
      }
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
  }

  function resetBtn(el, prop, after) {
    var b = h('span', { class: 'reset', title: 'Remove inline ' + prop }, [svgIcon('x')]);
    pressable(b, function () {
      commitStyle(el, prop, null, el.getAttribute('style'));
      if (after) after(); else rebuildProps();
    });
    return b;
  }

  /** One labeled CSS-length row: inline value editable, computed shown as
   * placeholder, ↑/↓ stepping, label scrubbing, reset ×. */
  function numRow(el, label, prop, opts) {
    opts = opts || {};
    var session = styleSession(el);
    var inline = inlineVal(el, prop);
    var input = h('input', { value: inline, placeholder: computedVal(el, prop) || '—', spellcheck: 'false' });
    var labelEl = h('span', { class: 'plabel', title: prop + ' — drag to scrub', text: label });
    wireNumeric(el, input, session, prop, opts);
    makeScrub(labelEl, input, function () { return styleSession(el); }, prop);
    return h('div', { class: 'prow' + (inline ? ' set' : '') },
      [labelEl, input, resetBtn(el, prop, opts.after)]);
  }

  /** Plain text row (no numeric stepping) for values like font-family. */
  function textStyleRow(el, label, prop) {
    var session = styleSession(el);
    var inline = inlineVal(el, prop);
    var input = h('input', { value: inline, placeholder: computedVal(el, prop) || '—', spellcheck: 'false' });
    input.addEventListener('focus', function () { session.start(); });
    input.addEventListener('input', function () { session.preview(prop, input.value.trim()); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') input.blur();
      else if (ev.key === 'Escape') { ev.stopPropagation(); session.cancel(); input.value = inlineVal(el, prop); input.blur(); }
    });
    input.addEventListener('blur', function () {
      if (!session.isActive()) return;
      var v = input.value.trim();
      session.cancel(); // revert preview before reading the pre-edit value
      var was = inlineVal(el, prop);
      if (!cssValueOk(prop, v)) {
        setStatus('invalid ' + prop + ': ' + v, 'err');
        input.value = was;
        markSet(input, was !== '');
        return;
      }
      if (v !== was) session.commit(prop, v === '' ? null : v);
      markSet(input, v !== '');
    });
    return h('div', { class: 'prow' + (inline ? ' set' : '') },
      [h('span', { class: 'plabel nodrag', title: prop, text: label }), input, resetBtn(el, prop)]);
  }

  /** <select> row committing on change. */
  function selectRow(el, label, prop, options, opts) {
    opts = opts || {};
    var inline = inlineVal(el, prop);
    var current = inline || computedVal(el, prop);
    var sel = h('select', {});
    var found = false;
    options.forEach(function (o) {
      var opt = h('option', { value: o, text: o });
      if (o === current) { opt.selected = true; found = true; }
      sel.appendChild(opt);
    });
    if (!found && current) {
      var extra = h('option', { value: current, text: current });
      extra.selected = true;
      sel.appendChild(extra);
    }
    sel.addEventListener('change', function () {
      commitStyle(el, prop, sel.value, el.getAttribute('style'));
      if (opts.after) opts.after(); else rebuildProps();
    });
    return h('div', { class: 'prow' + (inline ? ' set' : '') },
      [h('span', { class: 'plabel nodrag', title: prop, text: label }), sel, resetBtn(el, prop, opts.after)]);
  }

  /** Icon/label segmented control bound to one property.
   * options: [{v, icon?, label?, title, alt?}] — alt lists computed values
   * that should light the option up too (e.g. start ≈ flex-start). */
  function segRow(el, label, prop, options, opts) {
    opts = opts || {};
    var inline = inlineVal(el, prop);
    var current = inline || computedVal(el, prop);
    var seg = h('div', { class: 'seg' });
    options.forEach(function (o) {
      var b = h('button', { title: o.title || o.v }, o.icon ? [svgIcon(o.icon)] : [o.label || o.v]);
      if (o.v === current || (o.alt && o.alt.indexOf(current) !== -1)) b.classList.add('on');
      b.addEventListener('click', function () {
        // Clicking the active option with an inline value clears it back to
        // the stylesheet; otherwise the option becomes the inline value.
        var v = b.classList.contains('on') && inline ? null : o.v;
        commitStyle(el, prop, v, el.getAttribute('style'));
        if (opts.after) opts.after(); else rebuildProps();
      });
      seg.appendChild(b);
    });
    return h('div', { class: 'prow' + (inline ? ' set' : '') },
      [h('span', { class: 'plabel nodrag', title: prop, text: label }), seg]);
  }

  /** Color row: checkerboard swatch (native picker underneath) + text input. */
  function colorRow(el, label, prop) {
    var session = styleSession(el);
    var inline = inlineVal(el, prop);
    var computed = computedVal(el, prop);
    var current = inline || computed;
    var fill = h('span', { class: 'fill' });
    fill.style.background = current || 'transparent';
    var picker = h('input', { type: 'color', value: toHexColor(current) });
    var swatch = h('span', { class: 'swatch', title: 'Pick ' + prop }, [fill, picker]);
    var input = h('input', { value: inline, placeholder: computed || '—', spellcheck: 'false' });
    picker.addEventListener('input', function () {
      session.preview(prop, picker.value);
      input.value = picker.value;
      fill.style.background = picker.value;
      markSet(input, true);
    });
    picker.addEventListener('change', function () { session.commit(prop, picker.value); });
    input.addEventListener('focus', function () { session.start(); });
    input.addEventListener('input', function () {
      var v = input.value.trim();
      session.preview(prop, v);
      fill.style.background = v || computed;
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') input.blur();
      else if (ev.key === 'Escape') { ev.stopPropagation(); session.cancel(); input.value = inlineVal(el, prop); input.blur(); }
    });
    input.addEventListener('blur', function () {
      if (!session.isActive()) return;
      var v = input.value.trim();
      session.cancel(); // revert preview before reading the pre-edit value
      var was = inlineVal(el, prop);
      if (!cssValueOk(prop, v)) {
        setStatus('invalid ' + prop + ': ' + v, 'err');
        input.value = was;
        fill.style.background = was || computed;
        markSet(input, was !== '');
        return;
      }
      if (v !== was) session.commit(prop, v === '' ? null : v);
      markSet(input, v !== '');
    });
    return h('div', { class: 'prow' + (inline ? ' set' : '') },
      [h('span', { class: 'plabel nodrag', title: prop, text: label }), swatch, input, resetBtn(el, prop)]);
  }

  /** Shadow preset ladder (borrowed from openpath's inspector): named
   * box-shadow presets in a select; the raw row below covers custom values. */
  var SHADOW_PRESETS = [
    { label: 'none', v: 'none' },
    { label: 'subtle', v: '0 1px 2px rgba(0,0,0,.05)' },
    { label: 'soft', v: '0 4px 12px rgba(0,0,0,.1)' },
    { label: 'elevated', v: '0 12px 30px rgba(0,0,0,.16)' },
    { label: 'dramatic', v: '0 24px 60px rgba(0,0,0,.22)' },
    { label: 'inset', v: 'inset 0 2px 4px rgba(0,0,0,.06)' },
  ];

  var shadowProbe = h('div', {});

  /** Browsers re-serialize box-shadow (rgba first, px units) — normalize a
   * preset the same way so it still matches the stored inline value. */
  function normShadow(v) {
    shadowProbe.style.boxShadow = '';
    shadowProbe.style.boxShadow = v;
    return shadowProbe.style.boxShadow || v;
  }

  function shadowPresetRow(el) {
    var inline = inlineVal(el, 'box-shadow');
    var sel = h('select', {});
    var matched = false;
    SHADOW_PRESETS.forEach(function (p) {
      var opt = h('option', { value: p.v, text: p.label });
      if ((inline && (inline === p.v || inline === normShadow(p.v))) ||
          (!inline && p.v === 'none' && computedVal(el, 'box-shadow') === 'none')) {
        opt.selected = true; matched = true;
      }
      sel.appendChild(opt);
    });
    var custom = h('option', { value: '', text: 'custom…' });
    if (!matched) custom.selected = true;
    sel.appendChild(custom);
    sel.addEventListener('change', function () {
      if (sel.value === '') return; // "custom…" — edit via the raw row below
      // Picking "none" with no shadow anywhere is a no-op, not an edit.
      if (sel.value === 'none' && !inlineVal(el, 'box-shadow') &&
          computedVal(el, 'box-shadow') === 'none') return;
      commitStyle(el, 'box-shadow', sel.value, el.getAttribute('style'));
      rebuildProps();
    });
    return h('div', { class: 'prow' + (inline ? ' set' : '') },
      [h('span', { class: 'plabel nodrag', title: 'box-shadow', text: 'shadow' }), sel,
        resetBtn(el, 'box-shadow')]);
  }

  // -------------------------------------------------------------------------
  // Inspector — box model editor
  // -------------------------------------------------------------------------
  function bmField(el, prop, posCls) {
    var span = h('span', { class: 'bm-n ' + posCls + (inlineVal(el, prop) ? ' set' : ''), title: prop });
    function display() {
      var v = inlineVal(el, prop) || computedVal(el, prop);
      var n = parseFloat(v);
      span.textContent = isNaN(n) ? (v || '0') : String(Math.round(n * 10) / 10);
      span.classList.toggle('set', !!inlineVal(el, prop));
    }
    display();

    function openInput() {
      var session = styleSession(el);
      var input = h('input', {
        value: inlineVal(el, prop) || (Math.round(parseFloat(computedVal(el, prop)) || 0) + 'px'),
      });
      span.textContent = '';
      span.appendChild(input);
      input.focus(); input.select();
      input.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter') { input.blur(); }
        else if (ev.key === 'Escape') { session.cancel(); input.removeEventListener('blur', onBlur); display(); }
        else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          var delta = (ev.key === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
          var next = stepValue(input.value.trim() || '0px', delta);
          if (next == null) return;
          input.value = next;
          session.preview(prop, normalizeCss(next, true));
        }
      });
      input.addEventListener('input', function () { session.preview(prop, normalizeCss(input.value, true)); });
      function onBlur() {
        if (session.isActive()) {
          var v = normalizeCss(input.value, true);
          session.cancel(); // revert preview before reading the pre-edit value
          var was = inlineVal(el, prop);
          if (!cssValueOk(prop, v)) {
            setStatus('invalid ' + prop + ': ' + v, 'err');
          } else if (v !== was) {
            session.commit(prop, v === '' ? null : v);
          }
        }
        display();
      }
      input.addEventListener('blur', onBlur);
    }

    // Click edits in place; horizontal drag scrubs.
    span.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || span.querySelector('input')) return;
      ev.preventDefault();
      ev.stopPropagation();
      var startX = ev.clientX, moved = false;
      var session = styleSession(el);
      var baseN = parseFloat(inlineVal(el, prop) || computedVal(el, prop)) || 0;
      function onMove(e) {
        var dx = Math.round(e.clientX - startX);
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        var n = baseN + dx * (e.shiftKey ? 10 : 1);
        span.textContent = String(n);
        span.classList.add('set');
        session.preview(prop, n + 'px');
      }
      function onUp(e) {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (moved) {
          session.commit(prop, (baseN + Math.round(e.clientX - startX) * (e.shiftKey ? 10 : 1)) + 'px');
          display();
        } else {
          session.cancel();
          openInput();
        }
      }
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
    return span;
  }

  function buildBoxModel(el, body) {
    var core = h('div', { class: 'bm-core' });
    var r = el.getBoundingClientRect();
    core.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    var pad = h('div', { class: 'bm-pad' }, [
      h('span', { class: 'bm-tag', text: 'PADDING' }),
      bmField(el, 'padding-top', 'n-top'),
      bmField(el, 'padding-right', 'n-right'),
      bmField(el, 'padding-bottom', 'n-bottom'),
      bmField(el, 'padding-left', 'n-left'),
      core,
    ]);
    body.appendChild(h('div', { class: 'bm' }, [
      h('span', { class: 'bm-tag', text: 'MARGIN' }),
      bmField(el, 'margin-top', 'n-top'),
      bmField(el, 'margin-right', 'n-right'),
      bmField(el, 'margin-bottom', 'n-bottom'),
      bmField(el, 'margin-left', 'n-left'),
      pad,
    ]));
  }

  // -------------------------------------------------------------------------
  // Inspector — Design tab
  // -------------------------------------------------------------------------
  function buildDesignTab(el, box) {
    function relayout() { rebuildProps(); }

    box.appendChild(section('Layout', function (body) {
      body.appendChild(segRow(el, 'display', 'display', [
        { v: 'block', label: 'blk', title: 'block' },
        { v: 'flex', label: 'flex', title: 'flex' },
        { v: 'grid', label: 'grid', title: 'grid' },
        { v: 'inline-block', label: 'i-b', title: 'inline-block' },
        { v: 'inline', label: 'inl', title: 'inline' },
        { v: 'none', label: 'none', title: 'none' },
      ], { after: relayout }));
      var disp = inlineVal(el, 'display') || computedVal(el, 'display');
      if (/flex/.test(disp)) {
        body.appendChild(segRow(el, 'direction', 'flex-direction', [
          { v: 'row', icon: 'row', title: 'row' },
          { v: 'column', icon: 'col', title: 'column' },
        ], { after: relayout }));
        body.appendChild(segRow(el, 'justify', 'justify-content', [
          { v: 'flex-start', icon: 'jStart', title: 'flex-start', alt: ['start', 'normal'] },
          { v: 'center', icon: 'jCenter', title: 'center' },
          { v: 'space-between', icon: 'jBetween', title: 'space-between' },
          { v: 'flex-end', icon: 'jEnd', title: 'flex-end', alt: ['end'] },
        ]));
        body.appendChild(segRow(el, 'align', 'align-items', [
          { v: 'flex-start', icon: 'aStart', title: 'flex-start', alt: ['start'] },
          { v: 'center', icon: 'aCenter', title: 'center' },
          { v: 'stretch', icon: 'aStretch', title: 'stretch', alt: ['normal'] },
          { v: 'flex-end', icon: 'aEnd', title: 'flex-end', alt: ['end'] },
        ]));
        body.appendChild(segRow(el, 'wrap', 'flex-wrap', [
          { v: 'nowrap', label: 'nowrap', title: 'nowrap' },
          { v: 'wrap', label: 'wrap', title: 'wrap' },
        ]));
        body.appendChild(numRow(el, 'gap', 'gap'));
      } else if (/grid/.test(disp)) {
        body.appendChild(textStyleRow(el, 'columns', 'grid-template-columns'));
        body.appendChild(numRow(el, 'gap', 'gap'));
        body.appendChild(segRow(el, 'justify', 'justify-items', [
          { v: 'start', icon: 'jStart', title: 'start', alt: ['normal', 'legacy'] },
          { v: 'center', icon: 'jCenter', title: 'center' },
          { v: 'stretch', icon: 'aStretch', title: 'stretch' },
          { v: 'end', icon: 'jEnd', title: 'end' },
        ]));
      } else if (!/^(block|inline|inline-block|none)$/.test(disp)) {
        body.appendChild(h('div', { class: 'hint', text: 'computed: display ' + disp }));
      }
    }));

    box.appendChild(section('Spacing', function (body) {
      buildBoxModel(el, body);
    }));

    box.appendChild(section('Size', function (body) {
      body.appendChild(h('div', { class: 'grid2' }, [
        numRow(el, 'W', 'width'), numRow(el, 'H', 'height'),
        numRow(el, 'min W', 'min-width'), numRow(el, 'min H', 'min-height'),
        numRow(el, 'max W', 'max-width'), numRow(el, 'max H', 'max-height'),
      ]));
      body.appendChild(selectRow(el, 'overflow', 'overflow', ['visible', 'hidden', 'auto', 'scroll', 'clip']));
    }));

    box.appendChild(section('Position', function (body) {
      body.appendChild(selectRow(el, 'position', 'position',
        ['static', 'relative', 'absolute', 'fixed', 'sticky'], { after: relayout }));
      var pos = inlineVal(el, 'position') || computedVal(el, 'position');
      if (pos !== 'static') {
        body.appendChild(h('div', { class: 'grid2' }, [
          numRow(el, 'top', 'top'), numRow(el, 'right', 'right'),
          numRow(el, 'bottom', 'bottom'), numRow(el, 'left', 'left'),
        ]));
        body.appendChild(numRow(el, 'z-index', 'z-index', { px: false }));
      }
    }));

    box.appendChild(section('Typography', function (body) {
      body.appendChild(textStyleRow(el, 'family', 'font-family'));
      var weightRow = selectRow(el, 'weight', 'font-weight',
        ['100', '200', '300', '400', '500', '600', '700', '800', '900']);
      weightRow.querySelector('.plabel').style.width = '34px';
      body.appendChild(h('div', { class: 'grid2' }, [
        numRow(el, 'size', 'font-size'),
        weightRow,
        numRow(el, 'line', 'line-height', { px: false }),
        numRow(el, 'spacing', 'letter-spacing'),
      ]));
      body.appendChild(colorRow(el, 'color', 'color'));
      body.appendChild(segRow(el, 'align', 'text-align', [
        { v: 'left', icon: 'alignL', title: 'left', alt: ['start'] },
        { v: 'center', icon: 'alignC', title: 'center' },
        { v: 'right', icon: 'alignR', title: 'right', alt: ['end'] },
        { v: 'justify', icon: 'alignJ', title: 'justify' },
      ]));
      body.appendChild(segRow(el, 'style', 'font-style', [
        { v: 'normal', label: 'reg', title: 'normal' },
        { v: 'italic', label: 'italic', title: 'italic' },
      ]));
      body.appendChild(selectRow(el, 'transform', 'text-transform',
        ['none', 'uppercase', 'lowercase', 'capitalize']));
      body.appendChild(selectRow(el, 'decoration', 'text-decoration-line',
        ['none', 'underline', 'line-through', 'overline']));
    }));

    box.appendChild(section('Background', function (body) {
      body.appendChild(colorRow(el, 'color', 'background-color'));
      var bgi = computedVal(el, 'background-image');
      if (bgi && bgi !== 'none') {
        body.appendChild(h('div', { class: 'hint', title: bgi, text: 'image: ' + bgi }));
      }
    }));

    box.appendChild(section('Border', function (body) {
      var styleRow2 = selectRow(el, 'style', 'border-style',
        ['none', 'solid', 'dashed', 'dotted', 'double']);
      styleRow2.querySelector('.plabel').style.width = '34px';
      body.appendChild(h('div', { class: 'grid2' }, [
        numRow(el, 'width', 'border-width'),
        styleRow2,
      ]));
      body.appendChild(colorRow(el, 'color', 'border-color'));
      body.appendChild(numRow(el, 'radius', 'border-radius'));
    }));

    box.appendChild(section('Effects', function (body) {
      // Opacity slider (0–100%) with live preview.
      var session = styleSession(el);
      var current = parseFloat(inlineVal(el, 'opacity') || computedVal(el, 'opacity'));
      if (isNaN(current)) current = 1;
      var slider = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(current * 100)) });
      var pct = h('span', { class: 'plabel nodrag', text: Math.round(current * 100) + '%' });
      pct.style.width = '32px'; pct.style.textAlign = 'right';
      slider.style.setProperty('--fill', Math.round(current * 100) + '%');
      slider.addEventListener('input', function () {
        pct.textContent = slider.value + '%';
        slider.style.setProperty('--fill', slider.value + '%');
        session.preview('opacity', String(+slider.value / 100));
      });
      slider.addEventListener('change', function () {
        session.commit('opacity', String(+slider.value / 100));
      });
      body.appendChild(h('div', { class: 'prow' + (inlineVal(el, 'opacity') ? ' set' : '') }, [
        h('span', { class: 'plabel nodrag', text: 'opacity' }), slider, pct,
        resetBtn(el, 'opacity'),
      ]));
      body.appendChild(shadowPresetRow(el));
      body.appendChild(textStyleRow(el, 'custom', 'box-shadow'));
      body.appendChild(selectRow(el, 'cursor', 'cursor',
        ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'not-allowed']));
    }));
  }

  // -------------------------------------------------------------------------
  // Inspector — Element tab
  // -------------------------------------------------------------------------
  function buildElementTab(el, box) {
    var file = fileFor(el);

    box.appendChild(section('Identity', function (body) {
      var idIn = h('input', { value: el.id || '', placeholder: 'none', spellcheck: 'false' });
      idIn.addEventListener('change', function () {
        var v = idIn.value.trim();
        var inv = attrInverse(el, 'id');
        var redo = function () { if (v) el.id = v; else el.removeAttribute('id'); };
        redo();
        if (file) sendEdit(opFor(el, { op: 'setAttr', name: 'id', value: v || null }),
          { undo: inv.undo, redo: redo });
        rebuildTree(); rebuildCrumbs(); refreshOverlays();
      });
      body.appendChild(h('div', { class: 'prow' },
        [h('span', { class: 'plabel nodrag', text: 'id' }), idIn]));
    }));

    box.appendChild(section('Classes', function (body) {
      var chips = h('div', { class: 'chips' });
      function classList() {
        var raw = el.getAttribute('class') || '';
        return raw.trim() ? raw.trim().split(/\s+/) : [];
      }
      function commitClasses(list) {
        var v = list.join(' ');
        var inv = attrInverse(el, 'class');
        var redo = function () { if (v) el.setAttribute('class', v); else el.removeAttribute('class'); };
        redo();
        if (file) sendEdit(opFor(el, { op: 'setAttr', name: 'class', value: v || null }),
          { undo: inv.undo, redo: redo });
        renderChips();
        rebuildTree(); refreshOverlays();
      }
      function renderChips() {
        chips.textContent = '';
        classList().forEach(function (cls) {
          var rm = h('span', { class: 'rm', title: 'Remove .' + cls }, [svgIcon('x')]);
          pressable(rm, function () {
            commitClasses(classList().filter(function (c) { return c !== cls; }));
          });
          chips.appendChild(h('span', { class: 'chip' }, [cls, rm]));
        });
      }
      renderChips();
      var addIn = h('input', { placeholder: 'add class + ⏎', spellcheck: 'false' });
      addIn.style.marginTop = '6px';
      addIn.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var v = addIn.value.trim().replace(/^\./, '');
        if (!v) return;
        var list = classList();
        if (list.indexOf(v) === -1) commitClasses(list.concat(v));
        addIn.value = '';
      });
      body.appendChild(chips);
      body.appendChild(addIn);
    }));

    // Raw-text elements (<style>, <script>, <textarea>, <title>) are never
    // entity-decoded, so writing escaped text into them corrupts their
    // contents — `a > b` would land as `a &gt; b`. The server refuses these;
    // don't offer the editor in the first place.
    if (pageChildren(el).length === 0 && !RAW_TEXT_TAGS[el.tagName.toLowerCase()]) {
      box.appendChild(section('Text', function (body) {
        var ta = h('textarea', { text: el.textContent, spellcheck: 'false' });
        function autosize() {
          ta.style.height = 'auto';
          ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px';
        }
        ta.addEventListener('input', autosize);
        setTimeout(autosize, 0);
        ta.addEventListener('change', function () {
          var oldText = el.textContent;
          var newText = ta.value;
          var dom = {
            undo: function () { el.textContent = oldText; },
            redo: function () { el.textContent = newText; },
          };
          dom.redo();
          if (file) sendEdit(opFor(el, { op: 'setText', text: newText }), dom);
          rebuildTree(); refreshOverlays();
        });
        body.appendChild(ta);
      }));
    }

    box.appendChild(section('Attributes', function (body) {
      Array.prototype.forEach.call(el.attributes, function (a) {
        if (a.name === 'class' || a.name === 'style' || a.name === 'id') return;
        if (a.name.indexOf('data-ve-') === 0) return;
        body.appendChild(attrRow(el, a.name, a.value));
      });
      var addBtn = h('button', { class: 'mini', text: '+ attribute' });
      addBtn.style.marginTop = '8px';
      addBtn.addEventListener('click', function () {
        body.insertBefore(attrRow(el, '', ''), addBtn);
      });
      body.appendChild(addBtn);
    }));

    box.appendChild(section('Inline CSS', function (body) {
      for (var i = 0; i < el.style.length; i++) {
        var p = el.style[i];
        body.appendChild(styleRow(el, p, el.style.getPropertyValue(p)));
      }
      var addBtn = h('button', { class: 'mini', text: '+ property' });
      addBtn.style.marginTop = '8px';
      addBtn.addEventListener('click', function () {
        body.insertBefore(styleRow(el, '', ''), addBtn);
      });
      body.appendChild(addBtn);
    }));
  }

  function attrRow(el, name, value) {
    var nameIn = h('input', { value: name, placeholder: 'name', spellcheck: 'false' });
    var valIn = h('input', { value: value, placeholder: 'value', spellcheck: 'false' });
    nameIn.style.flex = '0 0 40%';
    // The name this row currently owns on the element. Renaming has to drop
    // the old attribute, or the element keeps both the old and the new one.
    var owned = name || '';
    function commit() {
      var n = nameIn.value.trim();
      if (!n) return;
      if (!ATTR_NAME_RE.test(n)) { setStatus('invalid attribute name: ' + n, 'err'); return; }
      if (owned && owned !== n) {
        var prev = owned;
        var prevInv = attrInverse(el, prev);
        var prevRedo = function () { el.removeAttribute(prev); };
        prevRedo();
        if (fileFor(el)) sendEdit(opFor(el, { op: 'setAttr', name: prev, value: null }),
          { undo: prevInv.undo, redo: prevRedo });
      }
      var inv = attrInverse(el, n);
      var redo = function () { el.setAttribute(n, valIn.value); };
      redo();
      owned = n;
      if (fileFor(el)) sendEdit(opFor(el, { op: 'setAttr', name: n, value: valIn.value }),
        { undo: inv.undo, redo: redo });
    }
    valIn.addEventListener('change', commit);
    nameIn.addEventListener('change', commit);
    var rm = h('span', { class: 'reset', title: 'Remove attribute' }, [svgIcon('x')]);
    rm.style.display = 'inline-flex';
    pressable(rm, function () {
      // Remove what the element actually carries, not a half-typed rename.
      var n = owned || nameIn.value.trim();
      if (n) {
        var inv = attrInverse(el, n);
        var redo = function () { el.removeAttribute(n); };
        redo();
        if (fileFor(el)) sendEdit(opFor(el, { op: 'setAttr', name: n, value: null }),
          { undo: inv.undo, redo: redo });
      }
      rm.parentElement.remove();
    });
    return h('div', { class: 'prow' }, [nameIn, valIn, rm]);
  }

  function styleRow(el, prop, value) {
    var propIn = h('input', { value: prop, placeholder: 'property', spellcheck: 'false' });
    var valIn = h('input', { value: value, placeholder: 'value', spellcheck: 'false' });
    propIn.style.flex = '0 0 40%';
    var owned = prop || ''; // the declaration this row currently owns
    function commit() {
      var p = propIn.value.trim();
      if (!PROP_NAME_RE.test(p)) { setStatus('error: bad property name', 'err'); return; }
      var v = valIn.value.trim();
      // Same draft guard the Design tab applies: setProperty silently drops an
      // invalid value, so without this the DOM shows nothing while the source
      // file gets the broken declaration written into it.
      if (!cssValueOk(p, v)) { setStatus('invalid ' + p + ': ' + v, 'err'); return; }
      if (owned && owned !== p) {
        var prev = owned;
        var prevInv = attrInverse(el, 'style');
        var prevRedo = function () { el.style.removeProperty(prev); };
        prevRedo();
        if (fileFor(el)) sendEdit(opFor(el, { op: 'setStyle', property: prev, value: null }),
          { undo: prevInv.undo, redo: prevRedo });
      }
      var inv = attrInverse(el, 'style'); // declaration-level undo = restore whole attr
      var redo = function () { el.style.setProperty(p, v); };
      redo();
      owned = p;
      if (fileFor(el)) sendEdit(opFor(el, { op: 'setStyle', property: p, value: v }),
        { undo: inv.undo, redo: redo });
      refreshOverlays();
    }
    valIn.addEventListener('change', commit);
    propIn.addEventListener('change', commit);
    var rm = h('span', { class: 'reset', title: 'Remove property' }, [svgIcon('x')]);
    rm.style.display = 'inline-flex';
    pressable(rm, function () {
      var p = owned || propIn.value.trim();
      if (p && PROP_NAME_RE.test(p)) {
        var inv = attrInverse(el, 'style');
        var redo = function () { el.style.removeProperty(p); };
        redo();
        if (fileFor(el)) sendEdit(opFor(el, { op: 'setStyle', property: p, value: null }),
          { undo: inv.undo, redo: redo });
      }
      rm.parentElement.remove();
      refreshOverlays();
    });
    return h('div', { class: 'prow' }, [propIn, valIn, rm]);
  }

  // -------------------------------------------------------------------------
  // Inspector — assembly
  // -------------------------------------------------------------------------
  function rebuildProps() {
    propsBox.textContent = '';
    elTag.textContent = '';
    fileChip.textContent = '';
    dimsEl = null;
    var el = state.selected;
    if (!el || !el.isConnected) {
      tabsRow.style.display = 'none';
      propsBox.appendChild(h('div', { class: 'empty-state' }, [
        svgIcon('crosshair'),
        h('div', {}, [
          'Nothing selected.', h('br'),
          'Click anything on the page,', h('br'),
          'or pick from the Navigator.',
        ]),
      ]));
      return;
    }
    tabsRow.style.display = 'flex';

    // Header chip: tag #id .class + live dims
    elTag.appendChild(h('span', { class: 'tag', text: el.tagName.toLowerCase() }));
    if (el.id) elTag.appendChild(h('span', { class: 'id', text: '#' + el.id }));
    var cls = (typeof el.className === 'string' && el.className)
      ? el.className.trim().split(/\s+/).slice(0, 1) : [];
    if (cls.length && cls[0]) elTag.appendChild(h('span', { class: 'cls', text: '.' + cls[0] }));
    dimsEl = h('span', { class: 'dims' });
    elTag.appendChild(dimsEl);
    updateDims();
    var file = fileFor(el);
    fileChip.textContent = file;
    fileChip.title = file;

    if (state.tab === 'design') buildDesignTab(el, propsBox);
    else buildElementTab(el, propsBox);
  }

  designTabBtn.addEventListener('click', function () {
    state.tab = 'design';
    designTabBtn.classList.add('on'); elementTabBtn.classList.remove('on');
    rebuildProps();
  });
  elementTabBtn.addEventListener('click', function () {
    state.tab = 'element';
    elementTabBtn.classList.add('on'); designTabBtn.classList.remove('on');
    rebuildProps();
  });

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------
  function select(el) {
    if (!el || isOurs(el)) return;
    if (el === document.documentElement || el === document.body) return;
    state.selected = el;
    // Expand every collapsed ancestor so the selected row is actually
    // rendered, then scroll it into view inside the tree panel.
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      state.open.set(p, true);
    }
    rebuildTree();
    rebuildProps();
    rebuildCrumbs();
    refreshOverlays();
    var row = treeRows.get(el);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function deselect() {
    state.selected = null;
    rebuildTree(); rebuildProps(); rebuildCrumbs(); hideSelOverlays();
  }

  // -------------------------------------------------------------------------
  // Select mode (crosshair) — capture-phase listeners on the document
  // -------------------------------------------------------------------------
  function onHover(ev) {
    if (isOurs(ev.target)) { hoverClear(); return; }
    hoverHighlight(ev.target);
  }
  function onClickCapture(ev) {
    // Swallow the click that follows a completed drag.
    if (suppressClick) {
      suppressClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!selMode()) return;
    if (isOurs(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Select mode stays on: keep clicking to select other elements.
    select(ev.target);
  }
  function onDblClick(ev) {
    if (isOurs(ev.target) || selMode()) return;
    ev.preventDefault();
    ev.stopPropagation();
    select(ev.target);
  }
  /** Effective mode: the persistent toggle, inverted while MODE_KEY is held. */
  function selMode() { return state.selectMode !== state.modeKeyHeld; }

  function refreshModeUI() {
    var on = selMode();
    selectBtn.className = on ? 'on' : '';
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    // Handing the page back means tidying up after ourselves: every overlay
    // the editor put on the canvas comes off. Going the other way repaints
    // them for the current selection.
    if (on) refreshOverlays();
    else clearCanvasOverlays();
  }

  function setSelectMode(on) {
    state.selectMode = on;
    refreshModeUI();
  }

  // Momentary mode invert: hold to browse the page while editing, or hold to
  // edit while browsing. Release returns to the toggled mode.
  //
  // This has to be a key the page itself has no use for. Space was wrong: it
  // scrolls, so holding it to "test the live page" fought the page, and a
  // plain Space tap while browsing went to the editor instead of scrolling.
  // A bare modifier types nothing, scrolls nothing, and is the usual
  // "temporarily switch tool" idiom in design tools. Change it here.
  function onModeKeyDown(ev) {
    if (ev.key !== MODE_KEY || ev.repeat || typingTarget() || editorFocused()) return;
    state.modeKeyHeld = true;
    // Stops a lone Alt press from focusing the browser menu bar on Windows.
    // Alt+<key> combinations are unaffected — those arrive as their own events.
    ev.preventDefault();
    refreshModeUI();
  }
  function onModeKeyUp(ev) {
    if (ev.key !== MODE_KEY || !state.modeKeyHeld) return;
    state.modeKeyHeld = false;
    refreshModeUI();
  }
  // Losing focus mid-hold (alt-tab, devtools, …) must not stick the invert.
  function onWindowBlur() {
    if (!state.modeKeyHeld) return;
    state.modeKeyHeld = false;
    refreshModeUI();
  }

  // -------------------------------------------------------------------------
  // Toolbar actions
  // -------------------------------------------------------------------------
  selectBtn.addEventListener('click', function () { setSelectMode(!state.selectMode); });

  function move(dir) {
    var el = state.selected;
    if (!el) return;
    var parent = el.parentElement;
    if (!parent) return;
    var sibs = pageChildren(parent);
    var i = sibs.indexOf(el);
    var canMove = i >= 0 && ((dir === 'up' && i > 0) || (dir === 'down' && i < sibs.length - 1));
    if (!canMove) return;
    // Capture the op (and its source path) BEFORE touching the DOM — the path
    // must describe the source file's current element order, not the new one.
    var op = fileFor(el) ? opFor(el, { op: 'move', direction: dir }) : null;
    var inv = moveInverse(el);
    var redo = dir === 'up'
      ? function () { parent.insertBefore(el, sibs[i - 1]); }
      : function () { parent.insertBefore(sibs[i + 1], el); };
    redo();
    if (op) sendEdit(op, { undo: inv.undo, redo: redo });
    rebuildTree(); refreshOverlays();
  }
  upBtn.addEventListener('click', function () { move('up'); });
  downBtn.addEventListener('click', function () { move('down'); });

  function deleteSelected() {
    var el = state.selected;
    if (!el) return;
    var name = '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '>';
    var op = fileFor(el) ? opFor(el, { op: 'remove' }) : null;
    var inv = moveInverse(el); // captures parent + next sibling before removal
    var redo = function () { el.remove(); };
    var dom = { undo: function () { inv.undo(); }, redo: redo };
    redo();
    state.selected = null;
    if (op) sendEdit(op, dom);
    else setStatus('deleted ' + name + ' — undo with ⌘Z', 'ok');
    refreshAll();
  }
  delBtn.addEventListener('click', deleteSelected);

  // -------------------------------------------------------------------------
  // Resizable panels — widths live in CSS custom properties on the host, so
  // the panels, the breadcrumb strip and (when docked) the page margins all
  // follow one number each.
  // -------------------------------------------------------------------------
  function applyPanelWidths() {
    host.style.setProperty('--leftw', prefs.leftW + 'px');
    host.style.setProperty('--rightw', prefs.rightW + 'px');
    if (state.docked) setDocked(true); // re-push the page to the new widths
    refreshOverlays();
  }

  function wireGrip(grip, side) {
    grip.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      grip.classList.add('on');
      var startX = ev.clientX;
      var startW = side === 'left' ? prefs.leftW : prefs.rightW;
      // The page must not text-select while the pointer is being dragged.
      setNoSelect(true);
      function onMove(e) {
        var dx = e.clientX - startX;
        if (side === 'left') prefs.leftW = clampLeftW(startW + dx);
        else prefs.rightW = clampRightW(startW - dx);
        applyPanelWidths();
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        grip.classList.remove('on');
        setNoSelect(false);
        savePrefs();
      }
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
    grip.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (side === 'left') prefs.leftW = clampLeftW(DEFAULT_LEFT_W);
      else prefs.rightW = clampRightW(DEFAULT_RIGHT_W);
      applyPanelWidths();
      savePrefs();
    });
  }
  wireGrip(leftGrip, 'left');
  wireGrip(rightGrip, 'right');

  function setDocked(on) {
    state.docked = on;
    dockBtn.className = on ? 'on' : '';
    var s = document.documentElement.style;
    if (on) {
      s.setProperty('margin-left', prefs.leftW + 'px', 'important');
      s.setProperty('margin-right', prefs.rightW + 'px', 'important');
      s.setProperty('margin-bottom', (BAR_H + CRUMB_H) + 'px', 'important');
    } else {
      s.removeProperty('margin-left');
      s.removeProperty('margin-right');
      s.removeProperty('margin-bottom');
    }
    refreshOverlays();
  }
  dockBtn.addEventListener('click', function () { setDocked(!state.docked); });

  function setLivePreview(on) {
    prefs.livePreview = !!on;
    liveBtn.className = prefs.livePreview ? 'on' : '';
    // Turning it off mid-drag must put the page back immediately.
    if (!prefs.livePreview) endLayoutPreview();
    savePrefs();
  }
  liveBtn.addEventListener('click', function () { setLivePreview(!prefs.livePreview); });

  closeBtn.addEventListener('click', function () { api.disable(); });
  undoBtn.addEventListener('click', function () { doUndo(); });

  // -------------------------------------------------------------------------
  // Keyboard navigation — tree walking, delete, escape, select-mode toggle
  // -------------------------------------------------------------------------
  function typingTarget() {
    var ae = document.activeElement;
    if (ae === host) ae = host.shadowRoot.activeElement;
    return ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
      ae.tagName === 'SELECT' || ae.isContentEditable) ? ae : null;
  }

  /** Keyboard focus is on one of the editor's own controls. Page-level
   * shortcuts (Backspace-deletes-element, MODE_KEY-inverts-mode) must not fire
   * while the user is driving the panels with the keyboard. */
  function editorFocused() {
    return document.activeElement === host && !!host.shadowRoot.activeElement;
  }

  function onNavKey(ev) {
    if (drag) return;
    if (typingTarget() || editorFocused()) return;
    var el = state.selected;
    if (ev.key === 'Escape') {
      // Select mode is sticky: Esc clears the filter, then the selection,
      // and only drops into browse mode when there is nothing left to clear.
      if (state.filter) {
        searchIn.value = ''; state.filter = ''; searchWrap.classList.remove('has');
        rebuildTree(); ev.preventDefault(); return;
      }
      if (el) { deselect(); ev.preventDefault(); return; }
      if (selMode()) { setSelectMode(false); ev.preventDefault(); }
      return;
    }
    if ((ev.key === 'v' || ev.key === 'V') && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      setSelectMode(!state.selectMode);
      ev.preventDefault();
      return;
    }
    if (!el) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      deleteSelected();
      return;
    }
    var order = state.navOrder;
    var idx = order.indexOf(el);
    if (ev.key === 'ArrowUp' && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      if (idx > 0) select(order[idx - 1]);
    } else if (ev.key === 'ArrowDown' && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      if (idx !== -1 && idx < order.length - 1) select(order[idx + 1]);
    } else if (ev.key === 'ArrowRight' && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      var kids = pageChildren(el);
      if (!kids.length) return;
      if (!treeRows.get(kids[0])) { state.open.set(el, true); rebuildTree(); }
      else select(kids[0]);
    } else if (ev.key === 'ArrowLeft' && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      var kids2 = pageChildren(el);
      if (kids2.length && treeRows.get(kids2[0])) {
        state.open.set(el, false); rebuildTree();
      } else if (el.parentElement && el.parentElement !== document.body) {
        select(el.parentElement);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Drag-and-drop repositioning (pointer events, no HTML5 DnD)
  // -------------------------------------------------------------------------

  // -- Validity rules ---------------------------------------------------------
  var VOID_TAGS = strSet('area base br col embed hr img input link meta source track wbr');
  // Elements that never accept editor-managed children.
  var NO_CHILD_TAGS = strSet('svg canvas iframe script style textarea object');
  var PHRASING_PARENTS = strSet('p h1 h2 h3 h4 h5 h6 span a button label em strong small code abbr cite');
  var BLOCK_CHILDREN = strSet(
    'div section article aside header footer nav main ul ol dl table form fieldset figure blockquote pre h1 h2 h3 h4 h5 h6 hr address'
  );
  function strSet(s) {
    var o = {};
    s.split(/\s+/).forEach(function (t) { o[t] = true; });
    return o;
  }

  /** Structural parent/child validity (simplified HTML content model). */
  function canContain(parentTag, childTag) {
    var p = String(parentTag).toLowerCase();
    var c = String(childTag).toLowerCase();
    if (p === 'html' || p === 'head') return false;
    if (c === 'html' || c === 'head' || c === 'body') return false;
    if (VOID_TAGS[p] || NO_CHILD_TAGS[p]) return false;
    if (p === 'select') return c === 'option' || c === 'optgroup';
    if (c === 'option' || c === 'optgroup') return p === 'select' || p === 'datalist';
    if (c === 'li') return p === 'ul' || p === 'ol' || p === 'menu';
    if (p === 'ul' || p === 'ol' || p === 'menu') return c === 'li' || c === 'script' || c === 'template';
    if (c === 'tr') return p === 'table' || p === 'tbody' || p === 'thead' || p === 'tfoot';
    if (c === 'td' || c === 'th') return p === 'tr';
    if (p === 'tr') return c === 'td' || c === 'th' || c === 'script' || c === 'template';
    if (c === 'thead' || c === 'tbody' || c === 'tfoot' || c === 'caption' || c === 'colgroup') {
      return p === 'table';
    }
    if (PHRASING_PARENTS[p] && BLOCK_CHILDREN[c]) return false;
    return true;
  }

  function canDrag(el) {
    var t = el.tagName.toLowerCase();
    return t !== 'html' && t !== 'head' && t !== 'body';
  }

  // -- Drag state ---------------------------------------------------------------
  // A press on a tree row can only mean "drag", so it arms quickly. A press on
  // the page is usually a click — in select mode it IS the select gesture — so
  // it demands enough travel to be unambiguous. Ordinary trackpad jitter must
  // never reach the threshold: a drop rewrites the source file.
  var DRAG_THRESHOLD = 4;
  var PAGE_DRAG_THRESHOLD = 12;
  // Re-evaluate the drop target only after the pointer has genuinely travelled
  // this far, and at most once per frame. Our own reflow moves the page under
  // a stationary pointer; without this gate that counts as "the pointer is
  // somewhere new" and the preview chases itself.
  var CANDIDATE_STEP = 5;
  var SWAP_MARGIN = 6;
  // Pointer travel required before a committed drop slot may change.
  var RELOCATE_MIN = 18;
  var previewRaf = 0;
  function dragThreshold() { return drag && drag.fromTree ? DRAG_THRESHOLD : PAGE_DRAG_THRESHOLD; }
  var drag = null;          // { el, startX, startY, lastX, lastY, active, candidate }
  var dragScrollTimer = null;
  var suppressClick = false;
  var noSelectStyle = null;
  var ghost = null;

  function setNoSelect(on) {
    if (on && !noSelectStyle) {
      noSelectStyle = h('style', { text: '* { user-select: none !important; }' });
      document.head.appendChild(noSelectStyle);
    } else if (!on && noSelectStyle) {
      noSelectStyle.remove();
      noSelectStyle = null;
    }
  }

  // -- Realtime drag ghost ------------------------------------------------------
  // Lives in the page DOM (tagged data-ve-editor-el so it is excluded from
  // trees/paths) so the clone keeps the page's own CSS.
  function showGhost(el, x, y) {
    hideGhost();
    ghost = document.createElement('div');
    ghost.setAttribute('data-ve-editor-el', '');
    ghost.style.cssText =
      'position:fixed;z-index:2147482998;pointer-events:none;opacity:.65;' +
      'outline:2px solid #4f9cf9;border-radius:3px;background:rgba(11,13,18,.45);max-width:45vw;' +
      'max-height:45vh;overflow:hidden;margin:0;box-shadow:0 12px 40px rgba(0,0,0,.5);';
    ghost.appendChild(el.cloneNode(true));
    document.body.appendChild(ghost);
    moveGhost(x, y);
  }
  function moveGhost(x, y) {
    if (!ghost) return;
    ghost.style.left = (x + 14) + 'px';
    ghost.style.top = (y + 14) + 'px';
  }
  function hideGhost() {
    if (ghost) { ghost.remove(); ghost = null; }
  }

  // -- Live layout preview ------------------------------------------------------
  // Instead of only drawing a line where the element *would* land, put a real
  // box of the element's exact size into the page at that spot and hide the
  // original. The page reflows for real, so you see the actual result — the
  // gap closing where it left, everything downstream shifting up, the target
  // container growing — while you are still dragging.
  //
  // The placeholder carries data-ve-editor-el, so isOurs() filters it out of
  // pageChildren() and therefore out of every element path and index. The
  // source-of-truth walk never sees it and the op maths is untouched.
  var placeholder = null;

  /** Absolutely/fixed-positioned elements are out of flow: hiding one frees no
   * space and a block placeholder would invent space that never existed, so
   * the preview would be a lie. Fall back to the plain marker for those. */
  function canPreviewLayout(el) {
    if (!prefs.livePreview) return false;
    var pos = computedVal(el, 'position');
    return pos !== 'absolute' && pos !== 'fixed';
  }

  function buildPlaceholder(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var ph = document.createElement('div');
    ph.setAttribute('data-ve-editor-el', '');
    // Deliberately hit-testable: elementFromPoint returning the stand-in is how
    // computeCandidate recognises "the pointer is already over the drop slot".
    // With pointer-events:none it would return whatever sits behind instead —
    // usually the parent container — and the stand-in would jump away from the
    // very spot the user is pointing at.
    ph.style.cssText = [
      'box-sizing:border-box',
      'width:' + r.width + 'px',
      'height:' + r.height + 'px',
      'margin:' + cs.marginTop + ' ' + cs.marginRight + ' ' + cs.marginBottom + ' ' + cs.marginLeft,
      'flex:0 0 auto',
      'align-self:' + (cs.alignSelf || 'auto'),
      'border:1.5px dashed rgba(79,156,249,.9)',
      'border-radius:3px',
      'background:rgba(79,156,249,.12)',
    ].join(';');
    return ph;
  }

  /** True when both candidates describe the same insertion slot. */
  function sameSlot(a, b) {
    return !!a && !!b && a.parent === b.parent && a.refEl === b.refEl &&
      a.inside === b.inside && a.before === b.before;
  }

  /** Swap the element for its stand-in the moment the drag begins, in the
   * element's OWN slot. Doing it here rather than on the first valid target
   * means the page reaches its "element lifted out" layout once, at the start,
   * instead of lurching into it mid-drag. */
  function startLayoutPreview() {
    if (!drag || placeholder || !canPreviewLayout(drag.el)) return;
    placeholder = buildPlaceholder(drag.el);       // measure before hiding
    drag.prevDisplay = drag.el.style.display;
    drag.el.parentNode.insertBefore(placeholder, drag.el);
    drag.el.style.display = 'none';
    drag.originHidden = true;
    drag.previewSlot = null;
  }

  /** Relocate the stand-in to the candidate slot. It is never removed here:
   * pulling it out for an invalid or absent target would collapse the layout
   * and slam it back on the next move. No target simply means "stay put". */
  function showLayoutPreview(c) {
    if (!placeholder || !c || !c.valid) return;
    if (sameSlot(c, drag.previewSlot)) return;     // already there — no reflow
    if (c.inside) c.parent.insertBefore(placeholder, c.parent === document.body ? host : null);
    else if (c.before) c.parent.insertBefore(placeholder, c.refEl);
    else c.parent.insertBefore(placeholder, c.refEl.nextElementSibling);
    drag.previewSlot = c;
  }

  /** Tear the preview down and put the real element back on screen. */
  function endLayoutPreview() {
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    placeholder = null;
    if (drag) {
      drag.previewSlot = null;
      if (drag.originHidden) {
        drag.el.style.display = drag.prevDisplay || '';
        if (!drag.el.getAttribute('style')) drag.el.removeAttribute('style');
        drag.originHidden = false;
      }
    }
  }

  function startPotentialDrag(el, x, y, fromTree) {
    if (!el || isOurs(el) || !canDrag(el)) return;
    if (fromTree) select(el);
    drag = { el: el, startX: x, startY: y, lastX: x, lastY: y, slotX: x, slotY: y,
      active: false, candidate: null, fromTree: !!fromTree };
  }

  /** Resolve an insertion point among a container's OWN children. Used when we
   * deliberately hold on to the container we are already dropping into instead
   * of re-deriving one from whatever happens to be topmost. */
  function resolveWithin(parent, x, y, dtag) {
    var sibs = pageChildren(parent);                       // index space the op uses
    var prect = parent.getBoundingClientRect();
    var ok = canContain(parent.tagName.toLowerCase(), dtag);
    var best = null, bestRect = null, bestD = Infinity;
    for (var i = 0; i < sibs.length; i++) {
      if (sibs[i] === drag.el) continue;                   // hidden while dragging: no box
      var kr = sibs[i].getBoundingClientRect();
      if (!kr.width && !kr.height) continue;
      var d = Math.abs(y - (kr.top + kr.height / 2)) + Math.abs(x - (kr.left + kr.width / 2)) * 0.25;
      if (d < bestD) { bestD = d; best = sibs[i]; bestRect = kr; }
    }
    if (!best) {
      return { parent: parent, refEl: null, inside: true, index: sibs.length, valid: ok, rect: prect };
    }
    var before = y < bestRect.top + bestRect.height / 2;
    var cur = drag.candidate;
    if (cur && cur.refEl === best && cur.before !== before &&
        Math.abs(y - (bestRect.top + bestRect.height / 2)) < SWAP_MARGIN) {
      before = cur.before;                                  // midline hysteresis
    }
    var idx = sibs.indexOf(best);
    return {
      parent: parent, refEl: best, inside: false, before: before, horizontal: false,
      index: before ? idx : idx + 1, valid: ok, rect: bestRect,
    };
  }

  // -- Insertion candidate under the pointer ------------------------------------
  function computeCandidate(x, y) {
    var t = document.elementFromPoint(x, y);
    var dragged = drag.el;
    // The pointer is over our own stand-in: the drop is already exactly where
    // the user is aiming. Keep the current candidate. Re-deriving one here is
    // the core oscillation — the stand-in would target its way out from under
    // the pointer, reflow, and come straight back.
    if (placeholder && (t === placeholder || placeholder.contains(t))) return drag.candidate;
    if (!t || isOurs(t)) return null;
    if (!placeholder) {
      // No preview (toggle off, or an out-of-flow element): still hovering the
      // element itself means the pointer has not been taken anywhere yet.
      // Walking up to an ancestor would invent a target — a few px of travel
      // inside the element would "move" it out into its own grandparent.
      var dr = dragged.getBoundingClientRect();
      if (x >= dr.left && x <= dr.right && y >= dr.top && y <= dr.bottom) return null;
    }
    // Never target the dragged element or its descendants.
    while (t && (t === dragged || dragged.contains(t))) t = t.parentElement;
    if (!t || isOurs(t) || t === document.documentElement) return null;
    var dtag = dragged.tagName.toLowerCase();

    // Sticky container. If the topmost element is an ANCESTOR of the container
    // we are already dropping into, and the pointer is still inside that
    // container, the pointer is in its padding or a gap between its children —
    // it has not genuinely moved somewhere new. Re-deriving a parent here is
    // what makes the target leap between nesting levels, and with the live
    // preview that leap reshuffles the page. Going deeper, or sideways into a
    // sibling subtree, is still free.
    var held = drag.candidate;
    if (held && held.parent && held.parent.isConnected && held.parent !== document.body &&
        t !== held.parent && t.contains(held.parent)) {
      var hr = held.parent.getBoundingClientRect();
      if (x >= hr.left && x <= hr.right && y >= hr.top && y <= hr.bottom) {
        return resolveWithin(held.parent, x, y, dtag);
      }
    }

    if (t === document.body) {
      return {
        parent: document.body, refEl: null, inside: true,
        index: pageChildren(document.body).length,
        valid: canContain('body', dtag),
        rect: document.body.getBoundingClientRect(),
      };
    }
    var rect = t.getBoundingClientRect();
    var ttag = t.tagName.toLowerCase();
    // Empty valid container → drop inside.
    var empty = pageChildren(t).length === 0 && (t.textContent || '').trim() === '';
    if (empty && canContain(ttag, dtag)) {
      return { parent: t, refEl: null, inside: true, index: 0, valid: true, rect: rect };
    }
    // Before/after by the dominant pointer axis within the rect.
    var dx = x - (rect.left + rect.width / 2);
    var dy = y - (rect.top + rect.height / 2);
    var horizontal = Math.abs(dx) / Math.max(rect.width, 1) > Math.abs(dy) / Math.max(rect.height, 1);
    var before = horizontal ? dx < 0 : dy < 0;
    // Hysteresis on the midline. Sitting right on a target's centre, a stray
    // pixel — or the target shifting slightly under our own reflow — would
    // flip before/after on every frame.
    var cur = drag.candidate;
    if (cur && cur.refEl === t && cur.before !== before &&
        (horizontal ? Math.abs(dx) : Math.abs(dy)) < SWAP_MARGIN) {
      before = cur.before;
    }
    var parent = t.parentElement;
    if (!parent || parent === document.documentElement) return null;
    var sibs = pageChildren(parent);
    var idx = sibs.indexOf(t);
    if (idx === -1) return null;
    return {
      parent: parent, refEl: t, inside: false, before: before, horizontal: horizontal,
      index: before ? idx : idx + 1,
      valid: canContain(parent.tagName.toLowerCase(), dtag),
      rect: rect,
    };
  }

  // -- Tree-internal drop candidates (dragging a row onto other rows) -----------
  function overTreePanel(x, y) {
    var r = leftPanel.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** Same candidate shape as computeCandidate, but resolved against tree rows:
   * top ~25% of a row → before that element, bottom ~25% → after,
   * middle 50% → into it as last child (when valid). */
  function computeTreeCandidate(x, y) {
    var row = shadow.elementFromPoint(x, y);
    while (row && !(row.classList && row.classList.contains('trow'))) row = row.parentElement;
    if (!row || !row.__veEl) return null;
    var target = row.__veEl;
    var dragged = drag.el;
    var dtag = dragged.tagName.toLowerCase();
    var rect = row.getBoundingClientRect();
    var relY = (y - rect.top) / Math.max(rect.height, 1);
    // Never onto the dragged element or its descendants.
    var intoDragged = target === dragged || dragged.contains(target);

    if (relY < 0.25 || relY > 0.75) {
      var parent = target.parentElement;
      if (!parent || parent === document.documentElement) return null;
      var sibs = pageChildren(parent);
      var idx = sibs.indexOf(target);
      if (idx === -1) return null;
      return {
        parent: parent, refEl: target, inside: false,
        before: relY < 0.25, horizontal: false,
        index: relY < 0.25 ? idx : idx + 1,
        valid: !intoDragged && canContain(parent.tagName.toLowerCase(), dtag),
        rect: rect,
      };
    }
    // Middle band: drop INTO the row's element as last child. Into an element
    // with element children is fine; into a text-leaf is not (unless empty
    // and canContain allows it).
    var hasKids = pageChildren(target).length > 0;
    var hasText = (target.textContent || '').trim() !== '';
    var valid = !intoDragged && canContain(target.tagName.toLowerCase(), dtag) &&
      (hasKids || !hasText);
    return {
      parent: target, refEl: null, inside: true,
      index: pageChildren(target).length,
      valid: valid, rect: rect,
    };
  }

  // -- Insertion markers ----------------------------------------------------------
  function renderDropMarker() {
    var c = drag && drag.active ? drag.candidate : null;
    if (!c) {
      ovLine.style.display = 'none';
      ovInside.style.display = 'none';
      ovDropLabel.style.display = 'none';
      return;
    }
    var bad = c.valid ? '' : 'bad';
    // With the live preview up, the placeholder IS the insertion marker.
    // Keep only the label so the target container is still named.
    if (c.valid && placeholder && placeholder.parentNode) {
      ovLine.style.display = 'none';
      ovInside.style.display = 'none';
      var pr = placeholder.getBoundingClientRect();
      ovDropLabel.className = 'ov ';
      ovDropLabel.style.display = 'block';
      ovDropLabel.style.left = pr.left + 'px';
      ovDropLabel.style.top = Math.max(0, pr.top - 16) + 'px';
      ovDropLabel.textContent = c.parent.tagName.toLowerCase();
      return;
    }
    var r = c.rect;
    var labelX = r.left, labelY = Math.max(0, r.top - 16);
    if (c.inside) {
      ovLine.style.display = 'none';
      ovInside.className = 'ov ' + bad;
      ovInside.style.display = 'block';
      ovInside.style.left = r.left + 'px';
      ovInside.style.top = r.top + 'px';
      ovInside.style.width = r.width + 'px';
      ovInside.style.height = r.height + 'px';
    } else {
      ovInside.style.display = 'none';
      ovLine.className = 'ov ' + bad;
      ovLine.style.display = 'block';
      if (c.horizontal) {
        ovLine.style.left = (c.before ? r.left : r.right) - 1 + 'px';
        ovLine.style.top = r.top + 'px';
        ovLine.style.width = '2px';
        ovLine.style.height = r.height + 'px';
      } else {
        ovLine.style.left = r.left + 'px';
        ovLine.style.top = (c.before ? r.top : r.bottom) - 1 + 'px';
        ovLine.style.width = r.width + 'px';
        ovLine.style.height = '2px';
      }
      if (!c.before) labelY = r.bottom + 2;
    }
    ovDropLabel.className = 'ov ' + bad;
    ovDropLabel.style.display = 'block';
    ovDropLabel.style.left = labelX + 'px';
    ovDropLabel.style.top = labelY + 'px';
    ovDropLabel.textContent = c.parent.tagName.toLowerCase() + (c.valid ? '' : ' — not allowed');
  }

  // -- Path adjustment: parentPath must describe the POST-removal tree -------------
  function adjustPathForRemoval(p, r) {
    // If the removed element is an earlier sibling of an element along p,
    // that level's index shifts down by one after the cut.
    var k = r.length - 1;
    if (k >= p.length) return p;
    for (var i = 0; i < k; i++) if (p[i] !== r[i]) return p;
    if (p[k] > r[k]) { var q = p.slice(); q[k]--; return q; }
    return p;
  }

  // -- Drop -------------------------------------------------------------------------
  function finishDrop() {
    var c = drag.candidate;
    if (!c || !c.valid) return;
    var el = drag.el;
    // Compute the op from the PRE-MOVE DOM state, send it, THEN mutate.
    var elPath = elementPath(el);
    var parentPath = adjustPathForRemoval(elementPath(c.parent), elPath);
    var index = c.index;
    var oldSibs = pageChildren(el.parentElement);
    // Same parent, moving downward: removal shifts the target index down by one.
    if (el.parentElement === c.parent && oldSibs.indexOf(el) !== -1 && oldSibs.indexOf(el) < index) {
      index--;
    }
    // Dropping an element exactly where it already sits is not an edit. Don't
    // rewrite the source file (or push an undo entry) for a no-op.
    if (el.parentElement === c.parent && oldSibs.indexOf(el) === index) {
      endLayoutPreview();
      return;
    }
    var inv = moveInverse(el);
    var redo = function () {
      if (c.inside) {
        c.parent.insertBefore(el, c.parent === document.body ? host : null);
      } else if (c.before) {
        c.parent.insertBefore(el, c.refEl);
      } else {
        c.parent.insertBefore(el, c.refEl.nextElementSibling);
      }
    };
    sendEdit(opFor(el, { op: 'moveTo', parentPath: parentPath, index: index }),
      { undo: inv.undo, redo: redo });
    // Take the stand-in out and un-hide the real element BEFORE moving it, so
    // redo() inserts against real siblings rather than against the placeholder.
    endLayoutPreview();
    redo();
    // An "into" drop opens the target so the user sees where it landed.
    if (c.inside) state.open.set(c.parent, true);
    rebuildTree(); rebuildProps(); rebuildCrumbs(); refreshOverlays();
  }

  function endDrag(commit) {
    cancelCandidateUpdate();
    if (drag && drag.active && commit) finishDrop();
    endLayoutPreview(); // idempotent: finishDrop() already ran it on the commit path
    drag = null;
    stopDragScroll();
    hideGhost();
    setNoSelect(false);
    renderDropMarker();
  }

  /** Coalesce target re-evaluation into one update per animation frame. */
  function scheduleCandidateUpdate() {
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(function () {
      previewRaf = 0;
      if (!drag || !drag.active) return;
      drag.candidate = computeDragCandidate(drag.lastX, drag.lastY);
      showLayoutPreview(drag.candidate);
      renderDropMarker();
    });
  }
  function cancelCandidateUpdate() {
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
  }

  // -- Pointer wiring -----------------------------------------------------------------
  function onPointerDown(ev) {
    if (ev.button !== 0 || isOurs(ev.target)) return;
    // Selection-first: pressing anywhere inside the already-selected element
    // (including on its children, which usually cover its whole surface)
    // starts a page drag. Works in select mode too: if the press never passes
    // the drag threshold, the follow-up click simply selects as usual.
    if (state.selected && state.selected.contains(ev.target)) {
      startPotentialDrag(state.selected, ev.clientX, ev.clientY, false);
    }
  }

  function onPointerMove(ev) {
    if (!drag) return;
    if (!drag.active) {
      var threshold = dragThreshold();
      if (Math.abs(ev.clientX - drag.startX) < threshold &&
          Math.abs(ev.clientY - drag.startY) < threshold) return;
      drag.active = true;
      setNoSelect(true);
      showGhost(drag.el, ev.clientX, ev.clientY);
      startLayoutPreview(); // lift the element out once, in its own slot
      startDragScroll();
    }
    ev.preventDefault();
    drag.lastX = ev.clientX; drag.lastY = ev.clientY;
    moveGhost(ev.clientX, ev.clientY); // the ghost tracks every event, so it stays smooth
    if (drag.evalX === undefined ||
        Math.abs(ev.clientX - drag.evalX) >= CANDIDATE_STEP ||
        Math.abs(ev.clientY - drag.evalY) >= CANDIDATE_STEP) {
      drag.evalX = ev.clientX; drag.evalY = ev.clientY;
      scheduleCandidateUpdate();
    }
  }

  // Tree-row drags over the tree panel resolve against rows; everything else
  // resolves against the page canvas as before.
  function computeDragCandidate(x, y) {
    var next = (drag.fromTree && overTreePanel(x, y)) ? computeTreeCandidate(x, y) : computeCandidate(x, y);
    // Commit hysteresis. Once a slot is chosen, hold it until the pointer has
    // travelled far enough for the change to be clearly deliberate.
    //
    // This is the one that actually kills the oscillation. Moving the stand-in
    // into a container reflows it; the container can then slide out from under
    // a barely-moving pointer, which legitimately re-targets its ancestor,
    // which reflows back, which re-targets the container... A "keep the
    // container while the pointer is still inside it" rule cannot break that
    // loop, because by the time we re-test, the pointer genuinely is outside.
    // Distance since the last committed slot is immune to it: our own reflow
    // never moves the pointer.
    var cur = drag.candidate;
    if (cur && next && !sameSlot(next, cur) &&
        Math.abs(x - drag.slotX) < RELOCATE_MIN && Math.abs(y - drag.slotY) < RELOCATE_MIN) {
      return cur;
    }
    if (!cur || !next || !sameSlot(next, cur)) { drag.slotX = x; drag.slotY = y; }
    return next;
  }

  // Edge auto-scroll: while dragging near the viewport top/bottom, scroll the
  // page (or the tree panel, for tree-internal drags) so long-distance moves
  // work. The candidate is recomputed after each scroll because content moves
  // under the (stationary) pointer.
  var DRAG_SCROLL_MARGIN = 56, DRAG_SCROLL_STEP = 18;
  function startDragScroll() {
    stopDragScroll();
    dragScrollTimer = setInterval(function () {
      if (!drag || !drag.active) { stopDragScroll(); return; }
      var y = drag.lastY;
      if (drag.fromTree && overTreePanel(drag.lastX, y)) {
        var r = treeBox.getBoundingClientRect();
        if (y < r.top + DRAG_SCROLL_MARGIN) treeBox.scrollTop -= DRAG_SCROLL_STEP;
        else if (y > r.bottom - DRAG_SCROLL_MARGIN) treeBox.scrollTop += DRAG_SCROLL_STEP;
        else return;
      } else {
        if (y < DRAG_SCROLL_MARGIN) window.scrollBy(0, -DRAG_SCROLL_STEP);
        else if (y > window.innerHeight - DRAG_SCROLL_MARGIN) window.scrollBy(0, DRAG_SCROLL_STEP);
        else return;
      }
      // Scrolling genuinely moves content under a still pointer, so this is a
      // real re-evaluation rather than a self-inflicted one.
      drag.evalX = drag.lastX; drag.evalY = drag.lastY;
      scheduleCandidateUpdate();
    }, 50);
  }
  function stopDragScroll() {
    if (dragScrollTimer) { clearInterval(dragScrollTimer); dragScrollTimer = null; }
  }

  function onPointerUp(ev) {
    if (!drag) return;
    if (drag.active) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 50);
      ev.preventDefault();
      endDrag(true);
    } else {
      drag = null;
    }
  }

  function onDragKey(ev) {
    if (drag && ev.key === 'Escape') {
      endDrag(false);
      ev.preventDefault();
    }
  }

  // -- Text-selection suppression ---------------------------------------------
  // In select mode the page is inert: mousedown default is blocked for every
  // page element so inputs never focus, buttons never arm, and text never
  // selects — clicks themselves are swallowed by onClickCapture. Outside
  // select mode, only block when a drag is armed or active.
  function onSelectStart(ev) {
    if ((drag || selMode()) && !isOurs(ev.target)) ev.preventDefault();
  }
  function onPageMouseDown(ev) {
    if (isOurs(ev.target)) return;
    if (selMode() || drag || (state.selected && state.selected.contains(ev.target))) {
      ev.preventDefault();
    }
  }

  // -- Undo shortcut: Ctrl/Cmd+Z, but never inside editor inputs ---------------
  function onUndoKey(ev) {
    if (ev.key !== 'z' && ev.key !== 'Z') return;
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey) return;
    if (typingTarget()) return;
    ev.preventDefault();
    doUndo();
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('keydown', onDragKey, true);
  document.addEventListener('keydown', onUndoKey, true);
  document.addEventListener('keydown', onNavKey, true);
  document.addEventListener('keydown', onModeKeyDown, true);
  document.addEventListener('keyup', onModeKeyUp, true);
  document.addEventListener('selectstart', onSelectStart, true);
  document.addEventListener('mousedown', onPageMouseDown, true);

  function removeDragListeners() {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keydown', onDragKey, true);
    document.removeEventListener('keydown', onUndoKey, true);
    document.removeEventListener('keydown', onNavKey, true);
    document.removeEventListener('keydown', onModeKeyDown, true);
    document.removeEventListener('keyup', onModeKeyUp, true);
    document.removeEventListener('selectstart', onSelectStart, true);
    document.removeEventListener('mousedown', onPageMouseDown, true);
    stopDragScroll();
    cancelCandidateUpdate();
    endLayoutPreview(); // tearing down mid-drag must not leave the element hidden
    hideGhost();
    setNoSelect(false);
  }

  // -------------------------------------------------------------------------
  // Global listeners
  // -------------------------------------------------------------------------
  function onMouseMove(ev) { if (selMode()) onHover(ev); }
  function onScroll() { refreshOverlays(); }
  function onResize() {
    // A narrower window can invalidate stored widths — re-clamp so the canvas
    // strip between the panels never disappears.
    var l = clampLeftW(prefs.leftW), r = clampRightW(prefs.rightW);
    if (l !== prefs.leftW || r !== prefs.rightW) {
      prefs.leftW = l; prefs.rightW = r;
      applyPanelWidths();
    }
    refreshOverlays();
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('dblclick', onDblClick, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onWindowBlur);

  // -------------------------------------------------------------------------
  // Public API + teardown
  // -------------------------------------------------------------------------
  var api = {
    disable: function () {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('dblclick', onDblClick, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onWindowBlur);
      removeDragListeners();
      setDocked(false);
      document.documentElement.style.cursor = '';
      // A pending "saved → idle" timer would keep poking detached nodes.
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      host.remove();
      delete window.__visualEditor;
    },
    select: select,
  };
  window.__visualEditor = api;

  // Initial paint — select mode is on from the start, so the page is inert
  // (clicks select elements instead of activating links/buttons) until the
  // user toggles browse mode with V / the Select button / Esc.
  setSelectMode(true);
  setLivePreview(prefs.livePreview);
  applyPanelWidths();
  loadProject();   // async; the palette fills in when it lands
  rebuildTree();
  rebuildProps();
})();
