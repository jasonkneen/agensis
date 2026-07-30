import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useSessionAccess } from '@/hooks/useSessionAccess';
import { useWorkspaceUsers } from '@/hooks/useWorkspaceUsers';
import {
  ACCESS_AUDIT_NOTE, ACCESS_FORBIDDEN_NOTE, GRANT_EXPIRY_CHOICES,
  accessMemberLabel, accessSummary, canRevoke, expiryLabel, grantCandidates,
  isParticipant, sortAccessMembers,
} from '@/lib/sessionAccess';

// ---------------------------------------------------------------------------
// WHO CAN READ THIS CONVERSATION.
//
// A direct message is readable only by its members. That default-deny shipped
// with a grant path — POST/DELETE/GET /backend/sessions/:id/access — and no
// screen, which meant that in practice the grant did not exist: the only way to
// let somebody back into a conversation they had lost was curl. This is that
// screen, and it does the three things the routes do and nothing else: show who
// can read, give one workspace member access, take it back.
//
// It deliberately does NOT offer to make the conversation public, remove a
// participant, or invite anyone to the workspace. Every one of those is a wider
// action than the routes behind this dialog allow, and a control that has to
// fail is worse than no control.
//
// The fetching lives in the inner AccessPanel, not out here: all three routes
// are manage-gated, and DialogContent is unmounted while the dialog is closed,
// so nothing is requested until somebody opens it.
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chat_sessions row. Null while the window has not resolved one yet. */
  sessionId: string | null;
  workspaceId: string | null;
  /** What the conversation is called, for the description line. */
  title?: string;
}

export function ConversationAccessDialog({ open, onOpenChange, sessionId, workspaceId, title }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The width must carry the `sm:` prefix. DialogContent's own base class
          ends in `sm:max-w-sm`, and tailwind-merge keeps a responsive variant
          and an unprefixed utility as separate keys — so a bare `max-w-lg`
          here loses to it above 640px and the dialog renders at 384px with the
          grant row wrapped onto three lines. Same idiom as the catch-up dialog
          in ChatWindowContent, which is where this was already solved. */}
      <DialogContent className="max-h-[calc(100svh-2rem)] w-[min(92vw,34rem)] overflow-hidden sm:max-w-[34rem]">
        <DialogHeader>
          <DialogTitle>Who can read this conversation</DialogTitle>
          <DialogDescription>
            {title ? `${title} is private.` : 'This conversation is private.'} Only its members can
            read it, plus anyone given access here.
          </DialogDescription>
        </DialogHeader>
        <AccessPanel sessionId={sessionId} workspaceId={workspaceId} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccessPanel({ sessionId, workspaceId }: { sessionId: string | null; workspaceId: string | null }) {
  const {
    members, isPrivate, loading, loaded, forbidden, unavailable, error, grant, revoke,
  } = useSessionAccess(sessionId);
  // Gated on `loaded` — the access read having SUCCEEDED — not on `!forbidden`.
  // The negative form is false on the first render, so the request went out
  // before the 403 that should have prevented it had even landed.
  const { members: workspaceUsers } = useWorkspaceUsers(loaded ? workspaceId : null);

  const [granteeId, setGranteeId] = useState('');
  const [expiryDays, setExpiryDays] = useState(String(GRANT_EXPIRY_CHOICES[0].days));
  const [busyUserId, setBusyUserId] = useState('');

  const rows = useMemo(() => sortAccessMembers(members), [members]);
  const candidates = useMemo(
    () => grantCandidates(workspaceUsers, members),
    [workspaceUsers, members],
  );

  const handleGrant = async () => {
    if (!granteeId) return;
    setBusyUserId(granteeId);
    const message = await grant(granteeId, Number(expiryDays) || null);
    setBusyUserId('');
    if (!message) setGranteeId('');
  };

  const handleRevoke = async (userId: string) => {
    setBusyUserId(userId);
    await revoke(userId);
    setBusyUserId('');
  };

  if (!sessionId) {
    return (
      <p className="text-xs text-muted-foreground">
        This conversation has not been opened on the server yet. Send a message first.
      </p>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading who can read this
      </div>
    );
  }

  // A refusal, not a failure. The routes are gated on the workspace role, so an
  // editor asking this question gets a straight answer instead of a red error.
  if (forbidden) {
    return <p className="text-sm text-muted-foreground">{ACCESS_FORBIDDEN_NOTE}</p>;
  }

  if (unavailable) {
    return (
      <p className="text-sm text-muted-foreground">
        This server does not have the conversation-access routes yet. Nobody has lost access —
        the conversation is still readable by its own members.
      </p>
    );
  }

  return (
    <div className="min-h-0 space-y-4 overflow-auto pr-1">
      <div className="text-xs text-muted-foreground">{accessSummary(members)}</div>

      <div className="space-y-1">
        {rows.map(member => {
          const participant = isParticipant(member);
          const revocable = canRevoke(member);
          const busy = busyUserId === member.userId;
          return (
            <div
              key={member.userId}
              className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{accessMemberLabel(member)}</div>
                {/* The badge says WHAT they are, this line says how long for.
                    They must not both say 'Expired' — the first version did,
                    and a row reading "Expired / Expired / Remove" looks like a
                    rendering fault rather than a lapsed grant. */}
                <div
                  className={cn(
                    'truncate text-xs',
                    !participant && !member.active ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {participant ? 'In this conversation' : expiryLabel(member.expiresAt)}
                </div>
              </div>
              <Badge variant="secondary">{participant ? 'Member' : 'Guest'}</Badge>
              {/* Participants have no Revoke button because the DELETE route
                  refuses one by design — it matches `source = 'grant'` only, so
                  nobody can be tidied out of their own conversation. */}
              {revocable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => { void handleRevoke(member.userId); }}
                >
                  {busy ? 'Removing' : 'Remove'}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {isPrivate ? (
        <div className="space-y-2 rounded-md border border-dashed border-border px-3 py-3">
          <Label htmlFor="conversation-access-grantee">Give someone access</Label>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              id="conversation-access-grantee"
              className="min-w-48 flex-1"
              value={granteeId}
              onChange={event => setGranteeId(event.target.value)}
              disabled={candidates.length === 0}
            >
              <NativeSelectOption value="">
                {candidates.length === 0 ? 'Everyone here already has access' : 'Choose a member'}
              </NativeSelectOption>
              {candidates.map(candidate => (
                <NativeSelectOption key={candidate.user_id} value={candidate.user_id}>
                  {candidate.email || candidate.user_id}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="How long the access lasts"
              value={expiryDays}
              onChange={event => setExpiryDays(event.target.value)}
            >
              {GRANT_EXPIRY_CHOICES.map(choice => (
                <NativeSelectOption key={choice.days} value={String(choice.days)}>
                  {choice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              type="button"
              size="sm"
              disabled={!granteeId || busyUserId === granteeId}
              onClick={() => { void handleGrant(); }}
            >
              {busyUserId === granteeId && granteeId ? 'Giving access' : 'Give access'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Only people already in this workspace can be given access. It lets them read this one
            conversation and nothing else.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          This conversation is not private — everyone in the workspace can already read it, so
          there is nothing to grant.
        </p>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <p className="text-xs text-muted-foreground">{ACCESS_AUDIT_NOTE}</p>
    </div>
  );
}
