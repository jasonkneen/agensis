import type { Task, WorkspaceAgent } from '../types';

export interface CanvasAppDefinition {
  id: string;
  name: string;
  description: string;
  category: 'workspace' | 'generated';
  buildHtml: () => string;
  defaultWidth?: number;   // % of canvas width
  defaultHeight?: number;  // % of canvas height
}

export const CANVAS_APPS: CanvasAppDefinition[] = [
  {
    id: 'task-kanban',
    name: 'Task Kanban',
    description: 'A live task board applet for workspace tasks and agent run notes',
    category: 'workspace',
    buildHtml: buildTaskKanbanAppHtml,
  },
  {
    id: 'calculator',
    name: 'Calculator',
    description: 'Standard calculator with keyboard support and persistent state',
    category: 'generated',
    buildHtml: buildCalculatorAppHtml,
    defaultWidth: 22,
    defaultHeight: 52,
  },
];

export function makeAppletState(appId: string, state: Record<string, unknown> = {}) {
  return JSON.stringify({ appId, state });
}

export function makeDocAppletState(docId: string, appName: string, state: Record<string, unknown> = {}) {
  return JSON.stringify({ appId: appName, docId, state });
}

export function parseAppletState(value?: string | null) {
  if (!value) return { appId: '', docId: null as string | null, state: {} as Record<string, unknown> };
  try {
    const parsed = JSON.parse(value);
    return {
      appId: typeof parsed.appId === 'string' ? parsed.appId : '',
      docId: typeof parsed.docId === 'string' ? parsed.docId : null,
      state: parsed.state && typeof parsed.state === 'object' ? parsed.state as Record<string, unknown> : {},
    };
  } catch {
    return { appId: '', docId: null as string | null, state: {} as Record<string, unknown> };
  }
}

export function extractHtmlFromDocContent(content: string): string {
  const match = content.match(/```html[\s\r\n]+([\s\S]+?)```/i);
  return match ? match[1].trim() : '';
}

export const APPLETS_FOLDER = 'Applets';

export interface AgensisAppletInit {
  state: Record<string, unknown>;
  tasks: Task[];
  agents: WorkspaceAgent[];
  theme?: {
    family?: string;
    scheme?: string;
    tokens?: Record<string, string>;
  } | null;
}

/**
 * Shared applet theming contract.
 *
 * The host (CanvasObjectRenderer) delivers the active app theme to every applet
 * two ways, and BOTH write the same `--agensis-*` custom properties:
 *   1. Static: `injectAppletHostTheme` bakes a <style> into the iframe srcDoc
 *      (correct first paint, no JS needed) — see readAppletTheme() for the token
 *      list. Values are already resolved (e.g. --agensis-radius-md: 0px in neo).
 *   2. Live: on theme switch a `agensis:init` postMessage carries theme.tokens
 *      and AGENSIS_APPLET_THEME_JS re-writes the same `--agensis-*` names.
 *
 * Applets MUST style off the semantic `--app-*` vars below (or the `--agensis-*`
 * aliases directly) and NEVER off bare `--radius-md`/`--shadow-md`, because those
 * canonical names go stale on live switch (baked once into srcDoc). Reading the
 * `--agensis-*` alias keeps both paths coherent. Any applet that includes
 * AGENSIS_APPLET_BASE_CSS + AGENSIS_APPLET_THEME_JS inherits themed controls
 * (radius, shadow, border weight, accent) across classic / neo / paper.
 */
export const AGENSIS_APPLET_BASE_CSS = `
    :root {
      color-scheme: light dark;
      /* Surfaces */
      --app-bg: var(--agensis-canvas-base, var(--agensis-background, #f7f4ec));
      --app-panel: var(--agensis-card, var(--agensis-canvas-elevated, #fffaf0));
      --app-raised: var(--agensis-canvas-overlay, var(--agensis-canvas-raised, var(--app-panel)));
      /* Text */
      --app-ink: var(--agensis-text-primary, var(--agensis-foreground, #202024));
      --app-muted: var(--agensis-text-muted, var(--agensis-muted-foreground, #6d6760));
      /* Lines & fills */
      --app-line: var(--agensis-border, #2b2926);
      --app-soft: var(--agensis-secondary, var(--agensis-muted, #ece3d1));
      --app-accent: var(--agensis-primary, var(--agensis-accent, #4b7fd7));
      --app-accent-ink: var(--agensis-primary-foreground, #ffffff);
      --app-ok: var(--agensis-success, #2f9b69);
      --app-warn: var(--agensis-warning, #d6942c);
      --app-err: var(--agensis-error, #d64c4c);
      /* Shape — flow straight from the active theme (0px+hard-shadow in neo-brutal,
         rounded+soft in classic/paper). */
      --app-radius: var(--agensis-radius-md, 8px);
      --app-radius-sm: var(--agensis-radius-sm, 6px);
      --app-radius-lg: var(--agensis-radius-lg, 12px);
      --app-shadow: var(--agensis-shadow-sm, 2px 2px 0 rgba(0,0,0,.14));
      --app-shadow-md: var(--agensis-shadow-md, 4px 4px 0 rgba(0,0,0,.18));
      --app-border-w: var(--agensis-border-width, 1px);
    }`;

/**
 * Shared live-theme applier. Mirrors the host's `--agensis-<kebab>` alias naming
 * and sanitization exactly, so the static and live theme paths can never drift.
 * Inline into an applet's <script>, then call `applyAgensisTheme(payload.theme)`.
 */
export const AGENSIS_APPLET_THEME_JS = `
      function applyAgensisTheme(theme) {
        if (!theme) return;
        document.body.dataset.family = theme.family || "classic";
        document.body.dataset.scheme = theme.scheme || "light";
        var tokens = theme.tokens || {};
        if (tokens.neoStyle) document.body.dataset.neoStyle = tokens.neoStyle;
        var root = document.documentElement;
        for (var key in tokens) {
          if (!Object.prototype.hasOwnProperty.call(tokens, key)) continue;
          var value = tokens[key];
          if (value == null || value === "") continue;
          var name = "--agensis-" + key.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
          root.style.setProperty(name, String(value).replace(/[<>{};]/g, ""));
        }
        root.style.setProperty("color-scheme", theme.scheme === "dark" ? "dark" : "light");
      }`;

function buildTaskKanbanAppHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    ${AGENSIS_APPLET_BASE_CSS}
    :root {
      font: 13px/1.45 var(--agensis-font, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--app-bg); color: var(--app-ink); }
    body { overflow: hidden; }
    button, input, select, textarea { font: inherit; color: inherit; }
    .app { display: grid; grid-template-rows: auto auto 1fr; height: 100vh; gap: 10px; padding: 12px; }
    header { display: flex; align-items: center; gap: 10px; }
    h1 { margin: 0; font-size: 17px; line-height: 1.1; letter-spacing: 0; }
    .meta { color: var(--app-muted); font-size: 12px; }
    .toolbar { display: grid; grid-template-columns: minmax(160px, 1fr) 130px auto; gap: 8px; }
    .agentbar { display: grid; grid-template-columns: minmax(120px, 170px) minmax(180px, 1fr) auto; gap: 8px; }
    input, select, textarea {
      width: 100%;
      min-width: 0;
      border: var(--app-border-w) solid var(--app-line);
      border-radius: var(--app-radius-sm);
      background: var(--app-panel);
      padding: 8px 9px;
      outline: none;
      box-shadow: var(--app-shadow);
    }
    button {
      border: var(--app-border-w) solid var(--app-line);
      border-radius: var(--app-radius-sm);
      background: var(--app-accent);
      color: var(--app-accent-ink);
      padding: 8px 10px;
      font-weight: 750;
      cursor: pointer;
      box-shadow: var(--app-shadow);
      white-space: nowrap;
      transition: transform .08s ease, box-shadow .08s ease;
    }
    button.secondary { background: var(--app-panel); color: var(--app-ink); }
    .board { min-height: 0; display: grid; grid-template-columns: repeat(4, minmax(170px, 1fr)); gap: 10px; overflow: auto; padding: 2px 2px 8px; }
    .lane {
      min-width: 170px;
      min-height: 0;
      display: flex;
      flex-direction: column;
      border: var(--app-border-w) solid var(--app-line);
      border-radius: var(--app-radius);
      background: var(--app-panel);
      box-shadow: var(--app-shadow-md);
      overflow: hidden;
    }
    .lane h2 { margin: 0; padding: 9px 10px; border-bottom: var(--app-border-w) solid var(--app-line); font-size: 13px; background: var(--app-soft); }
    .cards { min-height: 120px; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    .card {
      border: var(--app-border-w) solid var(--app-line);
      border-radius: var(--app-radius-sm);
      background: var(--app-raised);
      padding: 8px;
      box-shadow: var(--app-shadow);
    }
    .card-title { font-weight: 750; overflow-wrap: anywhere; }
    .card-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 8px; }
    .pill { border: 1px solid var(--app-line); border-radius: 99px; padding: 2px 7px; color: var(--app-muted); font-size: 11px; background: var(--app-panel); }
    .mini { padding: 4px 7px; font-size: 11px; box-shadow: none; }
    .runs { border-top: var(--app-border-w) solid var(--app-line); background: var(--app-soft); max-height: 76px; overflow: auto; padding: 7px 8px; color: var(--app-muted); font-size: 12px; }
    .run { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
    /* Neo family: chunkier weight, accent lane headers, and the signature
       press-into-the-shadow interaction. Radius/shadow/border already flow from
       the theme tokens above, so no per-family shape overrides are needed. */
    body[data-family="neo"] { font-weight: 650; }
    body[data-family="neo"] .lane h2 {
      background: var(--app-accent);
      color: var(--app-accent-ink);
    }
    body[data-family="neo"] button.secondary,
    body[data-family="neo"] .pill {
      background: var(--app-panel);
      color: var(--app-ink);
    }
    body[data-family="neo"] button:active {
      transform: translate(var(--agensis-shadow-x, 2px), var(--agensis-shadow-y, 2px));
      box-shadow: none;
    }
    @media (max-width: 760px) {
      .toolbar, .agentbar { grid-template-columns: 1fr; }
      .board { grid-template-columns: repeat(4, minmax(150px, 72vw)); }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div>
        <h1>Task Kanban</h1>
        <div class="meta" id="summary">Waiting for workspace...</div>
      </div>
    </header>
    <section class="toolbar">
      <input id="newTitle" placeholder="Create a task..." />
      <select id="newPriority">
        <option value="normal">Normal</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
        <option value="low">Low</option>
      </select>
      <button id="createTask">Add task</button>
    </section>
    <main class="board" id="board"></main>
    <section class="agentbar">
      <select id="agentSelect"></select>
      <input id="agentPrompt" placeholder="Agent run note..." />
      <button id="queueRun" class="secondary">Queue run</button>
    </section>
    <section class="runs" id="runs"></section>
  </div>
  <script>
    (function () {
      var tasks = [];
      var agents = [];
      var state = { agentRuns: [] };
      var statuses = [
        ["todo", "To do"],
        ["in_progress", "In progress"],
        ["done", "Done"],
        ["cancelled", "Cancelled"]
      ];
      function post(type, payload) {
        parent.postMessage({ source: "agensis-applet", type: type, payload: payload || {} }, "*");
      }
      window.Agensis = {
        setState: function (next) { state = Object.assign({}, state, next || {}); post("agensis:setState", { state: state }); renderRuns(); },
        tasks: {
          create: function (input) { post("agensis:createTask", input); },
          update: function (id, updates) { post("agensis:updateTask", { id: id, updates: updates }); }
        },
        agents: {
          queueRun: function (input) {
            var runs = state.agentRuns || [];
            runs.unshift(Object.assign({ id: String(Date.now()), status: "queued", createdAt: new Date().toISOString() }, input || {}));
            window.Agensis.setState({ agentRuns: runs.slice(0, 20) });
          }
        }
      };
      window.addEventListener("error", function (event) {
        post("agensis:crash", { message: event.message, filename: event.filename, line: event.lineno });
      });
      window.addEventListener("unhandledrejection", function (event) {
        post("agensis:crash", { message: String(event.reason && event.reason.message || event.reason || "Unhandled promise rejection") });
      });
      // Inbound bridge from the host app. Treat every message as UNTRUSTED:
      // (a) only accept messages from our embedding parent window,
      // (b) require a well-formed object with a string type,
      // (c) allowlist the permitted inbound message types and drop the rest,
      // (d) never eval message content.
      var INBOUND_TYPES = { "agensis:init": true };
      window.addEventListener("message", function (event) {
        if (event.source !== window.parent) return;
        var msg = event.data;
        if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
        if (INBOUND_TYPES[msg.type] !== true) {
          try { console.warn("[agensis-applet] dropped unknown bridge message", msg.type); } catch (e) {}
          return;
        }
        var payload = (msg.payload && typeof msg.payload === "object") ? msg.payload : {};
        tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        agents = Array.isArray(payload.agents) ? payload.agents : [];
        state = Object.assign({ agentRuns: [] }, payload.state || {});
        applyAgensisTheme(payload.theme);
        render();
      });
${AGENSIS_APPLET_THEME_JS}
      function taskCount(status) {
        return tasks.filter(function (task) { return task.status === status && !task.parent_id; }).length;
      }
      function render() {
        var open = tasks.filter(function (task) { return task.status !== "done" && task.status !== "cancelled"; }).length;
        document.getElementById("summary").textContent = tasks.length + " tasks, " + open + " open";
        var board = document.getElementById("board");
        // INTENTIONAL full-HTML writes: this script runs inside the sandboxed
        // applet iframe and renders its own (parent-provided) document. These
        // innerHTML assignments are NOT routed through DOMPurify by design.
        // Most dynamic values use .textContent; a few parent-provided values
        // (e.g. agent.id, run.status) are interpolated with only partial
        // escaping — acceptable ONLY because the frame is sandboxed.
        board.innerHTML = statuses.map(function (pair) {
          return '<section class="lane" data-status="' + pair[0] + '"><h2>' + pair[1] + ' (' + taskCount(pair[0]) + ')</h2><div class="cards"></div></section>';
        }).join("");
        statuses.forEach(function (pair) {
          var container = board.querySelector('[data-status="' + pair[0] + '"] .cards');
          tasks.filter(function (task) { return task.status === pair[0] && !task.parent_id; }).forEach(function (task) {
            var card = document.createElement("article");
            card.className = "card";
            card.innerHTML = '<div class="card-title"></div><div class="card-row"><span class="pill"></span><span class="actions"></span></div>';
            card.querySelector(".card-title").textContent = task.title;
            card.querySelector(".pill").textContent = task.priority || "normal";
            var actions = card.querySelector(".actions");
            statuses.forEach(function (next) {
              if (next[0] === task.status) return;
              var btn = document.createElement("button");
              btn.className = "mini secondary";
              btn.textContent = next[1];
              btn.addEventListener("click", function () {
                window.Agensis.tasks.update(task.id, { status: next[0] });
              });
              actions.appendChild(btn);
            });
            container.appendChild(card);
          });
        });
        var agentSelect = document.getElementById("agentSelect");
        agentSelect.innerHTML = '<option value="">No agent</option>' + agents.map(function (agent) {
          return '<option value="' + agent.id + '">' + String(agent.name || "Agent").replace(/[<>&"]/g, "") + '</option>';
        }).join("");
        renderRuns();
      }
      function renderRuns() {
        var runs = state.agentRuns || [];
        var node = document.getElementById("runs");
        node.innerHTML = runs.length ? runs.map(function (run) {
          return '<div class="run"><span>' + String(run.prompt || "Agent run").replace(/[<>&"]/g, "") + '</span><span>' + run.status + '</span></div>';
        }).join("") : "No agent runs queued in this applet.";
      }
      document.getElementById("createTask").addEventListener("click", function () {
        var title = document.getElementById("newTitle").value.trim();
        if (!title) return;
        window.Agensis.tasks.create({ title: title, priority: document.getElementById("newPriority").value, source_type: "canvas" });
        document.getElementById("newTitle").value = "";
      });
      document.getElementById("newTitle").addEventListener("keydown", function (event) {
        if (event.key === "Enter") document.getElementById("createTask").click();
      });
      document.getElementById("queueRun").addEventListener("click", function () {
        var prompt = document.getElementById("agentPrompt").value.trim();
        if (!prompt) return;
        var agentId = document.getElementById("agentSelect").value;
        var agent = agents.find(function (item) { return item.id === agentId; });
        window.Agensis.agents.queueRun({ agentId: agentId || null, agentName: agent ? agent.name : "Unassigned", prompt: prompt });
        document.getElementById("agentPrompt").value = "";
      });
      post("agensis:ready");
    })();
  </script>
</body>
</html>`;
}

function buildCalculatorAppHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Calculator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
${AGENSIS_APPLET_BASE_CSS}
  /* Calculator palette derives entirely from the shared theme contract, so the
     control colours, radius and border weight track the active app theme
     (classic / neo-brutal / paper, light + dark). */
  :root {
    --bg: var(--app-bg);
    --surface: var(--app-panel);
    --surface2: var(--app-soft);
    --accent: var(--app-accent);
    --text: var(--app-ink);
    --text-muted: var(--app-muted);
    --btn-num: var(--app-panel);
    --btn-num-hover: var(--app-soft);
    --btn-op: var(--app-soft);
    --btn-op-hover: var(--app-line);
    --btn-eq: var(--app-accent);
    --btn-eq-hover: var(--app-accent);
    --btn-clear: var(--app-soft);
    --btn-clear-hover: var(--app-line);
    --radius: var(--app-radius);
    --shadow: var(--app-shadow-md);
    --font: var(--agensis-font, system-ui, -apple-system, sans-serif);
  }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    transition: background 0.3s, color 0.3s;
  }

  .calc {
    width: 100%;
    max-width: 340px;
    background: var(--surface);
    border: var(--app-border-w) solid var(--app-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .display {
    background: var(--bg);
    padding: 20px 24px 16px;
    text-align: right;
    min-height: 100px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 4px;
  }

  .display-expr {
    font-size: 14px;
    color: var(--text-muted);
    min-height: 20px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .display-main {
    font-size: 42px;
    font-weight: 300;
    letter-spacing: -1px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1;
  }

  .display-main.small { font-size: 28px; }
  .display-main.error { color: var(--accent); font-size: 18px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--app-border-w);
    background: var(--app-line);
    padding: var(--app-border-w);
  }

  button {
    font-family: var(--font);
    font-size: 18px;
    font-weight: 400;
    padding: 20px 0;
    border: none;
    cursor: pointer;
    transition: background 0.12s, transform 0.08s;
    color: var(--text);
    background: var(--btn-num);
    outline: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }

  button:hover { background: var(--btn-num-hover); }
  button:active { transform: scale(0.95); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  button.op { background: var(--btn-op); color: var(--app-accent); font-size: 22px; }
  button.op:hover { background: var(--btn-op-hover); }

  button.eq {
    background: var(--btn-eq);
    color: var(--app-accent-ink);
    font-size: 24px;
    font-weight: 300;
  }
  button.eq:hover { background: var(--btn-eq-hover); filter: brightness(1.08); }

  button.clear { background: var(--btn-clear); color: var(--app-muted); }
  button.clear:hover { background: var(--btn-clear-hover); }

  button.zero { grid-column: span 2; }

  .kbd-hint {
    text-align: center;
    font-size: 11px;
    color: var(--text-muted);
    padding: 8px;
    background: var(--surface);
  }
</style>
</head>
<body>
<div class="calc" role="application" aria-label="Calculator">
  <div class="display" aria-live="polite" aria-atomic="true">
    <div class="display-expr" id="expr"></div>
    <div class="display-main" id="main">0</div>
  </div>
  <div class="grid">
    <button class="clear" data-action="clear" aria-label="Clear all">AC</button>
    <button class="clear" data-action="sign"  aria-label="Toggle sign">+/−</button>
    <button class="clear" data-action="pct"   aria-label="Percent">%</button>
    <button class="op"    data-action="op" data-op="÷" aria-label="Divide">÷</button>

    <button data-action="digit" data-val="7">7</button>
    <button data-action="digit" data-val="8">8</button>
    <button data-action="digit" data-val="9">9</button>
    <button class="op" data-action="op" data-op="×" aria-label="Multiply">×</button>

    <button data-action="digit" data-val="4">4</button>
    <button data-action="digit" data-val="5">5</button>
    <button data-action="digit" data-val="6">6</button>
    <button class="op" data-action="op" data-op="−" aria-label="Subtract">−</button>

    <button data-action="digit" data-val="1">1</button>
    <button data-action="digit" data-val="2">2</button>
    <button data-action="digit" data-val="3">3</button>
    <button class="op" data-action="op" data-op="+" aria-label="Add">+</button>

    <button class="zero" data-action="digit" data-val="0" aria-label="Zero">0</button>
    <button data-action="dot" aria-label="Decimal point">.</button>
    <button class="eq" data-action="equals" aria-label="Equals">=</button>
  </div>
  <div class="kbd-hint">keyboard supported</div>
</div>

<script>
// ── State ──────────────────────────────────────────────────────────────────
const ST = {
  current:   '0',
  prev:      null,
  op:        null,
  justEvaled: false,
  error:     false,
};

// ── Theme from agensis (shared contract) ───────────────────────────────────
${AGENSIS_APPLET_THEME_JS}

// ── Display ────────────────────────────────────────────────────────────────
const mainEl = document.getElementById('main');
const exprEl = document.getElementById('expr');

function fmt(n) {
  if (n === null || n === undefined) return '0';
  const s = String(n);
  if (s.length > 12) {
    const num = parseFloat(n);
    if (isNaN(num)) return 'Error';
    const exp = num.toExponential(4);
    return exp.length < 14 ? exp : 'Overflow';
  }
  return s;
}

function render() {
  const text = ST.error ? 'Error' : fmt(ST.current);
  mainEl.textContent = text;
  mainEl.className = 'display-main' +
    (ST.error ? ' error' : text.length > 9 ? ' small' : '');

  if (ST.op && ST.prev !== null && !ST.justEvaled) {
    exprEl.textContent = fmt(ST.prev) + ' ' + ST.op;
  } else if (ST.justEvaled && ST.prev !== null) {
    exprEl.textContent = fmt(ST.prev) + ' ' + ST.op + ' ' + fmt(ST._lastInput) + ' =';
  } else {
    exprEl.textContent = '';
  }
}

// ── Logic ──────────────────────────────────────────────────────────────────
function calc(a, b, op) {
  const fa = parseFloat(a), fb = parseFloat(b);
  switch (op) {
    case '+': return fa + fb;
    case '−': return fa - fb;
    case '×': return fa * fb;
    case '÷': return fb === 0 ? null : fa / fb;
  }
  return fb;
}

function cleanNum(n) {
  if (typeof n === 'number') {
    if (!isFinite(n)) return null;
    // avoid floating-point display noise
    const r = parseFloat(n.toPrecision(12));
    return String(r);
  }
  return String(n);
}

function dispatch(action, payload) {
  if (ST.error && action !== 'clear') return;

  switch (action) {
    case 'digit': {
      const v = payload;
      if (ST.justEvaled) {
        ST.current = v === '0' ? '0' : v;
        ST.prev = null; ST.op = null; ST.justEvaled = false;
      } else if (ST.current === '0' && v !== '.') {
        ST.current = v;
      } else if (ST.current.length < 15) {
        ST.current += v;
      }
      break;
    }
    case 'dot': {
      if (ST.justEvaled) { ST.current = '0.'; ST.justEvaled = false; break; }
      if (!ST.current.includes('.')) ST.current += '.';
      break;
    }
    case 'op': {
      const op = payload;
      if (ST.op && !ST.justEvaled && ST.prev !== null) {
        const r = calc(ST.prev, ST.current, ST.op);
        if (r === null) { ST.error = true; break; }
        ST.prev = cleanNum(r);
        ST.current = ST.prev;
      } else {
        ST.prev = ST.current;
      }
      ST.op = op;
      ST.justEvaled = false;
      ST.current = '0';
      break;
    }
    case 'equals': {
      if (!ST.op || ST.prev === null) break;
      const input = ST.justEvaled ? ST._lastInput : ST.current;
      ST._lastInput = input;
      const r = calc(ST.prev, input, ST.op);
      if (r === null) { ST.error = true; break; }
      ST.current = cleanNum(r);
      ST.justEvaled = true;
      break;
    }
    case 'sign': {
      if (ST.current !== '0') {
        ST.current = ST.current.startsWith('-')
          ? ST.current.slice(1)
          : '-' + ST.current;
      }
      break;
    }
    case 'pct': {
      const v = parseFloat(ST.current);
      ST.current = cleanNum(v / 100);
      break;
    }
    case 'clear': {
      Object.assign(ST, { current: '0', prev: null, op: null, justEvaled: false, error: false, _lastInput: undefined });
      break;
    }
  }

  render();
  saveState();
}

// ── Persistence (agensis) ──────────────────────────────────────────────────
function saveState() {
  try {
    window.parent.postMessage({
      source: 'agensis-applet',
      type:   'agensis:setState',
      payload: { state: { current: ST.current, prev: ST.prev, op: ST.op } },
    }, '*');
  } catch (_) {}
}

// ── Event wiring ───────────────────────────────────────────────────────────
document.querySelector('.grid').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { action, op, val } = btn.dataset;
  if (action === 'digit') dispatch('digit', val);
  else if (action === 'op') dispatch('op', op);
  else dispatch(action);
});

const KEY_MAP = {
  '0':'digit:0','1':'digit:1','2':'digit:2','3':'digit:3','4':'digit:4',
  '5':'digit:5','6':'digit:6','7':'digit:7','8':'digit:8','9':'digit:9',
  '.':'dot',',':'dot',
  '+':'op:+','-':'op:−','*':'op:×','/':'op:÷','x':'op:×',
  'Enter':'equals','=':'equals',
  'Escape':'clear','Backspace':'backspace','Delete':'clear',
  '%':'pct',
};

document.addEventListener('keydown', e => {
  const cmd = KEY_MAP[e.key];
  if (!cmd) return;
  e.preventDefault();
  if (cmd === 'backspace') {
    if (ST.error) { dispatch('clear'); return; }
    ST.current = ST.current.length > 1 ? ST.current.slice(0, -1) : '0';
    render(); saveState(); return;
  }
  const [action, payload] = cmd.split(':');
  dispatch(action, payload);
});

// ── agensis SDK ────────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'agensis:init') return;
  const { state, theme } = e.data.payload || {};
  if (theme) applyAgensisTheme(theme);
  if (state) {
    ST.current = state.current ?? '0';
    ST.prev    = state.prev    ?? null;
    ST.op      = state.op      ?? null;
  }
  render();
});

// Signal ready
window.parent.postMessage({ source: 'agensis-applet', type: 'agensis:ready' }, '*');

// Catch unhandled errors
window.addEventListener('error', ev => {
  window.parent.postMessage({
    source: 'agensis-applet', type: 'agensis:crash',
    payload: { message: ev.message || 'Unknown error' },
  }, '*');
});

// Initial render
render();
</script>
</body>
</html>`;
}
