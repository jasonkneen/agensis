// ============================================================================
// tests/unit/conversationAccessDialog.test.ts
// ----------------------------------------------------------------------------
// The access dialog, MOUNTED. The pure rules are covered in sessionAccess.test.ts;
// what this file exists for is the wiring — that the rules actually reach the
// screen, that a 403 reads as a sentence rather than an error, and above all
// that NOTHING IS REQUESTED UNTIL THE DIALOG IS OPENED. All three routes are
// manage-gated, so a hook mounted alongside every DM would fire a 403 per
// conversation for every editor in the workspace, and no unit test of a pure
// function can see that.
//
// The Radix dialog portals into document.body, so assertions read from there
// rather than from the container.
// ============================================================================

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { ConversationAccessDialog } = await import('../../src/components/chat/ConversationAccessDialog');

const SESSION_ID = 'bbd8f1f4-0000-4000-8000-000000000000';
const WORKSPACE_ID = 'ws-system';

interface Route { status: number; body: unknown }

let routes: Map<string, Route>;
let calls: Array<{ method: string; url: string; body: string }>;

function route(url: string): Route {
  for (const [pattern, value] of routes) {
    if (url.includes(pattern)) return value;
  }
  return { status: 404, body: { data: null, error: { message: 'no route' } } };
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Radix's focus handling and the dialog's scroll lock both touch APIs jsdom
  // does not implement. No-ops: they let the tree paint, they do not fake it.
  Element.prototype.scrollIntoView = () => {};
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = globalThis.MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls = [];
  routes = new Map<string, Route>([
    [`/sessions/${SESSION_ID}/access`, {
      status: 200,
      body: {
        data: {
          sessionId: SESSION_ID,
          private: true,
          members: [
            {
              userId: 'owner-1', name: 'Jason', source: 'participant',
              grantedBy: null, expiresAt: null, createdAt: '2026-07-01T00:00:00.000Z', active: true,
            },
            {
              userId: 'guest-1', name: 'Ada Lovelace', source: 'grant',
              grantedBy: 'owner-1', expiresAt: null, createdAt: '2026-07-05T00:00:00.000Z', active: true,
            },
          ],
        },
        error: null,
      },
    }],
    ['/members', {
      status: 200,
      body: {
        data: [
          { id: null, user_id: 'owner-1', email: 'jason@example.com', role: 'owner' },
          { id: 'm2', user_id: 'guest-1', email: 'ada@example.com', role: 'editor' },
          { id: 'm3', user_id: 'editor-1', email: 'locked-out@example.com', role: 'editor' },
        ],
        error: null,
      },
    }],
    ['/invites', { status: 200, body: { data: [], error: null } }],
  ]);

  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    calls.push({ method: init?.method || 'GET', url, body: init?.body || '' });
    const matched = route(url);
    return {
      ok: matched.status >= 200 && matched.status < 300,
      status: matched.status,
      json: async () => matched.body,
    } as unknown as Response;
  }));

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(open: boolean, sessionId: string | null = SESSION_ID) {
  await act(async () => {
    root.render(createElement(ConversationAccessDialog, {
      open,
      onOpenChange: () => {},
      sessionId,
      workspaceId: WORKSPACE_ID,
      title: 'Support Agent',
    }));
  });
  // Let the hook's fetch chain settle.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function screen(): string {
  return document.body.textContent || '';
}

describe('ConversationAccessDialog', () => {
  it('requests NOTHING while closed', async () => {
    // The whole reason the fetching lives in an inner component. If this ever
    // regresses, every editor in the workspace starts generating a 403 per DM.
    await render(false);
    expect(calls).toEqual([]);
    expect(screen()).not.toContain('Who can read this conversation');
  });

  it('lists who can read it, and offers Remove on the grant only', async () => {
    await render(true);
    expect(calls.some(call => call.url.includes(`/sessions/${SESSION_ID}/access`))).toBe(true);

    const text = screen();
    expect(text).toContain('Jason');
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('1 given access');

    // One Remove button, on the grant row. A second would mean a participant
    // had grown one, which is a button the DELETE route refuses.
    const removes = [...document.body.querySelectorAll('button')]
      .filter(button => (button.textContent || '').trim() === 'Remove');
    expect(removes).toHaveLength(1);
    const row = removes[0].closest('div');
    expect(row?.textContent || '').toContain('Ada Lovelace');
  });

  it('offers the locked-out member, and not the two who already have access', async () => {
    // This is Jason's actual row: an editor who predates the DM and lost
    // access. The picker exists to hand it back.
    await render(true);
    const options = [...document.body.querySelectorAll('option')].map(option => option.textContent || '');
    expect(options).toContain('locked-out@example.com');
    expect(options).not.toContain('jason@example.com');
    expect(options).not.toContain('ada@example.com');
  });

  it('sends the chosen expiry, and omits it entirely for an open-ended grant', async () => {
    await render(true);
    const select = document.body.querySelector('#conversation-access-grantee') as HTMLSelectElement;
    const give = [...document.body.querySelectorAll('button')]
      .find(button => (button.textContent || '').trim() === 'Give access') as HTMLButtonElement;

    await act(async () => {
      select.value = 'editor-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { give.click(); });
    await act(async () => { await Promise.resolve(); });

    const post = calls.find(call => call.method === 'POST');
    expect(post).toBeTruthy();
    const sent = JSON.parse(post!.body) as Record<string, unknown>;
    expect(sent.userId).toBe('editor-1');
    // Default choice is 7 days, so it must be on the wire.
    expect(sent.expiresInDays).toBe(7);

    // And 'No expiry' must send NO key at all — the route reads an absent field
    // as open-ended, and sending 0 would be rejected as out of the 1..365 range.
    const expirySelect = document.body.querySelector(
      '[aria-label="How long the access lasts"]',
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = 'editor-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expirySelect.value = '0';
      expirySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { give.click(); });
    await act(async () => { await Promise.resolve(); });

    const posts = calls.filter(call => call.method === 'POST');
    const last = JSON.parse(posts[posts.length - 1].body) as Record<string, unknown>;
    expect('expiresInDays' in last).toBe(false);
  });

  it('reads a 403 as a sentence, not as an error', async () => {
    routes.set(`/sessions/${SESSION_ID}/access`, { status: 403, body: { data: null, error: { message: 'Forbidden' } } });
    await render(true);
    expect(screen()).toContain('manage role');
    // And it must not have gone on to ask for the member list it cannot use.
    expect(calls.some(call => call.url.includes('/members'))).toBe(false);
  });

  it('shows the server-s own refusal when a grant is rejected', async () => {
    await render(true);
    routes.set(`/sessions/${SESSION_ID}/access`, {
      status: 400,
      body: { data: null, error: { message: 'That person is not a member of this workspace' } },
    });
    const select = document.body.querySelector('#conversation-access-grantee') as HTMLSelectElement;
    const give = [...document.body.querySelectorAll('button')]
      .find(button => (button.textContent || '').trim() === 'Give access') as HTMLButtonElement;
    await act(async () => {
      select.value = 'editor-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { give.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(screen()).toContain('not a member of this workspace');
  });

  it('says the conversation is not on the server yet rather than showing an empty list', async () => {
    await render(true, null);
    expect(screen()).toContain('Send a message first');
    expect(calls).toEqual([]);
  });

  it('names the audit log, including what it does NOT record', async () => {
    await render(true);
    expect(screen()).toContain('audit log');
    expect(screen()).toContain('not recorded');
  });
});
