import { useMemo, useState } from 'react';
import { ChevronLeft, Clock, FileText, Lock, MessageCircle, Pencil, RefreshCw } from 'lucide-react';
import type { WorkspaceAgent } from '../../types';
import { useAgentMemory } from '../../hooks/useAgentMemory';
import { useMemoryFileComments } from '../../hooks/useMemoryFileComments';
import { DocumentComments } from '../editor/DocumentComments';
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
}

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

export function AgentMemoryBrowser({ workspaceId, agents, userId, userEmail }: AgentMemoryBrowserProps) {
  const { files, loading, refresh } = useAgentMemory(workspaceId);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

  // Detail view: a single file's content + its comment thread.
  if (selectedFile) {
    return (
      <div className="flex h-full overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSelectedPath(null)} aria-label="Back to files">
              <ChevronLeft className="size-4" />
            </Button>
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{fileName(selectedFile.path)}</p>
              <p className="truncate text-xs text-muted-foreground">{selectedFile.path}</p>
            </div>
            {selectedFile.editable ? (
              <Badge variant="outline" className="gap-1"><Pencil className="size-3" />Editable</Badge>
            ) : (
              <Badge variant="outline" className="gap-1"><Lock className="size-3" />Read-only</Badge>
            )}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground">
              {selectedFile.content_cache || '(empty file)'}
            </pre>
          </ScrollArea>
        </div>
        <DocumentComments
          comments={comments.comments}
          topLevel={comments.topLevel}
          replyMap={comments.replyMap}
          currentUserId={userId}
          currentUserEmail={userEmail}
          onCreate={comments.createComment}
          onResolve={comments.resolveComment}
          onDelete={comments.deleteComment}
        />
      </div>
    );
  }

  // List view: agent filter chips + that agent's files.
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-card p-4">
        <div className="flex items-start gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <FileText className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Agent file memory</h2>
            <p className="text-sm text-muted-foreground">
              {agentFiles.length} file{agentFiles.length === 1 ? '' : 's'} from {agentName(effectiveAgentId)}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={handleRefresh} disabled={!effectiveAgentId || refreshing}>
            <RefreshCw data-icon="inline-start" className={refreshing ? 'animate-spin' : ''} />
            Refresh
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
        <div className="flex flex-col gap-3 p-4">
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
                <Item key={file.id} variant="outline" asChild>
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
    </div>
  );
}
