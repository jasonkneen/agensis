import type { AuditEntry } from '../types';

/**
 * What one `audit_log` row should SAY on screen.
 *
 * Pure string work, no React and no DOM, mirroring src/lib/activityEntry.ts —
 * which is what lets the panel's rendering rules be unit-tested without mounting
 * anything.
 *
 * The rows arrive already redacted: the server records a vault key's NAME and a
 * `configured` boolean but never its value, an invite's email DOMAIN but never
 * the local-part, and a connect token's agent but never the token. Nothing here
 * needs to redact, and nothing here should try to reconstruct what was withheld.
 */

/** Human label per action. Unknown actions fall back to the raw string. */
const ACTION_LABELS: Record<string, string> = {
  'member.role_changed': 'Member role changed',
  'member.removed': 'Member removed',
  'invite.created': 'Invite created',
  'invite.revoked': 'Invite revoked',
  'agent.permission_mode_changed': 'Agent permission mode changed',
  'agent.permission_rule_granted': 'Permanent tool grant added',
  'agent.permission_rule_revoked': 'Permanent tool grant removed',
  'agent.connect_token_minted': 'Connect token issued',
  'vault.secret_set': 'Vault secret set',
  'vault.secret_deleted': 'Vault secret deleted',
  'chat_session.access_granted': 'Private conversation opened to someone',
  'chat_session.access_revoked': 'Private conversation access removed',
  unknown: 'Unrecognised action',
};

/**
 * The actions that WIDEN what someone or something can do. The panel marks
 * these so an owner scanning a page lands on them first — a role promotion, a
 * permanent grant, a new token, and above all a flip to 'yolo', which is
 * unrestricted shell on the daemon host.
 */
const ESCALATING_ACTIONS = new Set([
  'agent.permission_mode_changed',
  'agent.permission_rule_granted',
  'agent.connect_token_minted',
  'member.role_changed',
  // Reading into a conversation somebody else believed was private is a
  // widening by any reading of the word, and it is the one an owner scanning
  // the page most wants to land on. The matching REVOKE is not listed: taking
  // access back narrows, and marking it would train people to skim past the
  // marker.
  'chat_session.access_granted',
]);

/** Roles ordered by reach, for deciding whether a role change was a promotion. */
const ROLE_RANK: Record<string, number> = {
  viewer: 0, commenter: 1, editor: 2, admin: 3, owner: 4,
};

const MODE_RANK: Record<string, number> = {
  default: 0, accept_edits: 1, yolo: 2,
};

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * True when this row represents a WIDENING of access.
 *
 * A role change or a mode change only counts if it actually went up — demoting
 * someone to viewer is not an escalation, and marking it as one would train
 * people to ignore the marker.
 */
export function isEscalation(entry: Pick<AuditEntry, 'action' | 'before_value' | 'after_value'>): boolean {
  if (!ESCALATING_ACTIONS.has(entry.action)) return false;
  if (entry.action === 'member.role_changed') {
    const before = ROLE_RANK[entry.before_value];
    const after = ROLE_RANK[entry.after_value];
    if (before === undefined || after === undefined) return true;
    return after > before;
  }
  if (entry.action === 'agent.permission_mode_changed') {
    const before = MODE_RANK[entry.before_value];
    const after = MODE_RANK[entry.after_value];
    if (before === undefined || after === undefined) return true;
    return after > before;
  }
  return true;
}

/** 'yolo' deserves its own callout: it is unrestricted shell on the daemon host. */
export function isUnrestrictedShellGrant(
  entry: Pick<AuditEntry, 'action' | 'after_value'>,
): boolean {
  return (entry.action === 'agent.permission_mode_changed'
    || entry.action === 'agent.connect_token_minted')
    && entry.after_value === 'yolo';
}

/**
 * The 'before -> after' cell. Either side may legitimately be empty — a removal
 * has no after, a grant has no before — so this renders whichever sides exist
 * rather than printing an arrow with nothing on one end of it.
 */
export function formatChange(
  entry: Pick<AuditEntry, 'before_value' | 'after_value'>,
): string {
  const before = entry.before_value?.trim() ?? '';
  const after = entry.after_value?.trim() ?? '';
  if (before && after) return `${before} to ${after}`;
  if (after) return after;
  if (before) return before;
  return '';
}

/**
 * Who did it. `actor_label` is set when the server knew a display name; the id
 * is the fallback, shortened, because a bare uuid tells a reader nothing but is
 * better than an empty cell. An unattributed row says so explicitly rather than
 * rendering blank, which would read as a UI bug rather than a real property.
 */
export function formatActor(
  entry: Pick<AuditEntry, 'actor_label' | 'actor_user_id' | 'actor_agent_id'>,
  resolveUser?: (userId: string) => string | undefined,
): string {
  const label = entry.actor_label?.trim();
  if (label) return label;
  if (entry.actor_user_id) {
    const resolved = resolveUser?.(entry.actor_user_id)?.trim();
    if (resolved) return resolved;
    return `User ${entry.actor_user_id.slice(0, 8)}`;
  }
  if (entry.actor_agent_id) return `Agent ${entry.actor_agent_id.slice(0, 8)}`;
  return 'Unattributed';
}

/** What it was done to. Prefers the label the server captured at the time. */
export function formatTarget(
  entry: Pick<AuditEntry, 'target_label' | 'target_id' | 'target_type'>,
): string {
  const label = entry.target_label?.trim();
  if (label) return label;
  if (entry.target_id) return entry.target_id.length > 12 ? `${entry.target_id.slice(0, 8)}...` : entry.target_id;
  return entry.target_type || '';
}

/** Short absolute timestamp. Audit reading is forensic; '2 hours ago' is not. */
export function formatAuditTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/**
 * The extra context line, built only from keys the redaction contract permits.
 *
 * An ALLOWLIST, not a filter: a `detail` key nobody has vetted must not reach
 * the screen just because a writer added it. If a new key is worth showing,
 * adding it here is the moment to decide it carries nothing sensitive.
 */
const DETAIL_KEYS: Array<{ key: string; label: string }> = [
  { key: 'key', label: 'Key' },
  { key: 'lane', label: 'Lane' },
  { key: 'email_domain', label: 'Domain' },
  { key: 'handle', label: 'Handle' },
  { key: 'model', label: 'Model' },
  { key: 'runtime', label: 'Runtime' },
  { key: 'rule_count', label: 'Rules' },
];

export function formatDetail(detail: AuditEntry['detail']): string {
  if (!detail || typeof detail !== 'object') return '';
  const parts: string[] = [];
  for (const { key, label } of DETAIL_KEYS) {
    const value = (detail as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') continue;
    parts.push(`${label}: ${String(value)}`);
  }
  return parts.join(' · ');
}

/**
 * The empty state's copy.
 *
 * It must say that the log STARTS here, because the actions it records left no
 * trace before it existed and there was nothing to backfill. Without this line a
 * reader reasonably assumes no rows means no privileged actions ever happened,
 * which is the opposite of true.
 */
export const AUDIT_EMPTY_STATE =
  'No entries yet. This log records privileged actions from the moment it was '
  + 'switched on; it was not backfilled, so an empty log does not mean nothing '
  + 'has ever happened in this workspace.';

/**
 * The honest description of what this log is worth, shown in the panel itself.
 *
 * Risk 5 in the plan, and the one most likely to actually bite because it is
 * social: shipping something called an audit log invites the assumption that it
 * is tamper-PROOF. It is tamper-EVIDENT, and only against application-level
 * actors. Saying so here is cheaper than someone relying on it in a dispute.
 */
export const AUDIT_TRUST_NOTE =
  'Entries are written by the server and cannot be created, edited or deleted '
  + 'through the app. Each row carries a content hash, so an edit is detectable '
  + 'and a gap in the sequence suggests a deletion. This is tamper-evident, not '
  + 'tamper-proof: anyone with direct database access can still alter it.';
