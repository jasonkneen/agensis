import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@agensis/ui/components/button';
import { Input } from '@agensis/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@agensis/ui/components/native-select';
import { BROADCAST_SERVICES, broadcastMonitor, broadcastMessage } from '../../lib/broadcast';

export default function StreamingPanel({ onStarted }: { onStarted?: () => void }) {
  const api = window.electronAPI?.broadcast;
  const [available, setAvailable] = useState(false);
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>([]);
  const [source, setSource] = useState('');
  const [service, setService] = useState<string>('restream');
  const [url, setUrl] = useState<string>(BROADCAST_SERVICES[0].url);
  const [key, setKey] = useState('');
  const [microphone, setMicrophone] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<{ url: string; service: string; hasKey: boolean } | null>(null);
  const [status, setStatus] = useState('Checking broadcast helper…');
  const live = useSyncExternalStore(broadcastMonitor.subscribe, broadcastMonitor.getSnapshot);
  const busy = pending || ['starting', 'running', 'unavailable'].includes(live.state);
  const requested = useRef('');
  const hasSavedKey = saved?.hasKey && saved.url === url.trim() && saved.service === service;

  useEffect(() => {
    if (requested.current && live.id === requested.current && live.state === 'running') {
      requested.current = ''; onStarted?.();
    }
  }, [live, onStarted]);

  useEffect(() => {
    let mounted = true;
    if (api) void Promise.all([api.capabilities(), api.sources(), api.config()]).then(([capabilities, list, config]) => {
      if (!mounted) return;
      setAvailable(capabilities.available); setSources(list); setSaved(config);
      setSource(config.sourceId); setService(config.service); setUrl(config.url); setMicrophone(config.audio);
      setStatus(capabilities.available ? 'Ready. Choose a source and configure the destination.' : 'Independent broadcasting requires macOS/Linux, FFmpeg and an unlocked OS keychain/secret service.');
      void broadcastMonitor.refresh();
    }).catch(() => { if (mounted) setStatus('Helper unavailable. Check FFmpeg, Screen Recording permissions and your OS keychain.'); });
    return () => { mounted = false; }; // Disconnect UI only; never stop media here.
  }, [api]);

  if (!api) return <p className="text-sm text-muted-foreground">Direct RTMP streaming requires the agensis Electron desktop app and FFmpeg installed on your computer. Browser and native SDK shells cannot run the local encoder.</p>;

  const start = async () => {
    if (busy) return;
    setPending(true);
    setStatus('Requesting capture permission…');
    const config = { url: url.trim(), key: key.trim(), audio: microphone, sourceId: source, service };
    try {
      const next = await broadcastMonitor.start(config);
      setKey(''); setSaved({ url: config.url, service, hasKey: true });
      if (next.state === 'running') onStarted?.();
      else if (next.state === 'starting') requested.current = next.id;
      else setStatus(broadcastMessage(next));
    } catch { setStatus('Could not start. Check FFmpeg, the selected source, OS keychain and RTMP server URL/key.'); }
    finally { setPending(false); }
  };

  return (
    <section className="space-y-4" aria-label="Direct RTMP streaming">
      <div>
        <h3 className="text-base font-medium">Stream From This Computer</h3>
        <p className="text-sm text-muted-foreground">Send a screen or window directly to a streaming service at 720p / 30 fps. Closing Settings, signing out, or restarting agensis does NOT stop the broadcast. Use Stop Broadcast. Choose a screen for restart survival; capturing the agensis window stops when that window disappears.</p>
      </div>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span>Screen or window</span>
          <NativeSelect name="broadcast-source" value={source} onChange={event => setSource(event.target.value)}>
            <NativeSelectOption value="">Choose a source…</NativeSelectOption>
            {source && !sources.some(item => item.id === source) && <NativeSelectOption value={source}>Saved source unavailable — select again</NativeSelectOption>}
            {sources.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <Button variant="outline" size="sm" onClick={() => {
          void api.sources().then(list => { setSources(list); if (!list.some(item => item.id === source)) setSource(''); }).catch(() => setStatus('Could not refresh sources. Check capture permissions.'));
        }}>Refresh Sources</Button>
        <label className="block space-y-1 text-sm">
          <span>Service</span>
          <NativeSelect name="broadcast-service" value={service} onChange={event => {
            setService(event.target.value);
            setUrl(BROADCAST_SERVICES.find(item => item.id === event.target.value)?.url ?? '');
            setKey(''); setConfirmed(false);
          }}>
            {BROADCAST_SERVICES.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <label className="block space-y-1 text-sm">
          <span>RTMP server URL (without stream key)</span>
          <Input name="broadcast-url" autoComplete="off" spellCheck={false} value={url} onChange={event => setUrl(event.target.value)} placeholder="rtmps://your-ingest-server/live…" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Stream key{hasSavedKey ? ' (saved securely; leave blank to reuse)' : ''}</span>
          <Input name="broadcast-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} />
        </label>
        <p className="text-sm text-muted-foreground">Copy the current server URL and key from your service dashboard. X requires a provisioned ingest destination. Destination, source and key are saved locally with OS-backed encryption on start. Keys are never returned to this form. A helper or computer restart never starts a broadcast automatically. RTMP is unencrypted; use RTMPS when your service supports it.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={microphone} onChange={event => setMicrophone(event.target.checked)} />Include microphone</label>
        <p className="text-sm text-muted-foreground">System and huddle audio are not captured. Without a microphone, the stream includes silent audio. Use Restream to distribute to multiple services.</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I understand the selected screen/window may contain private content and starting can broadcast publicly.</label>
      </fieldset>
      <p role="status" aria-live="polite" className="break-words text-sm">{live.state !== 'stopped' ? broadcastMessage(live) : status}</p>
      <div className="flex gap-2">
        <Button disabled={!available || busy || !sources.some(item => item.id === source) || !url.trim() || (!key.trim() && !hasSavedKey) || !confirmed} onClick={() => void start()}>Start Broadcast</Button>
        <Button variant="destructive" disabled={!busy} onClick={() => { requested.current = ''; void broadcastMonitor.stop(); }}>Stop Broadcast</Button>
      </div>
    </section>
  );
}
