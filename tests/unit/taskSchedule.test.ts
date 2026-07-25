import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import {
  DAY_MS,
  buildGanttRows,
  buildTaskSpans,
  collectDependents,
  dependencyCandidates,
  dependencyWouldCycle,
  dueDateFromExclusiveEnd,
  fromDateInputValue,
  startOfDay,
  taskDependsOn,
  toDateInputValue,
} from '../../src/components/windows/taskSchedule';

// Local midnight, so every assertion is timezone-independent: the module snaps
// to LOCAL days and building fixtures any other way would make these tests pass
// only in UTC.
function localIso(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day).toISOString();
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    workspace_id: 'ws-1',
    created_by: null,
    assignee_id: null,
    parent_id: null,
    title: overrides.id,
    description: '',
    status: 'todo',
    priority: 'normal',
    due_date: null,
    start_date: null,
    source_type: 'manual',
    source_id: null,
    completed_at: null,
    created_at: localIso(2026, 7, 20),
    updated_at: localIso(2026, 7, 20),
    ...overrides,
  };
}

const days = (span: { startMs: number; endMs: number }) => Math.round((span.endMs - span.startMs) / DAY_MS);

describe('date input round-trip', () => {
  it('round-trips a yyyy-mm-dd value through local midnight', () => {
    expect(toDateInputValue(fromDateInputValue('2026-08-03'))).toBe('2026-08-03');
    expect(toDateInputValue(fromDateInputValue('2026-01-01'))).toBe('2026-01-01');
    expect(toDateInputValue(fromDateInputValue('2026-12-31'))).toBe('2026-12-31');
  });

  it('reads an existing ISO timestamp as its LOCAL calendar day', () => {
    // The bug this guards: `iso.slice(0, 10)` would report the UTC day, which is
    // the previous day for anyone behind UTC after 00:00 local.
    const iso = localIso(2026, 8, 3);
    expect(toDateInputValue(iso)).toBe('2026-08-03');
  });

  it('returns an empty string for a missing or unparseable date', () => {
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue('')).toBe('');
    expect(toDateInputValue('not a date')).toBe('');
  });

  it('returns null (clear the date) for an empty input', () => {
    expect(fromDateInputValue('')).toBeNull();
  });

  it('refuses a malformed or rolled-over date rather than guessing', () => {
    expect(fromDateInputValue('03/08/2026')).toBeNull();
    expect(fromDateInputValue('2026-13-01')).toBeNull();
    // new Date(2026, 1, 31) silently becomes Mar 3 — storing that would save a
    // day the user never picked.
    expect(fromDateInputValue('2026-02-31')).toBeNull();
  });
});

describe('taskDependsOn', () => {
  it('passes a JS string array through', () => {
    expect(taskDependsOn({ depends_on: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('parses a raw PG array literal so Set math never walks characters', () => {
    expect(taskDependsOn({ depends_on: '{"a","b"}' } as unknown as Task)).toEqual(['a', 'b']);
    expect(taskDependsOn({ depends_on: '{}' } as unknown as Task)).toEqual([]);
  });

  it('treats a missing column as no dependencies', () => {
    expect(taskDependsOn({ depends_on: undefined })).toEqual([]);
    expect(taskDependsOn({ depends_on: null } as unknown as Task)).toEqual([]);
  });
});

describe('dependency cycle rejection', () => {
  // a <- b <- c: c depends on b depends on a.
  const chain = [
    { id: 'a', depends_on: [] as string[] },
    { id: 'b', depends_on: ['a'] },
    { id: 'c', depends_on: ['b'] },
    { id: 'loose', depends_on: [] as string[] },
  ];

  it('collects transitive dependents, not just direct ones', () => {
    expect([...collectDependents('a', chain)].sort()).toEqual(['b', 'c']);
    expect([...collectDependents('c', chain)]).toEqual([]);
  });

  it('rejects a self-dependency', () => {
    expect(dependencyWouldCycle('a', 'a', chain)).toBe(true);
  });

  it('rejects a direct 2-cycle', () => {
    expect(dependencyWouldCycle('a', 'b', chain)).toBe(true);
  });

  it('rejects a TRANSITIVE cycle a -> c where c -> b -> a', () => {
    // The case a one-hop check misses: nothing about c mentions a directly.
    expect(dependencyWouldCycle('a', 'c', chain)).toBe(true);
  });

  it('allows a dependency that does not close a loop', () => {
    expect(dependencyWouldCycle('c', 'a', chain)).toBe(false);
    expect(dependencyWouldCycle('a', 'loose', chain)).toBe(false);
  });

  it('terminates even if the stored graph ALREADY contains a cycle', () => {
    const corrupt = [
      { id: 'x', depends_on: ['y'] },
      { id: 'y', depends_on: ['x'] },
      { id: 'z', depends_on: [] as string[] },
    ];
    expect(dependencyWouldCycle('z', 'x', corrupt)).toBe(false);
    expect(dependencyWouldCycle('x', 'y', corrupt)).toBe(true);
  });

  it('offers candidates that exclude self and every dependent', () => {
    expect(dependencyCandidates({ id: 'a', depends_on: [] }, chain).map(t => t.id)).toEqual(['loose']);
    expect(dependencyCandidates({ id: 'c', depends_on: ['b'] }, chain).map(t => t.id).sort())
      .toEqual(['a', 'b', 'loose']);
  });
});

describe('buildTaskSpans', () => {
  it('spans start_date -> due_date inclusive of the due day', () => {
    const task = makeTask({ id: 't', start_date: localIso(2026, 8, 3), due_date: localIso(2026, 8, 7) });
    const span = buildTaskSpans([task]).get('t')!;
    expect(span.kind).toBe('span');
    expect(span.startMs).toBe(startOfDay(new Date(localIso(2026, 8, 3)).getTime()));
    // Aug 3..7 inclusive is FIVE days, not four.
    expect(days(span)).toBe(5);
  });

  it('draws a one-day span when start and due are the same day', () => {
    const task = makeTask({ id: 't', start_date: localIso(2026, 8, 3), due_date: localIso(2026, 8, 3) });
    expect(days(buildTaskSpans([task]).get('t')!)).toBe(1);
  });

  it('draws a one-day span when only ONE of the two dates is set', () => {
    const onlyStart = makeTask({ id: 's', start_date: localIso(2026, 8, 3) });
    const onlyDue = makeTask({ id: 'd', due_date: localIso(2026, 8, 9) });
    const spans = buildTaskSpans([onlyStart, onlyDue]);
    expect(spans.get('s')!.kind).toBe('span');
    expect(days(spans.get('s')!)).toBe(1);
    expect(spans.get('d')!.kind).toBe('span');
    expect(days(spans.get('d')!)).toBe(1);
    expect(spans.get('d')!.startMs).toBe(startOfDay(new Date(localIso(2026, 8, 9)).getTime()));
  });

  it('clamps to one day when due_date is BEFORE start_date', () => {
    const task = makeTask({ id: 't', start_date: localIso(2026, 8, 7), due_date: localIso(2026, 8, 3) });
    const span = buildTaskSpans([task]).get('t')!;
    expect(days(span)).toBe(1);
    expect(span.startMs).toBe(startOfDay(new Date(localIso(2026, 8, 7)).getTime()));
  });

  it('falls back to a single-day POINT marker at created_at when there are no dates', () => {
    // 14 of 14 real tasks are in this state, so it must render, and must be
    // distinguishable from a genuine one-day span.
    const task = makeTask({ id: 't', created_at: localIso(2026, 7, 20) });
    const span = buildTaskSpans([task]).get('t')!;
    expect(span.kind).toBe('point');
    expect(span.startMs).toBe(startOfDay(new Date(localIso(2026, 7, 20)).getTime()));
    expect(days(span)).toBe(1);
  });

  it('rolls a dateless parent up over its children', () => {
    const parent = makeTask({ id: 'p' });
    const kids = [
      makeTask({ id: 'k1', parent_id: 'p', start_date: localIso(2026, 8, 3), due_date: localIso(2026, 8, 5) }),
      makeTask({ id: 'k2', parent_id: 'p', start_date: localIso(2026, 8, 10), due_date: localIso(2026, 8, 12) }),
    ];
    const span = buildTaskSpans([parent, ...kids]).get('p')!;
    expect(span.kind).toBe('rollup');
    expect(span.startMs).toBe(startOfDay(new Date(localIso(2026, 8, 3)).getTime()));
    expect(days(span)).toBe(10); // Aug 3 .. Aug 12 inclusive
  });

  it('extends a parent that HAS its own dates to still cover its children', () => {
    const parent = makeTask({ id: 'p', start_date: localIso(2026, 8, 4), due_date: localIso(2026, 8, 6) });
    const kid = makeTask({ id: 'k', parent_id: 'p', start_date: localIso(2026, 8, 1), due_date: localIso(2026, 8, 20) });
    const span = buildTaskSpans([parent, kid]).get('p')!;
    expect(span.kind).toBe('rollup');
    expect(span.startMs).toBe(startOfDay(new Date(localIso(2026, 8, 1)).getTime()));
    expect(days(span)).toBe(20); // Aug 1 .. Aug 20 inclusive
  });

  it('rolls up through grandchildren', () => {
    const rows = [
      makeTask({ id: 'p' }),
      makeTask({ id: 'c', parent_id: 'p' }),
      makeTask({ id: 'g', parent_id: 'c', start_date: localIso(2026, 9, 1), due_date: localIso(2026, 9, 3) }),
    ];
    const spans = buildTaskSpans(rows);
    expect(spans.get('c')!.kind).toBe('rollup');
    expect(spans.get('p')!.kind).toBe('rollup');
    expect(days(spans.get('p')!)).toBe(3);
  });

  it('ignores UNDATED children so a parent is not dragged back to created_at', () => {
    const parent = makeTask({ id: 'p' });
    const dated = makeTask({ id: 'k1', parent_id: 'p', start_date: localIso(2026, 8, 3), due_date: localIso(2026, 8, 5) });
    const undated = makeTask({ id: 'k2', parent_id: 'p', created_at: localIso(2026, 1, 1) });
    const spans = buildTaskSpans([parent, dated, undated]);
    expect(spans.get('k2')!.kind).toBe('point');
    expect(spans.get('p')!.startMs).toBe(startOfDay(new Date(localIso(2026, 8, 3)).getTime()));
    expect(days(spans.get('p')!)).toBe(3);
  });

  it('stays a POINT when neither the parent nor any child has dates', () => {
    const spans = buildTaskSpans([makeTask({ id: 'p' }), makeTask({ id: 'k', parent_id: 'p' })]);
    expect(spans.get('p')!.kind).toBe('point');
    expect(spans.get('k')!.kind).toBe('point');
  });

  it('does not hang on a corrupt parent_id cycle', () => {
    const a = makeTask({ id: 'a', parent_id: 'b' });
    const b = makeTask({ id: 'b', parent_id: 'a' });
    const spans = buildTaskSpans([a, b]);
    expect(spans.get('a')).toBeTruthy();
    expect(spans.get('b')).toBeTruthy();
  });
});

describe('buildGanttRows', () => {
  const parent = makeTask({ id: 'p' });
  const child = makeTask({ id: 'c', parent_id: 'p' });
  const grand = makeTask({ id: 'g', parent_id: 'c' });
  const solo = makeTask({ id: 's' });
  const all = [parent, child, grand, solo];

  it('inlines descendants under their parent, indented', () => {
    const rows = buildGanttRows([parent, solo], all);
    expect(rows.map(r => [r.task.id, r.depth])).toEqual([['p', 0], ['c', 1], ['g', 2], ['s', 0]]);
  });

  it('flags rows that have children so a summary bar can be drawn', () => {
    const rows = buildGanttRows([parent, solo], all);
    expect(rows.map(r => r.hasChildren)).toEqual([true, true, false, false]);
  });

  it('never emits a task twice', () => {
    // A child passed in as a top-level row too (or a corrupt parent cycle) must
    // not duplicate a row — rowIndex maps id -> row and dependency arrows would
    // point at the wrong band.
    const rows = buildGanttRows([parent, child], all);
    expect(rows.map(r => r.task.id)).toEqual(['p', 'c', 'g']);
  });

  it('terminates on a corrupt parent_id cycle', () => {
    const a = makeTask({ id: 'a', parent_id: 'b' });
    const b = makeTask({ id: 'b', parent_id: 'a' });
    expect(buildGanttRows([a], [a, b]).length).toBeLessThanOrEqual(2);
  });
});

describe('dueDateFromExclusiveEnd', () => {
  it('converts an exclusive span end back to the INCLUSIVE due day', () => {
    // A bar covering only Aug 3 has endMs = Aug 4, and must commit due_date Aug 3.
    const start = startOfDay(new Date(localIso(2026, 8, 3)).getTime());
    expect(toDateInputValue(dueDateFromExclusiveEnd(start + DAY_MS))).toBe('2026-08-03');
    expect(toDateInputValue(dueDateFromExclusiveEnd(start + 5 * DAY_MS))).toBe('2026-08-07');
  });
});
