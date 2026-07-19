import { SparklesIcon, RocketIcon, ChevronRight } from 'lucide-react';
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
import { APP_VERSION, BUILD_ID } from '@/lib/appVersion';

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

// The per-note footer shows `version · date`, but authors sometimes set the
// version to a date-restatement (e.g. "2026.07.04" alongside date "2026-07-04"),
// which renders as the same day twice. The real build identity already lives in
// the header stamp (APP_VERSION · BUILD_ID), so here we drop a date-like version
// and keep only genuinely named labels (e.g. "mermaid", "slash-commands").
function versionLabel(note: ReleaseNote): string {
  const v = note.version.trim();
  const normalized = v.replace(/[.]/g, '-');
  const isDateLike = /^\d{4}-\d{2}-\d{2}$/.test(normalized);
  // Only collapse when the version is a restatement of THIS note's date; a
  // date-like version that differs stays visible so stale data isn't masked.
  return isDateLike && normalized === note.date ? note.date : `${v} · ${note.date}`;
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
            <span className="ml-auto text-xs font-normal text-muted-foreground/70">
              v{APP_VERSION} · {BUILD_ID.slice(0, 7)}
            </span>
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
              {notes.map((note, i) => {
                const isLatest = i === 0;
                const body = (
                  <>
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
                      {versionLabel(note)}
                    </span>
                  </>
                );

                // The newest note is shown expanded; older ones collapse into a
                // dimmed <details> the reader can open, so the latest is the focus.
                if (isLatest) {
                  return (
                    <li key={`${note.version}-${i}`} className="flex flex-col gap-1.5 rounded-md p-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{note.title}</span>
                        {available && (
                          <Badge variant="secondary" className="text-[0.65rem]">
                            Latest
                          </Badge>
                        )}
                      </div>
                      {body}
                    </li>
                  );
                }

                return (
                  <li key={`${note.version}-${i}`}>
                    <details className="group flex flex-col gap-1.5 rounded-md p-2 opacity-55 transition-opacity hover:opacity-100 [&[open]]:opacity-100">
                      <summary className="flex cursor-pointer list-none items-center gap-2">
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                        <span className="text-sm font-medium">{note.title}</span>
                        <span className="ml-auto text-xs text-muted-foreground/70">{note.date}</span>
                      </summary>
                      <div className="mt-1.5 flex flex-col gap-1.5 pl-5">
                        {body}
                      </div>
                    </details>
                  </li>
                );
              })}
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
