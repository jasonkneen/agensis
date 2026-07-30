import { useState } from 'react';
import { AlertTriangle, Check, CopyCheck, FileText, Lightbulb, Trash2, Wrench, X } from 'lucide-react';
import type { Document, MemoryFact } from '../../types';
import { useSuggestions } from '../../hooks/useSuggestions';
import {
  acceptTarget,
  decisionSummary,
  duplicateOf,
  kindLabel,
  suggestionCounts,
  suggestionProvenance,
  type Suggestion,
  type SuggestionKind,
  type SuggestionSet,
} from '../../lib/suggestions';
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

// Reviewing what this workspace's conversations suggested keeping.
//
// A conversation is read when it is deleted, and again whenever a live one has
// gone quiet for a few hours. Either way a model proposes what to keep, and
// those suggestions sit in the database with nothing to read them until here.
//
// Two rules the layout is built around:
//
//  1. Every suggestion says, before the click, WHERE accepting writes it.
//     Accept is the only thing in this feature that touches memory_facts or
//     documents, and a button whose consequence you learn afterwards is not a
//     review.
//  2. There is no bulk accept. Accepting a batch means accepting things nobody
//     read, which is the exact failure this whole design exists to prevent. The
//     only multi-row action is Dismiss all, which writes nothing anywhere.

const KIND_ICON: Record<SuggestionKind, typeof Lightbulb> = {
  memory: Lightbulb,
  skill: Wrench,
  doc: FileText,
};

interface SuggestionsPanelProps {
  workspaceId: string;
  /** Existing memory, used only to warn that a suggestion is already known. */
  facts: MemoryFact[];
  /** Existing documents, same. Metadata-only list rows are enough — title matches. */
  documents: Document[];
}

export function SuggestionsPanel({ workspaceId, facts, documents }: SuggestionsPanelProps) {
  const { suggestionSets, pendingCount, loading, busyKey, decide } = useSuggestions(workspaceId);
  const [error, setError] = useState('');

  const handleDecide = async (setId: string, index: number, decision: 'accept' | 'dismiss') => {
    setError('');
    const result = await decide(setId, index, decision);
    if (result.error) setError(result.error);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-card p-4">
        <div className="flex items-start gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Lightbulb className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Suggestions</h2>
            <p className="text-sm text-muted-foreground">
              {pendingCount === 0
                ? 'Nothing waiting on you.'
                : `${pendingCount} suggestion${pendingCount === 1 ? '' : 's'} waiting on you.`}
              {' '}
              A model reads a conversation once it is finished with — deleted, or
              simply gone quiet — and suggests what to keep. Nothing is saved until
              you accept it.
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
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">Loading suggestions…</p>
          ) : suggestionSets.length === 0 ? (
            <Empty className="min-h-80 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Lightbulb />
                </EmptyMedia>
                <EmptyTitle>No suggestions yet</EmptyTitle>
                <EmptyDescription>
                  When a conversation finishes — because it was deleted, or because it
                  has been quiet for a few hours — its transcript is read once for
                  anything worth keeping: a procedure, a durable fact, a decision worth
                  writing down. Whatever it finds shows up here for you to accept or
                  dismiss. Direct messages are never read.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            suggestionSets.map(set => (
              <SuggestionSetCard
                key={set.id}
                set={set}
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

function SuggestionSetCard({
  set,
  facts,
  documents,
  busyKey,
  onDecide,
}: {
  set: SuggestionSet;
  facts: MemoryFact[];
  documents: Document[];
  busyKey: string;
  onDecide: (setId: string, index: number, decision: 'accept' | 'dismiss') => void;
}) {
  const counts = suggestionCounts(set.suggestions);
  const pending = set.suggestions.filter(suggestion => !suggestion.decision);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">
              {set.threadTitle || 'Untitled conversation'}
            </h3>
            {/* The provenance is not a footnote: which conversation and what
                became of it, a model wrote this, and nothing has been saved.
                All three, up front. */}
            <p className="mt-0.5 text-xs text-muted-foreground">{suggestionProvenance(set)}</p>
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
              onClick={() => pending.forEach(suggestion => onDecide(set.id, suggestion.index, 'dismiss'))}
            >
              <Trash2 data-icon="inline-start" />
              Dismiss all {pending.length}
            </Button>
          </div>
        )}
      </header>

      <div className="flex flex-col divide-y divide-border">
        {set.suggestions.map(suggestion => (
          <SuggestionRow
            key={suggestion.index}
            setId={set.id}
            suggestion={suggestion}
            duplicate={duplicateOf(suggestion, facts, documents)}
            busy={busyKey === `${set.id}:${suggestion.index}`}
            onDecide={onDecide}
          />
        ))}
      </div>
    </section>
  );
}

function SuggestionRow({
  setId,
  suggestion,
  duplicate,
  busy,
  onDecide,
}: {
  setId: string;
  suggestion: Suggestion;
  duplicate: { kind: 'fact' | 'document'; label: string } | null;
  busy: boolean;
  onDecide: (setId: string, index: number, decision: 'accept' | 'dismiss') => void;
}) {
  const Icon = KIND_ICON[suggestion.kind];
  const target = acceptTarget(suggestion.kind);
  const settled = decisionSummary(suggestion);

  return (
    <article className={`px-4 py-3 ${suggestion.decision ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="min-w-0 text-sm font-medium">{suggestion.title}</h4>
            <Badge variant="outline" className="shrink-0">{kindLabel(suggestion.kind)}</Badge>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{suggestion.body}</p>
          {suggestion.why && (
            <p className="mt-1 text-xs italic text-muted-foreground">Why keep it: {suggestion.why}</p>
          )}

          {duplicate && !suggestion.decision && (
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
                onClick={() => onDecide(setId, suggestion.index, 'accept')}
              >
                <Check data-icon="inline-start" />
                Accept
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onDecide(setId, suggestion.index, 'dismiss')}
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
