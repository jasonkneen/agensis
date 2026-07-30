import { Megaphone } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useOwnerMessage } from '@/lib/ownerMessageContext';

/**
 * An owner broadcast that opens over the app on the next load.
 *
 * Same shell as the what's-new dialog (UpdateDialog): the shared Dialog
 * primitive, so it inherits every theme with no per-theme code, and the same
 * header rhythm — icon, title, one-line description, scrollable body, one
 * footer button. It is a separate component rather than a mode on UpdateDialog
 * because that component's props ARE release notes (a ReleaseNote[], a version
 * stamp, and a reload action); a broadcast has none of those, and faking them
 * would make both harder to read than sharing the primitive does.
 *
 * DISMISS IS THE ONLY EXIT, and it is a server write (see useOwnerMessages), so
 * closing it here is what stops it opening tomorrow. Escape and the overlay both
 * route through onOpenChange to the same dismissal — a dialog you can dodge with
 * Escape and be shown again forever is worse than one you cannot close.
 *
 * The body is a TEXT NODE. Nothing on this path renders HTML from operator text.
 */
export function OwnerMessageDialog() {
  const { message, dismiss } = useOwnerMessage('dialog');
  if (!message) return null;

  return (
    <Dialog open onOpenChange={open => { if (!open) dismiss(); }}>
      <DialogContent className="w-[min(92vw,34rem)] sm:max-w-[34rem]" data-owner-message="dialog">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Megaphone className="size-4 text-primary" />
            <DialogTitle>{message.title}</DialogTitle>
          </div>
          <DialogDescription>A message for you from the agensis team.</DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[52vh] overflow-y-auto px-1 pr-3">
          <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">
            {message.body}
          </p>
        </div>

        <DialogFooter>
          <Button onClick={dismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
