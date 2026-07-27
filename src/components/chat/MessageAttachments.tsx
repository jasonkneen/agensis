// Message attachments — the rendering half. See lib/messageAttachments.ts for
// the decisions (what counts as an image, how the list parses, what a missing
// file degrades to); this file only draws them.
//
// Two shapes:
//   image -> an inline thumbnail
//   other -> a download chip
//
// Both are the SAME control underneath: an authenticated fetch of
// /backend/files/:id/content followed by a download. There is no public URL and
// no <img src> pointing at the route directly — the route requires an
// Authorization header, which an <img> cannot send, so the bytes come through
// useAuthenticatedObjectUrl into a blob: URL exactly like the Files panel's
// preview already does.
//
// Nothing here opens an attachment in a tab. A downloaded file is inert; a file
// handed to a viewer in this origin is not, and `type` is attacker-chosen.
//
// The name is rendered as TEXT (React escapes it), pre-sanitised and
// length-capped by safeAttachmentName, and every chip truncates inside a
// bounded box — a crafted name can neither inject markup nor widen the row.

import { useState } from 'react';
import { Paperclip, TriangleAlert } from 'lucide-react';
import { apiAuthHeaders, apiUrl } from '../../lib/backendClient';
import { useAuthenticatedObjectUrl } from '../../hooks/useAuthenticatedObjectUrl';
import { formatBytes } from './ComposerAddContent';
import {
  ATTACHMENT_UNAVAILABLE_LABEL,
  attachmentContentPath,
  isImageAttachment,
  parseMessageAttachments,
  type MessageAttachment,
} from '../../lib/messageAttachments';
import { cn } from '@/lib/utils';

const CHIP_CLASS = 'inline-flex max-w-[260px] items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-left text-xs';

export function MessageAttachmentList({
  attachments,
  className,
}: {
  // Accepts the raw column as well as a parsed list — both go through the
  // parser below, so a caller cannot get this wrong.
  attachments: MessageAttachment[] | null | undefined;
  className?: string;
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
        <MessageAttachmentItem key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

function MessageAttachmentItem({ attachment }: { attachment: MessageAttachment }) {
  const isImage = isImageAttachment(attachment);
  const href = apiUrl(attachmentContentPath(attachment.id));
  // Only images prefetch. A chip costs nothing until it is clicked, so a
  // transcript of twenty PDFs does not fire twenty downloads on scroll.
  const { src, loading, error } = useAuthenticatedObjectUrl(isImage ? href : null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const unavailable = error || downloadFailed;
  const sizeLabel = attachment.size > 0 ? formatBytes(attachment.size) : '';

  // The row this attachment points at is gone (deleted file, or a workspace the
  // viewer can no longer read). Say so, rather than leaving a broken-image glyph
  // or a chip that does nothing when clicked.
  if (unavailable) {
    return (
      <span className={cn(CHIP_CLASS, 'text-muted-foreground')} title={attachment.name}>
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate">{attachment.name}</span>
          <span className="block truncate text-[11px]">{ATTACHMENT_UNAVAILABLE_LABEL}</span>
        </span>
      </span>
    );
  }

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const response = await fetch(href, { headers: apiAuthHeaders() });
      if (!response.ok) {
        setDownloadFailed(true);
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      // Sanitised upstream: one line, no control or bidi-override characters,
      // length-capped. `download` also forces a save rather than a navigation,
      // so the browser never renders the bytes in this origin.
      anchor.download = attachment.name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  if (isImage) {
    return (
      <button
        type="button"
        onClick={download}
        title={attachment.name}
        aria-label={`Download ${attachment.name}`}
        className="block max-w-[min(20rem,100%)] overflow-hidden rounded-lg border border-border bg-muted/40 transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {src ? (
          <img src={src} alt={attachment.name} className="max-h-64 w-auto max-w-full object-contain" />
        ) : (
          <span className="flex h-24 w-40 items-center justify-center text-[11px] text-muted-foreground">
            {loading ? 'Loading…' : attachment.name}
          </span>
        )}
      </button>
    );
  }

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
