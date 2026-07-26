import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_UNAVAILABLE,
  classifyWriteFailure,
  describeWriteFailure,
  presentableDetail,
  writeErrorText,
  writeFailureNotice,
} from '../../src/lib/writeFeedback';

// What this has to get right is narrow but load-bearing: the app used to say
// nothing at all when a write failed, so every sentence produced here is the
// only thing the user will ever see about a lost action.
//
// Two failure modes matter most. Showing a plumbing string ('Invalid JSON
// response' — what backendClient produces for any non-JSON error body, which is
// what a dead proxy actually returns) is barely better than silence. And
// mislabelling a permanent rejection as retryable invites the user to keep
// pressing a button that will never work.

describe('writeErrorText', () => {
  it('reads every shape the app hands back', () => {
    expect(writeErrorText({ message: 'nope' })).toBe('nope');
    expect(writeErrorText(new Error('boom'))).toBe('boom');
    expect(writeErrorText('plain')).toBe('plain');
    // server/index.cjs:8563 answers with a bare string under `error`.
    expect(writeErrorText({ error: 'Invalid signature' })).toBe('Invalid signature');
    expect(writeErrorText({ error: { message: 'nested' } })).toBe('nested');
    expect(writeErrorText(null)).toBe('');
    expect(writeErrorText(undefined)).toBe('');
  });
});

describe('presentableDetail', () => {
  it('suppresses our own plumbing', () => {
    expect(presentableDetail({ message: 'Invalid JSON response' })).toBeNull();
    expect(presentableDetail({ message: 'Request failed (500)' })).toBeNull();
    expect(presentableDetail({ message: 'Workspaces HTTP 401' })).toBeNull();
    expect(presentableDetail({ message: 'Network error' })).toBeNull();
    expect(presentableDetail({ message: 'Failed to fetch' })).toBeNull();
    expect(presentableDetail(null)).toBeNull();
  });

  it('keeps a message written for a human', () => {
    expect(presentableDetail({ message: 'You do not have permission to change this workspace' }))
      .toBe('You do not have permission to change this workspace');
  });
});

describe('classifyWriteFailure', () => {
  it('treats offline as offline whatever the error says', () => {
    const failure = classifyWriteFailure({ message: 'You do not have permission' }, { online: false });
    expect(failure.kind).toBe('offline');
    expect(failure.retryable).toBe(true);
  });

  it('uses an explicit status over the message', () => {
    // A 403 whose body happens to read like a validation problem is still a 403.
    const failure = classifyWriteFailure({ message: 'invalid request' }, { status: 403 });
    expect(failure.kind).toBe('permission');
  });

  it('parses the status backendClient bakes into its message', () => {
    expect(classifyWriteFailure({ message: 'Request failed (429)' }).kind).toBe('rate-limit');
    expect(classifyWriteFailure({ message: 'Request failed (401)' }).kind).toBe('auth');
    expect(classifyWriteFailure({ message: 'Agents HTTP 500' }).kind).toBe('server');
  });

  it('does not read a status out of a number inside a sentence', () => {
    // 'expected 404 rows' is data, not a status; misreading it would tell the
    // user their thing no longer exists when the server never said that.
    const failure = classifyWriteFailure({ message: 'Title must be shorter than 404 characters' });
    expect(failure.kind).toBe('validation');
  });

  it('honours the server error codes the backend actually emits', () => {
    expect(classifyWriteFailure({ message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' }).kind)
      .toBe('rate-limit');
    expect(classifyWriteFailure({ message: 'The selected agent daemon is offline', code: 'agent_offline' }).kind)
      .toBe('server');
  });

  it('recognises RBAC rejections by their wording', () => {
    const failure = classifyWriteFailure({ message: 'You do not have permission to change this workspace' });
    expect(failure.kind).toBe('permission');
    expect(failure.retryable).toBe(false);
  });

  it('classifies a dropped connection as network, not as a server rejection', () => {
    for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'connection refused']) {
      const failure = classifyWriteFailure({ message });
      expect(failure.kind, message).toBe('network');
      expect(failure.retryable, message).toBe(true);
    }
  });

  it('classifies the non-JSON error body a dead proxy returns as a server problem', () => {
    // This is the exact error the app produces today when the backend is down:
    // vite/Netlify answer 500 with an HTML body, backendClient can't parse it,
    // and the only string left is 'Invalid JSON response'.
    const failure = classifyWriteFailure({ message: 'Invalid JSON response', code: null });
    expect(failure.kind).toBe('server');
    expect(failure.retryable).toBe(true);
    expect(failure.reason).toBe('The server had a problem. Nothing was saved.');
    expect(failure.detail).toBeNull();
  });

  it('never surfaces a plumbing string as the reason', () => {
    for (const message of ['Invalid JSON response', 'Request failed (503)', 'Network error', 'Failed to fetch']) {
      expect(classifyWriteFailure({ message }).reason.toLowerCase(), message).not.toContain('json');
      expect(classifyWriteFailure({ message }).reason, message).not.toMatch(/request failed/i);
    }
  });

  it('marks permanent rejections as not worth retrying', () => {
    const permanent = ['permission', 'validation', 'auth', 'not-found', 'conflict'];
    for (const status of [401, 403, 400, 404, 409, 422]) {
      const failure = classifyWriteFailure({ message: 'x' }, { status });
      expect(permanent, String(status)).toContain(failure.kind);
      expect(failure.retryable, String(status)).toBe(false);
    }
  });

  it('marks transient failures as worth retrying', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyWriteFailure({ message: 'x' }, { status }).retryable, String(status)).toBe(true);
    }
  });

  it('falls back to unknown rather than guessing', () => {
    const failure = classifyWriteFailure(null);
    expect(failure.kind).toBe('unknown');
    expect(failure.reason).toBe('Something went wrong and nothing was saved.');
  });

  it('reads Error.status when a raw fetch path attaches one', () => {
    const error = Object.assign(new Error('The selected agent does not advertise coding support'), { status: 409 });
    expect(classifyWriteFailure(error).kind).toBe('conflict');
  });
});

describe('workspace-unavailable', () => {
  it('is retryable and says what to do', () => {
    expect(WORKSPACE_UNAVAILABLE.kind).toBe('workspace-unavailable');
    expect(WORKSPACE_UNAVAILABLE.retryable).toBe(true);
    expect(WORKSPACE_UNAVAILABLE.reason).toMatch(/reload/i);
  });
});

describe('writeFailureNotice', () => {
  it('names the action the user took', () => {
    // No presentable server wording here, so the fallback sentence is used.
    const notice = writeFailureNotice('create the agent', classifyWriteFailure({ message: 'Request failed (403)' }));
    expect(notice.title).toBe("Couldn't create the agent");
    expect(notice.description).toBe("You don't have permission to do that.");
  });

  it('prefers the server wording when the server explained itself', () => {
    const notice = describeWriteFailure(
      'create the workspace',
      { message: 'Cannot create a workspace for another user' },
      { status: 403 },
    );
    expect(notice.description).toBe('Cannot create a workspace for another user');
  });

  it('does not leak a plumbing string into the description', () => {
    const notice = describeWriteFailure('send your message', { message: 'Invalid JSON response' });
    expect(notice.title).toBe("Couldn't send your message");
    expect(notice.description).not.toMatch(/json/i);
  });
});
