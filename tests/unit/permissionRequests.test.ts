import { describe, expect, it } from 'vitest';
import {
  PERMISSION_REQUEST_KIND,
  isPermissionRequestMessage,
  isPermissionRequestOpen,
  offeredScopes,
  permissionOutcomeLabel,
  permissionRequestSummary,
} from '../../src/components/chat/permissionRequests';
import { buildTranscriptRows } from '../../src/components/chat/toolSteps';
import type { Message, PermissionRequest } from '../../src/types';

const BASE: PermissionRequest = {
  id: 'req-1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  jobId: 'job-1',
  sessionId: 'session-1',
  messageId: 'msg-1',
  toolName: 'Bash',
  toolDetail: 'git clone https://github.com/x/y',
  title: '',
  description: '',
  rules: ['Bash(git clone:*)'],
  scopes: ['once', 'session', 'always'],
  status: 'pending',
  scope: '',
  decidedBy: null,
  decidedByName: '',
  decidedAt: null,
  expiresAt: null,
  createdAt: null,
};

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    session_id: 'session-1',
    role: 'assistant',
    content: 'Bash · git clone https://github.com/x/y',
    created_at: new Date('2026-07-28T12:00:00Z').toISOString(),
    sender_id: 'agent-1',
    ...overrides,
  } as Message;
}

describe('offeredScopes', () => {
  it('orders scopes narrowest-first so the safe answer is nearest the eye', () => {
    expect(offeredScopes({ ...BASE, scopes: ['always', 'once', 'session'] }))
      .toEqual(['once', 'session', 'always']);
  });

  it('drops "always" when there is no rule to make permanent', () => {
    // Otherwise the button would have to mean "allow this whole tool forever",
    // which is far broader than the sentence next to it claims.
    expect(offeredScopes({ ...BASE, rules: [] })).toEqual(['once', 'session']);
  });

  it('never invents a scope the server did not offer', () => {
    expect(offeredScopes({ ...BASE, scopes: ['once'] })).toEqual(['once']);
  });

  it('falls back to the two narrow scopes rather than rendering no buttons at all', () => {
    // A row from a newer/older server with an unrecognised scopes array must
    // still be answerable — a card with no buttons wedges the agent's turn.
    expect(offeredScopes({ ...BASE, scopes: [] })).toEqual(['once', 'session']);
  });
});

describe('isPermissionRequestOpen', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');

  it('is open while pending and unexpired', () => {
    expect(isPermissionRequestOpen({ ...BASE, expiresAt: '2026-07-28T12:05:00Z' }, now)).toBe(true);
    expect(isPermissionRequestOpen({ ...BASE, expiresAt: null }, now)).toBe(true);
  });

  it('closes once the park deadline has passed, even if the row still says pending', () => {
    // The server sweeps expired rows every 30s, so between the deadline and the
    // sweep the buttons would otherwise still be live for a daemon that has
    // already given up and told the model it was refused.
    expect(isPermissionRequestOpen({ ...BASE, expiresAt: '2026-07-28T11:59:00Z' }, now)).toBe(false);
  });

  it('closes on any settled status', () => {
    for (const status of ['allowed', 'denied', 'expired'] as const) {
      expect(isPermissionRequestOpen({ ...BASE, status }, now)).toBe(false);
    }
  });
});

describe('permissionOutcomeLabel', () => {
  it('names the scope granted rather than flattening every allow into one word', () => {
    expect(permissionOutcomeLabel({ status: 'allowed', scope: 'once', decidedByName: 'Jason' }))
      .toBe('Allowed by Jason');
    expect(permissionOutcomeLabel({ status: 'allowed', scope: 'session', decidedByName: 'Jason' }))
      .toBe('Allowed for this session by Jason');
    // "just then" vs "from now on, forever" is the entire point of the buttons;
    // a transcript that flattens them cannot be audited later.
    expect(permissionOutcomeLabel({ status: 'allowed', scope: 'always', decidedByName: 'Jason' }))
      .toBe('Always allowed by Jason');
  });

  it('reads sensibly when nobody is named, and when nobody answered', () => {
    expect(permissionOutcomeLabel({ status: 'denied', scope: '', decidedByName: '' })).toBe('Denied');
    expect(permissionOutcomeLabel({ status: 'expired', scope: '', decidedByName: '' }))
      .toBe('Expired — nobody answered in time');
  });
});

describe('permissionRequestSummary', () => {
  it('prefers the bridge’s own sentence over one reconstructed from the tool name', () => {
    expect(permissionRequestSummary({ ...BASE, title: 'Claude wants to read foo.txt' }))
      .toBe('Claude wants to read foo.txt');
  });

  it('falls back through tool + detail to something never blank', () => {
    expect(permissionRequestSummary(BASE)).toBe('Bash · git clone https://github.com/x/y');
    expect(permissionRequestSummary({ toolName: 'WebFetch', toolDetail: '', title: '' })).toBe('WebFetch');
    expect(permissionRequestSummary({ toolName: '', toolDetail: '', title: '' })).toBe('a tool call');
  });
});

describe('transcript placement', () => {
  it('recognises the card message by kind', () => {
    expect(isPermissionRequestMessage(message({ message_kind: PERMISSION_REQUEST_KIND }))).toBe(true);
    expect(isPermissionRequestMessage(message({ message_kind: 'tool_step' }))).toBe(false);
    expect(isPermissionRequestMessage(message())).toBe(false);
  });

  it('never lets a request be swallowed into a tool-step chip group', () => {
    // The card is the one row in a run that a human has to ACT on. Collapsed
    // into the chip strip beside "4 tool calls" it would be invisible behind a
    // disclosure, and the agent would sit blocked until its park expired.
    const rows = buildTranscriptRows([
      message({ id: 'a', message_kind: 'tool_step', tool_name: 'Read', tool_detail: 'x.ts' }),
      message({ id: 'b', message_kind: PERMISSION_REQUEST_KIND, permission_request_id: 'req-1' }),
      message({ id: 'c', message_kind: 'tool_step', tool_name: 'Bash', tool_detail: 'ls' }),
    ]);

    expect(rows.map(row => row.kind)).toEqual(['steps', 'message', 'steps']);
    const card = rows[1];
    expect(card.kind === 'message' && card.message.id).toBe('b');
  });
});
