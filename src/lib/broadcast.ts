// Control only. Capture and encoding belong to the independent Electron helper.
import { setStreamPrivacy } from './streamPrivacy';
export const BROADCAST_SERVICES = [
  { id: 'restream', label: 'Restream', url: 'rtmps://live.restream.io:443/live' },
  { id: 'youtube', label: 'YouTube', url: 'rtmps://a.rtmps.youtube.com:443/live2' },
  { id: 'facebook', label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  { id: 'twitch', label: 'Twitch', url: 'rtmp://live.twitch.tv/app' },
  { id: 'x', label: 'X', url: '' },
  { id: 'custom', label: 'Custom RTMP', url: '' },
] as const;
export interface BroadcastConfig { url: string; key: string; audio: boolean; sourceId: string; service: string; otherAudioDeviceId?: string }
export type SavedBroadcastConfig = Omit<BroadcastConfig, 'key'> & { hasKey: boolean };
export interface BroadcastStatus { id: string; state: 'starting' | 'running' | 'stopped' | 'error' | 'unavailable'; error: string | null }
export interface BroadcastAPI {
  capabilities(): Promise<{ available: boolean; audioInputs?: boolean }>;
  audioInputs?(requestPermission?: boolean): Promise<Array<{ id: string; name: string }>>;
  sources(): Promise<Array<{ id: string; name: string }>>;
  config(): Promise<SavedBroadcastConfig>;
  save(config: BroadcastConfig): Promise<SavedBroadcastConfig>;
  start(config: BroadcastConfig): Promise<BroadcastStatus>;
  status(): Promise<BroadcastStatus>;
  stop(id: string): Promise<BroadcastStatus>;
}
export function normalizeBroadcastStatus(value: unknown, previousId = ''): BroadcastStatus {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const state = row?.state;
  if (!row || typeof row.id !== 'string' || row.id.length > 128 || !/^[\w-]*$/.test(row.id)
    || !['starting', 'running', 'stopped', 'error', 'unavailable'].includes(String(state))
    || (['starting', 'running'].includes(String(state)) && !row.id)) {
    return { id: previousId, state: 'unavailable', error: null };
  }
  // Closed UI messages: never display arbitrary/stale IPC errors containing keys or paths.
  let error: string | null = null;
  if (state === 'error') {
    const detail = typeof row.error === 'string' ? row.error : '';
    error = /^(Selected screen|Capture source)/.test(detail)
      ? 'Selected source disappeared. Choose a source and start again explicitly.'
      : /^Capture denied/.test(detail) ? 'Capture permission unavailable. Check Screen Recording and audio access for the helper.'
        : /^Audio/.test(detail) ? 'Audio input unavailable. Check the selected loopback device and microphone permissions.'
          : /^(Capture|Recording)/.test(detail) ? 'Capture stopped or stalled. Check the source and restart explicitly.'
            : 'Broadcast stopped. Check FFmpeg and the server URL/key in the service dashboard.';
  }
  return { id: row.id, state: state as BroadcastStatus['state'], error };
}
export function broadcastMessage(status: BroadcastStatus) {
  if (status.state === 'running') return 'Broadcasting — sending to service. Confirm live status in the service dashboard.';
  if (status.state === 'starting') return 'Starting broadcast — waiting for encoded output…';
  if (status.state === 'unavailable') return 'Broadcast status unavailable. It may still be running; reconnect before assuming it stopped.';
  return status.error || 'Broadcast stopped.';
}
export function createBroadcastMonitor(getAPI: () => BroadcastAPI | undefined) {
  let status: BroadcastStatus = { id: '', state: 'stopped', error: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let generation = 0;
  const publish = (value: unknown) => {
    const next = normalizeBroadcastStatus(value, status.id);
    setStreamPrivacy(['starting', 'running', 'unavailable'].includes(next.state));
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next; listeners.forEach(listener => listener());
  };
  const refresh = async () => {
    const api = getAPI();
    if (!api || polling) return;
    polling = true; const before = generation;
    try { const next = await api.status(); if (before === generation) publish(next); }
    catch { if (before === generation) publish({ ...status, state: 'unavailable', error: null }); }
    finally { polling = false; }
  };
  return {
    getSnapshot: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!timer && getAPI()) { void refresh(); timer = setInterval(() => void refresh(), 1000); }
      return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
    },
    refresh,
    async start(config: BroadcastConfig) {
      const api = getAPI(); if (!api) throw new Error('Desktop required.');
      const attempt = ++generation;
      const next = await api.start(config);
      if (attempt === generation) { generation++; publish(next); }
      return status;
    },
    async stop() {
      const api = getAPI(); if (!api) return;
      const attempt = ++generation;
      try { const next = await api.stop(status.id); if (attempt === generation) { generation++; publish(next); } }
      catch { if (attempt === generation) { generation++; publish({ ...status, state: 'unavailable', error: null }); } }
    },
  };
}
export const broadcastMonitor = createBroadcastMonitor(() => window.electronAPI?.broadcast);
