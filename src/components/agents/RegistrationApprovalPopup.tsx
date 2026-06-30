import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAgentRegistrations } from '../../hooks/useAgentRegistrations';

// The "X wants to register as @q — Allow?" popup. Mounted once at the app root; it shows
// the oldest pending agent-registration request and lets the owner Allow or Deny. Driven
// by realtime, so it appears the instant a connected MCP client calls register_agent.
export function RegistrationApprovalPopup({ workspaceId }: { workspaceId: string | null }) {
  const { pending, approve, deny } = useAgentRegistrations(workspaceId);
  const req = pending[0] || null;
  const open = Boolean(req);

  const label = req?.client_label?.trim();
  const isNew = req ? !req.agent_id : false;
  const handle = req?.requested_handle || req?.requested_name || 'agent';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && req) deny(req.id); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Allow this agent to connect?</DialogTitle>
          <DialogDescription>
            {label ? <><span className="font-medium text-foreground">{label}</span> wants to </> : 'A client wants to '}
            {isNew
              ? <>register as a new agent <span className="font-medium text-foreground">@{handle}</span>.</>
              : <>work as <span className="font-medium text-foreground">@{handle}</span> over MCP.</>}
            {' '}It will be able to read and reply in this workspace as that agent.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {req && (
            <>
              <Button type="button" variant="ghost" onClick={() => deny(req.id)}>Deny</Button>
              <Button type="button" onClick={() => approve(req.id)}>Allow</Button>
            </>
          )}
        </DialogFooter>
        {pending.length > 1 && (
          <p className="text-xs text-muted-foreground">{pending.length - 1} more request{pending.length - 1 === 1 ? '' : 's'} waiting.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
