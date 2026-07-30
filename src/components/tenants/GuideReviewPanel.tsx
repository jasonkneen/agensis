import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useGuideSubmissions } from '../../hooks/useGuideSubmissions';
import {
  guideSubmissionDate,
  guideSubmissionMatch,
  guideSubmissionOwner,
  type CursorBuddyGuideSubmission,
} from '../../lib/cursorbuddyGuides';
import { PANE_HEADER, TEXT_BODY, TEXT_META } from '../inbox/inboxPresentation';

type ReviewFilter = 'pending' | 'all';

function ReviewStatus({ status }: { status: CursorBuddyGuideSubmission['review_status'] }) {
  return (
    <span className={cn(
      'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]',
      status === 'approved' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      status === 'rejected' && 'border-destructive/30 bg-destructive/10 text-destructive',
      status === 'pending' && 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    )}>
      {status}
    </span>
  );
}

export function GuideReviewPanel() {
  const { guides, loading, error, refetch, review } = useGuideSubmissions(true);
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const visible = useMemo(
    () => filter === 'pending' ? guides.filter(guide => guide.review_status === 'pending') : guides,
    [filter, guides],
  );
  const selected = guides.find(guide => guide.id === selectedId) ?? visible[0] ?? null;

  useEffect(() => {
    setNotes(selected?.review_notes || '');
    setActionError(null);
  }, [selected?.id, selected?.review_notes]);

  async function decide(decision: 'approved' | 'rejected') {
    if (!selected || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      await review(selected.id, decision, notes);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Review could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      <div className={cn(PANE_HEADER, 'justify-between')}>
        <div className="flex min-w-0 items-center gap-2">
          <strong className={TEXT_BODY}>Community guide review</strong>
          <span className={cn('text-muted-foreground', TEXT_META)}>
            {guides.filter(guide => guide.review_status === 'pending').length} pending
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={filter === 'pending' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilter('pending')}
          >
            Pending
          </Button>
          <Button
            type="button"
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilter('all')}
          >
            All
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={refetch}
            aria-label="Refresh guide submissions"
            title="Refresh"
          >
            <RotateCw className={loading ? 'animate-spin' : undefined} />
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)] max-md:grid-cols-1">
        <ScrollArea className="min-h-0 border-r border-border/60 max-md:max-h-64 max-md:border-b max-md:border-r-0">
          <div className="divide-y divide-border/50">
            {visible.map((guide) => (
              <button
                key={guide.id}
                type="button"
                onClick={() => setSelectedId(guide.id)}
                className={cn(
                  'flex w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  selected?.id === guide.id && 'bg-muted',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className={cn('min-w-0 truncate', TEXT_BODY)}>{guide.name}</strong>
                  <ReviewStatus status={guide.review_status} />
                </span>
                <span className={cn('truncate text-muted-foreground', TEXT_META)}>{guideSubmissionMatch(guide)}</span>
                <span className={cn('truncate text-muted-foreground', TEXT_META)}>{guideSubmissionOwner(guide)}</span>
              </button>
            ))}
          </div>
          {!loading && !visible.length && (
            <p className={cn('p-6 text-center text-muted-foreground', TEXT_BODY)}>
              {filter === 'pending' ? 'No guides are waiting for review.' : 'No guide submissions yet.'}
            </p>
          )}
          {error && <p role="alert" className="p-4 text-sm text-destructive">{error}</p>}
        </ScrollArea>

        {selected ? (
          <ScrollArea className="min-h-0">
            <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-2"><ReviewStatus status={selected.review_status} /></div>
                  <h2 className="text-xl font-semibold">{selected.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{selected.summary || 'No summary supplied.'}</p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <a href={selected.site_url} target="_blank" rel="noreferrer">
                    Visit site
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              </div>

              <dl className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Match</dt><dd className="break-all font-medium">{guideSubmissionMatch(selected)}</dd></div>
                <div><dt className="text-muted-foreground">Submitted by</dt><dd className="break-all font-medium">{guideSubmissionOwner(selected)}</dd></div>
                <div><dt className="text-muted-foreground">Submitted</dt><dd>{guideSubmissionDate(selected.submitted_at)}</dd></div>
                <div><dt className="text-muted-foreground">Schema</dt><dd>{String(selected.manifest.version || '1.0')}</dd></div>
              </dl>

              <div>
                <h3 className="mb-2 text-sm font-semibold">Guide document</h3>
                <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-4 text-xs leading-relaxed">
                  {JSON.stringify(selected.manifest, null, 2)}
                </pre>
              </div>

              <div>
                <label htmlFor="guide-review-notes" className="mb-2 block text-sm font-semibold">
                  Review notes
                </label>
                <textarea
                  id="guide-review-notes"
                  value={notes}
                  onChange={event => setNotes(event.target.value)}
                  rows={4}
                  maxLength={1000}
                  placeholder="Explain anything the author should change."
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => void decide('approved')}
                  disabled={saving || selected.review_status !== 'pending'}
                >
                  <Check aria-hidden="true" />
                  Approve and publish
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void decide('rejected')}
                  disabled={saving || selected.review_status !== 'pending'}
                >
                  <X aria-hidden="true" />
                  Reject
                </Button>
              </div>
              <p aria-live="polite" className="sr-only">
                {saving ? 'Saving review' : actionError || ''}
              </p>
            </div>
          </ScrollArea>
        ) : (
          <div className="flex items-center justify-center p-8 text-center text-sm text-muted-foreground">
            Select a guide to inspect its match rules and content.
          </div>
        )}
      </div>
    </div>
  );
}
