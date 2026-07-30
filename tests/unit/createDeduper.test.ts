import { describe, it, expect } from 'vitest';
import { createDeduper } from '../../src/lib/realtimeManager';
import type { DbChangePayload } from '../../src/types/realtime';

// Item 6 — realtime deduper. Drops repeat deliveries of an already-applied
// (id, version); processes higher versions; evicts on DELETE; passes through
// rows that lack id or a freshness key.

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const insert = (row: Row): DbChangePayload<any> => ({ eventType: 'INSERT', new: row });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const update = (row: Row): DbChangePayload<any> => ({ eventType: 'UPDATE', new: row });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const del = (row: Row): DbChangePayload<any> => ({ eventType: 'DELETE', old: row });

describe('createDeduper', () => {
  it('suppresses the second delivery of the same (id, version)', () => {
    const d = createDeduper();
    expect(d.shouldProcess(update({ id: '1', version: 2 }))).toBe(true);
    expect(d.shouldProcess(update({ id: '1', version: 2 }))).toBe(false);
  });

  it('processes a higher version for the same id', () => {
    const d = createDeduper();
    expect(d.shouldProcess(update({ id: '1', version: 2 }))).toBe(true);
    expect(d.shouldProcess(update({ id: '1', version: 2 }))).toBe(false);
    expect(d.shouldProcess(update({ id: '1', version: 3 }))).toBe(true);
  });

  it('uses updated_at as the freshness key when version is absent', () => {
    const d = createDeduper();
    expect(d.shouldProcess(update({ id: '1', updated_at: 't1' }))).toBe(true);
    expect(d.shouldProcess(update({ id: '1', updated_at: 't1' }))).toBe(false);
    expect(d.shouldProcess(update({ id: '1', updated_at: 't2' }))).toBe(true);
  });

  it('evicts the id on DELETE so a later re-insert is not suppressed', () => {
    const d = createDeduper();
    expect(d.shouldProcess(insert({ id: '1', version: 1 }))).toBe(true);
    expect(d.shouldProcess(insert({ id: '1', version: 1 }))).toBe(false);
    // DELETE always processes and evicts the id.
    expect(d.shouldProcess(del({ id: '1', version: 1 }))).toBe(true);
    // Re-insert with the same (id, version) is NOT suppressed after eviction.
    expect(d.shouldProcess(insert({ id: '1', version: 1 }))).toBe(true);
  });

  it('always processes a row with no id (cannot dedupe)', () => {
    const d = createDeduper();
    expect(d.shouldProcess(update({ version: 2 }))).toBe(true);
    expect(d.shouldProcess(update({ version: 2 }))).toBe(true);
  });

  it('always processes a row with an id but no freshness key', () => {
    const d = createDeduper();
    expect(d.shouldProcess(update({ id: '1' }))).toBe(true);
    expect(d.shouldProcess(update({ id: '1' }))).toBe(true);
  });

  it('reset() clears state so a repeat is processed again', () => {
    const d = createDeduper();
    expect(d.shouldProcess(update({ id: '1', version: 2 }))).toBe(true);
    expect(d.shouldProcess(update({ id: '1', version: 2 }))).toBe(false);
    d.reset();
    expect(d.shouldProcess(update({ id: '1', version: 2 }))).toBe(true);
  });
});
