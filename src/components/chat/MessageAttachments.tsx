// Message attachments — the rendering half. See lib/messageAttachments.ts for
// the decisions (what counts as an image, how the list parses, how a thumbnail
// is sized, what a missing file degrades to); this file only draws them.
//
// Two shapes:
//   image -> a compact thumbnail that opens a modal preview
//   other -> a download chip
//
// Both are fed the SAME way: an authenticated fetch of
// /backend/files/:id/content. There is no public URL and no <img src> pointing
// at the route directly — the route requires an Authorization header, which an
// <img> cannot send, so the bytes come through useAuthenticatedObjectUrl into a
// blob: URL exactly like the Files panel's preview already does. The modal
// reuses the thumbnail's blob rather than fetching again: it is the same file,
// full size, already in memory.
//
// Nothing here opens an attachment in a TAB. A downloaded file is inert; a file
// handed to a viewer at this origin is not, and `type` is attacker-chosen. The
// modal is not a viewer in that sense — it is the same <img> the thumbnail
// already is, drawn larger, and `type` had to clear the closed raster allowlist
// (no SVG) to reach an <img> at all.
//
// The name is rendered as TEXT (React escapes it), pre-sanitised and
// length-capped by safeAttachmentName, and every chip, title and thumbnail
// truncates inside a bounded box — a crafted name can neither inject markup,
// widen a row, nor stretch the dialog.

import { useState } from 'react';
import { Paperclip, TriangleAlert, X } from 'lucide-react';
import { apiAuthHeaders, apiUrl } from '../../lib/backendClient';
import { useAuthenticatedObjectUrl } from '../../hooks/useAuthenticatedObjectUrl';
import { formatBytes } from './ComposerAddContent';
import {
  ATTACHMENT_THUMB_MAX_HEIGHT,
  ATTACHMENT_THUMB_PLACEHOLDER,
  ATTACHMENT_UNAVAILABLE_LABEL,
  attachmentContentPath,
  attachmentPreviewState,
  attachmentThumbnailBox,
  isImageAttachment,
  parseMessageAttachments,
  type AttachmentPreviewState,
  type MessageAttachment,
} from '../../lib/messageAttachments';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const CHIP_CLASS = 'inline-flex max-w-[260px] items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-left text-xs';

export function MessageAttachmentList({
  attachments,
  className,
  onRemove,
}: {
  // Accepts the raw column as well as a parsed list — both go through the
  // parser below, so a caller cannot get this wrong.
  attachments: MessageAttachment[] | null | undefined;
  className?: string;
  /**
   * When provided, every attachment gets a small remove control. Omitted by
   * every chat call site — a sent message's attachments are history, not
   * something a reader edits. The one caller that DOES own its list (a task's
   * attachments, added and removed before anyone else has seen them) passes
   * this instead of hand-rolling a second renderer.
   */
  onRemove?: (attachment: MessageAttachment) => void;
}) {
  // Re-parsed HERE rather than trusted from the caller. Callers already parse
  // (they need the count to decide what text to hide), but sanitisation is what
  // stops a crafted name reaching the DOM — so it belongs at the render
  // boundary, where no future call site can skip it. parseMessageAttachments is
  // idempotent, so the second pass costs a bounded list walk and nothing else.
  const items = parseMessageAttachments(attachments);
  if (items.length === 0) return null;
  return (
    <div className={cn('mt-2 flex flex-wrap items-start gap-2', className)} data-testid="message-attachments">
      {items.map(attachment => (
        <MessageAttachmentItem key={attachment.id} attachment={attachment} onRemove={onRemove} />
      ))}
    </div>
  );
}

/** The honest end state: the row this attachment points at is gone. */
function UnavailableChip({ attachment, onRemove }: { attachment: MessageAttachment; onRemove?: (attachment: MessageAttachment) => void }) {
  return (
    <span className={cn(CHIP_CLASS, 'text-muted-foreground', onRemove && 'pr-1')} title={attachment.name}>
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{attachment.name}</span>
        <span className="block truncate text-[11px]">{ATTACHMENT_UNAVAILABLE_LABEL}</span>
      </span>
      {onRemove && <RemoveButton attachment={attachment} onRemove={onRemove} />}
    </span>
  );
}

/** Small "x" used by both attachment shapes once a caller owns the list. */
function RemoveButton({ attachment, onRemove }: { attachment: MessageAttachment; onRemove: (attachment: MessageAttachment) => void }) {
  return (
    <button
      type="button"
      className="flex size-4.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Remove"
      aria-label={`Remove ${attachment.name}`}
      onClick={event => { event.preventDefault(); event.stopPropagation(); onRemove(attachment); }}
    >
      <X className="size-3" />
    </button>
  );
}

function MessageAttachmentItem({
  attachment,
  onRemove,
}: {
  attachment: MessageAttachment;
  onRemove?: (attachment: MessageAttachment) => void;
}) {
  const isImage = isImageAttachment(attachment);
  const href = apiUrl(attachmentContentPath(attachment.id));
  // Only images prefetch. A chip costs nothing until it is clicked, so a
  // transcript of twenty PDFs does not fire twenty downloads on scroll.
  const { src, loading, error } = useAuthenticatedObjectUrl(isImage ? href : null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Reserved before the bytes arrive, replaced with the real aspect on load.
  const [box, setBox] = useState<{ width: number; height: number }>(() => ({ ...ATTACHMENT_THUMB_PLACEHOLDER }));
  const sizeLabel = attachment.size > 0 ? formatBytes(attachment.size) : '';

  // Say so, rather than leaving a broken-image glyph or a chip that does
  // nothing when clicked. An image keeps its dialog mounted while it is open
  // even if the file disappears underneath — the modal has its own honest
  // branch, and yanking the whole dialog out from under a keyboard user mid-
  // interaction is worse than telling them what happened.
  const unavailable = error || downloadFailed;
  if (unavailable && !(isImage && previewOpen)) {
    return <UnavailableChip attachment={attachment} onRemove={onRemove} />;
  }

  // Hand the bytes to the browser as a SAVE, never a navigation: `download`
  // means the file is written to disk rather than rendered at this origin.
  // `attachment.name` is sanitised upstream — one line, no control or bidi
  // characters, length-capped.
  const saveToDisk = (objectUrl: string, revokeAfter: boolean) => {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = attachment.name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (revokeAfter) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  };

  const download = async () => {
    if (downloading) return;
    // An image's bytes are already here, as the blob behind the thumbnail. Do
    // not fetch the file a second time to save it, and do NOT revoke that URL
    // afterwards — the hook owns its lifetime and revoking would blank the
    // thumbnail and the open preview.
    if (isImage && src) {
      saveToDisk(src, false);
      return;
    }
    setDownloading(true);
    try {
      const response = await fetch(href, { headers: apiAuthHeaders() });
      if (!response.ok) {
        setDownloadFailed(true);
        return;
      }
      saveToDisk(URL.createObjectURL(await response.blob()), true);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  if (isImage) {
    const state = attachmentPreviewState({ src, loading, error: unavailable });
    // onRemove is undefined on every chat call site, so this stays a bare
    // DialogTrigger there — no wrapper, no extra node, identical markup to
    // before. Only a caller that owns its list (see MessageAttachmentList)
    // gets the relative wrapper the corner button needs to position against.
    const trigger = (
      <DialogTrigger asChild>
        <button
          type="button"
          title={attachment.name}
          aria-label={`Open preview of ${attachment.name}`}
          // The box is a STYLE, not a class: it comes from the image's own
          // dimensions, so there is no finite set of utilities for it.
          // max-w-full keeps it inside a narrow floating window; the image
          // letterboxes rather than distorting when that clamp bites.
          style={{ width: box.width, height: box.height }}
          className="block max-w-full overflow-hidden rounded-lg border border-border bg-muted/40 transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {state === 'ready' ? (
            <img
              src={src}
              alt={attachment.name}
              // Intrinsic size is only knowable once the bytes have decoded.
              onLoad={event => setBox(attachmentThumbnailBox(
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight,
              ))}
              className="size-full object-contain"
            />
          ) : (
            <span className="flex size-full items-center justify-center px-2 text-center text-[11px] text-muted-foreground">
              {state === 'loading' ? 'Loading…' : ATTACHMENT_UNAVAILABLE_LABEL}
            </span>
          )}
        </button>
      </DialogTrigger>
    );
    return (
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        {onRemove ? (
          <div className="relative inline-block">
            {trigger}
            <button
              type="button"
              className="absolute -top-1.5 -right-1.5 flex size-4.5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
              title="Remove"
              aria-label={`Remove ${attachment.name}`}
              onClick={event => { event.preventDefault(); event.stopPropagation(); onRemove(attachment); }}
            >
              <X className="size-3" />
            </button>
          </div>
        ) : trigger}
        <AttachmentPreviewDialog
          attachment={attachment}
          state={state}
          src={src}
          sizeLabel={sizeLabel}
          onDownload={download}
        />
      </Dialog>
    );
  }

  // No onRemove: unchanged from before this prop existed — a single button,
  // exactly what every chat call site still renders and every existing test
  // still finds via querySelector('button'). onRemove only appears for a
  // caller that owns the list, which needs a second, sibling control — and a
  // button cannot nest inside a button, hence the span wrapper on that branch
  // only.
  if (!onRemove) {
    return (
      <button
        type="button"
        onClick={download}
        title={attachment.name}
        aria-label={`Download ${attachment.name}`}
        className={cn(CHIP_CLASS, 'hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring')}
      >
        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate">{attachment.name}</span>
          {sizeLabel && <span className="block truncate text-[11px] text-muted-foreground">{sizeLabel}</span>}
        </span>
      </button>
    );
  }

  return (
    <span className={cn(CHIP_CLASS, 'pr-1')}>
      <button
        type="button"
        onClick={download}
        title={attachment.name}
        aria-label={`Download ${attachment.name}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate">{attachment.name}</span>
          {sizeLabel && <span className="block truncate text-[11px] text-muted-foreground">{sizeLabel}</span>}
        </span>
      </button>
      <RemoveButton attachment={attachment} onRemove={onRemove} />
    </span>
  );
}

/**
 * The full-size preview.
 *
 * Deliberately the app's Dialog primitive rather than a hand-rolled portal: the
 * focus trap, the Escape handler, the return of focus to the thumbnail that
 * opened it, `aria-modal`, and the surface treatment every theme family applies
 * to `dialog-content` all come with it. A hand-rolled one is how the presence
 * popover ended up rendering transparent under neo.
 */
function AttachmentPreviewDialog({
  attachment,
  state,
  src,
  sizeLabel,
  onDownload,
}: {
  attachment: MessageAttachment;
  state: AttachmentPreviewState;
  src: string;
  sizeLabel: string;
  onDownload: () => void;
}) {
  return (
    <DialogContent
      // Wide enough to be worth opening, bounded by the viewport rather than by
      // a breakpoint — chat lives in a floating, resizable window and the
      // preview has to survive being opened from a narrow one.
      className="max-w-[min(56rem,calc(100vw-2rem))] gap-3 sm:max-w-[min(56rem,calc(100vw-2rem))]"
      data-testid="attachment-preview"
    >
      <DialogHeader className="pr-8">
        {/* Plain text, truncated: a crafted name cannot widen the dialog. */}
        <DialogTitle className="truncate">{attachment.name}</DialogTitle>
        <DialogDescription className="truncate">{sizeLabel || 'Image attachment'}</DialogDescription>
      </DialogHeader>
      <div
        className="flex items-center justify-center overflow-auto rounded-lg border border-border bg-muted/30"
        style={{ minHeight: ATTACHMENT_THUMB_MAX_HEIGHT }}
      >
        {state === 'ready' ? (
          <img src={src} alt={attachment.name} className="max-h-[70vh] max-w-full object-contain" />
        ) : (
          <span className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            {state === 'unavailable' && <TriangleAlert className="size-4 shrink-0" aria-hidden />}
            {state === 'loading' ? 'Loading…' : ATTACHMENT_UNAVAILABLE_LABEL}
          </span>
        )}
      </div>
      <DialogFooter showCloseButton>
        <Button type="button" variant="outline" onClick={onDownload} disabled={state !== 'ready'}>
          Download
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
