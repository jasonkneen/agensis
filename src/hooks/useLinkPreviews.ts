import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { LinkPreview, LinkPreviewEntry } from '../lib/linkPreview';

// One module-level store for the whole app, on purpose.
//
// A card is rendered per message, and a channel scroll mounts dozens at once. If
// each component fetched for itself, opening a channel would be one HTTP request
// per link and a re-request on every remount. Instead: URLs go into a queue, the
// queue is flushed as ONE batched request a moment later, and the answers live in
// a module Map so a remount is free and two messages linking the same page share
// a single row.
//
// The server keeps the real cache (a week per URL, install-wide). This is only
// the per-session layer in front of it.

// Long enough for a channel's worth of message rows to mount and queue together,
// short enough that a card appears without a visible beat.
const FLUSH_DELAY_MS = 60;
// Must not exceed LINK_PREVIEW_MAX_PER_REQUEST on the server, which silently
// drops the overflow.
const MAX_PER_REQUEST = 8;
// A request-level failure (offline, 429, 500) is NOT a fact about the URL, so it
// is held only briefly and then retried, unlike a row the server actually wrote.
const LOCAL_FAILURE_RETRY_MS = 60_000;
const MAX_IDLE_PREVIEWS = 256;
const REQUEST_TIMEOUT_MS = 30_000;

const cache = new Map<string, LinkPreview>();
const inflight = new Set<string>();
const queue = new Set<string>();
/** url -> when a LOCAL (transport) failure was recorded, so it can be retried. */
const localFailures = new Map<string, number>();
const listeners = new Set<() => void>();
const consumers = new Map<string, number>();
let activeRequest: AbortController | null = null;
let generation = 0;

// Mounted cards keep their answer. Only the reusable, offscreen cache is capped.
function pruneCache() {
  let idle = 0;
  for (const url of cache.keys()) if (!consumers.has(url)) idle++;
  for (const url of cache.keys()) {
    if (idle <= MAX_IDLE_PREVIEWS) break;
    if (consumers.has(url)) continue;
    cache.delete(url);
    localFailures.delete(url);
    idle--;
  }
}

let storeVersion = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  storeVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion() {
  return storeVersion;
}

function localFailure(url: string, detail: string): LinkPreview {
  return {
    url,
    finalUrl: '',
    status: 'failed',
    title: '',
    description: '',
    siteName: '',
    imagePath: '',
    detail,
    fetchedAt: null,
  };
}

function scheduleFlush() {
  if (flushTimer !== null || activeRequest !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush() {
  const batch: string[] = [];
  for (const url of queue) {
    if (batch.length >= MAX_PER_REQUEST) break;
    batch.push(url);
  }
  for (const url of batch) {
    queue.delete(url);
    inflight.add(url);
  }
  if (!batch.length) return;
  const requestGeneration = generation;
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl('/backend/link-previews'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ urls: batch }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`link preview request failed (${response.status})`);
    const payload = await response.json();
    if (requestGeneration !== generation) return;
    const previews: LinkPreview[] = Array.isArray(payload?.data?.previews) ? payload.data.previews : [];
    for (const preview of previews) {
      if (!preview || typeof preview.url !== 'string' || !batch.includes(preview.url)) continue;
      cache.set(preview.url, preview);
      localFailures.delete(preview.url);
    }
    // A URL the server declined to answer for (it refused the shape, or trimmed
    // an overflow) must resolve to something, or its card spins forever.
    for (const url of batch) {
      if (!cache.has(url)) {
        cache.set(url, localFailure(url, 'no_preview_returned'));
        localFailures.set(url, Date.now());
      }
    }
  } catch {
    if (requestGeneration !== generation) return;
    for (const url of batch) {
      cache.set(url, localFailure(url, 'request_failed'));
      localFailures.set(url, Date.now());
    }
  } finally {
    clearTimeout(timeout);
    if (requestGeneration === generation) {
      activeRequest = null;
      for (const url of batch) inflight.delete(url);
      pruneCache();
      emit();
      if (queue.size > 0) scheduleFlush();
    }
  }
}

function request(urls: string[]) {
  let queued = false;
  const now = Date.now();
  for (const url of urls) {
    const failedAt = localFailures.get(url);
    if (failedAt !== undefined && now - failedAt > LOCAL_FAILURE_RETRY_MS) {
      // The last answer was about the connection, not about the URL. Try again.
      cache.delete(url);
      localFailures.delete(url);
    }
    if (cache.has(url) || inflight.has(url) || queue.has(url)) continue;
    queue.add(url);
    queued = true;
  }
  if (queued) scheduleFlush();
}

function entryFor(url: string): LinkPreviewEntry {
  const preview = cache.get(url);
  return preview ? { url, state: 'ready', preview } : { url, state: 'pending', preview: null };
}

const NO_ENTRIES: LinkPreviewEntry[] = [];

/**
 * Preview rows for these URLs, requesting the ones nobody has yet.
 *
 * Keyed on the joined URL list rather than the array identity, so a parent that
 * re-renders with a fresh array does not re-request. URLs cannot contain
 * whitespace (the extractor's character class excludes it), which is what makes
 * the newline join reversible.
 */
export function useLinkPreviews(urls: string[]): LinkPreviewEntry[] {
  const key = urls.join('\n');
  // useSyncExternalStore requires getSnapshot to return the SAME reference until
  // something actually changed, or React re-renders forever. The memo is per
  // component (a ref, not a module slot) so two cards with different URL lists
  // cannot thrash each other's cached array.
  const memo = useRef<{ key: string; version: number; value: LinkPreviewEntry[] }>({
    key: '',
    version: -1,
    value: NO_ENTRIES,
  });
  const getSnapshot = useCallback(() => {
    const current = memo.current;
    if (current.key === key && current.version === getVersion()) return current.value;
    const value = key ? key.split('\n').map(entryFor) : NO_ENTRIES;
    memo.current = { key, version: getVersion(), value };
    return value;
  }, [key]);
  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!key) return;
    const requested = key.split('\n');
    for (const url of requested) consumers.set(url, (consumers.get(url) ?? 0) + 1);
    request(requested);
    return () => {
      for (const url of requested) {
        const remaining = (consumers.get(url) ?? 1) - 1;
        if (remaining > 0) consumers.set(url, remaining);
        else {
          consumers.delete(url);
          queue.delete(url);
        }
      }
      pruneCache();
      if (queue.size === 0 && flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    };
  }, [key]);

  return entries;
}

/** Test seam: drop every cached row and pending request. */
export function __resetLinkPreviewStoreForTests() {
  generation++;
  activeRequest?.abort();
  activeRequest = null;
  consumers.clear();
  cache.clear();
  inflight.clear();
  queue.clear();
  localFailures.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  storeVersion = 0;
}
