import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { generateMcpToken, setMcpAutoApprove, type McpConnectInfo } from '../../lib/mcpConnect';
import { WORKSPACE_UNAVAILABLE, describeWriteFailure } from '../../lib/writeFeedback';
import { ConnectFlowsDialog } from '../integrations/ConnectFlowsDialog';

// "Connect an MCP client" — mints the ONE workspace token, shows the paste-able
// config, and toggles auto-approve. Prefer Settings → Connections for the full
// status panel; this dialog is the Agents-window shortcut.
export function ConnectMcpDialog({ workspaceId, open, onOpenChange }: { workspaceId: string | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [info, setInfo] = useState<McpConnectInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [webhookOpen, setWebhookOpen] = useState(false);

  const generate = async () => {
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    setBusy(true); setErr(null);
    try {
      const next = await generateMcpToken(workspaceId);
      setInfo(next);
      setAuto(next.autoApprove);
      setShowToken(false);
    } catch (e) {
      setErr(describeWriteFailure('generate a connection token', e).description);
    } finally { setBusy(false); }
  };

  const toggleAuto = async (next: boolean) => {
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    setAuto(next);
    setErr(null);
    try {
      await setMcpAutoApprove(workspaceId, next);
    } catch (e) {
      setAuto(!next);
      setErr(describeWriteFailure('change auto-approve', e).description);
    }
  };

  const copy = async (key: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

  const token = info?.token || '';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect an MCP client</DialogTitle>
            <DialogDescription>
              One token for this workspace. Add it to any MCP client (Grok, Claude Code, Cursor, Codex); the client then
              registers itself as an agent and you approve it with a popup — or automatically if you turn on auto-approve.
            </DialogDescription>
          </DialogHeader>

          {!info ? (
            <Button type="button" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Issue credential'}</Button>
          ) : (
            <div className="space-y-3 overflow-hidden">
              <Row label="claude mcp add" value={info.claudeMcpAdd} copied={copied === 'cmd'} onCopy={() => copy('cmd', info.claudeMcpAdd)} />
              <p className="pl-[7.5rem] text-xs text-muted-foreground">
                Replace <code className="rounded bg-muted px-1">aga_YOUR_AGENT_TOKEN</code> with the bearer token below.
              </p>
              <Row label="Endpoint" value={info.endpoint} copied={copied === 'ep'} onCopy={() => copy('ep', info.endpoint)} />
              {token ? (
                <Row
                  label="Bearer token"
                  value={token}
                  secret
                  revealed={showToken}
                  onToggleReveal={() => setShowToken(v => !v)}
                  copied={copied === 'tok'}
                  onCopy={() => copy('tok', token)}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Token not returned — issue again to get a new one.</p>
              )}
              <div className="flex items-center justify-between rounded-md border bg-card/50 px-3 py-2">
                <div>
                  <div className="text-sm">Auto-approve new agents</div>
                  <div className="text-xs text-muted-foreground">Skip the popup — a registering client is approved instantly.</div>
                </div>
                <Switch checked={auto} onCheckedChange={toggleAuto} aria-label="Auto-approve new agents" />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={generate} disabled={busy}>Rotate credential</Button>
            </div>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="border-t pt-4">
            <div className="mb-2 text-sm font-medium">Event webhooks</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Optional outbound signed deliveries when workspace events fire.
            </p>
            <Button type="button" variant="outline" onClick={() => setWebhookOpen(true)} disabled={!workspaceId}>
              Add event webhook
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConnectFlowsDialog workspaceId={workspaceId} channelId={null} open={webhookOpen} onOpenChange={setWebhookOpen} />
    </>
  );
}

function Row({
  label,
  value,
  secret,
  revealed,
  onToggleReveal,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  secret?: boolean;
  revealed?: boolean;
  onToggleReveal?: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  const display = secret && !revealed
    ? `${value.slice(0, 10)}…${value.slice(-4)}`
    : value;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{display}</code>
      {secret && onToggleReveal && (
        <Button type="button" size="sm" variant="ghost" onClick={onToggleReveal} aria-label={revealed ? `Hide ${label}` : `Show ${label}`}>
          {revealed ? <EyeOff /> : <Eye />}
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onCopy} aria-label={`Copy ${label}`}>{copied ? <Check /> : <Copy />}</Button>
    </div>
  );
}
