import { useCallback, useLayoutEffect, useRef } from 'react';

interface HistoryScrollOptions {
  scopeKey: string | null;
  firstMessageId: string | undefined;
  loadingEarlier: boolean;
  onLoadEarlier: (() => void) | undefined;
}

/** Keep the first visible row in place when an earlier history page arrives. */
export function useHistoryScrollAnchor({ scopeKey, firstMessageId, loadingEarlier, onLoadEarlier }: HistoryScrollOptions) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{
    scopeKey: string | null;
    firstMessageId: string | undefined;
    row: HTMLElement;
    offset: number;
    sawLoading: boolean;
  } | null>(null);

  const loadEarlier = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !onLoadEarlier || loadingEarlier) return;
    const bounds = viewport.getBoundingClientRect();
    const row = Array.from(viewport.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]'))
      .find(item => item.getBoundingClientRect().bottom > bounds.top);
    pending.current = row ? {
      scopeKey, firstMessageId, row,
      offset: row.getBoundingClientRect().top - bounds.top,
      sawLoading: false,
    } : null;
    onLoadEarlier();
  }, [scopeKey, firstMessageId, loadingEarlier, onLoadEarlier]);

  useLayoutEffect(() => {
    const anchor = pending.current;
    if (!anchor) return;
    const viewport = viewportRef.current;
    if (anchor.scopeKey !== scopeKey || !viewport || !viewport.contains(anchor.row)) {
      pending.current = null;
      return;
    }
    if (firstMessageId !== anchor.firstMessageId || (anchor.sawLoading && !loadingEarlier)) {
      const offset = anchor.row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.scrollTop += offset - anchor.offset;
      pending.current = null;
    } else if (loadingEarlier) {
      anchor.sawLoading = true;
    }
  });

  return { viewportRef, loadEarlier };
}
