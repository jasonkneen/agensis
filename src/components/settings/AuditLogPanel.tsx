import { useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '@agensis/ui/components/badge';
import { Button } from '@agensis/ui/components/button';
import { FieldDescription, FieldGroup } from '@agensis/ui/components/field';
import { NativeSelect, NativeSelectOption } from '@agensis/ui/components/native-select';
import { Spinner } from '@agensis/ui/components/spinner';
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

  // Consecutive identical actions collapse into one row with a count and a time
  // range. Fifteen "Connect token issued · claude · yolo (unchanged)" rows in a
  // column say exactly what one row and a "x15" says, except they also bury
  // every other event on the page — and the events you actually want out of an
  // audit log are the unusual ones. Only ADJACENT rows group, and only when
  // actor, action, target and change all match, so nothing is ever aggregated
  // across an intervening event that would change the reading.
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

  const groups = useMemo(() => {
    const out: Array<{ row: typeof rows[number]; count: number; oldestTime: string }> = [];
    for (const row of rows) {
      const previous = out[out.length - 1];
      const same = previous
        && previous.row.actor === row.actor
        && previous.row.action === row.action
        && previous.row.target === row.target
        && previous.row.change === row.change
        && previous.row.detail === row.detail;
      if (same) {
        previous.count += 1;
        // Entries arrive newest-first, so each later match is the older end of
        // the range.
        previous.oldestTime = row.time;
        continue;
      }
      out.push({ row, count: 1, oldestTime: row.time });
    }
    return out;
  }, [rows]);

  if (!workspaceId) {
    return (
      <FieldGroup>
        <FieldDescription>Select a workspace to read its audit log.</FieldDescription>
      </FieldGroup>
    );
  }

  return (
    <FieldGroup className="gap-3 text-2xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium">Audit log</div>
        <div className="flex items-center gap-1.5">
          <NativeSelect
            value={filter}
            onChange={event => setFilter(event.target.value as '' | AuditAction)}
            aria-label="Filter by action"
            className="h-7 text-2xs"
          >
            {FILTERS.map(option => (
              <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-2xs" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Risk 5 in the plan, and the one most likely to bite because it is
          social: "audit log" invites the assumption of tamper-PROOF. Say what it
          actually guarantees, in the panel, rather than letting someone rely on
          it in a dispute. */}
      <p className="text-3xs leading-snug text-muted-foreground">{AUDIT_TRUST_NOTE}</p>

      {loading && (
        <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <Spinner className="size-3.5" /> Loading…
        </div>
      )}

      {error && <p className="text-2xs text-destructive">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="text-2xs text-muted-foreground">{AUDIT_EMPTY_STATE}</p>
      )}

      {groups.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border/60">
          {/* Fixed layout so the columns hold their widths instead of being
              re-negotiated by whichever row happens to have the longest target:
              a table that reflows as you page through it is unreadable. */}
          <table className="w-full min-w-[36rem] table-fixed border-collapse text-3xs leading-tight">
            <colgroup>
              <col className="w-[7.5rem]" />
              <col className="w-[7rem]" />
              <col />
              <col className="w-[8rem]" />
              <col className="w-[9rem]" />
            </colgroup>
            <thead>
              <tr className="ui-section-label border-b border-border bg-muted/30 text-left">
                <th className="px-2 py-1.5 font-medium">Time</th>
                <th className="px-2 py-1.5 font-medium">Actor</th>
                <th className="px-2 py-1.5 font-medium">Action</th>
                <th className="px-2 py-1.5 font-medium">Target</th>
                <th className="px-2 py-1.5 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(({ row, count, oldestTime }) => (
                <tr key={row.entry.id} className="border-b border-border/50 align-top last:border-0 odd:bg-muted/15">
                  <td
                    className="whitespace-nowrap px-2 py-1.5 text-3xs text-muted-foreground tabular-nums"
                    title={row.entry.created_at}
                  >
                    {row.time}
                    {count > 1 && (
                      <div className="text-3xs opacity-70">to {oldestTime}</div>
                    )}
                  </td>
                  <td className="truncate px-2 py-1.5 text-3xs" title={row.actor}>
                    {row.actor}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-3xs">{row.action}</span>
                      {count > 1 && (
                        <Badge
                          variant="secondary"
                          className="h-4 px-1 text-3xs font-normal leading-none tabular-nums"
                          title={`${count} identical entries between ${oldestTime} and ${row.time}`}
                        >
                          x{count}
                        </Badge>
                      )}
                      {row.unrestricted && (
                        <Badge variant="destructive" className="h-4 gap-0.5 px-1 text-3xs font-normal leading-none" title="Unrestricted shell on the daemon host">
                          <ShieldAlert className="size-2" />
                          Unrestricted
                        </Badge>
                      )}
                      {!row.unrestricted && row.escalation && (
                        <Badge variant="secondary" className="h-4 px-1 text-3xs font-normal leading-none" title="This widened someone's access">
                          Escalation
                        </Badge>
                      )}
                    </div>
                    {/* The detail line is the row's own sub-text, so it is
                        indented under the action rather than starting at the
                        cell edge, and truncates instead of wrapping into a
                        second line that breaks the table's vertical rhythm.
                        The full value stays reachable on hover. */}
                    {row.detail && (
                      <div className="mt-0.5 truncate border-l border-border/60 pl-1.5 text-3xs text-muted-foreground" title={row.detail}>
                        {row.detail}
                      </div>
                    )}
                  </td>
                  <td className="truncate px-2 py-1.5 text-3xs" title={row.target}>
                    {row.target}
                  </td>
                  <td className="truncate px-2 py-1.5 text-3xs text-muted-foreground" title={row.change}>
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
          <Button type="button" variant="secondary" size="sm" className="h-7 text-2xs" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><Spinner className="size-3.5" /> Loading</> : 'Load more'}
          </Button>
        </div>
      )}
    </FieldGroup>
  );
}
