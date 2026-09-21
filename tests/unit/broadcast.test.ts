import { afterEach, expect, it, vi } from 'vitest';
import { createBroadcastMonitor, BROADCAST_SERVICES, type BroadcastAPI } from '../../src/lib/broadcast';
const live = { id: 'ongoing', state: 'running' as const, error: null };
function harness() {
  const api: BroadcastAPI = { capabilities: vi.fn(), sources: vi.fn(), config: vi.fn(), save: vi.fn(), start: vi.fn(), stop: vi.fn(), status: vi.fn().mockResolvedValue(live) };
  return { api, monitor: createBroadcastMonitor(() => api) };
}
afterEach(() => vi.useRealTimers());
it('discovers six services and reconnects to an ongoing broadcast without starting capture', async () => {
  expect(BROADCAST_SERVICES.map(s => s.id)).toEqual(['restream', 'youtube', 'facebook', 'twitch', 'x', 'custom']);
  const { api, monitor } = harness(); await monitor.refresh();
  expect(monitor.getSnapshot()).toEqual(live); expect(api.start).not.toHaveBeenCalled();
});
it('settings/global subscriber disconnect never stops the helper', async () => {
  vi.useFakeTimers(); const { api, monitor } = harness();
  const a = monitor.subscribe(vi.fn()); const b = monitor.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(1000); a(); b();
  const count = vi.mocked(api.status).mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000); expect(api.status).toHaveBeenCalledTimes(count); expect(api.stop).not.toHaveBeenCalled();
  const c = monitor.subscribe(vi.fn()); await vi.advanceTimersByTimeAsync(0);
  expect(monitor.getSnapshot()).toEqual(live); c();
});
it('uncertain connection never claims stopped, keeps id for stop, and recovers on reconnect', async () => {
  const { api, monitor } = harness(); await monitor.refresh();
  vi.mocked(api.status).mockRejectedValueOnce(new Error('private-details'));
  await monitor.refresh(); expect(monitor.getSnapshot()).toEqual({ ...live, state: 'unavailable' });
  expect(JSON.stringify(monitor.getSnapshot())).not.toContain('private-details');
  await monitor.refresh(); expect(monitor.getSnapshot()).toEqual(live);
  vi.mocked(api.stop).mockResolvedValue({ ...live, state: 'stopped' }); await monitor.stop();
  expect(api.stop).toHaveBeenCalledWith(live.id); expect(monitor.getSnapshot().state).toBe('stopped');
});
it('late status response cannot overwrite an acknowledged stop', async () => {
  const { api, monitor } = harness(); await monitor.refresh();
  let finish!: (value: typeof live) => void;
  vi.mocked(api.status).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = monitor.refresh(); vi.mocked(api.stop).mockResolvedValue({ ...live, state: 'stopped' }); await monitor.stop();
  finish(live); await pending; expect(monitor.getSnapshot().state).toBe('stopped');
});
