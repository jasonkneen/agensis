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

/**
 * The same outcome as one word, for a chip that has no room for a sentence.
 *
 * Names the SCOPE rather than the person: which grant was made outlives the
 * conversation, whereas "by Jason" is true of essentially every approval in a
 * one-admin workspace and was crowding out the tool call it described. The full
 * sentence stays one hover away.
 */
export function permissionOutcomeBadge(
  request: Pick<PermissionRequest, 'status' | 'scope'>,
): string {
  if (request.status === 'allowed') {
    if (request.scope === 'always') return 'Always';
    if (request.scope === 'session') return 'Session';
    return 'Once';
  }
  if (request.status === 'denied') return 'Denied';
  if (request.status === 'expired') return 'Expired';
  return 'Pending';
}

/** The settled sentences the server writes over a decided request's `content`. */
const SETTLED_OUTCOMES: ReadonlyArray<{
  prefix: string;
  status: PermissionRequest['status'];
  scope: PermissionScope | '';
}> = [
  // "Allowed" is a prefix of "Allowed for this session", but order is not what
  // separates them: the match below is an EXACT head or one followed by " by ",
  // so "Allowed for this session by Jason" can never be read as a bare "Allowed".
  { prefix: 'Always allowed', status: 'allowed', scope: 'always' },
  { prefix: 'Allowed for this session', status: 'allowed', scope: 'session' },
  { prefix: 'Allowed', status: 'allowed', scope: 'once' },
  { prefix: 'Denied', status: 'denied', scope: '' },
  { prefix: 'Expired', status: 'expired', scope: '' },
];

/**
 * Rebuild a decided request from the transcript row alone.
 *
 * The workspace route only returns requests that are still PENDING, so a
 * decision made before this tab loaded has no row to look up — and the message
 * then fell through to the ordinary bubble renderer, where the server's settled
 * sentence ("Always allowed by Jason: Read · /Users/…/Foo.tsx") became a
 * full-width message that read as something a person had said. The same
 * approval, decided while the tab was open, folded quietly into a chip. One
 * event, two shapes, depending only on when you opened the window.
 *
 * Everything needed to draw the chip is already on the message: `tool_name` and
 * `tool_detail` are its own columns, and the outcome is the sentence the server
 * wrote. So the sentence is parsed back — the summary is stripped off the END
 * using those columns rather than splitting on the first ": ", so a display name
 * containing a colon cannot cut it in the wrong place.
 *
 * Returns null for anything that is not a settled approval, including a still
 * pending one (whose content is just `Bash · git clone …`) — those must keep
 * their card and its buttons.
 */
export function settledApprovalFromMessage(
  message: Pick<ChatMessage, 'id' | 'content' | 'message_kind' | 'tool_name' | 'tool_detail' | 'permission_request_id' | 'session_id' | 'created_at'> | null | undefined,
): PermissionRequest | null {
  if (!message || !isPermissionRequestMessage(message)) return null;
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) return null;

  const toolName = String(message.tool_name ?? '').trim();
  const toolDetail = String(message.tool_detail ?? '').trim();
  const summary = toolName && toolDetail ? `${toolName} · ${toolDetail}` : toolName || toolDetail;

  let head = '';
  if (summary && content.endsWith(`: ${summary}`)) {
    head = content.slice(0, content.length - summary.length - 2);
  } else {
    // Rows written before messages carried tool_name/tool_detail. The verb list
    // below is what keeps this from claiming any colon-bearing sentence.
    const cut = content.indexOf(': ');
    if (cut <= 0) return null;
    head = content.slice(0, cut);
  }

  const outcome = SETTLED_OUTCOMES.find(
    entry => head === entry.prefix || head.startsWith(`${entry.prefix} by `),
  );
  if (!outcome) return null;

  return {
    id: message.permission_request_id || message.id,
    workspaceId: '',
    agentId: '',
    jobId: null,
    sessionId: message.session_id ?? null,
    messageId: message.id,
    toolName,
    toolDetail,
    title: '',
    description: '',
    // No rule or scope list survives in the transcript, and inventing either
    // would put buttons on a request nobody can answer any more. Empty is the
    // honest reading: this is a record, not an open question.
    rules: [],
    scopes: [],
    status: outcome.status,
    scope: outcome.scope,
    decidedBy: null,
    decidedByName: head.startsWith(`${outcome.prefix} by `) ? head.slice(outcome.prefix.length + 4) : '',
    decidedAt: null,
    expiresAt: null,
    createdAt: message.created_at ?? null,
  };
}

/**
 * The request behind one transcript row: the live one when we still hold it,
 * otherwise the settled one reconstructed from the row itself.
 *
 * Live wins, always — only it can still be pending, and only it carries the
 * rules and scopes a card needs to render buttons.
 */
export function resolvePermissionRequest(
  message: ChatMessage,
  byId: ReadonlyMap<string, PermissionRequest>,
): PermissionRequest | undefined {
  const known = message.permission_request_id ? byId.get(message.permission_request_id) : undefined;
  return known ?? settledApprovalFromMessage(message) ?? undefined;
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
