import { useEffect, useMemo, useState } from 'react';
import { apiAuthHeaders } from '../lib/backendClient';

export function shouldFetchWithApiAuth(src?: string | null) {
  if (!src || /^(data:|blob:)/i.test(src)) return false;
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
    const url = new URL(src, base);
    return url.pathname.includes('/backend/files/') && url.pathname.endsWith('/content');
  } catch {
    return false;
  }
}

export function useAuthenticatedObjectUrl(src?: string | null) {
  const needsAuth = useMemo(() => shouldFetchWithApiAuth(src), [src]);
  const [objectUrl, setObjectUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setObjectUrl('');
    setError(false);
    if (!src || !needsAuth) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let nextUrl = '';
    setLoading(true);

    fetch(src, {
      headers: apiAuthHeaders(),
      signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return response.blob();
      })
      .then(blob => {
        nextUrl = URL.createObjectURL(blob);
        setObjectUrl(nextUrl);
      })
      .catch(error => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [needsAuth, src]);

  return {
    src: needsAuth ? objectUrl : (src || ''),
    loading,
    error,
    needsAuth,
  };
}
