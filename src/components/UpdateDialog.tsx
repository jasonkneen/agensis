import { SparklesIcon, RocketIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ReleaseNote } from '@/lib/releaseNotes';

// The "larger panel" behind the update toast. Presentational only — open state,
// notes, and the reload action are owned by useAppUpdate/AppUpdateManager.
// Built on the shared Dialog primitive so it inherits every theme (brutal /
// tinyworld / dark / light) with no per-theme code.
export interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: ReleaseNote[];
  // 'available' — a newer build is live; primary action reloads to get it.
  // 'updated'   — we just reloaded into a new build; this is the recap.
  mode: 'available' | 'updated';
  onReload: () => void;
}

export function UpdateDialog({ open, onOpenChange, notes, mode, onReload }: UpdateDialogProps) {
  const available = mode === 'available';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,58rem)] sm:max-w-[58rem]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {available ? (
              <RocketIcon className="size-4 text-primary" />
            ) : (
              <SparklesIcon className="size-4 text-primary" />
            )}
            <DialogTitle>{available ? 'A new version is available' : "What's new"}</DialogTitle>
          </div>
          <DialogDescription>
            {available
              ? 'Reload to get the latest agensis. Here’s what changed:'
              : 'You’re on the latest agensis. Here’s what changed:'}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[62vh] overflow-y-auto px-1 pr-3">
          {notes.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Release notes aren’t available right now.
            </p>
          ) : (
            <ol className="flex flex-col gap-4">
              {notes.map((note, i) => (
                <li key={`${note.version}-${i}`} className="flex flex-col gap-1.5 rounded-md p-2 transition-colors hover:bg-muted/45 focus-within:bg-muted/45">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{note.title}</span>
                    {i === 0 && available && (
                      <Badge variant="secondary" className="text-[0.65rem]">
                        Latest
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-foreground/85">{note.summary}</p>
                  {note.highlights && note.highlights.length > 0 && (
                    <ul className="mt-0.5 flex flex-col gap-1 pl-4">
                      {note.highlights.map((h, j) => (
                        <li
                          key={j}
                          className="list-disc text-sm text-foreground/80 marker:text-primary/70"
                        >
                          {h}
                        </li>
                      ))}
                    </ul>
                  )}
                  <span className="text-xs text-muted-foreground/70">
                    {note.version} · {note.date}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <DialogFooter>
          {available ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Later
              </Button>
              <Button onClick={onReload}>Reload now</Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Got it</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
