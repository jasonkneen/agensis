import { useMemo, useState } from 'react';
import { ChevronDown, MousePointerSquareDashed, Send, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { DiagnosticsSnapshot } from '@/lib/feedbackDiagnostics';
import { elementChipLabel, type ElementDescriptor } from '@/lib/feedbackElement';
import { describeAttachments, type FeedbackPageRef, type FeedbackSubmission } from '@/lib/feedbackReport';

interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  workspaceId: string | null;
  userId: string | null;
  page: FeedbackPageRef;
  selections: ElementDescriptor[];
  onRemoveSelection: (index: number) => void;
  onStartPicking: () => void;
  maxSelections: number;
  includeDiagnostics: boolean;
  onToggleDiagnostics: (next: boolean) => void;
  diagnostics: DiagnosticsSnapshot | null;
  submission: FeedbackSubmission;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
}

/** Read-only context row. Shown, not hidden: people should see what identifies their report. */
function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80" title={value}>
        {value || '—'}
      </span>
    </div>
  );
}

export function FeedbackDialog({
  open,
  onClose,
  description,
  onDescriptionChange,
  workspaceId,
  userId,
  page,
  selections,
  onRemoveSelection,
  onStartPicking,
  maxSelections,
  includeDiagnostics,
  onToggleDiagnostics,
  diagnostics,
  submission,
  submitting,
  error,
  onSubmit,
}: FeedbackDialogProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // "Show the user what is attached before they submit" — this is that sentence,
  // and the panel below is the receipts. Consent to sending your console means
  // being able to read it first.
  const attachmentSummary = useMemo(() => describeAttachments(submission), [submission]);
  const canSubmit = description.trim().length >= 3 && !submitting;

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-xl" data-feedback-ui>
        <DialogHeader className="pr-8">
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Goes straight to the maintainers as a reviewable item. Nothing is shared with your workspace.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="feedback-description">What happened?</FieldLabel>
            <Textarea
              id="feedback-description"
              autoFocus
              rows={4}
              value={description}
              onChange={event => onDescriptionChange(event.target.value)}
              placeholder="The thing you expected, and the thing that happened instead."
            />
          </Field>

          <Field>
            <FieldLabel>Where you are</FieldLabel>
            <div className="space-y-1 rounded-lg border bg-muted/40 p-2.5">
              <ContextRow label="Page" value={`${page.path}${page.hash}`} />
              <ContextRow label="Workspace" value={page.label ? `${page.label} · ${workspaceId ?? '—'}` : (workspaceId ?? '—')} />
              <ContextRow label="User" value={userId ?? '—'} />
            </div>
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>Elements</FieldLabel>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onStartPicking}
                disabled={selections.length >= maxSelections}
              >
                <MousePointerSquareDashed data-icon="inline-start" className="size-3.5" />
                {selections.length === 0 ? 'Select element' : 'Select another'}
              </Button>
            </div>
            {selections.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Optional. Point at the thing that is wrong and we get its selector and position.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {selections.map((selection, index) => (
                  <Badge key={`${selection.selector}-${index}`} variant="secondary" className="max-w-full gap-1 pr-1">
                    <span className="truncate font-mono text-[10px]">{elementChipLabel(selection)}</span>
                    <button
                      type="button"
                      onClick={() => onRemoveSelection(index)}
                      className="rounded-sm text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${selection.selector}`}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </Field>

          <Field>
            <div className="flex items-start justify-between gap-3 rounded-lg border p-2.5">
              <div className="min-w-0">
                <FieldLabel htmlFor="feedback-diagnostics" className="mb-0.5">Attach diagnostics</FieldLabel>
                <p className="text-xs text-muted-foreground">{attachmentSummary}</p>
              </div>
              <Switch
                id="feedback-diagnostics"
                checked={includeDiagnostics}
                onCheckedChange={onToggleDiagnostics}
              />
            </div>

            {includeDiagnostics && diagnostics && (
              <div className="rounded-lg border">
                <button
                  type="button"
                  onClick={() => setShowDiagnostics(prev => !prev)}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs font-medium"
                  aria-expanded={showDiagnostics}
                >
                  <span>Review what will be sent</span>
                  <ChevronDown className={cn('size-3.5 transition-transform', showDiagnostics && 'rotate-180')} />
                </button>
                {showDiagnostics && (
                  <div className="border-t px-2.5 py-2">
                    <p className="mb-1.5 text-[11px] text-muted-foreground">
                      Tokens, keys and passwords are stripped before this leaves your browser. Stored values,
                      cookies and anything you typed into a field are never read.
                    </p>
                    <ScrollArea className="max-h-48">
                      <pre className="font-mono text-[10px] leading-4 whitespace-pre-wrap text-muted-foreground">
                        {[
                          `build   ${diagnostics.buildId}`,
                          `screen  ${diagnostics.viewport.width}x${diagnostics.viewport.height}`,
                          `agent   ${diagnostics.userAgent}`,
                          '',
                          ...diagnostics.errors.map(entry => `[${entry.kind}] ${entry.message}`),
                          ...diagnostics.console.map(entry => `[${entry.level}] ${entry.message}`),
                        ].join('\n')}
                      </pre>
                    </ScrollArea>
                  </div>
                )}
              </div>
            )}
          </Field>
        </FieldGroup>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" className="size-4" />}
            Send feedback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
