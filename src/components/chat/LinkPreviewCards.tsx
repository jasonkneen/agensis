import { useMemo } from 'react';
import { Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiUrl } from '@/lib/backendClient';
import { useAuthenticatedObjectUrl } from '@/hooks/useAuthenticatedObjectUrl';
import { useLinkPreviews } from '@/hooks/useLinkPreviews';
import {
  extractLinkUrls,
  hasCardContent,
  linkHostLabel,
  linkPreviewStateLabel,
  type LinkPreview,
  type LinkPreviewEntry,
} from '@/lib/linkPreview';

// The card a link in a message unfurls into.
//
// EVERYTHING SHOWN HERE IS UNTRUSTED. title, description and siteName were
// written by whatever page was linked to. Three rules follow, and they are the
// whole security story of this component:
//
//   1. They are rendered as React TEXT CHILDREN. No dangerouslySetInnerHTML, no
//      markdown pass, no sanitizeHtml. Note that routing them through
//      src/lib/sanitize.ts would be a DOWNGRADE, not an upgrade: that helper's
//      job is to permit a set of HTML tags for the rich-text editor, so using it
//      here would mean deciding to interpret a stranger's text as markup. A text
//      node cannot be markup at all.
//   2. The href is the URL FROM THE MESSAGE — never `finalUrl`, never anything
//      the page said about itself. A card cannot send you somewhere the message
//      did not.
//   3. The image comes through our own origin (see the proxy route), so viewing
//      a card does not hand the reader's IP to the linked host. The remote URL is
//      never even sent to the browser.
//
// Lengths are already capped server-side; the truncation here is layout, not
// safety.

interface LinkPreviewCardsProps {
  /** The message text. URLs are extracted from it, capped. */
  content: string;
  className?: string;
}

export function LinkPreviewCards({ content, className }: LinkPreviewCardsProps) {
  const urls = useMemo(() => extractLinkUrls(content), [content]);
  const entries = useLinkPreviews(urls);
  if (!entries.length) return null;
  return (
    <div className={cn('mt-2 flex flex-col gap-1.5', className)} data-testid="link-previews">
      {entries.map(entry => (
        <LinkPreviewRow key={entry.url} entry={entry} />
      ))}
    </div>
  );
}

function LinkPreviewRow({ entry }: { entry: LinkPreviewEntry }) {
  if (hasCardContent(entry.preview)) {
    return <LinkPreviewCard url={entry.url} preview={entry.preview as LinkPreview} />;
  }
  // Pending, "the page publishes nothing", and "we could not fetch it" all read
  // as one quiet line in the same shape — a stated fact about the link, matching
  // the huddle marker row's voice. A spinner that never resolves, or a blank
  // bordered rectangle, would both look like a bug instead of an answer.
  const label = linkPreviewStateLabel(entry);
  if (!label) return null;
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
      data-testid="link-preview-state"
      // The detail is our own vocabulary ('timeout', 'http_404'), not the page's.
      title={entry.state === 'ready' && entry.preview.detail ? `Reason: ${entry.preview.detail}` : undefined}
    >
      <Link2 className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function LinkPreviewCard({ url, preview }: { url: string; preview: LinkPreview }) {
  const site = preview.siteName || linkHostLabel(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      data-testid="link-preview-card"
      className={cn(
        'control-outer-ring flex max-w-xl gap-3 overflow-hidden rounded-md border border-border',
        'bg-muted/40 p-2.5 no-underline transition-colors hover:bg-muted/70',
      )}
    >
      <LinkPreviewThumb imagePath={preview.imagePath} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {site && <span className="truncate text-[11px] text-muted-foreground">{site}</span>}
        {preview.title && (
          <span className="truncate text-sm font-medium text-foreground">{preview.title}</span>
        )}
        {preview.description && (
          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{preview.description}</span>
        )}
      </div>
    </a>
  );
}

/**
 * The thumbnail, fetched through the proxy with the session's auth header and
 * shown from an object URL — the same pattern uploaded-file images already use,
 * because an <img src> cannot carry an Authorization header.
 *
 * Renders nothing at all while loading or on failure. A card whose text is fine
 * should not grow a broken-image box because a CDN was slow.
 */
function LinkPreviewThumb({ imagePath }: { imagePath: string }) {
  const src = imagePath ? apiUrl(imagePath) : '';
  const { src: objectUrl, error } = useAuthenticatedObjectUrl(src);
  if (!imagePath || error || !objectUrl) return null;
  return (
    <img
      src={objectUrl}
      // Deliberately empty: the alt text would have to come from the same
      // untrusted page, and a decorative thumbnail beside a title that already
      // says everything is better left out of the accessibility tree.
      alt=""
      aria-hidden
      loading="lazy"
      className="size-14 shrink-0 rounded object-cover"
    />
  );
}
