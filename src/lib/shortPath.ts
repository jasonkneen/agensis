/**
 * Filesystem paths, shortened for a log you SCAN rather than read.
 *
 * The Activity window's rows are dominated by absolute paths that all share the
 * same 55-character prefix — `/Users/<me>/Documents/GitHub/<repo>/.worktrees/…` —
 * so twenty consecutive rows look identical and the one part that differs (the
 * file) is the part a CSS `truncate` throws away first. Shortening from the
 * FRONT inverts that: the distinguishing end always survives.
 *
 * Two rules, in order:
 *
 *  1. A home directory collapses to `~`. `/Users/me`, `/home/me` and
 *     `C:\Users\me` are the three shapes that actually appear; this is a shape
 *     match, not a lookup, because a browser cannot know the host's `$HOME`.
 *  2. If the result is still over `budget`, leading segments are dropped one at
 *     a time and replaced with a single `…`, never going below `keep` trailing
 *     segments. So a path is only ever elided in the middle-to-front, and the
 *     filename plus at least one parent directory is guaranteed to survive
 *     however long the path is.
 *
 * Anything that is already inside the budget comes back byte-for-byte unchanged
 * — including short paths, bare filenames and strings that merely look
 * path-shaped. Callers are expected to keep the untouched original available on
 * hover, because a shortened path is a label, not an address.
 *
 * No React, no DOM: this is string logic and is tested as such.
 */

/**
 * Characters a path may occupy before segments start being dropped. Sized so
 * `~/Documents/GitHub/agensis-agent/.worktrees/x/src/App.tsx` lands on
 * `…/agensis-agent/.worktrees/x/src/App.tsx` — repo, worktree, and file — which
 * is the least a person needs to tell two otherwise identical rows apart.
 */
export const SHORT_PATH_BUDGET = 44;

/** Trailing segments that are never dropped, however far over budget they are. */
const KEEP_SEGMENTS = 2;

const POSIX_HOME = /^\/(?:Users|home)\/[^/\\]+(?=[/\\]|$)/;
const WINDOWS_HOME = /^[A-Za-z]:[\\/]Users[\\/][^/\\]+(?=[/\\]|$)/i;
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;
/** `https://…` and friends: a URL is not a filesystem path and must not be cut. */
const URL_LIKE = /^[A-Za-z][\w+.-]*:\/\//;

export interface ShortenPathOptions {
  /** Character budget before leading segments are dropped. */
  budget?: number;
  /** Trailing segments to preserve no matter what. Minimum 1. */
  keep?: number;
}

/** `\` only when backslashes genuinely outnumber forward slashes. */
function separatorFor(path: string): '/' | '\\' {
  let back = 0;
  let forward = 0;
  for (const char of path) {
    if (char === '\\') back += 1;
    else if (char === '/') forward += 1;
  }
  return back > forward ? '\\' : '/';
}

function collapseHome(path: string): string {
  if (POSIX_HOME.test(path)) return path.replace(POSIX_HOME, '~');
  if (WINDOWS_HOME.test(path)) return path.replace(WINDOWS_HOME, '~');
  return path;
}

/**
 * A display form of `path` that fits the budget by losing its head, never its
 * tail. Returns `''` for anything that is not a non-empty string.
 */
export function shortenPath(path: string, options: ShortenPathOptions = {}): string {
  if (typeof path !== 'string' || path === '') return '';
  const budget = options.budget ?? SHORT_PATH_BUDGET;
  const keep = Math.max(1, options.keep ?? KEEP_SEGMENTS);

  const collapsed = collapseHome(path);
  if (collapsed.length <= budget) return collapsed;

  const sep = separatorFor(collapsed);
  const parts = collapsed.split(sep).filter(Boolean);

  // Drop one leading segment per pass. The loop stops the moment it fits OR the
  // moment there is nothing left it is allowed to drop, so a single enormous
  // filename comes back whole rather than mangled.
  let out = collapsed;
  let start = 0;
  while (out.length > budget && parts.length - start > keep) {
    start += 1;
    out = `…${sep}${parts.slice(start).join(sep)}`;
  }
  return out;
}

/** Does this whitespace-delimited token address a file rather than read as prose? */
function looksLikePath(token: string): boolean {
  if (!token || URL_LIKE.test(token)) return false;
  if (token.startsWith('/') || token.startsWith('~/') || token.startsWith('~\\')) return true;
  if (WINDOWS_ROOT.test(token)) return true;
  // A relative path still needs shortening once it is deep enough; two or more
  // separators is the cheapest signal that survives contact with prose.
  return token.split('/').length > 2 || token.split('\\').length > 2;
}

const OPENERS = /^["'`([{<]*/;
const CLOSERS = /["'`)\]}>,;]*$/;

/**
 * Shorten every path embedded in a line of text, leaving everything else — and
 * all whitespace — exactly as it was. Built for the step lines the agent daemon
 * writes (`Bash · cd /Users/…/repo && npm test`), where the path is one token
 * among several rather than the whole string.
 */
export function shortenPathsIn(text: string, options?: ShortenPathOptions): string {
  if (typeof text !== 'string' || text === '') return '';
  return text.replace(/\S+/g, token => {
    const open = OPENERS.exec(token)?.[0] ?? '';
    const rest = token.slice(open.length);
    const close = CLOSERS.exec(rest)?.[0] ?? '';
    const core = close ? rest.slice(0, rest.length - close.length) : rest;
    if (!looksLikePath(core)) return token;
    return `${open}${shortenPath(core, options)}${close}`;
  });
}
