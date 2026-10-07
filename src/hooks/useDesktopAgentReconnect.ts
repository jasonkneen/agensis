import { useEffect } from 'react';
import { apiAuthHeaders, apiBaseUrl, apiUrl } from '../lib/backendClient';

/**
 * Desktop only. A local daemon stops itself when the hub refuses its stored
 * token, which happens whenever a connect command is minted for that agent
 * anywhere else (minting rotates the token). The main process can't mint a
 * replacement, so it tells us; we mint one as the signed-in user and hand it
 * back to restart the agent with its saved settings.
 *
 * Each agent gets one attempt per app session so a persistently failing agent
 * can never turn into a mint-and-fail loop.
 */
export function useDesktopAgentReconnect(enabled: boolean): void {
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI?.localRuntime;
    if (!enabled || !api?.onAuthRejected) return;

    const attempted = new Set<string>();
    let queue: Promise<void> = Promise.resolve();

    const reconnect = async ({ agentId, handle }: { agentId: string; handle?: string }) => {
      if (attempted.has(agentId)) return;
      attempted.add(agentId);
      try {
        const response = await fetch(apiUrl(`/backend/agents/${agentId}/connection-command`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({ handle, baseUrl: apiBaseUrl() }),
        });
        const payload = await response.json().catch(() => null);
        const token = payload?.data?.token;
        if (!response.ok || typeof token !== 'string' || !token) return;
        const baseUrl = typeof payload?.data?.baseUrl === 'string' ? payload.data.baseUrl : undefined;
        await api.reconnect({ agentId, token, baseUrl });
      } catch {
        // Offline or signed out: the agent stays down until it is started by hand.
      }
    };
    const enqueue = (info: { agentId: string; handle?: string }) => {
      queue = queue.then(() => reconnect(info));
    };

    const off = api.onAuthRejected(enqueue);
    // Rejections that happened before this window finished loading.
    void api.takeAuthRejected?.().then(list => list.forEach(enqueue)).catch(() => {});
    return off;
  }, [enabled]);
}
