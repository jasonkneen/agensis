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
  { value: 'agent_template.imported', label: 'Agent template imported' },
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
    <FieldGroup className="gap-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium">Audit log</div>
        <div className="flex items-center gap-1.5">
          <NativeSelect
            value={filter}
            onChange={event => setFilter(event.target.value as '' | AuditAction)}
            aria-label="Filter by action"
            className="h-7 text-[11px]"
          >
            {FILTERS.map(option => (
              <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Risk 5 in the plan, and the one most likely to bite because it is
          social: "audit log" invites the assumption of tamper-PROOF. Say what it
          actually guarantees, in the panel, rather than letting someone rely on
          it in a dispute. */}
      <p className="text-[10px] leading-snug text-muted-foreground">{AUDIT_TRUST_NOTE}</p>

      {loading && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Spinner className="size-3.5" /> Loading…
        </div>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">{AUDIT_EMPTY_STATE}</p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full min-w-[34rem] border-collapse text-[10px] leading-tight">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[9px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1 font-medium">Time</th>
                <th className="px-2 py-1 font-medium">Actor</th>
                <th className="px-2 py-1 font-medium">Action</th>
                <th className="px-2 py-1 font-medium">Target</th>
                <th className="px-2 py-1 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.entry.id} className="border-b border-border/50 align-top last:border-0">
                  <td
                    className="whitespace-nowrap px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums"
                    title={row.entry.created_at}
                  >
                    {row.time}
                  </td>
                  <td className="max-w-[7rem] truncate px-2 py-0.5 text-[10px]" title={row.actor}>
                    {row.actor}
                  </td>
                  <td className="px-2 py-0.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px]">{row.action}</span>
                      {row.unrestricted && (
                        <Badge variant="destructive" className="h-3.5 gap-0.5 px-1 text-[8px] font-normal leading-none" title="Unrestricted shell on the daemon host">
                          <ShieldAlert className="size-2" />
                          Unrestricted
                        </Badge>
                      )}
                      {!row.unrestricted && row.escalation && (
                        <Badge variant="secondary" className="h-3.5 px-1 text-[8px] font-normal leading-none" title="This widened someone's access">
                          Escalation
                        </Badge>
                      )}
                    </div>
                    {row.detail && (
                      <div className="mt-0.5 text-[9px] text-muted-foreground">{row.detail}</div>
                    )}
                  </td>
                  <td className="max-w-[8rem] truncate px-2 py-0.5 text-[10px]" title={row.target}>
                    {row.target}
                  </td>
                  <td className="max-w-[9rem] truncate px-2 py-0.5 text-[10px] text-muted-foreground" title={row.change}>
                    {row.change}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div>
          <Button type="button" variant="secondary" size="sm" className="h-7 text-[11px]" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><Spinner className="size-3.5" /> Loading</> : 'Load more'}
          </Button>
        </div>
      )}
    </FieldGroup>
  );
}
