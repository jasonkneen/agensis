import { useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldDescription, FieldGroup } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { useAuditLog } from '../../hooks/useAuditLog';
import {
  AUDIT_EMPTY_STATE,
  AUDIT_TRUST_NOTE,
  auditActionLabel,
  formatActor,
  formatAuditTime,
  formatChange,
  formatDetail,
  formatTarget,
  isEscalation,
  isUnrestrictedShellGrant,
} from '../../lib/auditEntry';
import type { AuditAction } from '../../types';

// The audit log panel: a durable record of the privileged actions that used to
// leave no trace anywhere — role changes, member removal, invites, permission
// mode flips (including 'yolo', which is unrestricted shell on the daemon host),
// permanent tool grants, connect tokens and vault writes.
//
// READ-ONLY by construction. There is nothing to edit here and no route that
// would accept an edit. Manage role only, matching the actions being recorded.
//
// Not live. Every other list in the app streams over realtime; this one is
// fetched on demand, because a realtime binding would fan audit rows at every
// subscribed browser. The server refuses such a subscription outright.
//
// All formatting lives in src/lib/auditEntry.ts so it can be unit-tested without
// mounting this component.

const FILTERS: Array<{ value: '' | AuditAction; label: string }> = [
  { value: '', label: 'All actions' },
  { value: 'agent.permission_mode_changed', label: 'Agent permission mode changed' },
  { value: 'agent.permission_rule_granted', label: 'Permanent tool grant added' },
  { value: 'agent.permission_rule_revoked', label: 'Permanent tool grant removed' },
  { value: 'agent.connect_token_minted', label: 'Connect token issued' },
  { value: 'member.role_changed', label: 'Member role changed' },
  { value: 'member.removed', label: 'Member removed' },
  { value: 'invite.created', label: 'Invite created' },
  { value: 'invite.revoked', label: 'Invite revoked' },
  { value: 'vault.secret_set', label: 'Vault secret set' },
  { value: 'vault.secret_deleted', label: 'Vault secret deleted' },
  { value: 'chat_session.access_granted', label: 'Private conversation opened to someone' },
  { value: 'chat_session.access_revoked', label: 'Private conversation access removed' },
];

export function AuditLogPanel({ workspaceId }: { workspaceId: string | null }) {
  const [filter, setFilter] = useState<'' | AuditAction>('');
  const { entries, loading, loadingMore, error, hasMore, loadMore, refresh } = useAuditLog(workspaceId, filter);

  const rows = useMemo(() => entries.map(entry => ({
    entry,
    time: formatAuditTime(entry.created_at),
    actor: formatActor(entry),
    action: auditActionLabel(entry.action),
    target: formatTarget(entry),
    change: formatChange(entry),
    detail: formatDetail(entry.detail),
    escalation: isEscalation(entry),
    unrestricted: isUnrestrictedShellGrant(entry),
  })), [entries]);

  if (!workspaceId) {
    return (
      <FieldGroup>
        <FieldDescription>Select a workspace to read its audit log.</FieldDescription>
      </FieldGroup>
    );
  }

  return (
    <FieldGroup>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold">Audit log</div>
        <div className="flex items-center gap-2">
          <NativeSelect
            value={filter}
            onChange={event => setFilter(event.target.value as '' | AuditAction)}
            aria-label="Filter by action"
          >
            {FILTERS.map(option => (
              <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Risk 5 in the plan, and the one most likely to bite because it is
          social: "audit log" invites the assumption of tamper-PROOF. Say what it
          actually guarantees, in the panel, rather than letting someone rely on
          it in a dispute. */}
      <FieldDescription>{AUDIT_TRUST_NOTE}</FieldDescription>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading the audit log
        </div>
      )}

      {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}

      {!loading && !error && rows.length === 0 && (
        <FieldDescription>{AUDIT_EMPTY_STATE}</FieldDescription>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Time</th>
                <th className="py-2 pr-3 font-medium">Actor</th>
                <th className="py-2 pr-3 font-medium">Action</th>
                <th className="py-2 pr-3 font-medium">Target</th>
                <th className="py-2 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.entry.id} className="border-b border-border/60 align-top">
                  <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground tabular-nums">{row.time}</td>
                  <td className="py-2 pr-3">{row.actor}</td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span>{row.action}</span>
                      {row.unrestricted && (
                        <Badge variant="destructive" title="Unrestricted shell on the daemon host">
                          <ShieldAlert />
                          Unrestricted
                        </Badge>
                      )}
                      {!row.unrestricted && row.escalation && (
                        <Badge variant="secondary" title="This widened someone's access">Escalation</Badge>
                      )}
                    </div>
                    {row.detail && (
                      <div className="mt-0.5 text-xs text-muted-foreground">{row.detail}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3">{row.target}</td>
                  <td className="py-2">{row.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><Spinner /> Loading</> : 'Load more'}
          </Button>
        </div>
      )}
    </FieldGroup>
  );
}
