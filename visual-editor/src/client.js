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
  // server's parse5 walk exactly (text/comment nodes are skipped).
  // -------------------------------------------------------------------------
  function elementPath(el) {
    var path = [];
    var node = el;
    while (node && node !== document.documentElement) {
      var parent = node.parentElement;
      if (!parent) return null;
      var idx = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i] === node) { path.unshift(idx); break; }
        idx++;
      }
      node = parent;
    }
    return node === document.documentElement ? path : null;
  }

  function elementFromPath(path) {
    var node = document.documentElement;
    for (var i = 0; i < path.length; i++) {
      if (!node || path[i] >= node.children.length) return null;
      node = node.children[path[i]];
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
      '.ov { position: fixed; z-index: 2147482999; pointer-events: none; }',
      '#ov-hover { border: 1px dashed #4a7ac7; background: rgba(74,122,199,.08); display: none; }',
      '#ov-sel { border: 2px solid #4a7ac7; display: none; }',
      '#ov-label { background: #4a7ac7; color: #fff; padding: 0 5px; font-size: 10px;',
      '  border-radius: 2px; display: none; }',
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
  var closeBtn = h('button', { text: '×', title: 'Close editor' });
  var bar = h('div', { class: 've', id: 'bar' },
    [selectBtn, upBtn, downBtn, delBtn, statusEl, closeBtn]);

  var ovHover = h('div', { class: 'ov', id: 'ov-hover' });
  var ovSel = h('div', { class: 'ov', id: 'ov-sel' });
  var ovLabel = h('div', { class: 'ov', id: 'ov-label' });

  [leftPanel, rightPanel, bar, ovHover, ovSel, ovLabel].forEach(function (el) {
    shadow.appendChild(el);
  });
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

  function isOurs(el) {
    return el === host || host.contains(el);
  }

  // -------------------------------------------------------------------------
  // Save status + server round-trip
  // -------------------------------------------------------------------------
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function sendEdit(op) {
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
          setStatus('saved ✓', 'ok');
        } else {
          setStatus('error: ' + ((res && res.error) || 'unknown'), 'err');
        }
      })
      .catch(function (err) {
        state.dirty = false;
        setStatus('error: ' + err.message, 'err');
      });
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
    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      select(el);
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
        el.id = v;
        if (file) sendEdit(opFor(el, { op: 'setAttr', name: 'id', value: v || null }));
        rebuildTree(); refreshOverlays();
      },
    }));

    // classes (single space-separated input → className)
    rightPanel.appendChild(h('label', { text: 'classes' }));
    rightPanel.appendChild(h('input', {
      value: el.className && typeof el.className === 'string' ? el.className : '',
      onchange: function (ev) {
        var v = ev.target.value.trim();
        el.className = v;
        if (file) sendEdit(opFor(el, { op: 'setAttr', name: 'class', value: v || null }));
        rebuildTree(); refreshOverlays();
      },
    }));

    // Text content — only for text-leaf elements
    if (el.children.length === 0) {
      rightPanel.appendChild(h('label', { text: 'text content' }));
      var ta = h('textarea', { text: el.textContent });
      ta.addEventListener('change', function () {
        el.textContent = ta.value;
        if (file) sendEdit(opFor(el, { op: 'setText', text: ta.value }));
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
      el.setAttribute(n, valIn.value);
      if (fileFor(el)) sendEdit(opFor(el, { op: 'setAttr', name: n, value: valIn.value }));
    }
    valIn.addEventListener('change', commit);
    nameIn.addEventListener('change', commit);
    return h('div', { class: 'row' }, [nameIn, valIn, h('button', {
      class: 'mini', text: '×', title: 'Remove attribute',
      onclick: function (ev) {
        var n = nameIn.value.trim();
        if (n) {
          el.removeAttribute(n);
          if (fileFor(el)) sendEdit(opFor(el, { op: 'setAttr', name: n, value: null }));
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
      el.style.setProperty(p, valIn.value);
      if (fileFor(el)) sendEdit(opFor(el, { op: 'setStyle', property: p, value: valIn.value }));
      refreshOverlays();
    }
    valIn.addEventListener('change', commit);
    propIn.addEventListener('change', commit);
    return h('div', { class: 'row' }, [propIn, valIn, h('button', {
      class: 'mini', text: '×', title: 'Remove property',
      onclick: function (ev) {
        var p = propIn.value.trim();
        if (p && PROP_NAME_RE.test(p)) {
          el.style.removeProperty(p);
          if (fileFor(el)) sendEdit(opFor(el, { op: 'setStyle', property: p, value: null }));
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
    rebuildTree();
    rebuildProps();
    refreshOverlays();
  }

  // -------------------------------------------------------------------------
  // Select mode (crosshair) — capture-phase listeners on the document
  // -------------------------------------------------------------------------
  function onHover(ev) {
    if (isOurs(ev.target)) { ovHover.style.display = 'none'; return; }
    placeOverlay(ovHover, ev.target, null);
  }
  function onClickCapture(ev) {
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
    var sibs = Array.prototype.filter.call(parent.children, function (c) { return !isOurs(c); });
    var i = sibs.indexOf(el);
    if (dir === 'up' && i > 0) parent.insertBefore(el, sibs[i - 1]);
    else if (dir === 'down' && i < sibs.length - 1) parent.insertBefore(sibs[i + 1], el);
    else return;
    if (fileFor(el)) sendEdit(opFor(el, { op: 'move', direction: dir }));
    rebuildTree(); refreshOverlays();
  }
  upBtn.addEventListener('click', function () { move('up'); });
  downBtn.addEventListener('click', function () { move('down'); });

  delBtn.addEventListener('click', function () {
    var el = state.selected;
    if (!el) return;
    if (!window.confirm('Delete <' + el.tagName.toLowerCase() + '> from page and source?')) return;
    var op = fileFor(el) ? opFor(el, { op: 'remove' }) : null;
    el.remove();
    state.selected = null;
    if (op) sendEdit(op);
    rebuildTree(); rebuildProps(); refreshOverlays();
  });

  closeBtn.addEventListener('click', function () { api.disable(); });

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
