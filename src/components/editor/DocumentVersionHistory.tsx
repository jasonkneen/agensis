import { History, RotateCcw, X } from 'lucide-react';
import type { DocumentVersion } from '../../types';
import { stripHtml } from '../../lib/utils';
import { sanitizeHtml } from '@/lib/sanitize';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemHeader, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';

interface DocumentVersionHistoryProps {
  versions: DocumentVersion[];
  loading: boolean;
  onRestore: (version: DocumentVersion) => void;
  onClose: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return date.toLocaleDateString();
}

function contentPreview(content: string): string {
  const plain = stripHtml(sanitizeHtml(content)).trim();
  if (plain.length <= 80) return plain;
  return plain.slice(0, 80) + '...';
}

export function DocumentVersionHistory({
  versions,
  loading,
  onRestore,
  onClose,
}: DocumentVersionHistoryProps) {
  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l border-border/60 bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <History data-icon="inline-start" className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">Version History</span>
        {versions.length > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {versions.length}
          </Badge>
        )}
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} title="Close version history">
          <X data-icon="inline-start" className="size-3" />
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-2.5">
          {loading ? (
            <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
              <Spinner className="mr-2 size-3.5" />
              Loading...
            </div>
          ) : versions.length === 0 ? (
            <Empty className="min-h-40 border-0 p-4">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <History className="size-4" />
                </EmptyMedia>
                <EmptyDescription className="text-xs">
                  No versions yet. Snapshots are created automatically as you edit.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            versions.map(version => (
              <Item key={version.id} variant="muted" className="block p-2.5">
                <ItemHeader className="mb-1 gap-2">
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    v{version.version_number}
                  </Badge>
                  <ItemTitle className="min-w-0 flex-1 truncate text-[11px]">{version.title}</ItemTitle>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{formatTime(version.created_at)}</span>
                </ItemHeader>
                {version.content && (
                  <ItemContent>
                    <ItemDescription className="truncate text-[11px]">{contentPreview(version.content)}</ItemDescription>
                  </ItemContent>
                )}
                <ItemActions className="mt-2">
                  <Button type="button" variant="outline" size="xs" onClick={() => onRestore({ ...version, content: sanitizeHtml(version.content) })}>
                    <RotateCcw data-icon="inline-start" className="size-3" />
                    Restore
                  </Button>
                </ItemActions>
              </Item>
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
