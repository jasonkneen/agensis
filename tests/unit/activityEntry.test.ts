import { describe, expect, it } from 'vitest';
import {
  activityEntryLabel,
  activityEntryText,
  activityMetadata,
  activityMetadataText,
  hasActivityMetadata,
} from '../../src/lib/activityEntry';

// Every activity_events row in the live DB stores `metadata` as a json STRING
// scalar rather than an object (jsonb_typeof = 'string' for all of them), because
// each writer binds JSON.stringify(metadata) to a $n::jsonb parameter that
// postgres.js encodes a second time. So the unwrap is not defensive politeness —
// it is the only reason the detail pane has anything readable to show.

const STEP_LINE = 'Bash · cd /Users/alice/Documents/GitHub/agensis-agent/.worktrees/self-update && npm test';

function row(overrides: Record<string, unknown> = {}) {
  return {
    event_type: 'message_sent',
    title: `Coder: ${STEP_LINE.slice(0, 80)}`,
    metadata: JSON.stringify({
      session_id: '924d6df6-5ef9-4263-8729-54f2e0843d68',
      role: 'assistant',
      sender_kind: 'agent',
      sender_name: 'Coder',
      content: STEP_LINE,
    }),
    ...overrides,
  };
}

describe('activityMetadata', () => {
  it('unwraps the double-encoded json string the writers produce', () => {
    expect(activityMetadata(JSON.stringify({ role: 'assistant' }))).toEqual({ role: 'assistant' });
  });

  it('accepts a plain object unchanged', () => {
    expect(activityMetadata({ role: 'user' })).toEqual({ role: 'user' });
  });

  it('returns null for anything that is not an object once unwrapped', () => {
    expect(activityMetadata(null)).toBeNull();
    expect(activityMetadata('')).toBeNull();
    expect(activityMetadata('not json at all')).toBeNull();
    expect(activityMetadata(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(activityMetadata(7)).toBeNull();
  });
});

describe('activityMetadataText', () => {
  it('pretty-prints instead of rendering one escaped line', () => {
    const text = activityMetadataText(JSON.stringify({ role: 'assistant', sender_name: 'Coder' }));
    expect(text).toBe('{\n  "role": "assistant",\n  "sender_name": "Coder"\n}');
    expect(text).not.toContain('\\"');
  });

  it('shows unparseable text as stored rather than escaping it again', () => {
    expect(activityMetadataText('half a { blob')).toBe('half a { blob');
  });

  it('is empty for nothing', () => {
    expect(activityMetadataText(null)).toBe('');
    expect(activityMetadataText(undefined)).toBe('');
  });
});

describe('hasActivityMetadata', () => {
  it('is true only when there is something to show', () => {
    expect(hasActivityMetadata(JSON.stringify({ role: 'user' }))).toBe(true);
    expect(hasActivityMetadata({})).toBe(false);
    expect(hasActivityMetadata(JSON.stringify({}))).toBe(false);
    expect(hasActivityMetadata(null)).toBe(false);
    expect(hasActivityMetadata('')).toBe(false);
  });
});

describe('activityEntryText', () => {
  it('rebuilds the line the stored title truncated away', () => {
    const text = activityEntryText(row());
    expect(text).toBe(`Coder: ${STEP_LINE}`);
    expect(text).toContain('npm test');
  });

  it('mirrors the server sender fallback when metadata carries no name', () => {
    expect(activityEntryText(row({
      metadata: JSON.stringify({ role: 'user', sender_name: '', content: 'hello' }),
    }))).toBe('You: hello');
    expect(activityEntryText(row({
      metadata: JSON.stringify({ role: 'assistant', content: 'hello' }),
    }))).toBe('Agent: hello');
  });

  it('collapses newlines so a multi-line message stays one row', () => {
    expect(activityEntryText(row({
      metadata: JSON.stringify({ sender_name: 'Coder', content: 'first\n\nsecond' }),
    }))).toBe('Coder: first second');
  });

  it('caps a very long message', () => {
    const text = activityEntryText(row({
      metadata: JSON.stringify({ sender_name: 'Coder', content: 'x'.repeat(500) }),
    }));
    expect(text).toHaveLength(240);
    expect(text.endsWith('…')).toBe(true);
  });

  it('falls back to the stored title for a non-message event or missing content', () => {
    expect(activityEntryText({ event_type: 'agent_connected', title: '@coder connected', metadata: '{}' }))
      .toBe('@coder connected');
    expect(activityEntryText(row({ metadata: null }))).toBe(row().title);
    expect(activityEntryText(null)).toBe('');
  });
});

describe('activityEntryLabel', () => {
  it('is the rebuilt line with its paths shortened', () => {
    expect(activityEntryLabel(row())).toBe('Coder: Bash · cd …/agensis-agent/.worktrees/self-update && npm test');
  });

  it('keeps a non-path title untouched', () => {
    expect(activityEntryLabel({ event_type: 'agent_connected', title: '@coder connected', metadata: null }))
      .toBe('@coder connected');
  });
});
