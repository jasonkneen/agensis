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
import { FeatureGallery } from '@/components/wireframe/FeatureGallery';
import { GALLERY_SLIDES } from '@/lib/wireframeScenes';

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
  const [latest, ...older] = notes;

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
            {/* pr-6 clears the Dialog's own close button, which is absolutely
                positioned in this corner — without it the build stamp runs
                underneath the x and both become unreadable. */}
            <span className="ml-auto pr-6 text-xs font-normal text-muted-foreground/70">
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
          {/* The gallery is the headline: a few features worth knowing, each
              with a demo. It is hand-curated rather than derived from the notes
              below — every slide needs an animation that actually illustrates
              it, and most notes do not have one. */}
          <FeatureGallery slides={GALLERY_SLIDES} className="mb-4" />

          {notes.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Release notes aren’t available right now.
            </p>
          ) : (
            <>
              {latest && (
                <section className="flex flex-col gap-1.5 rounded-md p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{latest.title}</span>
                    {available && (
                      <Badge variant="secondary" className="text-[0.65rem]">
                        Latest
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-foreground/85">{latest.summary}</p>
                  {latest.highlights && latest.highlights.length > 0 && (
                    <ul className="mt-0.5 flex flex-col gap-1 pl-4">
                      {latest.highlights.map((h, j) => (
                        <li
                          key={j}
                          className="list-disc text-sm text-foreground/80 marker:text-primary/70"
                        >
                          {h}
                        </li>
                      ))}
                    </ul>
                  )}
                  <span className="text-xs text-muted-foreground/70">{versionLabel(latest)}</span>
                </section>
              )}

              {/* ONE expander for everything older, not one per release. A
                  column of thirty collapsed rows is its own wall of text; a
                  single "earlier updates" is a reader deciding once whether
                  they care about history at all. Inside, the type is tighter
                  (leading-snug, smaller headings) because this is reference
                  material being scanned, not the thing being announced. */}
              {older.length > 0 && (
                <details className="group mt-2 rounded-md border border-border/60 bg-muted/20">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/40">
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                    Earlier updates
                    <span className="ml-auto text-xs font-normal text-muted-foreground/70">
                      {older.length}
                    </span>
                  </summary>
                  <ol className="flex flex-col gap-3 border-t border-border/60 px-3 py-2.5">
                    {older.map((note, i) => (
                      <li key={`${note.version}-${i}`} className="flex flex-col gap-0.5">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[0.8125rem] font-medium leading-snug">
                            {note.title}
                          </span>
                          <span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground/70">
                            {note.date}
                          </span>
                        </div>
                        <p className="text-[0.8125rem] leading-snug text-foreground/70">
                          {note.summary}
                        </p>
                        {note.highlights && note.highlights.length > 0 && (
                          <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
                            {note.highlights.map((h, j) => (
                              <li
                                key={j}
                                className="list-disc text-[0.8125rem] leading-snug text-foreground/60 marker:text-primary/50"
                              >
                                {h}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
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
