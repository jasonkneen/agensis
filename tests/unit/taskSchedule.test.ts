import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import {
  DAY_MS,
  GANTT_LABEL_CHAR_WIDTH,
  WIDEST_TASK_FILTERS,
  applyHideDone,
  buildGanttRows,
  buildTaskSpans,
  collectDependents,
  dependencyCandidates,
  dependencyWouldCycle,
  dueDateFromExclusiveEnd,
  fromDateInputValue,
  labelFitsInsideBar,
  resolveTaskFocus,
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

describe('applyHideDone', () => {
  it('drops done AND cancelled — "not open" has always meant both', () => {
    const list = [
      makeTask({ id: 'a', status: 'todo' }),
      makeTask({ id: 'b', status: 'in_progress' }),
      makeTask({ id: 'c', status: 'done' }),
      makeTask({ id: 'd', status: 'cancelled' }),
    ];
    expect(applyHideDone(list, true).map(t => t.id)).toEqual(['a', 'b']);
  });

  it('is the identity when the toggle is off', () => {
    const list = [makeTask({ id: 'a', status: 'done' })];
    expect(applyHideDone(list, false)).toBe(list);
  });
});

describe('resolveTaskFocus', () => {
  const narrowed = { filter: 'mine' as const, hideDone: true };

  it('does nothing without a request', () => {
    expect(resolveTaskFocus({ isVisible: false, filters: narrowed })).toEqual({ kind: 'reset' });
  });

  it('scrolls to a row that is already visible, then consumes it', () => {
    expect(resolveTaskFocus({ focusRowId: 't1', isVisible: true, filters: narrowed }))
      .toEqual({ kind: 'reveal' });
  });

  it('widens the filters once for a hidden row', () => {
    expect(resolveTaskFocus({ focusRowId: 't1', isVisible: false, filters: narrowed }))
      .toEqual({ kind: 'widen', next: WIDEST_TASK_FILTERS });
  });

  // The bug this whole function exists for: "Hide done" looked dead because the
  // effect re-widened on every toggle while a done task was still focused.
  it('never widens again once the request has been handled', () => {
    expect(resolveTaskFocus({
      focusRowId: 't1',
      handledFocusId: 't1',
      isVisible: false,
      filters: narrowed,
    })).toEqual({ kind: 'idle' });
  });

  it('leaves the user alone when they narrow the filters after being taken there', () => {
    // Reveal (terminal) -> user clicks "Hide done" -> the row leaves the list.
    // That must NOT bounce the toggle back off.
    const first = resolveTaskFocus({ focusRowId: 't1', isVisible: true, filters: WIDEST_TASK_FILTERS });
    expect(first).toEqual({ kind: 'reveal' });
    const afterUserHidesDone = resolveTaskFocus({
      focusRowId: 't1',
      handledFocusId: 't1',
      isVisible: false,
      filters: { filter: 'all', hideDone: true },
    });
    expect(afterUserHidesDone).toEqual({ kind: 'idle' });
  });

  it('consumes rather than looping when the widest filters still cannot show it', () => {
    // e.g. the Board/Timeline views, or a task that was deleted. Bailing out
    // without consuming is what let a stale id hold the filters hostage.
    expect(resolveTaskFocus({ focusRowId: 'gone', isVisible: false, filters: WIDEST_TASK_FILTERS }))
      .toEqual({ kind: 'consume' });
  });

  it('re-arms once the request is cleared, so the same task can be focused twice', () => {
    expect(resolveTaskFocus({ handledFocusId: 't1', isVisible: false, filters: WIDEST_TASK_FILTERS }))
      .toEqual({ kind: 'reset' });
  });

  it('treats a different task as a new request even after one was handled', () => {
    expect(resolveTaskFocus({
      focusRowId: 't2',
      handledFocusId: 't1',
      isVisible: false,
      filters: narrowed,
    })).toEqual({ kind: 'widen', next: WIDEST_TASK_FILTERS });
  });
});

describe('labelFitsInsideBar', () => {
  const DAY = 32; // GANTT_DAY_WIDTH — a bar's width is (days * this).

  it('puts a short name inside a long bar', () => {
    // "Design review" over three weeks: the bar is the obvious place for it.
    expect(labelFitsInsideBar('Design review', 21 * DAY)).toBe(true);
  });

  it('keeps a long name out of a bar that cannot hold it', () => {
    // A bar's width is its DATE RANGE — it cannot be grown to fit text, so the
    // only alternative to putting the name outside is truncating it, which is
    // exactly what this view was reported for.
    expect(labelFitsInsideBar('A title far too long to fit inside its own three-day bar', 3 * DAY)).toBe(false);
  });

  it('never puts anything inside a one-day bar', () => {
    expect(labelFitsInsideBar('Ship', DAY)).toBe(false);
    expect(labelFitsInsideBar('', DAY)).toBe(false);
  });

  it('accounts for the depth glyph on a nested row', () => {
    // A width that fits at depth 0 can stop fitting once the ↳ is prepended.
    const title = 'Wire the panel';
    const width = title.length * GANTT_LABEL_CHAR_WIDTH + 30;
    expect(labelFitsInsideBar(title, width, 0)).toBe(true);
    expect(labelFitsInsideBar(title, width, 1)).toBe(false);
  });

  it('errs towards putting the label outside', () => {
    // Over-estimating the text width costs a label that sits beside its bar;
    // under-estimating costs a truncated title. Only one of those is a bug.
    const title = 'Exactly this long';
    const generous = title.length * GANTT_LABEL_CHAR_WIDTH;
    expect(labelFitsInsideBar(title, generous)).toBe(false);
  });

  it('refuses a blank title however wide the bar', () => {
    expect(labelFitsInsideBar('   ', 30 * DAY)).toBe(false);
    expect(labelFitsInsideBar(undefined as unknown as string, 30 * DAY)).toBe(false);
  });
});

// "It's not remembering hidden done items."
//
// resolveTaskFocus widens the filters so a focused task that the current
// filters hide can still be reached — arriving from a comment or @mention link
// on a DONE task while "Hide done" is on. That is correct. What was wrong is
// what the caller DID with it: it called setFilter/setHideDone, which are the
// PERSISTED setters, so following one link wrote the user's preference away
// permanently. They set "Hide done" once, followed a link, and it was off
// forever with nothing to point at.
//
// The widening is now applied as a transient override for the duration of the
// focus. These pin the contract resolveTaskFocus offers the caller: it asks for
// the WIDEST filters, it stops asking once they are in force, and it never
// describes that widening as something to keep.
describe('resolveTaskFocus does not ask the caller to persist anything', () => {
  const HIDDEN = { filter: 'mine' as const, hideDone: true };

  it('asks to widen when the focused task is hidden', () => {
    const action = resolveTaskFocus({
      focusRowId: 't1', handledFocusId: null, isVisible: false, filters: HIDDEN,
    });
    expect(action.kind).toBe('widen');
    // It names the WIDEST filters, not a tweak of the user's own.
    expect(action.kind === 'widen' && action.next).toEqual(WIDEST_TASK_FILTERS);
  });

  it('stops asking once the widest filters are in force', () => {
    // The caller reports EFFECTIVE filters, so once the transient override is
    // on, this must not loop asking to widen again.
    const action = resolveTaskFocus({
      focusRowId: 't1', handledFocusId: null, isVisible: false, filters: WIDEST_TASK_FILTERS,
    });
    expect(action.kind).toBe('consume');
  });

  it('a visible task never triggers widening, whatever the filters', () => {
    // The common case: nothing should touch filters at all.
    const action = resolveTaskFocus({
      focusRowId: 't1', handledFocusId: null, isVisible: true, filters: HIDDEN,
    });
    expect(action.kind).toBe('reveal');
  });

  it('an already-handled focus is idle, so a re-render cannot re-widen', () => {
    const action = resolveTaskFocus({
      focusRowId: 't1', handledFocusId: 't1', isVisible: false, filters: HIDDEN,
    });
    expect(action.kind).toBe('idle');
  });
});
