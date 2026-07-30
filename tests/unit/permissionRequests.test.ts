import { describe, expect, it } from 'vitest';
import {
  PERMISSION_REQUEST_KIND,
  isPermissionRequestMessage,
  isPermissionRequestOpen,
  offeredScopes,
  permissionOutcomeBadge,
  permissionOutcomeLabel,
  permissionRequestSummary,
  resolvePermissionRequest,
  settledApprovalFromMessage,
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

describe('permissionOutcomeBadge', () => {
  it('names the scope, not the person — a chip has room for one word', () => {
    expect(permissionOutcomeBadge({ status: 'allowed', scope: 'always' })).toBe('Always');
    expect(permissionOutcomeBadge({ status: 'allowed', scope: 'session' })).toBe('Session');
    expect(permissionOutcomeBadge({ status: 'allowed', scope: 'once' })).toBe('Once');
    expect(permissionOutcomeBadge({ status: 'denied', scope: '' })).toBe('Denied');
    expect(permissionOutcomeBadge({ status: 'expired', scope: '' })).toBe('Expired');
  });
});

describe('settledApprovalFromMessage', () => {
  const decided = (content: string, overrides: Partial<Message> = {}) => message({
    message_kind: PERMISSION_REQUEST_KIND,
    permission_request_id: 'req-1',
    tool_name: 'Read',
    tool_detail: '/Users/alice/Documents/GitHub/agensis/src/App.tsx',
    content,
    ...overrides,
  });

  it('reads back every scope the server writes over the message', () => {
    const summary = 'Read · /Users/alice/Documents/GitHub/agensis/src/App.tsx';
    for (const [sentence, scope] of [
      ['Always allowed by Jason', 'always'],
      ['Allowed for this session by Jason', 'session'],
      ['Allowed by Jason', 'once'],
    ] as const) {
      const request = settledApprovalFromMessage(decided(`${sentence}: ${summary}`));
      expect(request?.status).toBe('allowed');
      expect(request?.scope).toBe(scope);
      expect(request?.decidedByName).toBe('Jason');
      // Round-trips: the reconstructed row renders the sentence it came from.
      expect(permissionOutcomeLabel(request!)).toBe(sentence);
    }
  });

  it('reads a denial and an expiry, which name nobody', () => {
    const summary = 'Read · /Users/alice/Documents/GitHub/agensis/src/App.tsx';
    expect(settledApprovalFromMessage(decided(`Denied: ${summary}`))?.status).toBe('denied');
    expect(settledApprovalFromMessage(decided(`Expired: ${summary}`))?.status).toBe('expired');
    expect(settledApprovalFromMessage(decided(`Denied: ${summary}`))?.decidedByName).toBe('');
  });

  it('survives a display name containing a colon', () => {
    // The summary is stripped off the END using the message's own columns, so a
    // name like this cannot cut the sentence in the wrong place.
    const request = settledApprovalFromMessage(
      decided('Always allowed by Ops: On-call: Read · /Users/alice/Documents/GitHub/agensis/src/App.tsx'),
    );
    expect(request?.decidedByName).toBe('Ops: On-call');
  });

  it('refuses anything that is not a settled approval', () => {
    // A pending request must keep its card and its buttons — reconstructing a
    // "decided" row from it would silently remove the only way to answer.
    expect(settledApprovalFromMessage(decided('Read · /Users/alice/Documents/GitHub/agensis/src/App.tsx'))).toBeNull();
    // Not a permission row at all.
    expect(settledApprovalFromMessage(message({ content: 'Allowed by Jason: Read · x.ts' }))).toBeNull();
    // A colon-bearing sentence with no recognised verb.
    expect(settledApprovalFromMessage(decided('Bash · echo "note: hi"', { tool_name: '', tool_detail: '' }))).toBeNull();
  });

  it('prefers a live row over the reconstructed one', () => {
    // Only the live row can still be pending, and only it carries the rules and
    // scopes a card needs to draw buttons.
    const live: PermissionRequest = { ...BASE, id: 'req-1', status: 'pending' };
    const msg = decided('Always allowed by Jason: Read · /Users/alice/Documents/GitHub/agensis/src/App.tsx');
    expect(resolvePermissionRequest(msg, new Map([['req-1', live]]))).toBe(live);
    expect(resolvePermissionRequest(msg, new Map())?.status).toBe('allowed');
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

  it('folds a settled approval into the call it gated even with no live row', () => {
    // The workspace route only returns PENDING requests, so an approval decided
    // before this tab loaded resolves to nothing — and used to fall through to a
    // full-width bubble carrying a raw absolute path, while the identical event
    // decided seconds earlier folded into a chip. One approval, one shape.
    const rows = buildTranscriptRows([
      message({
        id: 'a',
        message_kind: PERMISSION_REQUEST_KIND,
        permission_request_id: 'req-9',
        tool_name: 'Read',
        tool_detail: '/Users/alice/Documents/GitHub/agensis/src/App.tsx',
        content: 'Always allowed by Jason: Read · /Users/alice/Documents/GitHub/agensis/src/App.tsx',
      }),
      message({ id: 'b', message_kind: 'tool_step', tool_name: 'Read', tool_detail: 'src/App.tsx' }),
    ], undefined, () => undefined);

    expect(rows.map(row => row.kind)).toEqual(['steps']);
    const group = rows[0];
    expect(group.kind === 'steps' && group.approvals.b?.scope).toBe('always');
  });
});
