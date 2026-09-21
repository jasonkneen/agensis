import { useState } from 'react';
import { Zap } from 'lucide-react';
import { Button } from '@agensis/ui/components/button';
import {
 forceDrainAgentQueue,
 forceDrainMessage,
 getAgentQueueStatus,
 type ForceDrainResult,
 type QueueStatusResult,
} from '@/lib/forceDrainAgentQueue';
import { cn } from '@/lib/utils';

// Operator "Force drain" — a manage-gated override that runs the task-queue
// and / or chat-turn drain for one agent RIGHT NOW, bypassing the in-process
// debounce and the 30s reaper tick.
//
// WHY THIS LIVES NEXT TO Activate / Connect / Delete (not next to Stop on
// the chat header). The Stop control in src/components/chat/StopAgentButton
// is keyed by job id and aborts ONE running turn; this control is keyed by
// agent id and unblocks work the agent is NOT currently doing. They look
// similar from the outside (both are "make the agent move") but they answer
// different questions and live in different surfaces.
//
// WHY A ZAP, NOT A PLAY / ARROW. Play reads as "resume the running thing";
// a right-arrow reads as "go to next". Neither matches what an override does.
// A zap is the universal "kick this", which is exactly the affordance the
// operator is reaching for when the queue is wedged.
//
// WHY TWO STATES (idle / busy / result) AND NOT A CONFIRMATION DIALOG. A
// drain is idempotent — pressing it twice is the same as pressing it once.
// A confirmation dialog would add friction for an action whose failure mode
// is "nothing happened" (the audit row carries that, no confirmation needed).

interface Props {
 workspaceId: string;
 agentId: string;
 /** Bumps the the result pane after a successful drain. */
 onDrained?: (result: ForceDrainResult, status: QueueStatusResult | null) => void;
 className?: string;
}

const BUSY_LABEL = 'Draining…';

export function ForceDrainAgentButton({ workspaceId, agentId, onDrained, className }: Props) {
 const [busy, setBusy] = useState(false);
 const [status, setStatus] = useState<{ kind: 'success' | 'error' | 'idle'; message?: string }>({ kind: 'idle' });

 const onClick = async () => {
  if (busy) return;
  setBusy(true);
  setStatus({ kind: 'idle' });
  const outcome = await forceDrainAgentQueue(workspaceId, agentId, 'all');
  if (!outcome.ok || !outcome.result) {
   setStatus({ kind: 'error', message: outcome.error || 'Force drain failed' });
   setBusy(false);
   return;
  }
  // Refresh the status so the operator sees the post-drain queue state. The
  // status endpoint is the only durable answer to "did anything actually
  // happen" — the row counts in the result are a snapshot BEFORE the drain
  // fired.
  const statusOutcome = await getAgentQueueStatus(workspaceId, agentId);
  setStatus({ kind: 'success', message: forceDrainMessage(outcome.result) });
  if (statusOutcome.ok && statusOutcome.result && onDrained) {
   onDrained(outcome.result, statusOutcome.result);
  }
  setBusy(false);
 };

 return (
  <span className={cn('flex shrink-0 items-center gap-1.5', className)}>
   <Button
    type="button"
    variant="outline"
    size="sm"
    onClick={() => void onClick()}
    disabled={busy}
    title="Force-drain this agent's queues right now — bypasses the 30s reaper tick and audits an operator_force row."
   >
    <Zap data-icon="inline-start" />
    {busy ? BUSY_LABEL : 'Force drain'}
   </Button>
   {status.kind === 'success' && status.message ? (
    <span role="status" className="truncate text-xs text-muted-foreground">{status.message}</span>
   ) : null}
   {status.kind === 'error' && status.message ? (
    <span role="status" className="truncate text-xs text-destructive">{status.message}</span>
   ) : null}
  </span>
 );
}