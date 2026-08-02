import { describe, expect, it } from 'vitest';
import { agentKind, agentStatus, providerLabel } from '../../src/components/windows/agentNetworkModel';
import { agentModelPickerCanSwitch, normalizeAgentRunMode } from '../../src/lib/agentTemplates';
import type { WorkspaceAgent } from '../../src/types';

function agent(run_mode?: WorkspaceAgent['run_mode'] | string): WorkspaceAgent {
  return { id: 'a1', workspace_id: 'w1', name: 'Agent', run_mode, enabled: true } as WorkspaceAgent;
}

describe('four-mode UI classification', () => {
  it.each([
    ['builtin', 'builtin'],
    ['daemon', 'daemon'],
    ['sandbox', 'sandbox'],
    ['external', 'external'],
    ['future-mode', 'builtin'],
  ] as const)('normalizes %s as %s for the model picker', (input, expected) => {
    expect(normalizeAgentRunMode(input)).toBe(expected);
  });

  it('makes Connector model selection display-only because the external client owns its model', () => {
    expect(agentModelPickerCanSwitch('external', 'claude')).toBe(false);
    expect(agentModelPickerCanSwitch('builtin', 'claude')).toBe(true);
    expect(agentModelPickerCanSwitch('daemon', 'amp')).toBe(false);
  });

  it('classifies Connector agents explicitly and never as Direct', () => {
    const connector = agent('external');
    expect(agentKind(connector)).toBe('external');
    expect(providerLabel(connector)).toBe('Connector (external)');
    expect(agentStatus(connector, [])).toBe('disconnected');
  });
});
