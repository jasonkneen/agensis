/* visual-dev-editor — browser client.
 *
 * Plain non-module script, zero dependencies. Builds its entire UI inside one
 * Shadow-DOM host so editor CSS can never leak into the page (or vice versa).
 * Edits hit the real DOM first for instant feedback, then POST to
 * /__visual-editor/edit so the server patches the HTML source file on disk.
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
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  // -------------------------------------------------------------------------
  // Element path — element-only child indices from <html>, matching the
  // server's parse5 walk exactly (text/comment nodes are skipped, and so is
  // the editor's own host element, which never exists in the source).
  // -------------------------------------------------------------------------
  function isOurs(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === host || host.contains(el)) return true;
    if (el.hasAttribute('data-ve-editor-el')) return true; // drag ghost
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

  shadow.appendChild(h('style', {
    text: [
      ':host { all: initial; }',
      '* { box-sizing: border-box; margin: 0; padding: 0; }',
      '.ve { position: fixed; z-index: 2147483000; background: #16181d; color: #d6dae3;',
      '  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
      '  border: 1px solid #2c313c; box-shadow: 0 4px 24px rgba(0,0,0,.5); }',
      '#left { left: 0; top: 0; bottom: 44px; width: 240px; overflow: auto; border-width: 0 1px 0 0; }',
      '#right { right: 0; top: 0; bottom: 44px; width: 300px; overflow: auto; border-width: 0 0 0 1px; padding: 8px; }',
      '#bar { left: 0; right: 0; bottom: 0; height: 44px; display: flex; align-items: center;',
      '  gap: 8px; padding: 0 10px; border-width: 1px 0 0 0; }',
      'button { background: #22262f; color: #d6dae3; border: 1px solid #3a4150; border-radius: 3px;',
      '  padding: 3px 9px; font: inherit; cursor: pointer; }',
      'button:hover { background: #2c323f; }',
      'button.on { background: #2d4a7a; border-color: #4a7ac7; color: #fff; }',
      'input, textarea { background: #0f1115; color: #d6dae3; border: 1px solid #333a47;',
      '  border-radius: 3px; padding: 3px 6px; font: inherit; width: 100%; }',
      'textarea { resize: vertical; min-height: 48px; }',
      'label { display: block; color: #8b93a3; margin: 8px 0 3px; text-transform: uppercase;',
      '  font-size: 9px; letter-spacing: .08em; }',
      '.row { display: flex; gap: 4px; align-items: center; margin: 2px 0; }',
      '.row input { flex: 1; min-width: 0; }',
      '.mini { padding: 1px 6px; flex: none; }',
      '.sec { border-top: 1px solid #262b34; margin-top: 10px; padding-top: 4px; }',
      '#status { color: #8b93a3; margin-left: auto; white-space: nowrap; overflow: hidden;',
      '  text-overflow: ellipsis; max-width: 45%; }',
      '#status.err { color: #ff7b72; }',
      '#status.ok { color: #7ee787; }',
      '.trow { display: flex; align-items: center; white-space: nowrap; cursor: pointer;',
      '  padding: 0 4px; border-radius: 2px; }',
      '.trow:hover { background: #20242c; }',
      '.trow.sel { background: #2d4a7a; color: #fff; }',
      '.trow .caret { width: 12px; flex: none; color: #6b7382; cursor: pointer; user-select: none; }',
      '.trow .tag { color: #7aa5f8; }',
      '.trow.sel .tag { color: #cfe1ff; }',
      '.trow .id { color: #e0a75e; }',
      '.trow .cls { color: #9ece8a; }',
      '.trow .snip { color: #6b7382; overflow: hidden; text-overflow: ellipsis; }',
      '.kids { margin-left: 12px; }',
      '.ov { position: fixed; z-index: 2147483002; pointer-events: none; }',
      '#ov-hover { border: 1px dashed #4a7ac7; background: rgba(74,122,199,.08); display: none; }',
      '#ov-sel { border: 2px solid #4a7ac7; display: none; }',
      '#ov-label { background: #4a7ac7; color: #fff; padding: 0 5px; font-size: 10px;',
      '  border-radius: 2px; display: none; }',
      '#ov-line { background: #4a7ac7; display: none; }',
      '#ov-line.bad { background: #ff5c5c; }',
      '#ov-inside { border: 2px solid #4a7ac7; background: rgba(74,122,199,.10); display: none; }',
      '#ov-inside.bad { border-color: #ff5c5c; background: rgba(255,92,92,.10); }',
      '#ov-drop-label { background: #4a7ac7; color: #fff; padding: 0 5px; font-size: 10px;',
      '  border-radius: 2px; display: none; white-space: nowrap; }',
      '#ov-drop-label.bad { background: #ff5c5c; }',
    ].join('\n'),
  }));

  // -------------------------------------------------------------------------
  // Panel skeletons
  // -------------------------------------------------------------------------
  var leftPanel = h('div', { class: 've', id: 'left' });
  var rightPanel = h('div', { class: 've', id: 'right' });
  var statusEl = h('span', { id: 'status', text: 'idle' });
  var selectBtn = h('button', { text: 'Select', title: 'Click an element on the page' });
  var upBtn = h('button', { text: 'Move up' });
  var downBtn = h('button', { text: 'Move down' });
  var delBtn = h('button', { text: 'Delete' });
  var undoBtn = h('button', { text: 'Undo', title: 'Ctrl/Cmd+Z' });
  var closeBtn = h('button', { text: '×', title: 'Close editor' });
  var bar = h('div', { class: 've', id: 'bar' },
    [selectBtn, upBtn, downBtn, delBtn, undoBtn, statusEl, closeBtn]);

  var ovHover = h('div', { class: 'ov', id: 'ov-hover' });
  var ovSel = h('div', { class: 'ov', id: 'ov-sel' });
  var ovLabel = h('div', { class: 'ov', id: 'ov-label' });
  var ovLine = h('div', { class: 'ov', id: 'ov-line' });
  var ovInside = h('div', { class: 'ov', id: 'ov-inside' });
  var ovDropLabel = h('div', { class: 'ov', id: 'ov-drop-label' });

  [leftPanel, rightPanel, bar, ovHover, ovSel, ovLabel, ovLine, ovInside, ovDropLabel]
    .forEach(function (el) { shadow.appendChild(el); });
  document.body.appendChild(host);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  var state = {
    selected: null,      // currently selected page element
    selectMode: false,
    expanded: new WeakSet(),
    dirty: false,
  };

  // -------------------------------------------------------------------------
  // Save status + server round-trip + undo stack
  // -------------------------------------------------------------------------
  // Every edit ships with DOM closures: `undo` reverts the local mutation,
  // `redo` re-applies it. A server {ok:false} rolls the DOM back immediately
  // so page and source never diverge; a success pushes {file, undo, redo}
  // onto the undo stack (mirrored by the server's per-file source stack).
  var undoStack = [];

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function refreshAll() {
    rebuildTree(); rebuildProps(); refreshOverlays();
  }

  function sendEdit(op, dom) {
    setStatus('saving…');
    state.dirty = true;
    fetch(API, {
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
          setStatus('saved ✓', 'ok');
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
  }

  function doUndo() {
    var top = undoStack.pop();
    if (!top) { setStatus('nothing to undo'); return; }
    top.undo();
    refreshAll();
    setStatus('saving…');
    fetch('/__visual-editor/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: top.file }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) {
          setStatus('undone ✓', 'ok');
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
  // Highlight overlays
  // -------------------------------------------------------------------------
  function placeOverlay(ov, el, labelOv) {
    if (!el || !el.getBoundingClientRect) { ov.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { ov.style.display = 'none'; return; }
    ov.style.display = 'block';
    ov.style.left = r.left + 'px';
    ov.style.top = r.top + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    if (labelOv) {
      labelOv.style.display = 'block';
      labelOv.style.left = r.left + 'px';
      labelOv.style.top = Math.max(0, r.top - 16) + 'px';
      var name = el.tagName.toLowerCase();
      if (el.id) name += '#' + el.id;
      labelOv.textContent = name;
    }
  }

  function refreshOverlays() {
    placeOverlay(ovSel, state.selected, ovLabel);
  }

  // -------------------------------------------------------------------------
  // Tree (left panel)
  // -------------------------------------------------------------------------
  var treeRows = new WeakMap(); // element → its rendered row (for scrollIntoView)

  function shortText(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 28 ? t.slice(0, 28) + '…' : t;
  }

  function rowLabel(el) {
    var frag = document.createDocumentFragment();
    frag.appendChild(h('span', { class: 'tag', text: el.tagName.toLowerCase() }));
    if (el.id) frag.appendChild(h('span', { class: 'id', text: '#' + el.id }));
    var cls = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).slice(0, 2) : [];
    if (cls.length && cls[0]) frag.appendChild(h('span', { class: 'cls', text: '.' + cls.join('.') }));
    if (el.children.length === 0) {
      var s = shortText(el);
      if (s) frag.appendChild(h('span', { class: 'snip', text: ' “' + s + '”' }));
    }
    return frag;
  }

  function buildTreeRow(el, depth) {
    if (isOurs(el)) return null;
    var caret = h('span', { class: 'caret' });
    var row = h('div', { class: 'trow' + (el === state.selected ? ' sel' : '') }, [caret, rowLabel(el)]);
    row.style.paddingLeft = (depth * 12) + 'px';
    treeRows.set(el, row);
    row.__veEl = el; // reverse lookup for tree-internal drag-and-drop
    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      select(el);
    });
    // Dragging a tree row moves the element, same as dragging on the page.
    row.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      startPotentialDrag(el, ev.clientX, ev.clientY, true);
    });

    var wrap = h('div', {}, [row]);
    var kids = Array.prototype.filter.call(el.children, function (c) { return !isOurs(c); });
    if (kids.length && depth < MAX_DEPTH) {
      var open = depth < 2 || state.expanded.has(el);
      caret.textContent = open ? '▾' : '▸';
      caret.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (state.expanded.has(el)) state.expanded.delete(el);
        else state.expanded.add(el);
        rebuildTree();
      });
      if (open) {
        var box = h('div', { class: 'kids' });
        box.style.marginLeft = '0';
        kids.slice(0, MAX_CHILDREN).forEach(function (c) {
          var sub = buildTreeRow(c, depth + 1);
          if (sub) box.appendChild(sub);
        });
        if (kids.length > MAX_CHILDREN) {
          box.appendChild(h('div', { class: 'trow', text: '…' + (kids.length - MAX_CHILDREN) + ' more' }));
        }
        wrap.appendChild(box);
      }
    }
    return wrap;
  }

  function rebuildTree() {
    leftPanel.textContent = '';
    var frag = document.createDocumentFragment();
    Array.prototype.forEach.call(document.body.children, function (c) {
      var row = buildTreeRow(c, 0);
      if (row) frag.appendChild(row);
    });
    leftPanel.appendChild(frag);
  }

  // -------------------------------------------------------------------------
  // Properties (right panel)
  // -------------------------------------------------------------------------
  var PROP_NAME_RE = /^[a-zA-Z-][a-zA-Z0-9-]*$/;

  function rebuildProps() {
    rightPanel.textContent = '';
    var el = state.selected;
    if (!el) {
      rightPanel.appendChild(h('div', { text: 'Nothing selected.\nUse Select or the tree.' }));
      return;
    }
    var file = fileFor(el);

    // Tag name (read-only)
    rightPanel.appendChild(h('label', { text: 'tag' }));
    rightPanel.appendChild(h('input', { value: el.tagName.toLowerCase(), disabled: '' }));

    // id
    rightPanel.appendChild(h('label', { text: 'id' }));
    rightPanel.appendChild(h('input', {
      value: el.id || '',
      onchange: function (ev) {
        var v = ev.target.value.trim();
        var inv = attrInverse(el, 'id');
        var redo = function () { el.id = v; };
        redo();
        if (file) sendEdit(opFor(el, { op: 'setAttr', name: 'id', value: v || null }),
          { undo: inv.undo, redo: redo });
        rebuildTree(); refreshOverlays();
      },
    }));

    // classes (single space-separated input → className)
    rightPanel.appendChild(h('label', { text: 'classes' }));
    rightPanel.appendChild(h('input', {
      value: el.className && typeof el.className === 'string' ? el.className : '',
      onchange: function (ev) {
        var v = ev.target.value.trim();
        var inv = attrInverse(el, 'class');
        var redo = function () { el.className = v; };
        redo();
        if (file) sendEdit(opFor(el, { op: 'setAttr', name: 'class', value: v || null }),
          { undo: inv.undo, redo: redo });
        rebuildTree(); refreshOverlays();
      },
    }));

    // Text content — only for text-leaf elements
    if (el.children.length === 0) {
      rightPanel.appendChild(h('label', { text: 'text content' }));
      var ta = h('textarea', { text: el.textContent });
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
      rightPanel.appendChild(ta);
    }

    // Attributes (skip class/style — they have dedicated editors)
    var attrSec = h('div', { class: 'sec' });
    attrSec.appendChild(h('label', { text: 'attributes' }));
    Array.prototype.forEach.call(el.attributes, function (a) {
      if (a.name === 'class' || a.name === 'style') return;
      if (a.name.indexOf('data-ve-') === 0) return;
      attrSec.appendChild(attrRow(el, a.name, a.value));
    });
    attrSec.appendChild(h('button', {
      class: 'mini', text: '+ add attribute',
      onclick: function () { attrSec.insertBefore(attrRow(el, '', ''), attrSec.lastChild); },
    }));
    rightPanel.appendChild(attrSec);

    // Inline style editor
    var styleSec = h('div', { class: 'sec' });
    styleSec.appendChild(h('label', { text: 'inline style' }));
    for (var i = 0; i < el.style.length; i++) {
      var p = el.style[i];
      styleSec.appendChild(styleRow(el, p, el.style.getPropertyValue(p)));
    }
    styleSec.appendChild(h('button', {
      class: 'mini', text: '+ add property',
      onclick: function () { styleSec.insertBefore(styleRow(el, '', ''), styleSec.lastChild); },
    }));
    rightPanel.appendChild(styleSec);
  }

  function attrRow(el, name, value) {
    var nameIn = h('input', { value: name, placeholder: 'name' });
    var valIn = h('input', { value: value, placeholder: 'value' });
    function commit() {
      var n = nameIn.value.trim();
      if (!n) return;
      var inv = attrInverse(el, n);
      var redo = function () { el.setAttribute(n, valIn.value); };
      redo();
      if (fileFor(el)) sendEdit(opFor(el, { op: 'setAttr', name: n, value: valIn.value }),
        { undo: inv.undo, redo: redo });
    }
    valIn.addEventListener('change', commit);
    nameIn.addEventListener('change', commit);
    return h('div', { class: 'row' }, [nameIn, valIn, h('button', {
      class: 'mini', text: '×', title: 'Remove attribute',
      onclick: function (ev) {
        var n = nameIn.value.trim();
        if (n) {
          var inv = attrInverse(el, n);
          var redo = function () { el.removeAttribute(n); };
          redo();
          if (fileFor(el)) sendEdit(opFor(el, { op: 'setAttr', name: n, value: null }),
            { undo: inv.undo, redo: redo });
        }
        ev.target.parentElement.remove();
      },
    })]);
  }

  function styleRow(el, prop, value) {
    var propIn = h('input', { value: prop, placeholder: 'property' });
    var valIn = h('input', { value: value, placeholder: 'value' });
    function commit() {
      var p = propIn.value.trim();
      if (!PROP_NAME_RE.test(p)) { setStatus('error: bad property name', 'err'); return; }
      var inv = attrInverse(el, 'style'); // declaration-level undo = restore whole attr
      var redo = function () { el.style.setProperty(p, valIn.value); };
      redo();
      if (fileFor(el)) sendEdit(opFor(el, { op: 'setStyle', property: p, value: valIn.value }),
        { undo: inv.undo, redo: redo });
      refreshOverlays();
    }
    valIn.addEventListener('change', commit);
    propIn.addEventListener('change', commit);
    return h('div', { class: 'row' }, [propIn, valIn, h('button', {
      class: 'mini', text: '×', title: 'Remove property',
      onclick: function (ev) {
        var p = propIn.value.trim();
        if (p && PROP_NAME_RE.test(p)) {
          var inv = attrInverse(el, 'style');
          var redo = function () { el.style.removeProperty(p); };
          redo();
          if (fileFor(el)) sendEdit(opFor(el, { op: 'setStyle', property: p, value: null }),
            { undo: inv.undo, redo: redo });
        }
        ev.target.parentElement.remove();
        refreshOverlays();
      },
    })]);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------
  function select(el) {
    if (!el || isOurs(el)) return;
    state.selected = el;
    // Expand every collapsed ancestor so the selected row is actually
    // rendered, then scroll it into view inside the tree panel.
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      state.expanded.add(p);
    }
    rebuildTree();
    rebuildProps();
    refreshOverlays();
    var row = treeRows.get(el);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  // -------------------------------------------------------------------------
  // Select mode (crosshair) — capture-phase listeners on the document
  // -------------------------------------------------------------------------
  function onHover(ev) {
    if (isOurs(ev.target)) { ovHover.style.display = 'none'; return; }
    placeOverlay(ovHover, ev.target, null);
  }
  function onClickCapture(ev) {
    // Swallow the click that follows a completed drag.
    if (suppressClick) {
      suppressClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!state.selectMode) return;
    if (isOurs(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    setSelectMode(false);
    select(ev.target);
  }
  function setSelectMode(on) {
    state.selectMode = on;
    selectBtn.className = on ? 'on' : '';
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) ovHover.style.display = 'none';
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

  delBtn.addEventListener('click', function () {
    var el = state.selected;
    if (!el) return;
    if (!window.confirm('Delete <' + el.tagName.toLowerCase() + '> from page and source?')) return;
    var op = fileFor(el) ? opFor(el, { op: 'remove' }) : null;
    var inv = moveInverse(el); // captures parent + next sibling before removal
    var redo = function () { el.remove(); };
    var dom = { undo: function () { inv.undo(); }, redo: redo };
    redo();
    state.selected = null;
    if (op) sendEdit(op, dom);
    rebuildTree(); rebuildProps(); refreshOverlays();
  });

  closeBtn.addEventListener('click', function () { api.disable(); });
  undoBtn.addEventListener('click', function () { doUndo(); });

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
  var DRAG_THRESHOLD = 4;
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
      'outline:2px solid #4a7ac7;background:rgba(22,24,29,.4);max-width:45vw;' +
      'max-height:45vh;overflow:hidden;margin:0;';
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

  function startPotentialDrag(el, x, y, fromTree) {
    if (!el || isOurs(el) || !canDrag(el)) return;
    if (fromTree) select(el);
    drag = { el: el, startX: x, startY: y, lastX: x, lastY: y, active: false, candidate: null, fromTree: !!fromTree };
  }

  // -- Insertion candidate under the pointer ------------------------------------
  function computeCandidate(x, y) {
    var t = document.elementFromPoint(x, y);
    if (!t || isOurs(t)) return null;
    var dragged = drag.el;
    // Never target the dragged element or its descendants.
    while (t && (t === dragged || dragged.contains(t))) t = t.parentElement;
    if (!t || isOurs(t) || t === document.documentElement) return null;
    var dtag = dragged.tagName.toLowerCase();

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
   * top ~30% of a row → before that element, bottom ~30% → after,
   * middle 40% → into it as last child (when valid). */
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

    if (relY < 0.3 || relY > 0.7) {
      var parent = target.parentElement;
      if (!parent || parent === document.documentElement) return null;
      var sibs = pageChildren(parent);
      var idx = sibs.indexOf(target);
      if (idx === -1) return null;
      return {
        parent: parent, refEl: target, inside: false,
        before: relY < 0.3, horizontal: false,
        index: relY < 0.3 ? idx : idx + 1,
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
    redo();
    // An "into" drop opens the target so the user sees where it landed.
    if (c.inside) state.expanded.add(c.parent);
    rebuildTree(); rebuildProps(); refreshOverlays();
  }

  function endDrag(commit) {
    if (drag && drag.active && commit) finishDrop();
    drag = null;
    stopDragScroll();
    hideGhost();
    setNoSelect(false);
    renderDropMarker();
  }

  // -- Pointer wiring -----------------------------------------------------------------
  function onPointerDown(ev) {
    if (ev.button !== 0 || state.selectMode || isOurs(ev.target)) return;
    // Selection-first: pressing anywhere inside the already-selected element
    // (including on its children, which usually cover its whole surface)
    // starts a page drag.
    if (state.selected && state.selected.contains(ev.target)) {
      startPotentialDrag(state.selected, ev.clientX, ev.clientY, false);
    }
  }

  function onPointerMove(ev) {
    if (!drag) return;
    if (!drag.active) {
      if (Math.abs(ev.clientX - drag.startX) < DRAG_THRESHOLD &&
          Math.abs(ev.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      setNoSelect(true);
      showGhost(drag.el, ev.clientX, ev.clientY);
      startDragScroll();
    }
    ev.preventDefault();
    drag.lastX = ev.clientX; drag.lastY = ev.clientY;
    moveGhost(ev.clientX, ev.clientY);
    drag.candidate = computeDragCandidate(ev.clientX, ev.clientY);
    renderDropMarker();
  }

  // Tree-row drags over the tree panel resolve against rows; everything else
  // resolves against the page canvas as before.
  function computeDragCandidate(x, y) {
    if (drag.fromTree && overTreePanel(x, y)) return computeTreeCandidate(x, y);
    return computeCandidate(x, y);
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
        var r = leftPanel.getBoundingClientRect();
        if (y < r.top + DRAG_SCROLL_MARGIN) leftPanel.scrollTop -= DRAG_SCROLL_STEP;
        else if (y > r.bottom - DRAG_SCROLL_MARGIN) leftPanel.scrollTop += DRAG_SCROLL_STEP;
        else return;
      } else {
        if (y < DRAG_SCROLL_MARGIN) window.scrollBy(0, -DRAG_SCROLL_STEP);
        else if (y > window.innerHeight - DRAG_SCROLL_MARGIN) window.scrollBy(0, DRAG_SCROLL_STEP);
        else return;
      }
      drag.candidate = computeDragCandidate(drag.lastX, drag.lastY);
      renderDropMarker();
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
  // Block selectstart whenever a drag is armed or active; block mousedown
  // default on the selected element so press-drag never flashes a selection.
  // Neither touches the page when no drag is involved.
  function onSelectStart(ev) {
    if (drag && !isOurs(ev.target)) ev.preventDefault();
  }
  function onPageMouseDown(ev) {
    if (isOurs(ev.target)) return;
    if (drag || (state.selected && state.selected.contains(ev.target))) {
      ev.preventDefault();
    }
  }

  // -- Undo shortcut: Ctrl/Cmd+Z, but never inside editor inputs ---------------
  function onUndoKey(ev) {
    if (ev.key !== 'z' && ev.key !== 'Z') return;
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey) return;
    var ae = document.activeElement;
    if (ae === host) ae = host.shadowRoot.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    ev.preventDefault();
    doUndo();
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('keydown', onDragKey, true);
  document.addEventListener('keydown', onUndoKey, true);
  document.addEventListener('selectstart', onSelectStart, true);
  document.addEventListener('mousedown', onPageMouseDown, true);

  function removeDragListeners() {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keydown', onDragKey, true);
    document.removeEventListener('keydown', onUndoKey, true);
    document.removeEventListener('selectstart', onSelectStart, true);
    document.removeEventListener('mousedown', onPageMouseDown, true);
    stopDragScroll();
    hideGhost();
    setNoSelect(false);
  }

  // -------------------------------------------------------------------------
  // Global listeners
  // -------------------------------------------------------------------------
  function onMouseMove(ev) { if (state.selectMode) onHover(ev); }
  function onScroll() { refreshOverlays(); }
  function onResize() { refreshOverlays(); }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClickCapture, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);

  // -------------------------------------------------------------------------
  // Public API + teardown
  // -------------------------------------------------------------------------
  var api = {
    disable: function () {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      removeDragListeners();
      document.documentElement.style.cursor = '';
      host.remove();
      delete window.__visualEditor;
    },
    select: select,
  };
  window.__visualEditor = api;

  // Initial paint
  rebuildTree();
  rebuildProps();
})();
