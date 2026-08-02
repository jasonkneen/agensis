import { useEffect, useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { createFlowConnection, type FlowConnectionInfo } from '../../lib/flowConnect';

export function ConnectFlowsDialog({
  workspaceId,
  channelId = null,
  open,
  onOpenChange,
}: {
  workspaceId: string | null;
  channelId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [info, setInfo] = useState<FlowConnectionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!open) {
      setInfo(null);
      setError('');
      setCopied('');
    }
  }, [open]);

  const create = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError('');
    try {
      setInfo(await createFlowConnection({ workspaceId, channelId, webhookUrl }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1_500);
  };

  const scopeLabel = channelId ? 'this channel' : 'this workspace';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Link2 className="size-4" />Event webhook</DialogTitle>
          <DialogDescription>
            Create a revocable outbound webhook for {scopeLabel}. Agensis signs each delivery; the companion MCP credential is for reads and actions.
          </DialogDescription>
        </DialogHeader>

        {!info ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="event-webhook-url" className="text-sm font-medium">Webhook URL</label>
              <Input
                id="event-webhook-url"
                value={webhookUrl}
                onChange={event => setWebhookUrl(event.target.value)}
                placeholder="https://example.com/hooks/agensis/..."
              />
              <p className="text-xs text-muted-foreground">Optional now. Add a URL to receive signed workspace events.</p>
            </div>
            <Button type="button" onClick={() => void create()} disabled={busy || !workspaceId}>
              {busy ? 'Creating…' : `Create ${channelId ? 'channel' : 'workspace'} webhook`}
            </Button>
          </div>
        ) : (
          <div className="space-y-3 overflow-hidden">
            <ConnectionRow label="MCP endpoint" value={info.endpoint} copied={copied === 'endpoint'} onCopy={() => void copy('endpoint', info.endpoint)} />
            <ConnectionRow label="Bearer token" value={info.token} copied={copied === 'token'} onCopy={() => void copy('token', info.token)} />
            <ConnectionRow label="Signing secret" value={info.signingSecret} copied={copied === 'secret'} onCopy={() => void copy('secret', info.signingSecret)} />
            {info.channelId && <ConnectionRow label="Channel ID" value={info.channelId} copied={copied === 'channel'} onCopy={() => void copy('channel', info.channelId!)} />}
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Granted: {info.scopes.join(', ')}
            </div>
            <p className="text-xs text-destructive">Token and signing secret are shown once — save them where you receive events.</p>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{value}</code>
      <Button type="button" size="sm" variant="ghost" onClick={onCopy} aria-label={`Copy ${label}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
