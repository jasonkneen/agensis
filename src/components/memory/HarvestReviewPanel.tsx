import { useState } from 'react';
import { AlertTriangle, Check, CopyCheck, FileText, Sprout, Trash2, Wrench, X } from 'lucide-react';
import type { Document, MemoryFact } from '../../types';
import { useThreadHarvests } from '../../hooks/useThreadHarvests';
import {
  acceptTarget,
  decisionSummary,
  duplicateOf,
  harvestCounts,
  harvestProvenance,
  kindLabel,
  type HarvestFinding,
  type HarvestKind,
  type ThreadHarvest,
} from '../../lib/threadHarvest';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';

// Reviewing what a discarded thread proposed.
//
// Deleting a thread is when its lessons are most likely to be lost, so a worker
// reads the transcript and proposes what the workspace should keep. Those
// proposals sat in the database with nothing to read them until this panel.
//
// Two rules the layout is built around:
//
//  1. Every proposal says, before the click, WHERE accepting writes it. Accept
//     is the only thing in this feature that touches memory_facts or documents,
//     and a button whose consequence you learn afterwards is not a review.
//  2. There is no bulk accept. Accepting a batch means accepting things nobody
//     read, which is the exact failure this whole design exists to prevent. The
//     only multi-row action is Dismiss all, which writes nothing anywhere.

const KIND_ICON: Record<HarvestKind, typeof Sprout> = {
  memory: Sprout,
  skill: Wrench,
  doc: FileText,
};

interface HarvestReviewPanelProps {
  workspaceId: string;
  /** Existing memory, used only to warn that a proposal is already known. */
  facts: MemoryFact[];
  /** Existing documents, same. Metadata-only list rows are enough — title matches. */
  documents: Document[];
}

export function HarvestReviewPanel({ workspaceId, facts, documents }: HarvestReviewPanelProps) {
  const { harvests, pendingCount, loading, busyKey, decide } = useThreadHarvests(workspaceId);
  const [error, setError] = useState('');

  const handleDecide = async (harvestId: string, index: number, decision: 'accept' | 'dismiss') => {
    setError('');
    const result = await decide(harvestId, index, decision);
    if (result.error) setError(result.error);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-card p-4">
        <div className="flex items-start gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Sprout className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Harvested from deleted threads</h2>
            <p className="text-sm text-muted-foreground">
              {pendingCount === 0
                ? 'Nothing waiting on you.'
                : `${pendingCount} proposal${pendingCount === 1 ? '' : 's'} waiting on you.`}
              {' '}
              A model read each discarded thread and suggested what to keep. Nothing is saved until you accept it.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss error">
            <X className="size-4" />
          </button>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {loading ? (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">Loading proposals…</p>
          ) : harvests.length === 0 ? (
            <Empty className="min-h-80 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Sprout />
                </EmptyMedia>
                <EmptyTitle>Nothing harvested yet</EmptyTitle>
                <EmptyDescription>
                  When a chat thread is deleted, its transcript is read once for anything
                  worth keeping — a procedure, a durable fact, a decision worth writing
                  down. Whatever it finds shows up here for you to accept or discard.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            harvests.map(harvest => (
              <HarvestCard
                key={harvest.id}
                harvest={harvest}
                facts={facts}
                documents={documents}
                busyKey={busyKey}
                onDecide={handleDecide}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function HarvestCard({
  harvest,
  facts,
  documents,
  busyKey,
  onDecide,
}: {
  harvest: ThreadHarvest;
  facts: MemoryFact[];
  documents: Document[];
  busyKey: string;
  onDecide: (harvestId: string, index: number, decision: 'accept' | 'dismiss') => void;
}) {
  const counts = harvestCounts(harvest.findings);
  const pending = harvest.findings.filter(finding => !finding.decision);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">
              {harvest.threadTitle || 'Untitled thread'}
            </h3>
            {/* The provenance is not a footnote: the thread is GONE, a model
                wrote this, and nothing has been saved. All three, up front. */}
            <p className="mt-0.5 text-xs text-muted-foreground">{harvestProvenance(harvest)}</p>
          </div>
          <Badge variant={counts.pending > 0 ? 'default' : 'outline'} className="shrink-0">
            {counts.pending > 0 ? `${counts.pending} to review` : 'Reviewed'}
          </Badge>
        </div>
        {pending.length > 1 && (
          <div className="mt-2 flex justify-end">
            {/* Dismiss-all only. There is deliberately no accept-all: a bulk
                accept writes things nobody read into memory. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => pending.forEach(finding => onDecide(harvest.id, finding.index, 'dismiss'))}
            >
              <Trash2 data-icon="inline-start" />
              Dismiss all {pending.length}
            </Button>
          </div>
        )}
      </header>

      <div className="flex flex-col divide-y divide-border">
        {harvest.findings.map(finding => (
          <FindingRow
            key={finding.index}
            harvestId={harvest.id}
            finding={finding}
            duplicate={duplicateOf(finding, facts, documents)}
            busy={busyKey === `${harvest.id}:${finding.index}`}
            onDecide={onDecide}
          />
        ))}
      </div>
    </section>
  );
}

function FindingRow({
  harvestId,
  finding,
  duplicate,
  busy,
  onDecide,
}: {
  harvestId: string;
  finding: HarvestFinding;
  duplicate: { kind: 'fact' | 'document'; label: string } | null;
  busy: boolean;
  onDecide: (harvestId: string, index: number, decision: 'accept' | 'dismiss') => void;
}) {
  const Icon = KIND_ICON[finding.kind];
  const target = acceptTarget(finding.kind);
  const settled = decisionSummary(finding);

  return (
    <article className={`px-4 py-3 ${finding.decision ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="min-w-0 text-sm font-medium">{finding.title}</h4>
            <Badge variant="outline" className="shrink-0">{kindLabel(finding.kind)}</Badge>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{finding.body}</p>
          {finding.why && (
            <p className="mt-1 text-xs italic text-muted-foreground">Why keep it: {finding.why}</p>
          )}

          {duplicate && !finding.decision && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
              <CopyCheck className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">
                Looks like {duplicate.kind === 'fact' ? 'a fact' : 'a document'} you already have:
                {' '}
                <span className="font-medium">{duplicate.label}</span>
              </span>
            </p>
          )}

          {settled ? (
            <p className="mt-2 text-xs font-medium text-muted-foreground">{settled}</p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onDecide(harvestId, finding.index, 'accept')}
              >
                <Check data-icon="inline-start" />
                Accept
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onDecide(harvestId, finding.index, 'dismiss')}
              >
                <X data-icon="inline-start" />
                Dismiss
              </Button>
              {/* Said BEFORE the click. A skill has no app-side store, so it
                  becomes a written page — the label has to admit that. */}
              <span className="text-xs text-muted-foreground">Saves to {target.label}</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
