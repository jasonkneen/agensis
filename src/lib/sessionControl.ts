import { apiAuthHeaders, apiUrl } from './backendClient';

/**
 * Lifecycle-aware soft close. The server settles descendant sessions, jobs,
 * permission prompts, huddles, message bodies and activity in one transaction.
 * Callers must not remove local UI until this returns true.
 */
export async function closeSession(sessionId: string): Promise<boolean> {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const response = await fetch(
    apiUrl(`/backend/sessions/${encodeURIComponent(id)}/close`),
    {
      method: 'POST',
      headers: apiAuthHeaders(),
    },
  ).catch(() => null);
  return Boolean(response?.ok);
}
