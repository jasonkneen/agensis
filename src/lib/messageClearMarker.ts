export interface MessageClearMarker {
  id: string;
  created_at: string;
}

export function serializeMessageClearMarker(
  message: { id?: unknown; created_at?: unknown } | null | undefined,
): string | null {
  const id = typeof message?.id === 'string' ? message.id : '';
  const createdAt = typeof message?.created_at === 'string' ? message.created_at : '';
  if (!id || !Number.isFinite(Date.parse(createdAt))) return null;
  return JSON.stringify({ createdAt, id });
}

/**
 * New markers use the server message's compound `(created_at,id)` position.
 * Legacy installs stored a browser timestamp; preserve that older boundary
 * with a maximal id so every row at the same instant stays hidden.
 */
export function parseMessageClearMarker(value: string | null): MessageClearMarker | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { id?: unknown; createdAt?: unknown };
    if (
      typeof parsed.id === 'string'
      && parsed.id
      && typeof parsed.createdAt === 'string'
      && Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return { id: parsed.id, created_at: parsed.createdAt };
    }
  } catch {
    // Fall through to the legacy bare timestamp form.
  }
  return Number.isFinite(Date.parse(value))
    ? { id: '\uffff', created_at: value }
    : null;
}
