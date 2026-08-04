import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopAgentWork, stopLabel, stopOutcomeMessage } from '../../src/lib/stopAgentWork';

// What these pin, in order of how expensive it is to get wrong:
//  1. "already finished" is SUCCESS, not an error — the button is pressed
//     exactly when you cannot tell whether anything is still running;
//  2. one dead socket cannot swallow the other cancels;
//  3. the calls go out concurrently, because the user asked for all of them to
//     stop NOW, not one after another.

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(handler: (url: string) => { ok: boolean; stopped?: boolean } | 'throw') {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const outcome = handler(url);
    if (outcome === 'throw') throw new Error('network down');
    return {
      ok: outcome.ok,
      json: async () => ({ data: { stopped: outcome.stopped ?? false } }),
    } as Response;
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('stopAgentWork', () => {
  it('does nothing and calls nothing for an empty list', async () => {
    const calls = mockFetch(() => ({ ok: true, stopped: true }));
    expect(await stopAgentWork([])).toEqual({ stopped: 0, alreadyDone: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('posts one cancel per job, to the job-scoped route', async () => {
    const calls = mockFetch(() => ({ ok: true, stopped: true }));
    const result = await stopAgentWork(['job-1', 'job-2']);
    expect(result).toEqual({ stopped: 2, alreadyDone: 0, failed: 0 });
    expect(calls.some(url => url.endsWith('/backend/agent-jobs/job-1/cancel'))).toBe(true);
    expect(calls.some(url => url.endsWith('/backend/agent-jobs/job-2/cancel'))).toBe(true);
  });

  it('counts an already-finished turn as done, NOT as a failure', async () => {
    // 200 with stopped:false is the idempotent answer. Reporting it as an error
    // would make the common double-click look broken.
    mockFetch(() => ({ ok: true, stopped: false }));
    expect(await stopAgentWork(['job-1'])).toEqual({ stopped: 0, alreadyDone: 1, failed: 0 });
  });

  it('keeps going when one job fails', async () => {
    mockFetch(url => (url.includes('job-2') ? 'throw' : { ok: true, stopped: true }));
    expect(await stopAgentWork(['job-1', 'job-2', 'job-3']))
      .toEqual({ stopped: 2, alreadyDone: 0, failed: 1 });
  });

  it('treats a non-2xx as a failure rather than a silent success', async () => {
    mockFetch(() => ({ ok: false }));
    expect(await stopAgentWork(['job-1'])).toEqual({ stopped: 0, alreadyDone: 0, failed: 1 });
  });

  it('de-duplicates and drops blank ids, so one job is never cancelled twice', async () => {
    const calls = mockFetch(() => ({ ok: true, stopped: true }));
    const result = await stopAgentWork(['job-1', 'job-1', '  ', '']);
    expect(result).toEqual({ stopped: 1, alreadyDone: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it('fires the cancels concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    globalThis.fetch = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, json: async () => ({ data: { stopped: true } }) } as Response;
    }) as typeof fetch;
    await stopAgentWork(['a', 'b', 'c']);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('stopLabel', () => {
  it('names the agent when there is exactly one', () => {
    expect(stopLabel(['Coder'])).toEqual({
      label: 'Stop',
      title: 'Stop Coder — end this turn now',
    });
  });

  it('falls back to an unnamed label rather than printing "null"', () => {
    expect(stopLabel([null])).toEqual({
      label: 'Stop',
      title: 'Stop this agent — end this turn now',
    });
  });

  it('counts instead of listing names past one', () => {
    // Four names in a status line is unreadable.
    expect(stopLabel(['Coder', 'Grok', 'Hermes'])).toEqual({
      label: 'Stop all (3)',
      title: 'Stop all 3 agents working here',
    });
  });
});

describe('stopOutcomeMessage', () => {
  it('says nothing on a clean stop — the indicator vanishing IS the confirmation', () => {
    expect(stopOutcomeMessage({ stopped: 2, alreadyDone: 0, failed: 0 })).toBe('');
  });

  it('explains a total failure without claiming anything changed', () => {
    expect(stopOutcomeMessage({ stopped: 0, alreadyDone: 0, failed: 1 }))
      .toBe('Could not stop the agent. Nothing was changed.');
  });

  it('reports a partial failure honestly', () => {
    expect(stopOutcomeMessage({ stopped: 2, alreadyDone: 0, failed: 1 }))
      .toBe('Stopped 2, but 1 could not be stopped.');
  });

  it('explains the no-op case so the button does not look dead', () => {
    expect(stopOutcomeMessage({ stopped: 0, alreadyDone: 1, failed: 0 }))
      .toBe('That turn had already finished.');
  });
});
