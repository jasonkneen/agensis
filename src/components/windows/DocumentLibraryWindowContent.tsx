import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, FileText, FolderTree, Info, Library, RefreshCw, Search, Users } from 'lucide-react';
import {
  LIBRARY_SOURCE_LABELS,
  LIBRARY_SPLIT_MIN_WIDTH,
  compareToPrimary,
  describeSource,
  filterLibrary,
  formatLibraryBytes,
  groupLibraryByDomain,
  librarySelectionStillExists,
  type LibrarySource,
} from '../../lib/documentLibrary';
import { describeDiff, diffHunks, diffLines, type DiffResult } from '../../lib/textDiff';
import type { DocumentLibrary } from '../../hooks/useDocumentLibrary';
import { MarkdownContent } from '../chat/MarkdownContent';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

// ---------------------------------------------------------------------------
// THE LIBRARY — every document the workspace can reach, in one place.
//
// One row per DOCUMENT, with a chip for each place that has a copy. The
// collation itself lives in src/lib/documentLibrary.ts (pure, unit-tested);
// this file is the surface over it, and follows the Skills window and the
// memory browser exactly: master-detail above LIBRARY_SPLIT_MIN_WIDTH, full
// detail with a back arrow below it.
//
// THE COMPARE VIEW IS THE POINT. A library that showed one copy and hid the
// rest would answer "what does this document say" while quietly picking a
// winner — and the interesting case is precisely when the copies DISAGREE,
// because that means one machine is working from a stale README. So: the newest
// copy renders as the document, every other copy is listed with its provenance,
// and opening one diffs it against the newest rather than replacing the view.
//
// BODIES ARE FETCHED ON SELECTION, never for the list. See useAgentDocuments.
// ---------------------------------------------------------------------------

function SourceChip({ source, onOpen }: { source: LibrarySource; onOpen: () => void }) {
  const agent = source.agent;
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={event => { event.stopPropagation(); onOpen(); }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      title={describeSource(source)}
      className={`inline-flex max-w-[11rem] items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] transition-colors ${
        // A CONNECTED agent's copy is filled; an offline agent's is outlined.
        // Same fill/outline vocabulary the Skills window uses for
        // advertised-vs-configured, and the same underlying question: is this
        // claim backed by something live, or is it the last thing we were told?
        agent?.connected || !agent
          ? 'bg-muted text-foreground hover:bg-muted/70'
          : 'border border-dashed border-border text-muted-foreground hover:bg-muted/40'
      }`}
    >
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white ${agent?.connected || !agent ? '' : 'opacity-60'}`}
        style={{ backgroundColor: agent?.color || 'var(--primary)' }}
        aria-hidden="true"
      >
        {agent?.initials || 'WS'}
      </span>
      <span className="truncate">{agent?.name || 'Workspace'}</span>
    </span>
  );
}

/**
 * A unified diff, hunked.
 *
 * Rendered as plain lines rather than through MarkdownContent on purpose: the
 * whole question is which CHARACTERS differ, and markdown that renders a
 * changed heading as a heading hides the change inside the thing it changed.
 */
function DiffView({ result }: { result: DiffResult }) {
  const hunks = useMemo(() => diffHunks(result), [result]);
  if (result.identical) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        These two copies are identical, character for character.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {result.truncated && (
        <p className="rounded-md border border-dashed border-border bg-muted/30 p-2 text-xs text-muted-foreground">
          These documents are too large to compare line by line, so every line is shown as replaced.
          The counts below are file sizes, not real edits.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
        <table className="w-full border-collapse font-mono text-[11px] leading-relaxed">
          <tbody>
            {hunks.map((hunk, hunkIndex) => (
              // Keyed fragment: a bare <> inside a .map() has no key, so React
              // falls back to reconciling the whole table by position.
              <Fragment key={`hunk-${hunkIndex}`}>
                {hunk.skipped > 0 && (
                  <tr>
                    <td colSpan={3} className="bg-muted/40 px-2 py-1 text-center text-[10px] text-muted-foreground">
                      {hunk.skipped} unchanged line{hunk.skipped === 1 ? '' : 's'}
                    </td>
                  </tr>
                )}
                {hunk.lines.map((line, lineIndex) => (
                  <tr
                    key={`${hunkIndex}-${lineIndex}`}
                    className={
                      line.op === 'added'
                        ? 'bg-emerald-500/10'
                        : line.op === 'removed'
                          ? 'bg-rose-500/10'
                          : ''
                    }
                  >
                    <td className="w-10 select-none border-r border-border/60 px-1.5 text-right align-top text-muted-foreground">
                      {line.leftNumber ?? ''}
                    </td>
                    <td className="w-10 select-none border-r border-border/60 px-1.5 text-right align-top text-muted-foreground">
                      {line.rightNumber ?? ''}
                    </td>
                    <td className="whitespace-pre-wrap break-words px-2 align-top text-foreground">
                      <span className="select-none pr-1 text-muted-foreground">
                        {line.op === 'added' ? '+' : line.op === 'removed' ? '−' : ' '}
                      </span>
                      {line.text || ' '}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface DocumentLibraryWindowContentProps {
  /**
   * The collation, assembled by useDocumentLibrary in AppContent.
   *
   * Passed in rather than built here so the sidebar and this window read ONE
   * library: each mirror behind it opens a realtime subscription, and two
   * copies would both double the subscriptions and let the two surfaces
   * disagree while one was mid-fetch.
   */
  library: DocumentLibrary;
  /**
   * A collation key to open on arrival — set when the window was opened by
   * clicking a document in the sidebar. Consumed once (see onFocusConsumed) so
   * it cannot re-hijack the pane after the reader navigates away.
   */
  focusKey?: string;
  onFocusConsumed?: () => void;
  /** Open a workspace document in the editor. Absent for sources with no editor. */
  onOpenWorkspaceDocument?: (documentId: string) => void;
}

export function DocumentLibraryWindowContent({
  library,
  focusKey,
  onFocusConsumed,
  onOpenWorkspaceDocument,
}: DocumentLibraryWindowContentProps) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** The alternate being compared against the primary. null = show the primary. */
  const [comparingId, setComparingId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setWide(entry.contentRect.width >= LIBRARY_SPLIT_MIN_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { entries, loadSource, refreshAgent } = library;

  const filtered = useMemo(() => filterLibrary(entries, query), [entries, query]);
  const groups = useMemo(() => groupLibraryByDomain(filtered), [filtered]);

  // Open what the sidebar pointed at, once. Waits for the entry to EXIST rather
  // than selecting blind: the collation is assembled from mirrors that arrive
  // asynchronously, so on a cold open the key routinely names a document the
  // library has not built yet, and selecting it immediately would land on
  // nothing and clear itself.
  useEffect(() => {
    if (!focusKey) return;
    if (!entries.some(entry => entry.key === focusKey)) return;
    setSelectedKey(focusKey);
    setComparingId(null);
    onFocusConsumed?.();
  }, [focusKey, entries, onFocusConsumed]);

  // A daemon disconnecting (or a document being deleted) can take the selected
  // entry out from under the pane. Drop a selection that no longer resolves
  // rather than describing something that is gone.
  useEffect(() => {
    if (selectedKey && !librarySelectionStillExists(selectedKey, entries)) {
      setSelectedKey(null);
      setComparingId(null);
    }
  }, [selectedKey, entries]);

  const selected = selectedKey ? entries.find(entry => entry.key === selectedKey) ?? null : null;
  const comparing = selected && comparingId
    ? selected.sources.find(source => source.id === comparingId) ?? null
    : null;

  const [primaryBody, setPrimaryBody] = useState('');
  const [compareBody, setCompareBody] = useState('');
  const [bodyLoading, setBodyLoading] = useState(false);

  const primaryId = selected?.primary.id ?? '';
  useEffect(() => {
    if (!selected) { setPrimaryBody(''); setBodyLoading(false); return; }
    let cancelled = false;
    setBodyLoading(true);
    void loadSource(selected.primary).then(body => {
      // Checked before EVERY setState including the loading flag: an early
      // return that leaves the spinner on is the version of this bug that looks
      // like a hang rather than a glitch.
      if (cancelled) return;
      setPrimaryBody(body);
      setBodyLoading(false);
    });
    return () => { cancelled = true; };
    // Keyed on the primary's id rather than the entry object: a realtime tick
    // rebuilds every entry, and depending on the object would refetch the body
    // on every heartbeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryId, loadSource]);

  useEffect(() => {
    if (!comparing) { setCompareBody(''); return; }
    let cancelled = false;
    void loadSource(comparing).then(body => {
      if (!cancelled) setCompareBody(body);
    });
    return () => { cancelled = true; };
  }, [comparing, loadSource]);

  const diff = useMemo(
    () => (comparing ? diffLines(compareBody, primaryBody) : null),
    [comparing, compareBody, primaryBody],
  );

  const select = (key: string) => {
    setSelectedKey(prev => (prev === key ? null : key));
    setComparingId(null);
  };

  const totalSources = entries.reduce((sum, entry) => sum + entry.sources.length, 0);

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Library /></EmptyMedia>
            <EmptyTitle>Nothing in the library yet</EmptyTitle>
            <EmptyDescription>
              Documents you write here appear alongside the markdown your connected agents
              mirror up from their own locations. Connect an agent, or check that document
              sharing is on for the ones you have.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const renderList = (compact: boolean) => (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search documents, folders or agents…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        {!compact && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {entries.length} document{entries.length === 1 ? '' : 's'}
            {totalSources > entries.length ? ` · ${totalSources} copies` : ''}
          </span>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {groups.map(group => (
            <section key={group.domain}>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <FolderTree className="size-3.5" />
                {group.domain}
                <span className="font-normal normal-case">({group.entries.length})</span>
              </h3>
              <div className="space-y-1.5">
                {group.entries.map(entry => {
                  const active = entry.key === selectedKey;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => select(entry.key)}
                      aria-pressed={active}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                        active ? 'border-primary bg-primary/5' : 'border-border bg-card/40 hover:bg-card/70'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="size-3.5 shrink-0 text-primary" />
                        <span className="truncate text-sm font-medium text-foreground">{entry.title}</span>
                        {/* The count is the library's whole reason for existing:
                            it says "several places have this" at list level,
                            where the comparison is actually made. */}
                        {entry.sources.length > 1 && (
                          <Badge variant="secondary" className="ml-auto shrink-0" title={`${entry.sources.length} copies`}>
                            <Users className="size-3" />
                            {entry.sources.length}
                          </Badge>
                        )}
                      </div>
                      {entry.primary.summary && (
                        <p className="mt-1 line-clamp-2 pl-5.5 text-[11px] leading-snug text-muted-foreground">
                          {entry.primary.summary}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-5.5">
                        {entry.sources.map(source => (
                          <SourceChip
                            key={source.id}
                            source={source}
                            onOpen={() => { select(entry.key); setComparingId(source.id === entry.primary.id ? null : source.id); }}
                          />
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {groups.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No documents match “{query}”.</div>
          )}
        </div>
      </ScrollArea>
    </>
  );

  const renderDetail = (full: boolean) => {
    if (!selected) return null;
    return (
      <div className={full ? 'flex min-w-0 flex-1 flex-col overflow-hidden' : 'flex min-w-0 flex-1 flex-col overflow-hidden'}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
          {full && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-ml-1 shrink-0"
              onClick={() => { setSelectedKey(null); setComparingId(null); }}
              aria-label="Back to the library"
            >
              <ChevronLeft className="size-4" />
            </Button>
          )}
          <FileText className="size-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{selected.title}</p>
          {selected.primary.agent && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              title={`Ask ${selected.primary.agent.name} to re-scan its documents`}
              aria-label="Refresh from the agent"
              onClick={() => { void refreshAgent(selected.primary.agent?.id || ''); }}
            >
              <RefreshCw className="size-4" />
            </Button>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-3">
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Where this lives
              </h4>
              <div className="space-y-1">
                {selected.sources.map(source => {
                  const agreement = compareToPrimary(selected, source);
                  const isPrimary = source.id === selected.primary.id;
                  return (
                    <button
                      key={source.id}
                      type="button"
                      onClick={() => setComparingId(isPrimary ? null : (comparingId === source.id ? null : source.id))}
                      aria-pressed={comparingId === source.id}
                      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                        comparingId === source.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-card/40 hover:bg-card/70'
                      }`}
                    >
                      <span
                        className="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white"
                        style={{ backgroundColor: source.agent?.color || 'var(--primary)' }}
                        aria-hidden="true"
                      >
                        {source.agent?.initials || 'WS'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {source.agent?.name || 'This workspace'}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">
                          {source.path || LIBRARY_SOURCE_LABELS[source.kind]}
                        </span>
                      </span>
                      {isPrimary ? (
                        <Badge variant="outline" className="shrink-0 text-[10px]">latest</Badge>
                      ) : agreement === 'identical' ? (
                        <Badge variant="outline" className="shrink-0 text-[10px]">same</Badge>
                      ) : agreement === 'different' ? (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">differs</Badge>
                      ) : (
                        <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">compare</Badge>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Said in words, because "latest" is a claim and a reader is
                  entitled to know what it is based on. */}
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                “Latest” is the most recently modified copy — the file’s own timestamp where the
                agent reported one, otherwise when it last synced.
              </p>
            </div>

            {comparing && diff ? (
              <div>
                <div className="mb-1.5 flex items-center gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {comparing.agent?.name || 'This workspace'} vs latest
                  </h4>
                  <Badge variant="secondary" className="text-[10px]">{describeDiff(diff)}</Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 px-2 text-xs"
                    onClick={() => setComparingId(null)}
                  >
                    Show latest
                  </Button>
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  Green is in the latest copy only. Red is in {comparing.agent?.name || 'this copy'} only.
                </p>
                <DiffView result={diff} />
              </div>
            ) : (
              <div>
                <div className="mb-1.5 flex items-center gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest version</h4>
                  <span className="text-[11px] text-muted-foreground">{describeSource(selected.primary)}</span>
                  {selected.primary.kind === 'workspace' && onOpenWorkspaceDocument && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-2 text-xs"
                      onClick={() => onOpenWorkspaceDocument(selected.primary.rowId)}
                    >
                      Open in editor
                    </Button>
                  )}
                </div>
                {bodyLoading ? (
                  <div className="space-y-2" aria-busy="true">
                    <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
                  </div>
                ) : primaryBody ? (
                  <div className="rounded-lg border border-border bg-card/40 p-3">
                    {/* Untrusted text: a file from somebody else's machine.
                        MarkdownContent builds elements and never touches
                        innerHTML, which is what makes rendering it safe. */}
                    <MarkdownContent content={primaryBody} compact />
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Info className="size-3.5 shrink-0 text-muted-foreground" />
                      No body stored for this copy
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      The library knows this document exists and where it lives, but nothing has
                      mirrored its text up yet. It arrives on the agent’s next sync.
                    </p>
                  </div>
                )}
                {selected.primary.truncated && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Shown up to {formatLibraryBytes(selected.primary.byteSize)} — the file is longer on disk.
                  </p>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    );
  };

  const hasDetail = Boolean(selected);
  const showFullDetail = hasDetail && !wide;
  const showSplitDetail = hasDetail && wide;

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden">
      {showFullDetail ? (
        renderDetail(true)
      ) : (
        <>
          <div
            className={
              showSplitDetail
                ? 'flex w-[340px] shrink-0 flex-col overflow-hidden border-r border-border'
                : 'flex min-w-0 flex-1 flex-col overflow-hidden'
            }
          >
            {renderList(showSplitDetail)}
          </div>
          {showSplitDetail && renderDetail(false)}
        </>
      )}
    </div>
  );
}
