import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { MarketplaceListing } from '../lib/marketplace';

// The agent marketplace, browse + act.
//
// THE FETCH MUST FALL BACK, NOT ERROR — the same rule as useAgentTemplates and
// for the same reason: the frontend deploys on push while the Fly backend
// needs an explicit deploy, so this hook routinely runs against a server that
// does not have the routes yet. A failure leaves `listings` empty and sets
// `unavailable`, and the create flow simply shows no marketplace section —
// byte-identical to before the feature, which is also the rollback story.
//
// Action helpers return an error MESSAGE ('' on success) rather than a
// boolean, mirroring importTemplate: the server's refusals are the useful part
// (403 -> "needs the manage role"), and a bare `false` would throw them away.

interface ListingsResponse {
  data?: MarketplaceListing[] | null;
  error?: { message?: string } | string | null;
}

function errorText(body: { error?: { message?: string } | string | null } | null, fallback: string): string {
  const error = body?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && error.message) return error.message;
  return fallback;
}

export function useMarketplace(workspaceId: string | null) {
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(false);
  /** True when the route could not be reached — the create flow hides the section. */
  const [unavailable, setUnavailable] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    try {
      const response = await fetch(apiUrl('/backend/marketplace/listings'), {
        headers: apiAuthHeaders(),
      });
      if (requestRef.current !== requestId) return;
      if (!response.ok) {
        setListings([]);
        setUnavailable(true);
        return;
      }
      const body: ListingsResponse | null = await response.json().catch(() => null);
      if (requestRef.current !== requestId) return;
      setListings(Array.isArray(body?.data) ? body.data : []);
      setUnavailable(false);
    } catch {
      if (requestRef.current !== requestId) return;
      setListings([]);
      setUnavailable(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Share an agent to the marketplace. Manage-gated server-side. */
  const publishListing = useCallback(async (
    agentId: string,
    listing: {
      listingType: 'template' | 'hire';
      name?: string;
      description?: string;
      category?: string;
      capabilities?: string[];
    },
  ): Promise<string> => {
    if (!workspaceId) return 'No workspace selected';
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/marketplace/listings`),
        {
          method: 'POST',
          headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, listing }),
        },
      );
      const body = await response.json().catch(() => null);
      if (response.status === 403) return 'Sharing to the marketplace needs the manage role on this workspace.';
      if (response.status === 404 && !body?.error) return 'This server does not support the marketplace yet.';
      if (!response.ok) return errorText(body, 'Could not publish that listing');
      void refresh();
      return '';
    } catch {
      return 'Could not reach the server';
    }
  }, [workspaceId, refresh]);

  /** Take a published listing down. Publisher workspace + manage only. */
  const unpublishListing = useCallback(async (listingId: string): Promise<string> => {
    if (!workspaceId) return 'No workspace selected';
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/marketplace/listings/${listingId}`),
        { method: 'DELETE', headers: apiAuthHeaders() },
      );
      const body = await response.json().catch(() => null);
      if (response.status === 403) return 'Removing a listing needs the manage role on this workspace.';
      if (!response.ok) return errorText(body, 'Could not remove that listing');
      setListings(prev => prev.filter(entry => entry.id !== listingId));
      return '';
    } catch {
      return 'Could not reach the server';
    }
  }, [workspaceId]);

  /**
   * Save a template listing into this workspace's own templates. Routed
   * through the server's import lane, so it is manage-gated and audited like
   * any other cross-workspace import.
   */
  const copyListing = useCallback(async (listingId: string): Promise<string> => {
    if (!workspaceId) return 'No workspace selected';
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/marketplace/listings/${listingId}/copy`),
        { method: 'POST', headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' } },
      );
      const body = await response.json().catch(() => null);
      if (response.status === 403) return 'Copying a marketplace template needs the manage role on this workspace.';
      if (!response.ok) return errorText(body, 'Could not copy that template');
      return '';
    } catch {
      return 'Could not reach the server';
    }
  }, [workspaceId]);

  /** Hire a listing: the server authors the Connector roster row. */
  const hireListing = useCallback(async (listingId: string): Promise<string> => {
    if (!workspaceId) return 'No workspace selected';
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/marketplace/listings/${listingId}/hire`),
        { method: 'POST', headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' } },
      );
      const body = await response.json().catch(() => null);
      if (response.status === 403) return 'Hiring an agent needs the manage role on this workspace.';
      if (!response.ok) return errorText(body, 'Could not hire that agent');
      void refresh();
      return '';
    } catch {
      return 'Could not reach the server';
    }
  }, [workspaceId, refresh]);

  return { listings, loading, unavailable, refresh, publishListing, unpublishListing, copyListing, hireListing };
}
