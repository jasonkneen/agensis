import { describe, expect, it } from 'vitest';
import { AI_MODELS, type AgentConnection } from '../../src/types';
import { workspaceChatModels } from '../../src/lib/sharedModels';

describe('workspace shared models', () => {
  it('turns online daemon adverts into stable workspace-scoped picker options', () => {
    const connections = [{
      id: 'connection-1', workspace_id: 'workspace-1', agent_id: 'agent-1', name: 'Studio Mac', handle: 'studio', host: 'studio.local', cwd: '/work', status: 'online', metadata: {}, connected_at: '', last_seen_at: '', updated_at: '',
      capabilities: { skills: [], clis: [], mcpServers: [], memoryRoot: null, sharedModels: [{ id: 'qwen3:8b', name: 'Qwen 3', provider: 'ollama', protocol: 'openai-chat', upstreamModel: 'qwen3:8b', capabilities: ['text'], maxConcurrency: 2, shared: true }] },
    }] satisfies AgentConnection[];
    const options = workspaceChatModels('workspace-1', connections);
    expect(options.slice(0, AI_MODELS.length)).toEqual(AI_MODELS);
    expect(options.at(-1)).toEqual({
      id: 'agensis/workspace-1/agent-1/qwen3%3A8b',
      label: 'Qwen 3 · Studio Mac',
      description: 'ollama shared by @studio',
    });
  });

  it('excludes offline, private, and duplicate model routes', () => {
    const base = { id: 'connection', workspace_id: 'workspace-1', agent_id: 'agent-1', name: 'Desk', handle: 'desk', host: '', cwd: '', metadata: {}, connected_at: '', last_seen_at: '', updated_at: '' };
    const model = { id: 'local', name: 'Local', provider: 'local', protocol: 'openai-chat', upstreamModel: 'local', capabilities: ['text'], maxConcurrency: 1, shared: true as const };
    const connections = [
      { ...base, status: 'offline' as const, capabilities: { skills: [], clis: [], mcpServers: [], memoryRoot: null, sharedModels: [model] } },
      { ...base, id: 'online', status: 'online' as const, capabilities: { skills: [], clis: [], mcpServers: [], memoryRoot: null, sharedModels: [model, model] } },
    ];
    expect(workspaceChatModels('workspace-1', connections)).toHaveLength(AI_MODELS.length + 1);
  });
});
