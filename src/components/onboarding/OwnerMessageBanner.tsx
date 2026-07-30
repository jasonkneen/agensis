import { Megaphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOwnerMessage } from '@/lib/ownerMessageContext';

/**
 * An owner broadcast under the home composer.
 *
 * Deliberately the same card as the "Set up your daily brief" prompt it sits
 * beside — same rounded frame, same 40px icon tile, same title/body rhythm, same
 * ghost X. That slot already has a meaning on this screen ("something worth your
 * attention, dismissible"), and inventing a second banner style would only make
 * the two argue.
 *
 * The body is a TEXT NODE, and there is no action button: a banner from the
 * operator says something, it does not navigate anywhere. Nothing in the message
 * can carry a link.
 */
export function OwnerMessageBanner() {
  const { message, dismiss } = useOwnerMessage('banner');
  if (!message) return null;

  return (
    <div
      className="pointer-events-auto relative flex w-full max-w-3xl items-center gap-3 rounded-xl border border-primary/50 bg-card/90 px-4 py-3 shadow-lg ring-1 ring-primary/20 backdrop-blur"
      data-owner-message="banner"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
        <Megaphone className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          {message.title}
          <span className="text-[0.65rem] font-semibold tracking-wide text-primary">FOR YOU</span>
        </div>
        <p className="whitespace-pre-line text-xs text-muted-foreground">{message.body}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 self-start"
        aria-label="Dismiss this message"
        onClick={dismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
