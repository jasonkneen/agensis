import { describe, expect, it } from 'vitest';
import {
  booleanPreference,
  oneOf,
  readPreference,
  setOf,
  viewPreferenceKey,
  writePreference,
  type PreferenceStorage,
} from '../../src/lib/viewPreferences';

// Remembering a filter is four lines of code and about six ways to be quietly
// wrong, so the interesting cases here are all the ones where the stored value
// is NOT what this build expects: an option that has since been removed, a
// hand-edited key, a JSON blob where a plain string was meant, or a browser
// that throws the moment you touch storage. Every one of them has to end at the
// default. A filter that renders an empty screen because a key went stale is a
// worse bug than the one this feature fixes.

function fakeStorage(initial: Record<string, string> = {}): PreferenceStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => { map.set(key, value); },
  };
}

/** A browser with storage disabled: the access itself throws, on read and write alike. */
const hostileStorage: PreferenceStorage = {
  getItem() { throw new Error('SecurityError: storage is disabled'); },
  setItem() { throw new Error('SecurityError: storage is disabled'); },
};

/** Private mode: reads fine, refuses to keep anything. */
const fullStorage: PreferenceStorage = {
  getItem: () => null,
  setItem() { throw new Error('QuotaExceededError'); },
};

const TASK_FILTERS = ['all', 'mine', 'others'] as const;
const taskFilter = oneOf(TASK_FILTERS);

describe('viewPreferenceKey', () => {
  it('namespaces the setting and scopes it to the workspace', () => {
    expect(viewPreferenceKey('tasks.hide-done', 'ws-1')).toBe('agensis.tasks.hide-done:ws-1');
  });

  it('refuses to make a key without a workspace, so a filter cannot leak between them', () => {
    expect(viewPreferenceKey('tasks.filter', null)).toBeNull();
    expect(viewPreferenceKey('tasks.filter', undefined)).toBeNull();
    expect(viewPreferenceKey('tasks.filter', '')).toBeNull();
    expect(viewPreferenceKey('tasks.filter', '   ')).toBeNull();
    expect(viewPreferenceKey('', 'ws-1')).toBeNull();
  });
});

describe('round trip', () => {
  it('reads back what it wrote', () => {
    const storage = fakeStorage();
    const key = viewPreferenceKey('tasks.filter', 'ws-1');
    expect(writePreference(key, taskFilter, 'mine', storage)).toBe(true);
    expect(readPreference(key, taskFilter, 'all', storage)).toBe('mine');
  });

  it('keeps two workspaces apart', () => {
    const storage = fakeStorage();
    const one = viewPreferenceKey('tasks.filter', 'ws-1');
    const two = viewPreferenceKey('tasks.filter', 'ws-2');
    writePreference(one, taskFilter, 'mine', storage);
    writePreference(two, taskFilter, 'others', storage);
    expect(readPreference(one, taskFilter, 'all', storage)).toBe('mine');
    expect(readPreference(two, taskFilter, 'all', storage)).toBe('others');
    // And a third workspace that has never been touched still gets the default.
    expect(readPreference(viewPreferenceKey('tasks.filter', 'ws-3'), taskFilter, 'all', storage)).toBe('all');
  });
});

describe('a stored value this build cannot use', () => {
  const key = 'agensis.tasks.filter:ws-1';

  it('falls back when the option no longer exists', () => {
    // 'assigned-to-agents' shipped once and was removed. Nobody is stuck on it.
    const storage = fakeStorage({ [key]: 'assigned-to-agents' });
    expect(readPreference(key, taskFilter, 'all', storage)).toBe('all');
  });

  it('falls back on a hand-edited or empty key', () => {
    expect(readPreference(key, taskFilter, 'all', fakeStorage({ [key]: '' }))).toBe('all');
    expect(readPreference(key, taskFilter, 'all', fakeStorage({ [key]: '   ' }))).toBe('all');
    expect(readPreference(key, taskFilter, 'all', fakeStorage({ [key]: 'null' }))).toBe('all');
    expect(readPreference(key, taskFilter, 'all', fakeStorage({ [key]: 'undefined' }))).toBe('all');
  });

  it('falls back on a JSON blob where a plain string was expected', () => {
    expect(readPreference(key, taskFilter, 'all', fakeStorage({ [key]: '{"filter":"mine"}' }))).toBe('all');
    expect(readPreference(key, taskFilter, 'all', fakeStorage({ [key]: '["mine"]' }))).toBe('all');
  });

  it('falls back when the key is absent entirely', () => {
    expect(readPreference(key, taskFilter, 'others', fakeStorage())).toBe('others');
  });
});

describe('storage that fails', () => {
  const key = 'agensis.tasks.filter:ws-1';

  it('falls back to the default when the read throws', () => {
    expect(readPreference(key, taskFilter, 'all', hostileStorage)).toBe('all');
  });

  it('reports a failed write instead of throwing at the caller', () => {
    expect(() => writePreference(key, taskFilter, 'mine', fullStorage)).not.toThrow();
    expect(writePreference(key, taskFilter, 'mine', fullStorage)).toBe(false);
    expect(writePreference(key, taskFilter, 'mine', hostileStorage)).toBe(false);
  });

  it('degrades to in-memory when there is no storage at all', () => {
    expect(readPreference(key, taskFilter, 'all', null)).toBe('all');
    expect(writePreference(key, taskFilter, 'mine', null)).toBe(false);
  });

  it('does nothing at all without a key', () => {
    const storage = fakeStorage();
    expect(readPreference(null, taskFilter, 'all', storage)).toBe('all');
    expect(writePreference(null, taskFilter, 'mine', storage)).toBe(false);
    expect(storage.map.size).toBe(0);
  });
});

describe('booleanPreference', () => {
  const key = 'agensis.tasks.hide-done:ws-1';

  it('round-trips both states', () => {
    const storage = fakeStorage();
    writePreference(key, booleanPreference, true, storage);
    expect(readPreference(key, booleanPreference, false, storage)).toBe(true);
    writePreference(key, booleanPreference, false, storage);
    expect(readPreference(key, booleanPreference, true, storage)).toBe(false);
  });

  it('does not treat every truthy-looking string as true', () => {
    // The failure that matters: `'false'` reading back as `true` would turn
    // hide-done permanently on for anyone with an old-format key.
    for (const raw of ['true', 'false', 'yes', '', '2', 'null']) {
      expect(readPreference(key, booleanPreference, false, fakeStorage({ [key]: raw }))).toBe(false);
      expect(readPreference(key, booleanPreference, true, fakeStorage({ [key]: raw }))).toBe(true);
    }
  });
});

describe('setOf', () => {
  const key = 'agensis.agents.status-filter:ws-1';
  const statuses = setOf(['busy', 'idle', 'disconnected', 'inactive'] as const);

  it('round-trips a multi-select, including the empty one', () => {
    const storage = fakeStorage();
    writePreference(key, statuses, new Set(['busy', 'idle'] as const), storage);
    expect([...readPreference(key, statuses, new Set(), storage)].sort()).toEqual(['busy', 'idle']);
    writePreference(key, statuses, new Set(), storage);
    expect(readPreference(key, statuses, new Set(['busy'] as const), storage).size).toBe(0);
  });

  it('drops a retired option but keeps the rest of the selection', () => {
    const storage = fakeStorage({ [key]: '["busy","zombie"]' });
    expect([...readPreference(key, statuses, new Set(), storage)]).toEqual(['busy']);
  });

  it('falls back on malformed JSON or the wrong shape', () => {
    const fallback = new Set(['idle'] as const);
    for (const raw of ['{oops', 'busy', '{"busy":true}', '[1,2]', '[null]', '42']) {
      expect(readPreference(key, statuses, fallback, fakeStorage({ [key]: raw }))).toBe(fallback);
    }
  });
});
