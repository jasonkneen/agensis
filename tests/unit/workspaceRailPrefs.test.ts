import { describe, expect, it } from 'vitest';
import {
  addHidden,
  moveInOrder,
  orderWorkspaces,
  parseIdList,
  partitionWorkspaceRail,
  readHiddenWorkspaceIds,
  readWorkspaceOrder,
  removeHidden,
  writeHiddenWorkspaceIds,
  writeWorkspaceOrder,
  WORKSPACE_RAIL_HIDDEN_KEY,
  WORKSPACE_RAIL_ORDER_KEY,
  type RailPrefsStorage,
} from '../../src/lib/workspaceRailPrefs';

type Row = { id: string; is_system?: boolean };

const ws = (id: string, is_system = false): Row => ({ id, is_system });

/** A trivial in-memory storage so the pure helpers can be exercised off the DOM. */
function fakeStorage(seed: Record<string, string> = {}): RailPrefsStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
  };
}

describe('parseIdList', () => {
  it('reads a clean array', () => {
    expect(parseIdList('["a","b"]')).toEqual(['a', 'b']);
  });

  it('degrades junk to an empty list rather than throwing', () => {
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList('')).toEqual([]);
    expect(parseIdList('not json')).toEqual([]);
    expect(parseIdList('{"a":1}')).toEqual([]);
    expect(parseIdList('42')).toEqual([]);
  });

  it('drops non-string and empty entries and dedupes, first occurrence wins', () => {
    expect(parseIdList('["a",1,"",null,"a","b"]')).toEqual(['a', 'b']);
  });
});

describe('orderWorkspaces', () => {
  it('places known ids in the saved sequence', () => {
    const items = [ws('a'), ws('b'), ws('c')];
    expect(orderWorkspaces(items, ['c', 'a', 'b']).map(w => w.id)).toEqual(['c', 'a', 'b']);
  });

  it('puts ids not in the order first (newest surfaces at the top), preserving incoming order', () => {
    const items = [ws('new2'), ws('new1'), ws('a'), ws('b')];
    expect(orderWorkspaces(items, ['b', 'a']).map(w => w.id)).toEqual(['new2', 'new1', 'b', 'a']);
  });

  it('never drops or duplicates a row when the order names ids that are gone', () => {
    const items = [ws('a'), ws('b')];
    expect(orderWorkspaces(items, ['ghost', 'b', 'a']).map(w => w.id)).toEqual(['b', 'a']);
  });

  it('is a no-op with an empty order', () => {
    const items = [ws('a'), ws('b')];
    expect(orderWorkspaces(items, []).map(w => w.id)).toEqual(['a', 'b']);
  });
});

describe('partitionWorkspaceRail', () => {
  it('splits hidden from visible and orders the visible ones', () => {
    const items = [ws('a'), ws('b'), ws('c')];
    const { rail, hidden } = partitionWorkspaceRail(items, ['b'], ['c', 'a']);
    expect(rail.map(w => w.id)).toEqual(['c', 'a']);
    expect(hidden.map(w => w.id)).toEqual(['b']);
  });

  it('never hides the System workspace even if a stale id says so, and keeps it in the rail', () => {
    const items = [ws('a'), ws('sys', true)];
    const { rail, hidden } = partitionWorkspaceRail(items, ['sys', 'a'], []);
    expect(rail.map(w => w.id)).toEqual(['sys']); // ordinary 'a' hidden; system stays
    expect(hidden.map(w => w.id)).toEqual(['a']);
  });

  it('appends system workspaces after the ordered ordinary ones', () => {
    const items = [ws('a'), ws('b'), ws('sys', true)];
    const { rail } = partitionWorkspaceRail(items, [], ['b', 'a']);
    expect(rail.map(w => w.id)).toEqual(['b', 'a', 'sys']);
  });
});

describe('moveInOrder', () => {
  it('moves up toward index 0', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
  });

  it('moves down toward the end', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at the top edge', () => {
    expect(moveInOrder(['a', 'b'], 'a', 'up')).toEqual(['a', 'b']);
  });

  it('is a no-op at the bottom edge', () => {
    expect(moveInOrder(['a', 'b'], 'b', 'down')).toEqual(['a', 'b']);
  });

  it('is a no-op for an unknown id', () => {
    expect(moveInOrder(['a', 'b'], 'zz', 'up')).toEqual(['a', 'b']);
  });

  it('returns a new array, not the input', () => {
    const input = ['a', 'b'];
    expect(moveInOrder(input, 'a', 'up')).not.toBe(input);
  });
});

describe('addHidden / removeHidden', () => {
  it('adds idempotently', () => {
    expect(addHidden(['a'], 'b')).toEqual(['a', 'b']);
    expect(addHidden(['a', 'b'], 'b')).toEqual(['a', 'b']);
  });

  it('removes idempotently', () => {
    expect(removeHidden(['a', 'b'], 'a')).toEqual(['b']);
    expect(removeHidden(['b'], 'a')).toEqual(['b']);
  });
});

describe('storage read/write round-trip', () => {
  it('writes and reads the hidden set and order under the documented keys', () => {
    const store = fakeStorage();
    writeHiddenWorkspaceIds(['x', 'y'], store);
    writeWorkspaceOrder(['y', 'x'], store);
    expect(store.data[WORKSPACE_RAIL_HIDDEN_KEY]).toBe('["x","y"]');
    expect(store.data[WORKSPACE_RAIL_ORDER_KEY]).toBe('["y","x"]');
    expect(readHiddenWorkspaceIds(store)).toEqual(['x', 'y']);
    expect(readWorkspaceOrder(store)).toEqual(['y', 'x']);
  });

  it('reads empty from a null storage (SSR / locked down)', () => {
    expect(readHiddenWorkspaceIds(null)).toEqual([]);
    expect(readWorkspaceOrder(null)).toEqual([]);
  });

  it('recovers from a corrupt stored value', () => {
    const store = fakeStorage({ [WORKSPACE_RAIL_HIDDEN_KEY]: '{bad', [WORKSPACE_RAIL_ORDER_KEY]: 'null' });
    expect(readHiddenWorkspaceIds(store)).toEqual([]);
    expect(readWorkspaceOrder(store)).toEqual([]);
  });
});
