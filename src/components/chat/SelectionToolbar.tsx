import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Check, Copy, Quote } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export type SelectionTarget = {
  messageId: string;
  excerpt: string;
};

type Anchor = { top: number; left: number; target: SelectionTarget };

const TOOLBAR_WIDTH = 168;

function articleFor(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>('[data-message-id]') ?? null;
}

/** Centred over the selection, clamped to the viewport. */
function anchorFor(range: Range, target: SelectionTarget): Anchor {
  const rect = range.getBoundingClientRect();
  return {
    top: Math.max(8, rect.top - 44),
    left: Math.min(
      Math.max(8, rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2),
      window.innerWidth - TOOLBAR_WIDTH - 8,
    ),
    target,
  };
}

/**
 * The toolbar that appears over selected text in the transcript: quote it into
 * the composer, or copy it. It follows the selection and leaves the moment the
 * selection does. Ported from legion.
 */
export function SelectionToolbar({
  scopeRef,
  onQuote,
}: {
  /** Only selections inside this element are offered a toolbar. */
  scopeRef: RefObject<HTMLElement | null>;
  onQuote: (target: SelectionTarget) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [copied, setCopied] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const read = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!selection || selection.isCollapsed || !text) return setAnchor(null);

    const scope = scopeRef.current;
    const start = selection.anchorNode;
    const end = selection.focusNode;
    if (!start || !end || !scope || !scope.contains(start) || !scope.contains(end)) {
      return setAnchor(null);
    }

    // Both ends of the drag must live in one message: a cross-message
    // selection has no honest author, so none is invented.
    const article = articleFor(start);
    if (!article || article !== articleFor(end)) return setAnchor(null);

    setAnchor(
      anchorFor(selection.getRangeAt(0), {
        messageId: article.dataset.messageId!,
        excerpt: text.replace(/\s+/g, ' '),
      }),
    );
  }, [scopeRef]);

  useEffect(() => {
    let settleTimer = 0;
    // A pointer release settles the selection; a keyboard one lands on keyup.
    const settle = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(read, 0);
    };
    const onDown = (event: PointerEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      setAnchor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return setAnchor(null);
      settle();
    };
    const onScroll = () => setAnchor(null);
    document.addEventListener('pointerup', settle);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keyup', onKey);
    // Scrolling moves the text out from under the toolbar, so it goes.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.clearTimeout(settleTimer);
      document.removeEventListener('pointerup', settle);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keyup', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [read]);

  useEffect(() => {
    if (!anchor) setCopied(false);
  }, [anchor]);

  if (!anchor) return null;

  const dismiss = () => {
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  };

  const buttonClass = 'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-muted hover:text-foreground';

  return (
    <div
      ref={toolbarRef}
      data-selection-toolbar
      role="toolbar"
      aria-label="Selection actions"
      className="selection-toolbar fixed z-50 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <button
        type="button"
        onClick={() => {
          onQuote(anchor.target);
          dismiss();
        }}
        className={cn(buttonClass, 'text-muted-foreground')}
      >
        <Quote className="size-3.5" />
        Quote
      </button>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(anchor.target.excerpt);
            setCopied(true);
            window.setTimeout(dismiss, 700);
          } catch {
            toast.error("Couldn't copy that");
            dismiss();
          }
        }}
        className={cn(buttonClass, copied ? 'text-primary' : 'text-muted-foreground')}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
