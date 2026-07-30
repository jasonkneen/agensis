import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { CursorBuddyGuideSubmission } from '../lib/cursorbuddyGuides';

type ReviewDecision = 'approved' | 'rejected';

async function guideRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...apiAuthHeaders(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload?.data as T;
}

export function useGuideSubmissions(enabled: boolean) {
  const [guides, setGuides] = useState<CursorBuddyGuideSubmission[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => setReloadToken(token => token + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void guideRequest<CursorBuddyGuideSubmission[]>('/backend/tenants/guide-submissions')
      .then((data) => {
        if (cancelled) return;
        setGuides(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : 'Could not load guide submissions');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [enabled, reloadToken]);

  const review = useCallback(async (
    guideId: string,
    decision: ReviewDecision,
    notes: string,
  ) => {
    const updated = await guideRequest<CursorBuddyGuideSubmission>(
      `/backend/tenants/guide-submissions/${encodeURIComponent(guideId)}/review`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, notes }),
      },
    );
    setGuides(current => current.map(guide => guide.id === updated.id ? updated : guide));
    return updated;
  }, []);

  return { guides, loading, error, refetch, review };
}
