import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingTour } from '../../src/components/onboarding/OnboardingTour';
import type { CreateAgentInput } from '../../src/hooks/useAgents';
import type { WorkspaceAgent } from '../../src/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const createdAgent: WorkspaceAgent = {
  id: 'agent-codex',
  workspace_id: 'workspace-1',
  name: 'Codex',
  avatar: 'AI',
  description: '',
  system_prompt: '',
  metadata: { runtime: 'codex' },
  handle: 'codex-cli',
  model: 'auto',
  run_mode: 'daemon',
  created_by: 'user-1',
  created_at: '2026-07-31T00:00:00.000Z',
  updated_at: '2026-07-31T00:00:00.000Z',
};

describe('OnboardingTour remote CLI setup', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    host.remove();
  });

  it('persists the Codex runtime before requesting its connection command', async () => {
    const inputs: CreateAgentInput[] = [];
    const createAgent = vi.fn(async (input: CreateAgentInput) => {
      inputs.push(input);
      return { agent: createdAgent, failure: null };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { portableCommand: 'agensis connect --runtime codex' },
      error: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await act(async () => {
      root.render(createElement(OnboardingTour, {
        onComplete: () => {},
        workspaceId: 'workspace-1',
        workspaceReadiness: { ready: true, status: 'ready', reason: null, canRetry: false },
        agents: [],
        connections: [],
        createAgent,
      }));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 140));
    });

    const connectStep = document.querySelector<HTMLButtonElement>('button[aria-label="Go to step 3"]');
    expect(connectStep).not.toBeNull();
    await act(async () => connectStep!.click());

    const connectButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter(button => button.textContent?.trim() === 'Connect');
    expect(connectButtons).toHaveLength(2);
    await act(async () => {
      connectButtons[1].click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      name: 'Codex',
      handle: 'codex-cli',
      metadata: { runtime: 'codex' },
      model: 'auto',
      run_mode: 'daemon',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toContain('/backend/agents/agent-codex/connection-command');
  });
});
