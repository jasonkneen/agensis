// ---------------------------------------------------------------------------
// Who can read one private conversation — the screen half of
// server/session-access-routes.cjs.
//
// The routes shipped without a surface, which in practice meant the grant did
// not exist: a `manage` holder could only reach it with curl, so a member who
// had lost access to a DM stayed locked out. Everything here is the pure part
// of that screen, kept out of the component so the rules below can be tested
// without mounting a dialog.
//
// THREE RULES THE SERVER ENFORCES THAT THIS FILE MUST NOT CONTRADICT:
//
// 1. A PARTICIPANT IS NOT REVOCABLE. `source` separates the people whose
//    conversation it is from the people let in, and DELETE only ever matches
//    `source = 'grant'`. So `canRevoke` is the same predicate, and offering a
//    Revoke button on a participant would be offering a button that 404s.
//
// 2. AN EXPIRED GRANT IS STILL A ROW. It confers nothing — the read gate
//    evaluates expiry in SQL — but it is history and it stays. So it is listed,
//    marked expired, and the person REMAINS a grant candidate: POST upserts
//    onto the existing row, which is exactly how an expired grant is renewed.
//
// 3. THE GRANTEE MUST ALREADY BE IN THE WORKSPACE. A grant widens what a member
//    may see, never who is a member, so the candidate list is drawn from the
//    workspace's own members and can never contain a stranger.
// ---------------------------------------------------------------------------

/** One row of `chat_session_members`, as GET /backend/sessions/:id/access returns it. */
export interface SessionAccessMember {
  userId: string;
  /** Display name, or email, or '' when the join found no app_users row. */
  name: string;
  /** 'participant' = whose conversation it is. 'grant' = let in, revocably. */
  source: string;
  grantedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** False once `expiresAt` has passed. The row survives; the access does not. */
  active: boolean;
}

/** The workspace members a grant may be offered to. Shape from useWorkspaceUsers. */
export interface GrantCandidate {
  user_id: string;
  email: string;
}

export function isParticipant(member: Pick<SessionAccessMember, 'source'>): boolean {
  return member.source === 'participant';
}

/** RULE 1. Mirrors the DELETE route's `and source = 'grant'` exactly. */
export function canRevoke(member: Pick<SessionAccessMember, 'source'>): boolean {
  return member.source === 'grant';
}

/**
 * Participants first, then grants; oldest first within each.
 *
 * Deliberately not left to the server's `order by m.source asc`, which sorts
 * 'grant' ABOVE 'participant' alphabetically and so puts the guests above the
 * people whose conversation it is. The list answers "whose DM is this, and who
 * else got in", and that reads in one order only.
 */
export function sortAccessMembers(members: SessionAccessMember[]): SessionAccessMember[] {
  return [...members].sort((a, b) => {
    const aParticipant = isParticipant(a) ? 0 : 1;
    const bParticipant = isParticipant(b) ? 0 : 1;
    if (aParticipant !== bParticipant) return aParticipant - bParticipant;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

/**
 * RULE 2 + RULE 3. Who may still be offered a grant.
 *
 * Excluded: participants (granting one is a no-op the server reports as
 * 'participant'), and anyone holding a grant that is still live. NOT excluded:
 * somebody whose grant has expired — re-granting them is the whole renewal
 * path, and hiding them would leave an expired grant with no way back.
 */
export function grantCandidates(
  users: GrantCandidate[],
  members: SessionAccessMember[],
): GrantCandidate[] {
  const blocked = new Set(
    members
      .filter(member => isParticipant(member) || member.active)
      .map(member => member.userId),
  );
  return users
    .filter(user => user.user_id && !blocked.has(user.user_id))
    .sort((a, b) => (a.email || '').localeCompare(b.email || ''));
}

/** A name for a row that may have neither a display name nor an email. */
export function accessMemberLabel(member: Pick<SessionAccessMember, 'name' | 'userId'>): string {
  const name = member.name?.trim();
  if (name) return name;
  return `User ${String(member.userId).slice(0, 8)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the expiry means today, in days rather than a formatted date — a grant is
 * read as "how long has this got left", and a date makes the reader do the
 * subtraction. 'Expired' is a distinct answer from 'No expiry', and conflating
 * them would show a row that confers nothing as though it were permanent.
 */
export function expiryLabel(expiresAt: string | null, nowMs: number = Date.now()): string {
  if (!expiresAt) return 'No expiry';
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return 'No expiry';
  const remaining = at - nowMs;
  if (remaining <= 0) return 'Expired';
  // Whole days remaining, floored: a grant with 7 days on it reads "in 7 days",
  // and the last partial day reads "today" rather than rounding up to "in 1 day"
  // on a grant that is hours from lapsing.
  const days = Math.floor(remaining / DAY_MS);
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

/**
 * The expiry choices, in days. 0 means no expiry, which the POST spells as an
 * absent `expiresInDays` — an open-ended grant should be a deliberate pick from
 * the same control, not the thing that happens when a field is left blank.
 *
 * Bounded by the route at 1..365, so nothing here may exceed 365.
 */
export const GRANT_EXPIRY_CHOICES: Array<{ days: number; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 0, label: 'No expiry' },
];

/** One line for the header: who is in, and how many were let in. */
export function accessSummary(members: SessionAccessMember[]): string {
  const participants = members.filter(isParticipant).length;
  const grants = members.filter(member => canRevoke(member) && member.active).length;
  const expired = members.filter(member => canRevoke(member) && !member.active).length;
  const parts = [`${participants} in this conversation`];
  if (grants > 0) parts.push(`${grants} given access`);
  if (expired > 0) parts.push(`${expired} expired`);
  return parts.join(' · ');
}

/**
 * What this screen records, said on the screen itself.
 *
 * Both halves are load-bearing. A grant that nobody can see afterwards has the
 * shape of privacy with none of the substance, so the log is named here. And a
 * REFUSED read is deliberately not recorded — it fires on ordinary sidebar
 * rendering — so anyone reading the log for "did somebody try" must be told the
 * log cannot answer that, rather than reading an empty result as a no.
 */
export const ACCESS_AUDIT_NOTE =
  'Giving or removing access here is written to the workspace audit log, with who '
  + 'did it and when. Being refused a read is not recorded, so an empty log does '
  + 'not mean nobody tried.';

/** Shown when the viewer lacks `manage`. The routes 403; say why, do not error. */
export const ACCESS_FORBIDDEN_NOTE =
  'Only someone with the manage role on this workspace can see or change who reads '
  + 'a private conversation.';
