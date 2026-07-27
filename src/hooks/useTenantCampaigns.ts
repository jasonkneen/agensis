import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type {
  CampaignCategory,
  CampaignPreview,
  CampaignSegment,
  CampaignSurface,
  SentCampaign,
} from '../lib/tenantCampaigns';

// ---------------------------------------------------------------------------
// The SENDING side of owner broadcasts. Owner-only; every route it calls runs
// assertSystemOwner on both backends, so a non-owner rendering this component
// gets 403s and an empty composer.
//
// THE PREVIEW IS A ROUND TRIP, on purpose. The segment could be evaluated in
// the browser over a loaded list of accounts — the tenant search already works
// that way — but this number is the one the owner is about to confirm, and a
// client-side matcher would be a SECOND implementation that could disagree with
// the one that actually picks the recipients. So the server answers "who
// matches", and the send route re-answers it and refuses if the number moved.
//
// Debounced rather than fired per keystroke: ticking four filters in a row is
// four segments, and only the last one is a question anybody wants answered.
// ---------------------------------------------------------------------------

const PREVIEW_DEBOUNCE_MS = 300;

async function ownerFetch<T>(path: string, init?: RequestInit): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...apiAuthHeaders(),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 403) return { data: null, error: 'Not available for this account.' };
    if (!response.ok) return { data: null, error: payload?.error?.message || `HTTP ${response.status}` };
    return { data: (payload?.data ?? null) as T, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'Network error' };
  }
}

export interface UseTenantCampaignsResult {
  categories: CampaignCategory[];
  preview: CampaignPreview | null;
  previewLoading: boolean;
  previewError: string | null;
  history: SentCampaign[];
  sending: boolean;
  sendError: string | null;
  /** Resolves to the sent campaign, or null when the server refused. */
  send: (input: { title: string; body: string; surface: CampaignSurface; segment: CampaignSegment; confirmCount: number }) => Promise<SentCampaign | null>;
}

export function useTenantCampaigns(enabled: boolean, segment: CampaignSegment): UseTenantCampaignsResult {
  const [categories, setCategories] = useState<CampaignCategory[]>([]);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [history, setHistory] = useState<SentCampaign[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    const { data } = await ownerFetch<{ campaigns: SentCampaign[] }>('/backend/tenants/campaigns');
    setHistory(Array.isArray(data?.campaigns) ? data.campaigns : []);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void ownerFetch<{ categories: CampaignCategory[] }>('/backend/tenants/campaigns/categories').then(({ data }) => {
      if (cancelled) return;
      setCategories(Array.isArray(data?.categories) ? data.categories : []);
    });
    void refreshHistory();
    return () => { cancelled = true; };
  }, [enabled, refreshHistory]);

  // Serialized rather than passed as an object dependency: the composer rebuilds
  // the segment on every render, and a reference dependency would re-fetch the
  // preview on every keystroke in the TITLE field.
  const segmentKey = JSON.stringify(segment);

  // A slow reply for an older segment must never overwrite a newer one's count —
  // that is the number the owner confirms. Each request takes a ticket and only
  // the current ticket may write.
  const ticketRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const parsed = JSON.parse(segmentKey) as CampaignSegment;
    if (parsed.conditions.length === 0) {
      // No filters is not "everyone", it is "nobody" — the server says the same,
      // but showing zero immediately means the composer never briefly reads as
      // if an empty segment were a large one.
      ticketRef.current += 1;
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const ticket = ++ticketRef.current;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void ownerFetch<CampaignPreview>('/backend/tenants/campaigns/preview', {
        method: 'POST',
        body: JSON.stringify({ segment: parsed }),
      }).then(({ data, error }) => {
        if (ticket !== ticketRef.current) return;
        setPreview(data);
        setPreviewError(error);
        setPreviewLoading(false);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, segmentKey]);

  const send = useCallback(async (input: {
    title: string; body: string; surface: CampaignSurface; segment: CampaignSegment; confirmCount: number;
  }) => {
    setSending(true);
    setSendError(null);
    const { data, error } = await ownerFetch<{ campaign: SentCampaign }>('/backend/tenants/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        surface: input.surface,
        segment: input.segment,
        // The number the owner just agreed to. The server compares it against
        // what it computes itself and refuses (409) if the audience moved.
        confirm_recipient_count: input.confirmCount,
      }),
    });
    setSending(false);
    if (error || !data?.campaign) {
      setSendError(error || 'The message could not be sent.');
      return null;
    }
    await refreshHistory();
    return data.campaign;
  }, [refreshHistory]);

  return { categories, preview, previewLoading, previewError, history, sending, sendError, send };
}
