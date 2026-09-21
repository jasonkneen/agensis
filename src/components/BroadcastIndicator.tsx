import { lazy, Suspense, useState, useSyncExternalStore } from 'react';
import { Button } from '@agensis/ui/components/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@agensis/ui/components/dialog';
import { broadcastMessage, broadcastMonitor } from '../lib/broadcast';
const StreamingPanel = lazy(() => import('./settings/StreamingPanel'));

// Mounted above App/account/workspace trees. Settings is a controller, not owner.
export function BroadcastIndicator() {
  const status = useSyncExternalStore(broadcastMonitor.subscribe, broadcastMonitor.getSnapshot);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  if (!window.electronAPI?.broadcast) return null;
  const active = ['starting', 'running', 'unavailable'].includes(status.state);
  return <>
    {status.state !== 'stopped' && <aside aria-label="Broadcast status" className="fixed inset-x-3 bottom-3 z-[100] flex flex-wrap items-center justify-center gap-3 rounded-lg border-2 border-destructive bg-background p-3 text-sm shadow-lg">
      <span role="status" aria-live="polite">{broadcastMessage(status)}</span>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Streaming Settings</Button>
      {status.state === 'unavailable' && <Button size="sm" variant="outline" onClick={() => void broadcastMonitor.refresh()}>Reconnect</Button>}
      {active && <Button size="sm" variant="destructive" disabled={stopping} onClick={() => {
        setStopping(true); void broadcastMonitor.stop().finally(() => setStopping(false));
      }}>Stop Broadcast</Button>}
    </aside>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85svh] overflow-y-auto">
        <DialogHeader><DialogTitle>Streaming</DialogTitle><DialogDescription>Broadcast controls for this computer</DialogDescription></DialogHeader>
        {open && <Suspense fallback={<p role="status">Loading streaming…</p>}><StreamingPanel onStarted={() => setOpen(false)} /></Suspense>}
      </DialogContent>
    </Dialog>
  </>;
}
