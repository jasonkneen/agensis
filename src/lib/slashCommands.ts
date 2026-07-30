// Slash-command model for the chat composer.
//
// Typing `/` at the start of a word opens a picker of things the workspace can do.
// Three kinds, mirroring Jason's taxonomy:
//   - builtin        → a client-side app action (/clear, /split). Executes, never inserts.
//   - command        → a loose `.claude/commands/*.md` file. Inserts `/name` as text.
//   - skill          → a skill/plugin namespace (parent). Inserts `/name` as text.
//   - skill-command  → a command that lives inside a skill (parent:child). Inserts as text.
//
// Built-ins EXECUTE (run: 'action'); everything else INSERTS a text token the target
// agent reads as an instruction (run: 'insert') — consistent with how @agent / #group
// tokens already work in the composer.

export type SlashItemKind = 'builtin' | 'command' | 'skill' | 'skill-command';

// Client-side actions a built-in can fire. The composer maps these ids to real
// handlers; keeping them as ids means this module has zero React/handler coupling.
export type SlashActionId = 'clear' | 'restore' | 'split';

export type SlashItem = {
  /** Stable id, e.g. "builtin:clear", "skill:cascade", "skill-command:cascade:cascade-plan". */
  id: string;
  /** Bare name shown after the slash, e.g. "clear", "cascade-plan". */
  name: string;
  kind: SlashItemKind;
  /** Owning skill/plugin name for skill-commands (drives the nested display). */
  parent?: string;
  /** One-line description or source hint. */
  detail?: string;
  /** 'action' executes a client handler; 'insert' drops a text token into the draft. */
  run: 'action' | 'insert';
  /** For run: 'insert' — the exact text to insert (defaults to `/name`). */
  insertText?: string;
  /** For run: 'action' — which built-in handler to fire. */
  action?: SlashActionId;
};

// The built-in registry. These are the only items that execute. `available` handlers
// are decided by the composer at render time (e.g. /split only when splitting is wired).
export const BUILTIN_SLASH_ITEMS: SlashItem[] = [
  {
    id: 'builtin:clear',
    name: 'clear',
    kind: 'builtin',
    run: 'action',
    action: 'clear',
    detail: 'Clear this view — messages stay, scroll up to restore',
  },
  {
    id: 'builtin:restore',
    name: 'restore',
    kind: 'builtin',
    run: 'action',
    action: 'restore',
    detail: 'Restore cleared messages back into view',
  },
  {
    id: 'builtin:split',
    name: 'split',
    kind: 'builtin',
    run: 'action',
    action: 'split',
    detail: 'Split this thread into a sub-thread',
  },
];

/** The text a run: 'insert' item drops into the draft. */
export function slashInsertText(item: SlashItem): string {
  return item.insertText ?? `/${item.name}`;
}

// ---- Fuzzy matching ---------------------------------------------------------

const SCORE = {
  exact: 1000,
  prefix: 800,
  wordBoundary: 600,
  subsequence: 400,
  builtinBoost: 60,
} as const;

// Score `query` against a single haystack string. Higher is better; -1 = no match.
function scoreString(haystack: string, query: string): number {
  if (!query) return 1; // empty query matches everything, lowest positive score
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  if (h === q) return SCORE.exact;
  if (h.startsWith(q)) return SCORE.prefix - (h.length - q.length);

  // Word-boundary prefix: query starts one of the segments (split on - _ : / space).
  const segments = h.split(/[-_:/\s]+/).filter(Boolean);
  let offset = 0;
  for (const seg of segments) {
    if (seg.startsWith(q)) return SCORE.wordBoundary - offset - (seg.length - q.length);
    offset += seg.length;
  }

  // Subsequence: all query chars appear in order. Penalise gaps.
  let hi = 0;
  let gaps = 0;
  let lastMatch = -1;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    for (; hi < h.length; hi += 1) {
      if (h[hi] === ch) {
        found = hi;
        hi += 1;
        break;
      }
    }
    if (found === -1) return -1;
    if (lastMatch >= 0) gaps += found - lastMatch - 1;
    lastMatch = found;
  }
  return SCORE.subsequence - gaps;
}

/** Best score for an item, aware of its parent (so `/casc` surfaces cascade's children). */
export function scoreSlashItem(item: SlashItem, query: string): number {
  const q = query.replace(/^\//, '');
  const candidates = [item.name];
  if (item.parent) {
    candidates.push(item.parent, `${item.parent}:${item.name}`, `${item.parent} ${item.name}`);
  }
  let best = -1;
  for (const candidate of candidates) {
    best = Math.max(best, scoreString(candidate, q));
  }
  if (best < 0) return -1;
  if (item.kind === 'builtin') best += SCORE.builtinBoost;
  return best;
}

/** Rank items by fuzzy match against the query (leading slash optional). */
export function matchSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.replace(/^\//, '');
  return items
    .map(item => ({ item, score: scoreSlashItem(item, q) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.name.localeCompare(b.item.name);
    })
    .map(entry => entry.item);
}

// ---- Grouping (built-ins → commands → skills-with-children) -----------------

export type SlashGroup =
  | { type: 'builtin'; label: string; items: SlashItem[] }
  | { type: 'command'; label: string; items: SlashItem[] }
  | { type: 'skill'; label: string; parent?: SlashItem; children: SlashItem[] };

// Turn a ranked flat list into grouped sections for the menu, preserving the
// parent→child nesting. Built-ins always lead; remaining groups follow in
// best-match order. Ranking within each group is preserved from the input.
export function groupSlashItems(ranked: SlashItem[]): SlashGroup[] {
  const builtins = ranked.filter(i => i.kind === 'builtin');
  const commands = ranked.filter(i => i.kind === 'command');
  const skillLeaves = ranked.filter(i => i.kind === 'skill');
  const skillCommands = ranked.filter(i => i.kind === 'skill-command');

  const groups: SlashGroup[] = [];
  if (builtins.length) groups.push({ type: 'builtin', label: 'Built-in', items: builtins });
  if (commands.length) groups.push({ type: 'command', label: 'Commands', items: commands });

  // One group per skill parent. A parent may exist as a leaf, as the owner of
  // matched children, or both. Preserve first-seen order (already rank-ordered).
  const order: string[] = [];
  const byParent = new Map<string, { parent?: SlashItem; children: SlashItem[] }>();
  const ensure = (name: string) => {
    if (!byParent.has(name)) {
      byParent.set(name, { parent: undefined, children: [] });
      order.push(name);
    }
    return byParent.get(name)!;
  };
  for (const leaf of skillLeaves) ensure(leaf.name).parent = leaf;
  for (const cmd of skillCommands) {
    const key = cmd.parent || cmd.name;
    ensure(key).children.push(cmd);
  }
  for (const name of order) {
    const entry = byParent.get(name)!;
    groups.push({ type: 'skill', label: name, parent: entry.parent, children: entry.children });
  }
  return groups;
}
