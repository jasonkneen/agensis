import { useEffect, useMemo, useState } from 'react';
import { Brain, ChevronLeft, Clock, Code2, Eye, FileText, Lock, MessageCircle, Pencil, RefreshCw } from 'lucide-react';
import type { WorkspaceAgent } from '../../types';
import { useAgentMemory } from '../../hooks/useAgentMemory';
import { useMemoryFileComments } from '../../hooks/useMemoryFileComments';
import { usePaneSplit } from '../../hooks/usePaneSplit';
import { MEMORY_SPLIT_BOUNDS, MEMORY_SPLIT_WIDE_PX } from '../../lib/memorySplit';
import { viewPreferenceKey } from '../../lib/viewPreferences';
import { DocumentComments } from '../editor/DocumentComments';
import { MarkdownContent } from '../chat/MarkdownContent';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';

interface AgentMemoryBrowserProps {
  workspaceId: string;
  agents: WorkspaceAgent[];
  userId: string;
  userEmail: string;
  /**
   * Open the Team-facts composer on a category. Supplied by MemorySection,
   * which owns both tabs — this pane can only READ agent files (phase 1 of
   * docs/agent-memory-plan.md is a read-only mirror), so the only honest place
   * in this window to write a new memory is the other tab. Absent means the
   * suggestion chips that would lead there are not rendered at all, rather than
   * rendered dead.
   */
  onStartFact?: (category: string) => void;
}

/**
 * The categories offered as "start a memory" chips. Drawn from the same seed
 * list MemorySection uses, so a chip can never create a category the facts
 * pane does not already know about.
 */
const SUGGESTED_FACT_CATEGORIES = ['about me', 'preferences', 'work', 'goals'];

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function AgentMemoryBrowser({ workspaceId, agents, userId, userEmail, onStartFact }: AgentMemoryBrowserProps) {
  const { files, loading, refresh, fetchFileContent } = useAgentMemory(workspaceId);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  const [showComments, setShowComments] = useState(false);

  // Master-detail is responsive AND resizable. Above MEMORY_SPLIT_WIDE_PX the
  // list and the preview sit side by side with a draggable divider between
  // them; below it the preview takes over the whole surface (the original
  // full-swap behaviour, because there is no width left to divide).
  //
  // One measurement serves both decisions — the hook already observes this
  // container for the clamp, so `wide` reads off the same number rather than
  // running a second ResizeObserver on the same node.
  const split = usePaneSplit({
    preferenceKey: viewPreferenceKey('memory.files-split', workspaceId),
    direction: 'row',
    bounds: MEMORY_SPLIT_BOUNDS,
    label: 'Resize memory file list',
  });
  const wide = split.containerSize >= MEMORY_SPLIT_WIDE_PX;

  // Only agents that actually have mirrored files are worth showing as filters.
  const agentsWithFiles = useMemo(() => {
    const ids = new Set(files.map(f => f.agent_id));
    return agents.filter(a => ids.has(a.id));
  }, [agents, files]);

  const effectiveAgentId = selectedAgentId ?? agentsWithFiles[0]?.id ?? null;
  const agentFiles = useMemo(
    () => files.filter(f => f.agent_id === effectiveAgentId),
    [files, effectiveAgentId],
  );
  const selectedFile = useMemo(
    () => agentFiles.find(f => f.path === selectedPath) ?? null,
    [agentFiles, selectedPath],
  );
  // The three most recently synced files, offered as one-click chips in the
  // empty preview. Most-recent is the useful order here: the list itself is
  // sorted by path, so "what changed last" is not otherwise reachable.
  const recentFiles = useMemo(
    () => [...agentFiles]
      .sort((a, b) => String(b.last_synced ?? '').localeCompare(String(a.last_synced ?? '')))
      .slice(0, 3),
    [agentFiles],
  );

  // NET-06 pattern: the file list is metadata-only, so the selected file's body
  // is fetched on demand. Keyed on identity+version via the hook's own cache.
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedFile) { setSelectedContent(null); return; }
    let cancelled = false;
    setSelectedContent(null);
    fetchFileContent(selectedFile).then(body => {
      if (!cancelled) setSelectedContent(body);
    });
    return () => { cancelled = true; };
  }, [selectedFile, fetchFileContent]);

  const comments = useMemoryFileComments(workspaceId, effectiveAgentId, selectedPath, userId);

  const agentName = (id: string | null) => agents.find(a => a.id === id)?.name ?? 'Agent';

  const handleRefresh = async () => {
    if (!effectiveAgentId) return;
    setRefreshing(true);
    await refresh(effectiveAgentId);
    // The push lands as a realtime change; clear the spinner after a short beat.
    setTimeout(() => setRefreshing(false), 1500);
  };

  if (!loading && files.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <Empty className="min-h-80 flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText />
            </EmptyMedia>
            <EmptyTitle>No agent file memory yet</EmptyTitle>
            <EmptyDescription>
              When a daemon-backed agent connects, its memory files are mirrored here and
              become browsable. Connect an agent, then Refresh.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  // Detail view: a single file's content (preview or source) + its comment thread.
  // `showBack` shows a back arrow — only needed in the full-swap (narrow) layout,
  // since in split mode the list stays visible alongside.
  const renderDetail = (showBack: boolean) => {
    if (!selectedFile) return null;
    return (
      <div className="flex h-full min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
            {showBack && (
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSelectedPath(null)} aria-label="Back to files">
                <ChevronLeft className="size-4" />
              </Button>
            )}
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{fileName(selectedFile.path)}</p>
              <p className="truncate text-xs text-muted-foreground">{selectedFile.path}</p>
            </div>
            <div className="flex shrink-0 items-center rounded-md border border-border bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('preview')}
                aria-pressed={viewMode === 'preview'}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${viewMode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <Eye className="size-3.5" />
                Preview
              </button>
              <button
                type="button"
                onClick={() => setViewMode('source')}
                aria-pressed={viewMode === 'source'}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${viewMode === 'source' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <Code2 className="size-3.5" />
                Source
              </button>
            </div>
            {selectedFile.editable ? (
              <Badge variant="outline" className="gap-1"><Pencil className="size-3" />Editable</Badge>
            ) : (
              <Badge variant="outline" className="gap-1"><Lock className="size-3" />Read-only</Badge>
            )}
            <Button
              type="button"
              variant={showComments ? 'default' : 'ghost'}
              size="icon-sm"
              onClick={() => setShowComments(v => !v)}
              title={showComments ? 'Hide comments' : 'Show comments'}
            >
              <MessageCircle className="size-4" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {selectedContent === null ? (
              <p className="p-4 text-xs text-muted-foreground">Loading…</p>
            ) : viewMode === 'preview' ? (
              selectedContent ? (
                <div className="p-4">
                  <MarkdownContent content={selectedContent} />
                </div>
              ) : (
                <p className="p-4 text-xs text-muted-foreground">(empty file)</p>
              )
            ) : (
              <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground">
                {selectedContent || '(empty file)'}
              </pre>
            )}
          </ScrollArea>
        </div>
        {showComments && (
          <DocumentComments
            comments={comments.comments}
            topLevel={comments.topLevel}
            replyMap={comments.replyMap}
            currentUserId={userId}
            currentUserEmail={userEmail}
            onCreate={comments.createComment}
            onResolve={comments.resolveComment}
            onDelete={comments.deleteComment}
            onClose={() => setShowComments(false)}
          />
        )}
      </div>
    );
  };

  // What the preview pane shows before a file is picked.
  //
  // This pane is rendered FROM LOAD, not on first click. It used to appear only
  // once a file was selected, which meant the first click resized the file list
  // from full width to a column and shoved every row sideways under the cursor.
  // A pane holding an explanation is a better trade than a layout that jumps.
  //
  // Every chip below performs a real action. Nothing here offers to generate a
  // memory file: agent files are a READ-ONLY mirror (docs/agent-memory-plan.md
  // — write-back is phase 2), so a "write a memory" button on this tab would be
  // a lie. The honest write path in this window is the Team facts tab, and the
  // chips that lead there open its composer for real.
  const renderEmptyPreview = () => (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-6 py-10">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <FileText className="size-5" />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold">Select a memory file</p>
              <p className="text-sm text-muted-foreground">
                Pick a file on the left to read it. Agent files are a read-only mirror of the
                memory an agent keeps on its own machine — the daemon pushes them here.
              </p>
            </div>
          </div>

          {(recentFiles.length > 0 || !!effectiveAgentId) && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Recently synced</p>
              <div className="flex flex-wrap gap-2">
                {recentFiles.map(file => (
                  <Badge key={file.id} asChild variant="outline" className="cursor-pointer">
                    <button type="button" onClick={() => setSelectedPath(file.path)}>
                      <FileText data-icon="inline-start" />
                      {fileName(file.path)}
                    </button>
                  </Badge>
                ))}
                {effectiveAgentId && (
                  <Badge asChild variant="outline" className="cursor-pointer">
                    <button type="button" onClick={handleRefresh} disabled={refreshing}>
                      <RefreshCw data-icon="inline-start" className={refreshing ? 'animate-spin' : ''} />
                      Pull the latest from {agentName(effectiveAgentId)}
                    </button>
                  </Badge>
                )}
              </div>
            </div>
          )}

          {onStartFact && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Start a team fact</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_FACT_CATEGORIES.map(category => (
                  <Badge key={category} asChild variant="outline" className="cursor-pointer">
                    <button type="button" onClick={() => onStartFact(category)}>
                      <Brain data-icon="inline-start" />
                      {category}
                    </button>
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Opens the Team facts composer. Facts are workspace memory every agent reads;
                agent files stay the agent&apos;s own.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <p className="text-xs font-medium text-muted-foreground">Tips</p>
            <p className="text-xs text-muted-foreground">
              Comments are anchored to a file&apos;s path, so they survive the agent re-syncing
              or deleting it.
            </p>
            <p className="text-xs text-muted-foreground">
              Only agents running the daemon mirror their files. If one is missing here,
              connect it and pull the latest.
            </p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );

  // List view: agent filter chips + that agent's files. `compact` tightens the
  // padding for the narrow left column when a detail panel sits beside it.
  const renderList = (compact: boolean) => (
    <>
      <div className={`shrink-0 border-b border-border bg-card ${compact ? 'p-3' : 'p-4'}`}>
        <div className={`flex items-start ${compact ? 'gap-3' : 'gap-4'}`}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <FileText className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Agent file memory</h2>
            <p className="truncate text-sm text-muted-foreground">
              {agentFiles.length} file{agentFiles.length === 1 ? '' : 's'} from {agentName(effectiveAgentId)}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={handleRefresh} disabled={!effectiveAgentId || refreshing}>
            <RefreshCw data-icon="inline-start" className={refreshing ? 'animate-spin' : ''} />
            {!compact && 'Refresh'}
          </Button>
        </div>

        {agentsWithFiles.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {agentsWithFiles.map(agent => (
              <Badge
                key={agent.id}
                asChild
                variant={effectiveAgentId === agent.id ? 'default' : 'outline'}
                className="cursor-pointer"
              >
                <button
                  type="button"
                  onClick={() => { setSelectedAgentId(agent.id); setSelectedPath(null); }}
                >
                  {agent.name}
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className={`flex flex-col gap-3 ${compact ? 'p-3' : 'p-4'}`}>
          {agentFiles.length === 0 ? (
            <Empty className="min-h-60 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>No files for this agent</EmptyTitle>
                <EmptyDescription>Try Refresh to pull the latest snapshot from the daemon.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-2">
              {agentFiles.map(file => (
                <Item
                  key={file.id}
                  variant="outline"
                  asChild
                  className={selectedPath === file.path ? 'border-primary bg-primary/5' : undefined}
                >
                  <button type="button" className="w-full text-left" onClick={() => setSelectedPath(file.path)}>
                    <ItemMedia variant="icon" className="size-9 rounded-xl bg-muted [&_svg]:size-5">
                      <FileText />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="truncate">{fileName(file.path)}</ItemTitle>
                      <ItemDescription className="flex items-center gap-2 text-xs">
                        <span>{formatBytes(file.byte_size)}</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="size-3" />
                          {new Date(file.last_synced).toLocaleString()}
                        </span>
                      </ItemDescription>
                      {file.summary && (
                        <ItemDescription className="truncate">{file.summary}</ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions>
                      {file.editable && (
                        <Badge variant="outline" className="gap-1"><Pencil className="size-3" />Editable</Badge>
                      )}
                      <MessageCircle className="size-4 text-muted-foreground" />
                    </ItemActions>
                  </button>
                </Item>
              ))}
            </ItemGroup>
          )}
        </div>
      </ScrollArea>
    </>
  );

  return (
    <div ref={split.containerRef} className="flex h-full overflow-hidden">
      {wide ? (
        <>
          {/* The list owns a WIDTH, dragged and remembered. usePaneSplit
              re-clamps it against this container on every render, so a width
              chosen in a wide window cannot squeeze either pane away when the
              window narrows. */}
          <div
            className="relative flex shrink-0 flex-col overflow-hidden border-r border-border"
            style={{ width: `${split.size}px` }}
          >
            {renderList(true)}
            {/* The same invisible grab strip the account list uses: a hairline
                that only appears under the pointer or focus. Inside the pane
                rather than straddling the border, because the pane clips. */}
            <button
              {...split.dividerProps}
              className="group/split absolute inset-y-0 right-0 z-30 flex w-2.5 cursor-col-resize justify-center rounded-none outline-none"
            >
              <span
                aria-hidden="true"
                className="h-full w-px bg-transparent transition-colors group-hover/split:bg-border group-focus-visible/split:bg-primary/70"
              />
            </button>
          </div>
          {selectedFile ? renderDetail(false) : renderEmptyPreview()}
        </>
      ) : selectedFile ? (
        renderDetail(true)
      ) : (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {renderList(false)}
        </div>
      )}
    </div>
  );
}
