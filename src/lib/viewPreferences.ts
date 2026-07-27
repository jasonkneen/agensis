// Per-device view preferences: which filter a window opens on, which layout,
// whether done work is hidden.
//
// These are NOT user data. They are the shape of one person's window on one
// machine, so they live in localStorage rather than costing a column, a
// migration and a round trip. What they must do is survive a reload — the whole
// complaint this exists to answer is re-hiding done tasks on every launch.
//
// Three rules the call sites get for free by going through here:
//
//   1. NEVER TRUST THE PARSE. A key can hold a value from a version that had a
//      different set of options, a hand-edit, `"undefined"`, or a JSON blob
//      where a plain string was expected. Every read is validated against the
//      options that exist NOW and falls back to the default otherwise, so a
//      stale key can never render an empty screen.
//   2. STORAGE IS ALLOWED TO FAIL. Safari private mode throws on write; a
//      locked-down browser throws on the `localStorage` property access itself.
//      Both reads and writes swallow that and degrade to in-memory state — a
//      preference that does not survive the reload is a nuisance, a window that
//      will not open is a bug.
//   3. PER WORKSPACE. `viewPreferenceKey` cannot produce a key without a
//      workspace id, so a filter chosen in one workspace structurally cannot
//      leak into another.
//
// Deliberately free of React and of any direct `window` reference at module
// scope, so the whole thing is testable by handing it a fake storage.

/** The slice of the Web Storage API this module uses. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * How one preference crosses the storage boundary.
 *
 * `parse` returns `null` for anything it does not recognise — that is the
 * signal to fall back to the caller's default. It is allowed to throw
 * (`JSON.parse` does); `readPreference` treats a throw the same as `null`.
 */
export interface PreferenceCodec<T> {
  parse(raw: string): T | null;
  serialize(value: T): string;
}

/** Namespace shared with the other `agensis.*` view keys (e.g. the inbox list width). */
const KEY_PREFIX = 'agensis.';

/**
 * Build the storage key for a workspace-scoped view preference, e.g.
 * `agensis.tasks.hide-done:9f1c…`.
 *
 * Returns `null` when there is no workspace yet (app still booting, user
 * between workspaces). A null key means "do not persist" everywhere in this
 * module — better to keep the choice in memory for a moment than to write it
 * into a bucket every workspace would then read back.
 */
export function viewPreferenceKey(name: string, workspaceId: string | null | undefined): string | null {
  const scope = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!name || !scope) return null;
  return `${KEY_PREFIX}${name}:${scope}`;
}

/**
 * The real localStorage, or null when it cannot be reached. The access itself
 * is inside the try: reading `window.localStorage` throws outright in a browser
 * with storage disabled, before any getItem/setItem call.
 */
function defaultStorage(): PreferenceStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a stored preference, or the default if there is nothing valid there.
 *
 * `storage === undefined` means "use localStorage"; passing `null` explicitly
 * disables persistence (and is what the tests use to prove the caller still
 * works without storage).
 */
export function readPreference<T>(
  key: string | null,
  codec: PreferenceCodec<T>,
  fallback: T,
  storage?: PreferenceStorage | null,
): T {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!key || !store) return fallback;
  let raw: string | null = null;
  try {
    raw = store.getItem(key);
  } catch {
    return fallback;
  }
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    const parsed = codec.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * Persist a preference. Returns whether it actually landed — callers ignore it,
 * because a failed write is not something to interrupt anyone about, but the
 * tests assert on it.
 */
export function writePreference<T>(
  key: string | null,
  codec: PreferenceCodec<T>,
  value: T,
  storage?: PreferenceStorage | null,
): boolean {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!key || !store) return false;
  try {
    store.setItem(key, codec.serialize(value));
    return true;
  } catch {
    // Quota exceeded, or private mode. The choice holds for this session only.
    return false;
  }
}

/**
 * A value from a closed set of strings — the shape almost every filter and view
 * toggle in the app has. An option that no longer exists reads back as `null`,
 * so removing one from the app removes it from everyone's stored state too.
 */
export function oneOf<T extends string>(options: readonly T[]): PreferenceCodec<T> {
  const allowed = new Set<string>(options);
  return {
    parse: raw => (allowed.has(raw) ? (raw as T) : null),
    serialize: value => value,
  };
}

/** A checkbox-shaped preference. Stored as `1`/`0`; anything else is not a boolean. */
export const booleanPreference: PreferenceCodec<boolean> = {
  parse: raw => {
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  },
  serialize: value => (value ? '1' : '0'),
};

/**
 * A dragged measurement in CSS pixels — a pane height or width someone set by
 * hauling a divider. Stored as a plain integer.
 *
 * `max` is a sanity ceiling, NOT the layout clamp. What a stored measurement is
 * allowed to be depends on the container it is restored into, which this module
 * knows nothing about, so the clamp lives with the layout (e.g.
 * `agentSplitGridHeight`) and runs on every render. All this rejects is a value
 * that is not a measurement at all: an empty string, a NaN, a negative, a JSON
 * blob, or a number so large it could only be corruption.
 *
 * `0` is deliberately not a valid measurement — it is the "never dragged"
 * fallback everywhere this is used, so a zero in storage reads back as "no
 * choice made" rather than as a pane with no height.
 */
export function pixelPreference(max: number): PreferenceCodec<number> {
  return {
    parse: raw => {
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0 || value > max) return null;
      return Math.round(value);
    },
    serialize: value => String(Math.round(value)),
  };
}

/**
 * A multi-select over a closed set (the Agents window's status chips).
 *
 * Anything that is not a JSON array of strings is garbage and falls back to the
 * default. Members that ARE strings but are no longer valid options are dropped
 * instead: one retired option should not wipe out the user's other selections,
 * and an empty set is already the meaningful "no filter" value.
 */
export function setOf<T extends string>(options: readonly T[]): PreferenceCodec<Set<T>> {
  const allowed = new Set<string>(options);
  return {
    parse: raw => {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      if (!parsed.every(item => typeof item === 'string')) return null;
      return new Set(parsed.filter((item): item is T => allowed.has(item)));
    },
    serialize: value => JSON.stringify([...value].filter(item => allowed.has(item))),
  };
}
