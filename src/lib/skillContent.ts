import { apiAuthHeaders, apiUrl } from './backendClient';

// ---------------------------------------------------------------------------
// The body behind a row in the Skills browser.
//
// A skill in that list is usually a NAME — either one a connected daemon
// advertised from its own machine, or one somebody typed into an agent's form.
// Only some of them come with a document, and this module's whole job is to
// keep those two cases visibly apart. The rule the pane follows: show the real
// text, or say plainly that there isn't any and why. Never approximate one.
// ---------------------------------------------------------------------------

/**
 * The ceiling the backend reads and stores a document at
 * (SKILL_CONTENT_MAX_BYTES in server/skill-content.cjs). Mirrored here only so
 * the pane can name the number when it says a file was cut short.
 */
export const SKILL_CONTENT_MAX_BYTES = 64 * 1024;

/** Where a body came from. */
export type SkillContentSource =
  /** A daemon mirrored the real file up from the machine that has the skill. */
  | 'daemon'
  /** A sandbox / provider skill definition agensis itself holds. */
  | 'sandbox'
  /** A file read from a skill library on the backend host. */
  | 'host';

export type SkillUnavailableReason =
  /** A live machine claims the skill; agensis was told the name and nothing else. */
  | 'not-synced'
  /** The library lives on the backend host and host reads are switched off there. */
  | 'host-fs-disabled'
  | 'not-found'
  | 'unreadable'
  /** Client-side only: the backend never answered (offline, or the route isn't deployed). */
  | 'request-failed';

export interface SkillContentAvailable {
  available: true;
  source: SkillContentSource;
  markdown: string;
  path: string;
  byteSize: number;
  truncated: boolean;
  summary?: string;
  agentName?: string;
  lastSynced?: string | null;
}

export interface SkillContentUnavailable {
  available: false;
  reason: SkillUnavailableReason;
  path?: string;
}

export type SkillContentResult = SkillContentAvailable | SkillContentUnavailable;

export interface SkillLibraryEntry {
  name: string;
  /** The on-disk name, which is what the entry read is addressed by. */
  entry: string;
  kind: 'folder' | 'file';
}

export interface SkillLibraryListing {
  entries: SkillLibraryEntry[];
  path?: string;
  available?: boolean;
  reason?: SkillUnavailableReason;
}

const REASONS: readonly SkillUnavailableReason[] = [
  'not-synced',
  'host-fs-disabled',
  'not-found',
  'unreadable',
  'request-failed',
];

function asReason(value: unknown): SkillUnavailableReason {
  return REASONS.includes(value as SkillUnavailableReason) ? (value as SkillUnavailableReason) : 'not-found';
}

/**
 * Narrow an untrusted payload into a result.
 *
 * The backend answers a closed set of reasons precisely so the wording lives
 * here rather than being echoed from the server — but the response is still
 * untrusted, so an unrecognised reason collapses to 'not-found' instead of
 * reaching the screen.
 */
export function parseSkillContent(payload: unknown): SkillContentResult {
  const data = payload as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return { available: false, reason: 'request-failed' };
  if (data.available !== true) {
    return { available: false, reason: asReason(data.reason), path: typeof data.path === 'string' ? data.path : '' };
  }
  const source = data.source === 'daemon' || data.source === 'sandbox' || data.source === 'host'
    ? data.source
    : 'daemon';
  return {
    available: true,
    source,
    markdown: typeof data.markdown === 'string' ? data.markdown : '',
    path: typeof data.path === 'string' ? data.path : '',
    byteSize: Number(data.byteSize) || 0,
    truncated: data.truncated === true,
    summary: typeof data.summary === 'string' ? data.summary : '',
    agentName: typeof data.agentName === 'string' ? data.agentName : '',
    lastSynced: typeof data.lastSynced === 'string' ? data.lastSynced : null,
  };
}

/**
 * What the pane says when there is no body.
 *
 * Each reason gets its own wording because each has a different fix, and
 * "nothing to show" without the reason sends people looking in the wrong
 * place — the repo's standard is that an empty state naming the cause beats a
 * plausible-looking fabrication.
 */
export function describeSkillUnavailable(
  reason: SkillUnavailableReason,
  { name = '' }: { name?: string } = {},
): { title: string; detail: string } {
  switch (reason) {
    case 'not-synced':
      return {
        title: 'The file is on the machine, not here',
        detail: `A connected daemon advertised ${name ? `“${name}”` : 'this skill'} by name. agensis was told the name and nothing else — the daemon has not sent the file up, so there is no text to show. Nothing is missing on your side.`,
      };
    case 'host-fs-disabled':
      return {
        title: 'Reading files on the backend host is switched off',
        detail: 'This library was found on the machine running the agensis backend. Its files are only readable when an operator sets AGENSIS_ALLOW_PROJECT_FS on that host, so on a shared backend they stay unread.',
      };
    case 'unreadable':
      return {
        title: 'The file could not be read',
        detail: 'agensis found the file but could not open it — most often a permissions problem on the host.',
      };
    case 'request-failed':
      return {
        title: 'Could not reach the backend',
        detail: 'The request for this skill did not complete. If it keeps failing, the backend may be older than this build of the app.',
      };
    case 'not-found':
    default:
      return {
        title: 'No document for this skill',
        detail: `agensis holds no text for ${name ? `“${name}”` : 'this skill'} — it is a name on an agent, not a file agensis has a copy of.`,
      };
  }
}

/** One line describing where a shown body came from. */
export function describeSkillSource(
  result: SkillContentAvailable,
): string {
  switch (result.source) {
    case 'daemon':
      return result.agentName
        ? `Mirrored from ${result.agentName}'s machine.`
        : 'Mirrored from the machine that has this skill.';
    case 'sandbox':
      return 'This is the exact text the agent is given for this skill each turn.';
    case 'host':
    default:
      return 'Read from a skill library on the machine running the agensis backend.';
  }
}

export function formatSkillBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

async function getSkillContentJson(query: string): Promise<unknown> {
  const path = `/backend/system/skill-content?${query}`;
  const response = await fetch(apiUrl(path), { headers: apiAuthHeaders() });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload as { error?: unknown } | null)?.error) return null;
  return (payload as { data?: unknown } | null)?.data ?? null;
}

/** The document for one named agent skill. Never throws — a failure is a reason. */
export async function fetchSkillContent(workspaceId: string, skill: string): Promise<SkillContentResult> {
  if (!workspaceId || !skill) return { available: false, reason: 'not-found' };
  try {
    const data = await getSkillContentJson(
      `workspaceId=${encodeURIComponent(workspaceId)}&skill=${encodeURIComponent(skill)}`,
    );
    if (!data) return { available: false, reason: 'request-failed' };
    return parseSkillContent(data);
  } catch {
    return { available: false, reason: 'request-failed' };
  }
}

/** The entries inside a detected skill library. */
export async function fetchSkillLibrary(workspaceId: string, libraryId: string): Promise<SkillLibraryListing> {
  if (!workspaceId || !libraryId) return { entries: [], available: false, reason: 'not-found' };
  try {
    const data = await getSkillContentJson(
      `workspaceId=${encodeURIComponent(workspaceId)}&library=${encodeURIComponent(libraryId)}`,
    ) as Record<string, unknown> | null;
    if (!data) return { entries: [], available: false, reason: 'request-failed' };
    if (data.available === false) return { entries: [], available: false, reason: asReason(data.reason) };
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return {
      entries: entries.flatMap((raw): SkillLibraryEntry[] => {
        const row = raw as Record<string, unknown>;
        const entry = typeof row?.entry === 'string' ? row.entry : '';
        if (!entry) return [];
        return [{
          entry,
          name: typeof row.name === 'string' && row.name ? row.name : entry,
          kind: row.kind === 'folder' ? 'folder' : 'file',
        }];
      }),
      path: typeof data.path === 'string' ? data.path : '',
      available: true,
    };
  } catch {
    return { entries: [], available: false, reason: 'request-failed' };
  }
}

/** One entry's markdown. */
export async function fetchSkillLibraryEntry(
  workspaceId: string,
  libraryId: string,
  entry: string,
): Promise<SkillContentResult> {
  if (!workspaceId || !libraryId || !entry) return { available: false, reason: 'not-found' };
  try {
    const data = await getSkillContentJson(
      `workspaceId=${encodeURIComponent(workspaceId)}&library=${encodeURIComponent(libraryId)}&entry=${encodeURIComponent(entry)}`,
    );
    if (!data) return { available: false, reason: 'request-failed' };
    return parseSkillContent(data);
  } catch {
    return { available: false, reason: 'request-failed' };
  }
}
