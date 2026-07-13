import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/backendClient', () => ({
  apiUrl: (path: string) => `https://backend.example.test${path}`,
  apiAuthHeaders: () => ({ Authorization: 'Bearer session' }),
}));

import { createFlowConnection } from '../../src/lib/flowConnect';

describe('createFlowConnection', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a channel-scoped connection on the backend host', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'flow-1', workspaceId: 'ws-1', channelId: 'ch-1', token: 'agx_test', signingSecret: 'ags_test' },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const connection = await createFlowConnection({
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      webhookUrl: ' https://flows.example.test/events ',
    });

    expect(connection).toMatchObject({ id: 'flow-1', channelId: 'ch-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example.test/backend/workspaces/ws-1/flow-connections',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer session' }),
        body: JSON.stringify({ channelId: 'ch-1', name: 'Flows', webhookUrl: 'https://flows.example.test/events' }),
      }),
    );
  });
});
