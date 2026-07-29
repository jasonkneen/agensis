import { useState } from 'react';
import { Check, Clock, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PermissionRequest, PermissionScope } from '../../types';
import {
  SCOPE_HINTS,
  SCOPE_LABELS,
  isPermissionRequestOpen,
  offeredScopes,
  permissionOutcomeBadge,
  permissionOutcomeLabel,
  permissionRequestSummary,
} from './permissionRequests';
import { shortenPathsIn } from '../../lib/shortPath';

// Matches ToolStepGroup's rails so a request lines up with the tool chips it
// interrupts — same indent, same "hanging off the conversation" reading.
const CHANNEL_INDENT = 'pl-[3.75rem] pr-4';
const COMPACT_INDENT = 'pl-11 pr-2';

export interface PermissionRequestCardProps {
  request: PermissionRequest;
  /**
   * Pass false only where the caller actually KNOWS the viewer lacks `manage`.
   * Defaults to true because the chat window has no reliable role signal, and
   * greying out the button for someone who is in fact an admin is worse than
   * letting the server refuse — its refusal says exactly why, and the card
   * shows it.
   */
  canGrantPermanently?: boolean;
  busy?: boolean;
  compact?: boolean;
  onDecide: (behavior: 'allow' | 'deny', scope: PermissionScope) => void | Promise<void>;
}

/**
 * "@scout wants to run `git clone …`" — with the buttons that answer it.
 *
 * The agent is BLOCKED while this is on screen: its turn is parked on the other
 * end of a socket waiting for one of these clicks, and if nobody clicks, the
 * tool call is refused. So the card states what is being asked in the agent's
 * own words, says out loud what each scope costs, and never hides the narrow
 * option behind the broad one.
 *
 * Once decided it collapses to a single settled line naming the scope granted.
 * Flattening "allowed once" and "allowed forever" into one "Approved" would
 * make the transcript useless to anyone auditing what an agent was given.
 */
export function PermissionRequestCard({
  request,
  canGrantPermanently = true,
  busy = false,
  compact = false,
  onDecide,
}: PermissionRequestCardProps) {
  const [error, setError] = useState('');
  const open = isPermissionRequestOpen(request);
  const summary = permissionRequestSummary(request);
  const indent = compact ? COMPACT_INDENT : CHANNEL_INDENT;

  // Settled: a record, not a question. WHAT was approved leads and gets the
  // room; the scope is one word and the approver's name lives in the tooltip.
  // Reading "Always allowed by <name>" first, with an absolute path trailing off
  // the end of the line, buried the only part that identifies the call.
  if (!open) {
    const allowed = request.status === 'allowed';
    const Icon = allowed ? ShieldCheck : request.status === 'expired' ? Clock : ShieldAlert;
    return (
      <div className={cn('min-w-0 py-1', indent)}>
        <div className="flex min-w-0 items-center gap-2 border-l border-border pl-2.5 text-[11px] text-muted-foreground">
          <Icon className={cn('size-3.5 shrink-0', allowed ? 'text-emerald-500' : '')} aria-hidden />
          <span className="truncate font-mono" title={summary}>{shortenPathsIn(summary)}</span>
          <span
            className={cn('shrink-0 font-medium', allowed ? 'text-emerald-600/90 dark:text-emerald-400/90' : '')}
            title={permissionOutcomeLabel(request)}
          >
            {permissionOutcomeBadge(request)}
          </span>
        </div>
      </div>
    );
  }

  const scopes = offeredScopes(request);
  const decide = async (behavior: 'allow' | 'deny', scope: PermissionScope) => {
    setError('');
    try {
      await onDecide(behavior, scope);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record that decision');
    }
  };

  return (
    <div className={cn('min-w-0 py-1', indent)}>
      <div
        role="group"
        aria-label="Permission request"
        className="min-w-0 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
      >
        <div className="flex min-w-0 items-start gap-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">Waiting on you to approve a tool call</p>
            <p className="mt-1 break-words font-mono text-[11px] leading-5 text-muted-foreground">{summary}</p>
            {request.description && (
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{request.description}</p>
            )}
            {request.rules.length > 0 && (
              // What "Always allow" would actually write. Shown up front rather
              // than in a tooltip: it is the one button here with consequences
              // that outlive the conversation.
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                Permanent grant would be{' '}
                {request.rules.map((rule, index) => (
                  <span key={rule}>
                    {index > 0 && ', '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{rule}</code>
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {scopes.map(scope => {
            const blocked = scope === 'always' && !canGrantPermanently;
            return (
              <button
                key={scope}
                type="button"
                disabled={busy || blocked}
                title={blocked ? 'Only a workspace admin can make a grant permanent.' : SCOPE_HINTS[scope]}
                onClick={() => void decide('allow', scope)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  scope === 'once'
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 hover:border-emerald-500 dark:text-emerald-400'
                    : 'border-border bg-muted text-muted-foreground hover:border-ring hover:text-foreground',
                )}
              >
                {scope === 'once' && <Check className="size-3" aria-hidden />}
                {SCOPE_LABELS[scope]}
              </button>
            );
          })}
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide('deny', 'once')}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors',
              'hover:border-destructive/60 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <X className="size-3" aria-hidden />
            Deny
          </button>
        </div>
        {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      </div>
    </div>
  );
}
