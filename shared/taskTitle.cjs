'use strict';

// ---------------------------------------------------------------------------
// Task title normalisation.
//
// Agents keep faking hierarchy and ordering inside `tasks.title`, despite the
// create_task tool description telling them not to:
//
//   "Ship UI work / 1. Push main to origin (Netlify build)"
//   "Ship UI work / 2. fly deploy for the server changes"
//   "1.2.1 Wire the panel"
//
// The columns for that already exist (`parent_id`, `depends_on`), so the text
// is pure noise — it reads as clutter in every view and the fake numbering goes
// stale the moment anything is reordered.
//
// This module is the guard rail. It runs on CREATE only, and it is deliberately
// timid: a title it is not sure about is returned untouched, byte for byte.
// A false positive silently corrupts user data, a false negative just leaves a
// prefix the user can delete, so the two failures are not remotely equal.
//
// What it will strip (and only at the very start of the title):
//   "3. Foo"            -> "Foo"          numbering with a trailing dot
//   "1.2. Foo"          -> "Foo"
//   "1.2.1 Foo"         -> "Foo"          >= 3 components, dot optional
//   "Parent / 3. Foo"   -> "Foo"          + reports "Parent" as the parent path
//
// What it will NOT touch:
//   "2026 roadmap"      digits, no dot at all
//   "3D view removal"   no separator between the digit and the word
//   "3.5 Sonnet eval"   two components and no trailing dot — that is a version
//                       or a decimal, not an outline number
//   "1.5x faster"       same, and not followed by whitespace
//   "and/or handling"   a slash with no numbering after it
//   "1. "               nothing meaningful would be left
// ---------------------------------------------------------------------------

/**
 * A leading outline number: digits, optionally dot-separated, optionally with a
 * trailing dot, and ALWAYS followed by whitespace. The trailing `\s+` is what
 * keeps "3D" and "1.5x" out.
 */
const LEADING_NUMBERING = /^(\d+(?:\.\d+)*)(\.?)\s+/;

/**
 * A single leading path segment: up to 64 non-slash characters, then a slash.
 * Capped so a long sentence containing a slash cannot be eaten as a "parent".
 */
const LEADING_PATH = /^([^/\n]{1,64}?)\s*\/\s*(?=\S)/;

/** Shortest remainder we are willing to reduce a title to. */
const MIN_REMAINDER = 2;

/**
 * Strip a leading outline number, or return null to leave the text alone.
 *
 * Two components with no trailing dot ("3.5 Sonnet eval") are ambiguous with
 * version numbers and decimals, so they are left alone. Three or more
 * components ("1.2.1") are not ambiguous with anything.
 */
function stripLeadingNumbering(text) {
 const match = LEADING_NUMBERING.exec(text);
 if (!match) return null;
 const componentCount = match[1].split('.').length;
 const hasTrailingDot = match[2] === '.';
 if (!hasTrailingDot && componentCount < 3) return null;
 const rest = text.slice(match[0].length).trim();
 if (rest.length < MIN_REMAINDER) return null;
 return rest;
}

/**
 * Normalise a task title on create.
 *
 * @param {unknown} rawTitle
 * @returns {{ title: string, parentTitle: string|null, changed: boolean }}
 *   `changed: false` returns the input EXACTLY as given (not even trimmed), so
 *   a caller can pass the result straight through without thinking about it.
 */
function normalizeTaskTitle(rawTitle) {
 const original = typeof rawTitle === 'string' ? rawTitle : '';
 const unchanged = { title: original, parentTitle: null, changed: false };
 const trimmed = original.trim();
 if (!trimmed) return unchanged;

 // "Parent / 3. Foo" — a path segment is only a parent path when real
 // numbering follows it. Without that, "and/or handling" would lose its start.
 const path = LEADING_PATH.exec(trimmed);
 if (path) {
  const parentTitle = path[1].trim();
  const stripped = stripLeadingNumbering(trimmed.slice(path[0].length));
  if (stripped && parentTitle.length >= MIN_REMAINDER) {
   return { title: stripped, parentTitle, changed: true };
  }
 }

 const stripped = stripLeadingNumbering(trimmed);
 if (stripped) return { title: stripped, parentTitle: null, changed: true };
 return unchanged;
}

/**
 * Resolve the task a stripped parent path named, or null.
 *
 * Exact (case- and whitespace-insensitive) title match inside the workspace,
 * and ONLY when exactly one task matches — two candidates means we cannot know
 * which one was meant, and guessing would move a task under the wrong parent.
 *
 * @param {(sql: string, params: unknown[]) => Promise<Array<{id: string}>>} query
 */
async function resolveTaskParentByTitle(query, workspaceId, parentTitle) {
 const wanted = String(parentTitle || '').trim();
 if (!wanted || !workspaceId) return null;
 const rows = await query(
  `select id from tasks
     where workspace_id = $1 and lower(btrim(title)) = lower(btrim($2))
     limit 2`,
  [workspaceId, wanted],
 );
 return Array.isArray(rows) && rows.length === 1 ? rows[0].id : null;
}

module.exports = {
 normalizeTaskTitle,
 resolveTaskParentByTitle,
 LEADING_NUMBERING,
 LEADING_PATH,
};
