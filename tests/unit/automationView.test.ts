// ============================================================================
// tests/unit/automationView.test.ts
// ----------------------------------------------------------------------------
// What the Automations window SAYS.
//
// The load-bearing group is the three-state one. An automation that switched
// ITSELF off (the runaway guard) is `enabled: false` in the database exactly
// like one a person paused — and on screen those must never look the same. A
// rule that silently stopped firing is the worst outcome this feature has.
//
// MUST live under tests/unit/**/*.test.ts or vitest never runs it.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_EMPTY_NOTE,
  AUTOMATION_PERMISSION_NOTE,
  AUTOMATION_SAFETY_NOTE,
  AUTOMATION_UNAVAILABLE_NOTE,
  automationState,
  conditionLabel,
  eventLabel,
  formatRunTime,
  runCountLabel,
  runFailed,
  runStatusLabel,
  ruleSummary,
  stateLabel,
  stepLabel,
  stoppedExplanation,
} from '../../src/lib/automationView';

describe('automationState', () => {
  it('tells a rule that STOPPED ITSELF apart from one that was paused', () => {
    // THE assertion in this file. Both rows are enabled:false in the database.
    // MUTATION: return 'off' whenever enabled is false -> this fails, and a
    // runaway that switched itself off becomes indistinguishable from a
    // deliberate pause.
    expect(automationState({ enabled: false, disabled_reason: 'More than 10 runs a minute, 3 times in a row.' })).toBe('stopped');
    expect(automationState({ enabled: false, disabled_reason: '' })).toBe('off');
    expect(automationState({ enabled: true, disabled_reason: '' })).toBe('active');
  });

  it('labels all three states differently', () => {
    const labels = (['stopped', 'off', 'active'] as const).map(stateLabel);
    expect(new Set(labels).size).toBe(3);
    expect(stateLabel('stopped')).toMatch(/automatically/i);
  });

  it('a re-enabled rule reads as active even with a stale reason', () => {
    // The server clears disabled_reason on re-enable, but the UI must not show
    // "Stopped" on a rule that is demonstrably running.
    expect(automationState({ enabled: true, disabled_reason: 'old reason' })).toBe('active');
  });
});

describe('stoppedExplanation', () => {
  it('says why it stopped AND what to do', () => {
    // A reason with no next step leaves someone stuck looking at a red box.
    const text = stoppedExplanation({ disabled_reason: 'More than 10 runs a minute, 3 times in a row.' });
    expect(text).toContain('More than 10 runs a minute');
    expect(text).toMatch(/turn it back on/i);
  });

  it('is empty when there is no reason', () => {
    expect(stoppedExplanation({ disabled_reason: '' })).toBe('');
  });
});

describe('ruleSummary', () => {
  it('renders the whole rule as one sentence', () => {
    const summary = ruleSummary({
      version: 1,
      trigger: { event: 'message.created' },
      when: [{ field: 'data.content', op: 'contains', value: 'deploy failed' }],
      steps: [{ action: 'post_message', channelId: 'c1', text: 'Heads up' }],
    });
    expect(summary).toBe('When a message is posted, and the message text contains "deploy failed", post a message.');
  });

  it('reads correctly with no conditions', () => {
    // An unconditional rule is legal and fires on every matching event, so the
    // sentence must not imply a filter that is not there.
    const summary = ruleSummary({
      version: 1,
      trigger: { event: 'document.created' },
      when: [],
      steps: [{ action: 'post_message', channelId: 'c1', text: 'x' }],
    });
    expect(summary).toBe('When a document is created, post a message.');
    expect(summary).not.toContain('and');
  });

  it('joins several conditions with "and", never "or"', () => {
    // The evaluator is AND-only. A summary saying "or" would describe a rule
    // that does not exist.
    const summary = ruleSummary({
      version: 1,
      trigger: { event: 'message.created' },
      when: [
        { field: 'channelId', op: 'equals', value: 'c1' },
        { field: 'data.content', op: 'contains', value: 'urgent' },
      ],
      steps: [{ action: 'post_message', channelId: 'c2', text: 'x' }],
    });
    expect(summary).toContain('and');
    expect(summary).not.toMatch(/\bor\b/);
  });

  it('does not throw on a malformed definition', () => {
    expect(ruleSummary({ version: 1, trigger: { event: '' }, when: [], steps: [] })).toBe('');
    expect(() => ruleSummary(undefined as never)).not.toThrow();
  });
});

describe('labels', () => {
  it('renders events, fields and ops in words, not dotted names', () => {
    expect(eventLabel('message.created')).toBe('A message is posted');
    expect(conditionLabel({ field: 'data.content', op: 'contains', value: 'x' })).toBe('the message text contains "x"');
    expect(conditionLabel({ field: 'data.content', op: 'is_empty' })).toBe('the message text is empty');
    expect(stepLabel({ action: 'post_message' })).toBe('Post a message');
  });

  it('falls back to the raw name rather than rendering nothing', () => {
    expect(eventLabel('future.event')).toBe('future.event');
    expect(stepLabel({ action: 'future_action' })).toBe('future_action');
  });

  it('omits the value for a unary op', () => {
    expect(conditionLabel({ field: 'data.content', op: 'is_not_empty' })).not.toContain('""');
  });
});

describe('run status', () => {
  it('names each status in plain words', () => {
    expect(runStatusLabel('done')).toBe('Done');
    expect(runStatusLabel('dead')).toBe('Gave up');
    expect(runStatusLabel('skipped')).toBe('Skipped');
    expect(runStatusLabel('weird')).toBe('weird');
  });

  it('treats error and dead as failures, and skipped as not one', () => {
    // A skipped run is a correct outcome (the rule was switched off between
    // queueing and running); showing it as a failure would train people to
    // ignore the colour.
    expect(runFailed({ status: 'error' })).toBe(true);
    expect(runFailed({ status: 'dead' })).toBe(true);
    expect(runFailed({ status: 'skipped' })).toBe(false);
    expect(runFailed({ status: 'done' })).toBe(false);
  });
});

describe('runCountLabel', () => {
  it('does not claim a number it does not have', () => {
    expect(runCountLabel({ run_count: 0, fail_count: 0 })).toBe('Has not run yet');
    expect(runCountLabel({ run_count: 1, fail_count: 0 })).toBe('1 run');
    expect(runCountLabel({ run_count: 12, fail_count: 0 })).toBe('12 runs');
    expect(runCountLabel({ run_count: 12, fail_count: 3 })).toBe('12 runs, 3 failed');
  });
});

describe('formatRunTime', () => {
  it('says Never rather than rendering a blank cell', () => {
    expect(formatRunTime(null)).toBe('Never');
  });

  it('returns empty for an unparseable timestamp instead of Invalid Date', () => {
    expect(formatRunTime('not-a-date')).toBe('');
  });

  it('renders a real timestamp', () => {
    expect(formatRunTime('2026-07-30T10:30:00.000Z', 'en-GB')).toMatch(/Jul/);
  });
});

describe('the window copy', () => {
  it('states plainly that a rule cannot wake an agent or spend tokens', () => {
    // Both wrong assumptions are expensive: expecting a bill that never comes,
    // or expecting an agent to reply and getting nothing.
    // MUTATION: soften this to "automations are lightweight" -> this fails.
    expect(AUTOMATION_SAFETY_NOTE).toMatch(/cannot wake an agent/i);
    expect(AUTOMATION_SAFETY_NOTE).toMatch(/spend any tokens/i);
  });

  it('states the admin requirement before someone types a rule', () => {
    expect(AUTOMATION_PERMISSION_NOTE).toMatch(/admin role/i);
  });

  it('distinguishes "feature is off" from "you have none"', () => {
    expect(AUTOMATION_UNAVAILABLE_NOTE).toMatch(/not switched on/i);
    expect(AUTOMATION_UNAVAILABLE_NOTE).toMatch(/nothing is wrong/i);
    expect(AUTOMATION_EMPTY_NOTE).toMatch(/no rules yet/i);
  });

  it('uses no emoji anywhere', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const copy of [
      AUTOMATION_SAFETY_NOTE, AUTOMATION_PERMISSION_NOTE,
      AUTOMATION_UNAVAILABLE_NOTE, AUTOMATION_EMPTY_NOTE,
    ]) {
      expect(emoji.test(copy)).toBe(false);
    }
  });
});
