import { useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { CartesiaVoice } from '../lib/agentVoice';

// The Cartesia voice catalogue, fetched through our own backend.
//
// It goes through the backend rather than straight to api.cartesia.ai for one
// reason: CARTESIA_API_KEY must never reach the browser. A voice ID is a public
// identifier and is safe to hand out; the key that mints audio is not.
//
// Fetched ONCE PER PAGE, not once per panel. There are ~836 voices behind a
// cursor-paginated endpoint the server pages through and caches, and the Agents
// window mounts this on every agent you click. A module-level cache plus a
// shared in-flight promise keeps that to a single request.

export interface CartesiaVoicesState {
  voices: CartesiaVoice[];
  loading: boolean;
  /** False when the backend has no Cartesia key — a config state, not an error. */
  configured: boolean;
  error: string;
}

interface Cached {
  voices: CartesiaVoice[];
  configured: boolean;
  error: string;
}

let cache: Cached | null = null;
let inflight: Promise<Cached> | null = null;

async function loadVoices(): Promise<Cached> {
  const response = await fetch(apiUrl('/backend/tts/voices'), { headers: apiAuthHeaders() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return {
    voices: Array.isArray(payload?.data) ? payload.data : [],
    // Absent means an older backend that predates the route; treat it as
    // configured so the picker renders rather than claiming a misconfiguration.
    configured: payload?.configured !== false,
    error: '',
  };
}

function fetchVoices(): Promise<Cached> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = loadVoices()
    .then(result => {
      cache = result;
      inflight = null;
      return result;
    })
    .catch((error: unknown) => {
      inflight = null;
      // NOT cached: a failed fetch should be retried the next time the panel
      // opens, whereas caching the failure would leave the picker permanently
      // empty after one blip.
      return {
        voices: [],
        configured: true,
        error: error instanceof Error ? error.message : 'Could not load voices.',
      };
    });
  return inflight;
}

export function useCartesiaVoices(): CartesiaVoicesState {
  const [state, setState] = useState<CartesiaVoicesState>(() => (
    cache
      ? { ...cache, loading: false }
      : { voices: [], loading: true, configured: true, error: '' }
  ));

  useEffect(() => {
    if (cache) return;
    let active = true;
    void fetchVoices().then(result => {
      if (active) setState({ ...result, loading: false });
    });
    return () => { active = false; };
  }, []);

  return state;
}
