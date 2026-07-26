import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceAgent } from '../../src/types';
import type { AgentVoicePreference } from '../../src/lib/agentVoice';

// Nobody can choose a voice from a list of 418 names without hearing one, so the
// section has to load the catalogue and speak a sample. Three things a typecheck
// cannot tell you:
//
//   1. it mounts, including before the catalogue arrives and when the backend
//      has no Cartesia key at all;
//   2. that VIEW mode is genuinely read-only. The picker used to live in the
//      read-only detail screen and persisted on every change — the owner's own
//      words: "why is it allowing editing of voice when VIEWING the agent". In
//      edit mode the controls write a DRAFT; nothing persists until Save;
//   3. that it previews through our backend, never api.cartesia.ai directly —
//      the API key must not be in the browser.

const VOICE_A = 'f9fc912e-e650-4766-a20c-5a93a43aa6e3';
const VOICE_B = '0834f3df-e650-4766-a20c-5a93a43aa6e3';

const CATALOGUE = [
  { id: VOICE_A, name: 'Brooke', language: 'en-GB', gender: 'feminine' },
  { id: VOICE_B, name: 'Ryan', language: 'en-US', gender: 'masculine' },
];

const AGENT: WorkspaceAgent = {
  id: 'agent-1',
  workspace_id: 'ws-1',
  name: 'Coder',
  avatar: 'CO',
  description: '',
  system_prompt: '',
  model: 'auto',
  created_by: null,
  created_at: '2026-07-26T10:00:00.000Z',
  updated_at: '2026-07-26T10:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix's slider measures its thumb; jsdom has no ResizeObserver. A no-op is
  // enough — nothing here asserts on layout.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => {
  vi.resetModules();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function stubVoices(payload: unknown, ok = true) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/backend/tts/voices')) {
      return { ok, status: ok ? 200 : 500, json: async () => payload } as unknown as Response;
    }
    return { ok: true, status: 200, blob: async () => new Blob([]) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Imported per test, AFTER vi.resetModules(). useCartesiaVoices caches the
// catalogue at module scope on purpose — the Agents window mounts this section
// on every agent you click and ~836 voices is not a per-click fetch — so a
// shared module instance would leak one test's catalogue into the next.
async function render(
  agent: WorkspaceAgent,
  options: {
    mode?: 'view' | 'edit';
    draft?: AgentVoicePreference;
    onDraftChange?: (voice: AgentVoicePreference) => void;
  } = {},
) {
  const { VoiceSection } = await import('../../src/components/windows/AgentsWindowContent');
  await act(async () => {
    root.render(createElement(VoiceSection, { agent, roster: [agent], ...options }));
  });
}

function selects() {
  return [...container.querySelectorAll('select')] as HTMLSelectElement[];
}

function change(element: HTMLSelectElement, value: string) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('the voice section', () => {
  it('loads the catalogue through OUR backend, not Cartesia directly', async () => {
    const fetchMock = stubVoices({ data: CATALOGUE, configured: true });
    await render(AGENT);

    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.includes('/backend/tts/voices'))).toBe(true);
    // The API key mints billable audio; it must never be in the browser, which
    // means the browser must never talk to api.cartesia.ai.
    expect(urls.some(url => url.includes('api.cartesia.ai'))).toBe(false);
  });

  it('shows the automatic voice an unconfigured agent already has', async () => {
    stubVoices({ data: CATALOGUE, configured: true });
    await render(AGENT);
    // Nobody has chosen anything, but the agent is not voiceless — it has a
    // distinct one derived from its id, and the view says so by name.
    expect(container.textContent).toMatch(/automatic/i);
    expect(container.textContent).toMatch(/Brooke|Ryan/);
  });

  it('explains itself when the backend has no Cartesia key', async () => {
    stubVoices({ data: [], configured: false });
    await render(AGENT);
    expect(container.textContent).toContain('not configured');
    // …and does not offer controls that could not possibly work.
    expect(selects()).toHaveLength(0);
  });

  it('mounts before the catalogue arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await render(AGENT);
    expect(container.textContent).toContain('Voice');
  });

  it('VIEW mode renders no editing controls at all — the live complaint', async () => {
    // The picker used to live in the read-only detail screen and persisted on
    // change. View mode is display: the resolved voice's name and a preview
    // button, nothing that writes.
    stubVoices({ data: CATALOGUE, configured: true });
    await render(AGENT, { mode: 'view' });

    expect(selects()).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    const preview = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Preview'));
    expect(preview).toBeTruthy();
  });

  it('EDIT mode writes a DRAFT voice — it never persists on change', async () => {
    stubVoices({ data: CATALOGUE, configured: true });
    const drafts: AgentVoicePreference[] = [];
    await render(AGENT, { mode: 'edit', draft: {}, onDraftChange: voice => drafts.push(voice) });

    change(selects()[0], VOICE_B);

    expect(drafts).toHaveLength(1);
    // A pure voice preference: the draft carries no identity wrapper and no
    // human_set — Save decides what (if anything) is written, as identity.voice.
    expect(drafts[0]).toEqual({ cartesia_voice_id: VOICE_B });
  });

  it('stores an emotion, which is delivery — not the agent\'s persona', async () => {
    stubVoices({ data: CATALOGUE, configured: true });
    const drafts: AgentVoicePreference[] = [];
    await render(AGENT, { mode: 'edit', draft: {}, onDraftChange: voice => drafts.push(voice) });

    const emotion = selects()[1];
    change(emotion, 'contemplative');

    expect(drafts[0]?.emotion).toBe('contemplative');
    // The panel must point people at Soul for persona, or they will try to
    // express it here and be disappointed.
    expect(container.textContent).toContain('edit Soul');
  });

  it('offers a preview that posts the resolved voice to the backend', async () => {
    const fetchMock = stubVoices({ data: CATALOGUE, configured: true });
    await render(AGENT);

    const preview = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Preview'));
    expect(preview).toBeTruthy();
    expect(preview?.hasAttribute('disabled')).toBe(false);

    await act(async () => { preview!.click(); });

    const call = fetchMock.mock.calls.find(entry => String(entry[0]).includes('/backend/tts/preview'));
    expect(call).toBeTruthy();
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body.cartesia_voice_id).toMatch(/^[0-9a-f-]{36}$/);
    // The transcript is the server's business — sending one would make this a
    // metered TTS endpoint.
    expect('transcript' in body).toBe(false);
  });
});
