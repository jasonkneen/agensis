import type { Message as ChatMessage, PermissionRequest, PermissionScope } from '../../types';

/** `messages.message_kind` for one agent permission request. */
export const PERMISSION_REQUEST_KIND = 'permission_request';

export function isPermissionRequestMessage(
  message: Pick<ChatMessage, 'message_kind'> | null | undefined,
): boolean {
  return (message?.message_kind ?? '') === PERMISSION_REQUEST_KIND;
}

/** Button copy, ordered narrowest-first so the safe answer is the one nearest the eye. */
export const SCOPE_LABELS: Record<PermissionScope, string> = {
  once: 'Allow once',
  session: 'Allow this session',
  always: 'Always allow',
};

export const SCOPE_HINTS: Record<PermissionScope, string> = {
  once: 'Just this one call.',
  session: "Stops asking for the rest of this agent's session.",
  always: 'Saved on the agent — survives restarts, until you revoke it.',
};

/**
 * The scopes to render, always narrowest-first and never inventing one.
 *
 * A request that offered no rule cannot be answered with "always": there would
 * be nothing to store but the whole tool, which is a much larger grant than the
 * sentence beside the button claims. The server enforces this too — this is the
 * UI agreeing with it rather than deciding it.
 */
export function offeredScopes(request: Pick<PermissionRequest, 'scopes' | 'rules'>): PermissionScope[] {
  const offered = Array.isArray(request.scopes) ? request.scopes : [];
  const ordered: PermissionScope[] = ['once', 'session', 'always'];
  const allowed = ordered.filter(scope => offered.includes(scope));
  if (allowed.length === 0) return ['once', 'session'];
  if (!request.rules?.length) return allowed.filter(scope => scope !== 'always');
  return allowed;
}

/** True while the buttons should still be live. */
export function isPermissionRequestOpen(
  request: Pick<PermissionRequest, 'status' | 'expiresAt'> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!request || request.status !== 'pending') return false;
  if (!request.expiresAt) return true;
  const expires = Date.parse(request.expiresAt);
  return !Number.isFinite(expires) || expires > now;
}

/**
 * One settled sentence for a decided request.
 *
 * Deliberately says WHICH scope was granted rather than a flat "Allowed": the
 * difference between "just then" and "from now on, forever" is the whole point
 * of the buttons, and a transcript that flattens it is a transcript nobody can
 * audit later.
 */
export function permissionOutcomeLabel(
  request: Pick<PermissionRequest, 'status' | 'scope' | 'decidedByName'>,
): string {
  const who = request.decidedByName ? ` by ${request.decidedByName}` : '';
  if (request.status === 'allowed') {
    if (request.scope === 'always') return `Always allowed${who}`;
    if (request.scope === 'session') return `Allowed for this session${who}`;
    return `Allowed${who}`;
  }
  if (request.status === 'denied') return `Denied${who}`;
  if (request.status === 'expired') return 'Expired — nobody answered in time';
  return 'Waiting for a decision';
}

/** The one-line description of what is being asked for. */
export function permissionRequestSummary(
  request: Pick<PermissionRequest, 'toolName' | 'toolDetail' | 'title'>,
): string {
  // The daemon's `title` is the bridge's own full sentence ("Claude wants to
  // read foo.txt") and reads better than anything reconstructed from the tool
  // name, so it wins when present.
  if (request.title) return request.title;
  if (request.toolName && request.toolDetail) return `${request.toolName} · ${request.toolDetail}`;
  return request.toolName || request.toolDetail || 'a tool call';
}
