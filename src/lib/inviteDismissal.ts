// Which invite links may be cleared out of the list, and which the list shows.
//
// The list of invite links only grows: every link you ever made stays there,
// finished or not, so the more you use invites the harder the list is to read.
// Dismissing is a SOFT delete — `dismissed_at` is a display flag, nothing is
// removed. An accepted invite is the record of how a member got into the
// workspace, so its row has to survive being tidied away.
//
// The rule that matters for security: an ACTIVE link is never dismissable.
// Hiding a live invite would leave it granting access while it disappears from
// the only surface it can be seen on. Revoke it first — that ends the link —
// and then it is spent and can be dismissed. The backend enforces the same
// predicate in SQL; this module is what stops the UI from offering the action.

export type InviteLifecycleState = 'active' | 'expired' | 'accepted' | 'revoked';

/** The invite fields these decisions read. Deliberately narrower than WorkspaceInvite. */
export interface DismissableInvite {
  status: 'pending' | 'accepted' | 'revoked';
  expires_at?: string | null;
  dismissed_at?: string | null;
}

function isExpired(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  // An unparseable date means "we don't know" — treat it as no expiry, which
  // keeps the invite ACTIVE and therefore NOT dismissable. Fail towards the
  // link staying visible.
  if (!Number.isFinite(at)) return false;
  return at <= now;
}

/**
 * The state a link is actually in, which is not the same as its `status`
 * column: a `pending` invite past `expires_at` is finished business, and the
 * DB has no 'expired' status to say so.
 */
export function inviteLifecycleState(invite: DismissableInvite, now: number = Date.now()): InviteLifecycleState {
  if (invite.status === 'revoked') return 'revoked';
  // Acceptance wins over expiry: someone got in through this link, and that is
  // the more useful thing to show next to it.
  if (invite.status === 'accepted') return 'accepted';
  return isExpired(invite.expires_at, now) ? 'expired' : 'active';
}

/** Spent = the link can no longer let anyone new in. */
export function isInviteSpent(invite: DismissableInvite, now: number = Date.now()): boolean {
  return inviteLifecycleState(invite, now) !== 'active';
}

/** Dismissable = spent, and not already dismissed. */
export function isInviteDismissable(invite: DismissableInvite, now: number = Date.now()): boolean {
  if (invite.dismissed_at) return false;
  return isInviteSpent(invite, now);
}

export function isInviteDismissed(invite: DismissableInvite): boolean {
  return Boolean(invite.dismissed_at);
}

/**
 * What the list renders. Dismissed rows are hidden unless the user asks for
 * them — that toggle is the whole way back from a soft delete, so it must show
 * every dismissed row, never a subset.
 */
export function visibleInvites<T extends DismissableInvite>(invites: T[], showDismissed: boolean): T[] {
  if (showDismissed) return invites.slice();
  return invites.filter(invite => !isInviteDismissed(invite));
}

/** The rows a "Clear spent" bulk action would take, so the button can count them. */
export function dismissableInvites<T extends DismissableInvite>(invites: T[], now: number = Date.now()): T[] {
  return invites.filter(invite => isInviteDismissable(invite, now));
}

export function dismissedCount(invites: DismissableInvite[]): number {
  return invites.reduce((n, invite) => (isInviteDismissed(invite) ? n + 1 : n), 0);
}
