import type { SystemCapabilities } from './backendClient';
import type { SkillEntry } from './skillsView';

// ---------------------------------------------------------------------------
// The Skills field on an agent, as a token/chip input — every decision it makes,
// out of the component and into functions a test can hold still.
//
// THE STORAGE SHAPE DOES NOT MOVE. `workspace_agents.skills` is `jsonb` holding
// an array of STRINGS and five surfaces read it that way (see the header of
// server/sandbox-skills.cjs). The Agents form has always round-tripped it as a
// COMMA-SEPARATED STRING, and it still does: `agentFormUpdates` splits that
// string, and the edit pane's sparse diff compares the split arrays against the
// baseline it seeded from. So the chips live entirely inside the field —
// `value` in, `value` out, same comma-joined string — and nothing downstream
// can tell the difference. Converting at the form boundary is the whole design.
//
// The corollary, and the reason `parseSkillTokens` dedupes EXACTLY rather than
// case-insensitively: opening an agent and saving it without touching the
// Skills field must produce no `skills` key in the patch. That holds only if
// parsing is faithful to what was stored. An agent carrying both `Foo` and
// `foo` is odd, but silently collapsing them on open would turn a no-op save
// into a write. Adding through the UI is the opposite case — see
// `addSkillToken`, which refuses a case-insensitive repeat, because a human
// typing `foo` under a chip that says `Foo` means the one they can already see.
// ---------------------------------------------------------------------------

/** One row the field can offer. `value` is what lands in the field. */
export interface SkillSuggestion {
  value: string;
  label: string;
  /** Where it came from, shown right-aligned on the row. Never a count alone. */
  detail: string;
}

/**
 * A row in the open menu. `custom` is the free-typed value — this field is how
 * a skill name that nothing knows about yet enters the system, so it is always
 * offered, under the matches (see `skillMenuOptions`).
 */
export interface SkillMenuOption {
  kind: 'suggestion' | 'custom';
  value: string;
  label: string;
  detail: string;
}

export interface SkillFieldState {
  tokens: string[];
  draft: string;
  /** Index into the menu options. -1 while nothing is highlighted. */
  activeIndex: number;
  open: boolean;
}

/** How many rows the menu shows at once. */
export const SKILL_MENU_LIMIT = 8;

function trimToken(value: unknown): string {
  return String(value ?? '').trim();
}

function sameToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The stored/serialized form value -> chips. Commas and newlines both separate
 * (a pasted list from a terminal arrives newline-separated), empties are
 * dropped, exact repeats collapse — the same normalization the plain input did
 * via `splitList` + `Set`, so a value that round-trips through this field is
 * byte-identical to what it was.
 */
export function parseSkillTokens(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(value ?? '').split(/[,\n]/)) {
    const token = part.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** Chips -> the form value. `, ` matches what `joinList` seeds the form with. */
export function serializeSkillTokens(tokens: readonly string[]): string {
  return tokens.join(', ');
}

/**
 * Add one token. Whitespace is trimmed, an empty value is ignored, and a value
 * that already exists — under any casing — is a no-op rather than a second chip.
 * Returns the SAME array reference when nothing changed, so a caller can use
 * identity to decide whether to fire onChange.
 */
export function addSkillToken(tokens: readonly string[], raw: string): string[] {
  const token = trimToken(raw);
  if (!token) return tokens as string[];
  if (tokens.some(existing => sameToken(existing, token))) return tokens as string[];
  return [...tokens, token];
}

/** Remove the chip at `index`. Out-of-range is a no-op, not a truncation. */
export function removeSkillTokenAt(tokens: readonly string[], index: number): string[] {
  if (index < 0 || index >= tokens.length) return tokens as string[];
  return tokens.filter((_, i) => i !== index);
}

/**
 * Every skill this workspace knows a name for, in the order the menu shows them.
 *
 * The union of three sources on purpose. `capabilities.skills` alone — all the
 * old button row offered — is the skill LIBRARIES found on the backend host,
 * which says nothing about the skills the agents in this workspace actually
 * carry; a suggestion list that can't offer a name already sitting on the agent
 * next to it reads as broken. So: skills any agent advertises or has configured
 * (both already unioned into `SkillEntry` by buildSkillEntries), the catalog
 * agensis ships (same source, origin 'catalog'), then the host libraries.
 *
 * Carried skills sort first because they are the ones a human is most likely to
 * be copying onto another agent.
 */
export function buildSkillSuggestions(
  entries: readonly SkillEntry[],
  capabilities: SystemCapabilities | null,
): SkillSuggestion[] {
  const seen = new Set<string>();
  const carried: SkillSuggestion[] = [];
  const catalog: SkillSuggestion[] = [];

  for (const entry of entries) {
    const value = trimToken(entry.name);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    if (entry.agents.length > 0) {
      carried.push({
        value,
        label: value,
        detail: entry.agents.length === 1 ? '1 agent' : `${entry.agents.length} agents`,
      });
    } else {
      // A workspace-authored skill and one agensis ships both have a readable
      // body and neither is carried yet, but they are not the same offer:
      // "Written here" is a procedure a teammate wrote in this workspace, and
      // saying "In agensis" over it would credit the wrong author.
      catalog.push({ value, label: value, detail: entry.stored ? 'Written here' : 'In agensis' });
    }
  }

  const libraries: SkillSuggestion[] = [];
  for (const lib of capabilities?.skills || []) {
    if (!lib.available) continue;
    const value = trimToken(lib.id);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    libraries.push({
      value,
      label: trimToken(lib.label) || value,
      detail: lib.count > 0 ? `Library · ${lib.count}` : 'Library',
    });
  }

  const byLabel = (a: SkillSuggestion, b: SkillSuggestion) => a.label.localeCompare(b.label);
  return [...carried.sort(byLabel), ...catalog.sort(byLabel), ...libraries.sort(byLabel)];
}

/**
 * The skill names on an agent (or on a template being applied) that NOTHING in
 * this workspace can supply a body for.
 *
 * THE DANGLING-REFERENCE CHECK. `workspace_agents.skills` and a template's
 * `skills` array are both lists of NAMES, and a name resolves to nothing on its
 * own — so a template authored elsewhere could say `skills: ['security-review']`
 * and export a claim with no procedure behind it. Nothing surfaced that, which
 * is how an agent came to advertise a skill it could not read.
 *
 * A name is BACKED when any of three things is true, and each is a real body:
 *   - it is written in this workspace (`workspace_skills`),
 *   - agensis ships a definition for it (origin 'catalog'),
 *   - a live daemon advertises it, so the machine holding it really has the file.
 *
 * A name that is only CONFIGURED on an agent nothing is connected to is exactly
 * the claim-without-a-procedure case, and it is reported. The remedy is now one
 * click — write the skill here — which is why saying so is worth the space.
 */
export function unresolvedSkillTokens(
  tokens: readonly string[],
  entries: readonly SkillEntry[],
): string[] {
  const backed = new Set<string>();
  for (const entry of entries) {
    if (entry.stored || entry.origin === 'catalog' || entry.advertised) {
      backed.add(entry.name.toLowerCase());
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const token = trimToken(raw);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key) || backed.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/**
 * The rows to draw, for a draft and the chips already chosen.
 *
 * Chosen skills are filtered out — offering a chip you already have is offering
 * a no-op. Matches rank prefix-first (typing `sand` should reach
 * `sandbox-provider-box` before `aws-sandbox`) and otherwise hold the order
 * `buildSkillSuggestions` put them in.
 *
 * With an empty draft the whole list is browsable, which is what the old row of
 * buttons was for. The `custom` row appears only for a draft that isn't already
 * a chip and isn't an exact suggestion — otherwise it would be a duplicate of
 * the row above it — and it sits at the BOTTOM, so Enter lands on the best
 * match rather than on the half-typed name.
 */
export function skillMenuOptions(
  suggestions: readonly SkillSuggestion[],
  draft: string,
  tokens: readonly string[],
  limit: number = SKILL_MENU_LIMIT,
): SkillMenuOption[] {
  const query = trimToken(draft).toLowerCase();
  const chosen = new Set(tokens.map(token => token.toLowerCase()));

  const scored: Array<{ option: SkillMenuOption; score: number; order: number }> = [];
  suggestions.forEach((suggestion, order) => {
    const value = suggestion.value.toLowerCase();
    if (chosen.has(value)) return;
    let score = 0;
    if (query) {
      const label = suggestion.label.toLowerCase();
      if (value.startsWith(query) || label.startsWith(query)) score = 0;
      else if (value.includes(query) || label.includes(query)) score = 1;
      else return;
    }
    scored.push({
      option: { kind: 'suggestion', value: suggestion.value, label: suggestion.label, detail: suggestion.detail },
      score,
      order,
    });
  });

  scored.sort((a, b) => (a.score - b.score) || (a.order - b.order));
  const rows = scored.slice(0, Math.max(0, limit)).map(item => item.option);

  const typed = trimToken(draft);
  const exact = typed
    && (chosen.has(typed.toLowerCase()) || suggestions.some(s => sameToken(s.value, typed)));
  if (typed && !exact) {
    // LAST, not first. Enter with nothing highlighted takes row 0, and after
    // typing `sand` the row a human means is `sandbox-provider-box`, not the
    // literal three letters. When nothing matches, this is row 0 anyway — which
    // is exactly when the free-typed name IS what they mean.
    // No detail on this row: the label already reads `Add "…"`, and repeating
    // the word down the right-hand column is noise.
    rows.push({ kind: 'custom', value: typed, label: typed, detail: '' });
  }
  return rows;
}

/** Wrap-around movement through the menu. An empty menu has no active row. */
export function nextActiveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return ((current + delta) % length + length) % length;
}

/**
 * One keystroke, applied. `handled` means the component should
 * `preventDefault()` — and, just as importantly, that when it is FALSE the key
 * belongs to somebody else: Escape with the menu closed must reach the dialog
 * that wants to close, and Backspace with text in the draft must delete a
 * character.
 *
 * Backspace on an empty draft removes the last chip. That is the behaviour
 * every token field has, and it is why this is a state machine rather than a
 * pile of conditions inside an onKeyDown.
 */
export function applySkillFieldKey(
  state: SkillFieldState,
  key: string,
  options: readonly SkillMenuOption[],
): { state: SkillFieldState; handled: boolean } {
  const unhandled = { state, handled: false };

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const delta = key === 'ArrowDown' ? 1 : -1;
    if (!state.open) return { state: { ...state, open: true, activeIndex: options.length > 0 ? 0 : -1 }, handled: true };
    if (options.length === 0) return { state, handled: true };
    return { state: { ...state, activeIndex: nextActiveIndex(state.activeIndex, delta, options.length) }, handled: true };
  }

  if (key === 'Escape') {
    if (!state.open) return unhandled;
    return { state: { ...state, open: false, activeIndex: -1 }, handled: true };
  }

  if (key === 'Enter' || key === ',') {
    // The highlighted row if there is one; otherwise the first row, which is
    // the `custom` one whenever the draft is a name nothing knows yet.
    const picked = (state.open && state.activeIndex >= 0 ? options[state.activeIndex] : options[0]) || null;
    const value = picked ? picked.value : trimToken(state.draft);
    if (!value) return { state, handled: key === ',' };
    return {
      state: { ...state, tokens: addSkillToken(state.tokens, value), draft: '', activeIndex: -1, open: false },
      handled: true,
    };
  }

  if (key === 'Backspace') {
    if (state.draft !== '' || state.tokens.length === 0) return unhandled;
    return { state: { ...state, tokens: state.tokens.slice(0, -1) }, handled: true };
  }

  return unhandled;
}

/**
 * Typed or pasted text. Everything before the last separator becomes chips, so
 * pasting `a, b, c` lands three chips and leaves the field empty, and pasting
 * `a, b, c` with no trailing comma leaves `c` in the draft to be confirmed.
 */
export function applySkillFieldInput(state: SkillFieldState, raw: string): SkillFieldState {
  if (!/[,\n]/.test(raw)) return { ...state, draft: raw, open: true, activeIndex: -1 };
  const parts = raw.split(/[,\n]/);
  const draft = parts.pop() ?? '';
  let tokens = state.tokens;
  for (const part of parts) tokens = addSkillToken(tokens, part);
  return { ...state, tokens, draft, open: true, activeIndex: -1 };
}
