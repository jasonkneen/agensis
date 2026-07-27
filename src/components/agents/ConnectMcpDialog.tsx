import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { generateMcpToken, setMcpAutoApprove, type McpConnectInfo } from '../../lib/mcpConnect';
import { WORKSPACE_UNAVAILABLE, describeWriteFailure } from '../../lib/writeFeedback';
import { ConnectFlowsDialog } from '../integrations/ConnectFlowsDialog';

// "Connect an MCP client" — mints the ONE workspace token, shows the paste-able config,
// and toggles auto-approve. A client added with this can register_agent to become an
// agent; you approve via the popup (or automatically when auto-approve is on).
export function ConnectMcpDialog({ workspaceId, open, onOpenChange }: { workspaceId: string | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [info, setInfo] = useState<McpConnectInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flowsOpen, setFlowsOpen] = useState(false);

  const generate = async () => {
    // No workspace id means the workspace list never loaded. The button used to
    // be silently `disabled` in that state, so clicking it did nothing at all
    // and nothing said why. Say why instead.
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    setBusy(true); setErr(null);
    try {
      const next = await generateMcpToken(workspaceId);
      setInfo(next);
      setAuto(next.autoApprove);
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
      // The switch snapping back on its own is not an explanation.
      setAuto(!next);
      setErr(describeWriteFailure('change auto-approve', e).description);
    }
  };

  const copy = async (key: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect an MCP client</DialogTitle>
            <DialogDescription>
              One token for this workspace. Add it to any MCP client (Claude Code, Cursor, Codex); the client then
              registers itself as an agent and you approve it with a popup — or automatically if you turn on auto-approve.
            </DialogDescription>
          </DialogHeader>

          {!info ? (
            <Button type="button" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate connection token'}</Button>
          ) : (
            <div className="space-y-3 overflow-hidden">
              {/* The command carries a PLACEHOLDER token, never the live one: it is
                  shown in full and copied to the clipboard as plain text, which is
                  how a real token ended up pasted into a transcript. Copy the token
                  from its own row below and substitute it. */}
              <Row label="claude mcp add" value={info.claudeMcpAdd} copied={copied === 'cmd'} onCopy={() => copy('cmd', info.claudeMcpAdd)} />
              <p className="pl-[7.5rem] text-xs text-muted-foreground">
                Replace <code className="rounded bg-muted px-1">aga_YOUR_AGENT_TOKEN</code> with the bearer token below.
              </p>
              <Row label="Endpoint" value={info.endpoint} copied={copied === 'ep'} onCopy={() => copy('ep', info.endpoint)} />
              <Row label="Bearer token" value={info.token} secret copied={copied === 'tok'} onCopy={() => copy('tok', info.token)} />
              <div className="flex items-center justify-between rounded-md border bg-card/50 px-3 py-2">
                <div>
                  <div className="text-sm">Auto-approve new agents</div>
                  <div className="text-xs text-muted-foreground">Skip the popup — a registering client is approved instantly.</div>
                </div>
                <Switch checked={auto} onCheckedChange={toggleAuto} aria-label="Auto-approve new agents" />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={generate} disabled={busy}>Regenerate token</Button>
            </div>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="border-t pt-4">
            <div className="mb-2 text-sm font-medium">Connect Flows</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Create a workspace-scoped MCP connection with an optional signed event webhook.
            </p>
            <Button type="button" variant="outline" onClick={() => setFlowsOpen(true)} disabled={!workspaceId}>
              Connect Flows workspace
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConnectFlowsDialog workspaceId={workspaceId} channelId={null} open={flowsOpen} onOpenChange={setFlowsOpen} />
    </>
  );
}

function Row({ label, value, secret, copied, onCopy }: { label: string; value: string; secret?: boolean; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{secret ? `${value.slice(0, 10)}…${value.slice(-4)}` : value}</code>
      <Button type="button" size="sm" variant="ghost" onClick={onCopy} aria-label={`Copy ${label}`}>{copied ? <Check /> : <Copy />}</Button>
    </div>
  );
}
