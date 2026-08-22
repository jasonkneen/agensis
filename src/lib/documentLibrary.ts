import type { AgentDocument, AgentMemoryFile, Document, WorkspaceAgent } from '../types';
import { agentAccentColor } from './agentAccent';

// ---------------------------------------------------------------------------
// THE DOCUMENT LIBRARY — one place for every document the workspace can reach.
//
// Documents arrive here from four unrelated places, and before this file each
// of them had its own browse surface:
//
//   1. `documents`            — authored in the app. The only WRITABLE kind.
//   2. `agent_documents`      — markdown a connected agent mirrored up from its
//                               own locations (its repo, its docs/ tree).
//   3. `agent_memory_files`   — the memory palace. Markdown files with paths.
//   4. `agent_skill_documents`— the SKILL.md behind an advertised skill name.
//
// THE ROW IS A DOCUMENT; THE AGENTS ARE ITS SOURCES. Same shape as the Skills
// window (src/lib/skillsView.ts) and for the same reason: three checkouts of one
// repo is the NORMAL case, and three rows saying README would make the library
// worse than no library at all. One row, three source chips, and the question
// "do they agree?" answerable at a glance.
//
// WHAT MAKES TWO ROWS THE SAME DOCUMENT is the interesting decision, and it is
// deliberately NOT the content hash. Hash equality proves two copies are
// identical; it cannot recognise that agent A's README is a newer edit of agent
// B's README, which is the exact case the compare view exists for. So identity
// is (normalized path, normalized title) — see documentIdentityKey — and the
// hash is used afterwards, to say whether the copies AGREE.
//
// PURE. No hooks, no fetch, no clock — every input is passed in, including
// `now` where a caller wants relative times. Unit-tested in
// tests/unit/documentLibrary.test.ts.
// ---------------------------------------------------------------------------

/** Where one copy of a document came from. */
export type LibrarySourceKind =
  /** A row in `documents`: authored here, editable, workspace-owned. */
  | 'workspace'
  /** A file an agent's daemon mirrored from its own locations. */
  | 'agent-document'
  /** A markdown file in an agent's memory palace. */
  | 'agent-memory'
  /** The body behind a skill an agent advertises. */
  | 'agent-skill';

export const LIBRARY_SOURCE_LABELS: Record<LibrarySourceKind, string> = {
  workspace: 'Workspace',
  'agent-document': 'Agent files',
  'agent-memory': 'Agent memory',
  'agent-skill': 'Agent skills',
};

/** The agent behind a source, reduced to what a chip needs. */
export interface LibraryAgentRef {
  id: string;
  name: string;
  handle: string;
  /** Chip identity: initials on a solid colour. NEVER an emoji. */
  initials: string;
  color: string;
  /** A live daemon is attached right now. */
  connected: boolean;
}

/**
 * ONE copy of a document, from one place.
 *
 * `rowId` is the identity of the row this came from, and `kind` says which
 * table it is in — the two together are what a body fetch needs, and keeping
 * them separate from the collation key is what lets the same document exist in
 * four tables without the library pretending it is four documents.
 */
export interface LibrarySource {
  /** Stable within a library build: `${kind}:${rowId}`. */
  id: string;
  kind: LibrarySourceKind;
  rowId: string;
  /** Null for a workspace document — nobody's agent owns it. */
  agent: LibraryAgentRef | null;
  /** Where this copy lives, in the words of wherever it came from. */
  path: string;
  title: string;
  summary: string;
  byteSize: number;
  /** '' when the source cannot supply one (only agent_documents can today). */
  contentHash: string;
  /**
   * When this copy was last CHANGED, as an epoch ms, or 0 when unknown.
   *
   * Ranked on the source's own clock where it has one (an agent document's
   * `source_modified_at` is the file's mtime), falling back to the sync/update
   * time. "Newest" has to mean the newest FILE — ranking on sync time alone
   * would promote whichever daemon reconnected most recently.
   */
  modifiedAt: number;
  /** Whether this copy is a truncated snapshot of a larger file. */
  truncated: boolean;
}

/** One document, wherever its copies live. */
export interface LibraryEntry {
  /** The collation key. Stable across rebuilds; safe as a React key. */
  key: string;
  title: string;
  /** The folder/domain this document groups under. Never ''; see DEFAULT_DOMAIN. */
  domain: string;
  /** Every copy, newest first. */
  sources: LibrarySource[];
  /**
   * The copy the library treats as current: newest by `modifiedAt`, with a
   * WORKSPACE document winning a tie.
   *
   * The tiebreak is not arbitrary. A workspace document is the one somebody
   * here can actually edit, and it is the only copy whose timestamp describes
   * an act in this workspace rather than on a machine elsewhere. When two
   * copies claim the same instant, the one you can do something about is the
   * more useful default.
   */
  primary: LibrarySource;
  /** Every copy that is not the primary. Empty for a single-source document. */
  alternates: LibrarySource[];
  /**
   * Do all copies agree?
   *
   * `true` only when every source reports the SAME non-empty content hash.
   * Unknown (a source with no hash — every kind but agent-document today) is
   * not agreement: saying "identical" on missing evidence is the one answer a
   * compare view must never give.
   */
  identical: boolean;
  /** How many distinct agents contribute a copy. */
  agentCount: number;
}

/** The group a document with no folder of its own falls into. */
export const DEFAULT_DOMAIN = 'General';

export interface LibraryDomainGroup {
  domain: string;
  entries: LibraryEntry[];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Strip directories and the extension: `docs/API Guide.md` -> `api guide`. */
function baseName(path: string): string {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : '';
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

function normalizeForKey(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * What makes two copies the SAME document.
 *
 * The filename without its extension, falling back to the title. Filename
 * first, because it is what actually travels between machines: two checkouts of
 * a repo agree on `docs/architecture.md` even after somebody edits the `#`
 * heading on one of them, and a title-first key would split that document in
 * two at the exact moment the compare view became interesting.
 *
 * The title is the fallback rather than part of the key for the same reason. A
 * workspace document has no path at all, so it can only be matched by title —
 * and joining a titled workspace doc to a same-named file on an agent's disk is
 * the join that makes the library one library.
 *
 * The DIRECTORY is deliberately not in the key. `docs/setup.md` on one agent and
 * `setup.md` on another are the same document seen from two checkouts, and a
 * key that included the directory would present them as two.
 */
export function documentIdentityKey(input: { path?: string | null; title?: string | null }): string {
  const fromPath = normalizeForKey(baseName(String(input.path || '')));
  if (fromPath) return fromPath;
  const fromTitle = normalizeForKey(String(input.title || ''));
  return fromTitle || 'untitled';
}

/**
 * Up to two initials. Letters and digits only, NEVER an emoji.
 *
 * The name is tried first and the handle SECOND rather than only when the name
 * is empty: an agent called "🤖" has a name that is entirely non-alphanumeric,
 * and stopping there yields "?" for an agent whose handle would have given a
 * perfectly good chip.
 */
export function libraryAgentInitials(agent: Pick<WorkspaceAgent, 'name' | 'handle'>): string {
  for (const candidate of [agent.name, agent.handle]) {
    const words = String(candidate || '').trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return '?';
}

function timestamp(...values: Array<string | null | undefined>): number {
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * The folder a document groups under.
 *
 * A daemon-supplied domain wins, then the path's first directory, then the
 * workspace document's own folder. '' becomes DEFAULT_DOMAIN rather than an
 * empty heading — a group with no name reads as a rendering bug.
 */
function resolveDomain(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return DEFAULT_DOMAIN;
}

function firstDirectory(path: string): string {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? parts[0] : '';
}

// ---------------------------------------------------------------------------
// Source builders — one per contributing table
// ---------------------------------------------------------------------------

/**
 * Which markdown in an agent's memory palace belongs in a DOCUMENT library.
 *
 * Memory files are a mixed bag: some are genuine documents an agent keeps
 * (notes, specs, a running log), and some are machine state that happens to be
 * stored as text. Only the markdown ones are carried, on the same reasoning as
 * the server's extension rule — a library that quietly ingested every file kind
 * on an agent's disk would be a different, worse feature wearing this one's
 * name.
 */
export function isLibraryMemoryFile(file: Pick<AgentMemoryFile, 'path'>): boolean {
  return /\.(md|markdown|mdx|txt)$/i.test(String(file.path || ''));
}

interface AgentIndex {
  byId: Map<string, WorkspaceAgent>;
  connected: Set<string>;
}

function agentRef(index: AgentIndex, agentId: string): LibraryAgentRef | null {
  const agent = index.byId.get(String(agentId));
  if (!agent) return null;
  return {
    id: String(agent.id),
    name: agent.name,
    handle: String(agent.handle || ''),
    initials: libraryAgentInitials(agent),
    color: agentAccentColor(agent),
    connected: index.connected.has(String(agent.id)),
  };
}

/** The rows a library build reads. Every list is optional and defaults to []. */
export interface LibraryInput {
  documents?: readonly Document[];
  agentDocuments?: readonly AgentDocument[];
  memoryFiles?: readonly AgentMemoryFile[];
  skillDocuments?: readonly LibrarySkillDocumentRef[];
  agents?: readonly WorkspaceAgent[];
  /** Agent ids with a live daemon attached. */
  connectedAgentIds?: readonly string[];
}

/**
 * The bit of an agent_skill_documents row the library needs.
 *
 * Deliberately not the wire row: that table is not readable through the generic
 * database path (it is absent from ALLOWED_TABLES on purpose), so its metadata
 * reaches the browser through the skills surfaces. A narrow input keeps this
 * builder independent of whichever of those a caller happens to have.
 */
export interface LibrarySkillDocumentRef {
  id: string;
  agent_id: string;
  skill: string;
  path?: string | null;
  summary?: string | null;
  byte_size?: number | null;
  updated_at?: string | null;
  last_synced?: string | null;
}

/**
 * Collate every contributing table into one deduped, grouped library.
 *
 * An agent that is not in `agents` contributes NOTHING — not an anonymous
 * source. A document whose provenance cannot be named is a document a reader
 * cannot judge, and the library's whole claim is that you can see where each
 * copy came from.
 */
export function buildDocumentLibrary(input: LibraryInput): LibraryEntry[] {
  const agents = input.agents || [];
  const index: AgentIndex = {
    byId: new Map(agents.map(agent => [String(agent.id), agent])),
    connected: new Set((input.connectedAgentIds || []).map(id => String(id))),
  };

  const sourcesByKey = new Map<string, LibrarySource[]>();
  const domainByKey = new Map<string, string>();

  const push = (key: string, domain: string, source: LibrarySource) => {
    const existing = sourcesByKey.get(key);
    if (existing) existing.push(source);
    else sourcesByKey.set(key, [source]);
    // FIRST non-default domain wins, and the traversal order below puts
    // workspace documents first on purpose: if somebody filed a document under
    // a folder in this app, that is a decision a person made about where it
    // belongs, and a daemon's path-derived guess should not overrule it.
    const current = domainByKey.get(key);
    if (!current || current === DEFAULT_DOMAIN) domainByKey.set(key, domain);
  };

  for (const doc of input.documents || []) {
    const key = documentIdentityKey({ title: doc.title });
    push(key, resolveDomain(doc.folder), {
      id: `workspace:${doc.id}`,
      kind: 'workspace',
      rowId: String(doc.id),
      agent: null,
      path: '',
      title: doc.title || 'Untitled',
      summary: '',
      byteSize: typeof doc.content === 'string' ? doc.content.length : 0,
      contentHash: '',
      modifiedAt: timestamp(doc.updated_at, doc.created_at),
      truncated: false,
    });
  }

  for (const doc of input.agentDocuments || []) {
    const agent = agentRef(index, doc.agent_id);
    if (!agent) continue;
    const key = documentIdentityKey({ path: doc.path, title: doc.title });
    push(key, resolveDomain(doc.domain, firstDirectory(doc.path)), {
      id: `agent-document:${doc.id}`,
      kind: 'agent-document',
      rowId: String(doc.id),
      agent,
      path: doc.path,
      title: doc.title || doc.path,
      summary: doc.summary || '',
      byteSize: Number(doc.byte_size || 0),
      contentHash: String(doc.content_hash || ''),
      modifiedAt: timestamp(doc.source_modified_at, doc.last_synced, doc.updated_at),
      truncated: doc.truncated === true,
    });
  }

  for (const file of input.memoryFiles || []) {
    if (!isLibraryMemoryFile(file)) continue;
    const agent = agentRef(index, file.agent_id);
    if (!agent) continue;
    const key = documentIdentityKey({ path: file.path });
    push(key, resolveDomain(firstDirectory(file.path)), {
      id: `agent-memory:${file.id}`,
      kind: 'agent-memory',
      rowId: String(file.id),
      agent,
      path: file.path,
      title: file.path,
      summary: file.summary || '',
      byteSize: Number(file.byte_size || 0),
      contentHash: '',
      modifiedAt: timestamp(file.last_synced, file.updated_at),
      truncated: false,
    });
  }

  for (const doc of input.skillDocuments || []) {
    const agent = agentRef(index, doc.agent_id);
    if (!agent) continue;
    const key = documentIdentityKey({ path: doc.path || '', title: doc.skill });
    push(key, resolveDomain(firstDirectory(String(doc.path || '')), 'Skills'), {
      id: `agent-skill:${doc.id}`,
      kind: 'agent-skill',
      rowId: String(doc.id),
      agent,
      path: String(doc.path || ''),
      title: doc.skill,
      summary: doc.summary || '',
      byteSize: Number(doc.byte_size || 0),
      contentHash: '',
      modifiedAt: timestamp(doc.last_synced, doc.updated_at),
      truncated: false,
    });
  }

  const entries: LibraryEntry[] = [];
  for (const [key, sources] of sourcesByKey) {
    const ranked = [...sources].sort(compareSources);
    const primary = ranked[0];
    const hashes = new Set(ranked.map(source => source.contentHash));
    entries.push({
      key,
      // The PRIMARY's title, not the first one seen: the title shown next to a
      // body has to be the title of the body being shown.
      title: primary.title,
      domain: domainByKey.get(key) || DEFAULT_DOMAIN,
      sources: ranked,
      primary,
      alternates: ranked.slice(1),
      identical: ranked.length > 1 && hashes.size === 1 && !hashes.has(''),
      agentCount: new Set(ranked.map(source => source.agent?.id).filter(Boolean)).size,
    });
  }

  return entries.sort((left, right) => left.title.localeCompare(right.title));
}

/**
 * Newest first, workspace winning a tie. See LibraryEntry.primary.
 *
 * The final tiebreak is the source id, so a rebuild with identical inputs
 * produces an identical order — an unstable sort here would reshuffle the
 * sidebar on every realtime tick.
 */
function compareSources(left: LibrarySource, right: LibrarySource): number {
  if (right.modifiedAt !== left.modifiedAt) return right.modifiedAt - left.modifiedAt;
  const leftWorkspace = left.kind === 'workspace' ? 0 : 1;
  const rightWorkspace = right.kind === 'workspace' ? 0 : 1;
  if (leftWorkspace !== rightWorkspace) return leftWorkspace - rightWorkspace;
  return left.id.localeCompare(right.id);
}

// ---------------------------------------------------------------------------
// Views over the library
// ---------------------------------------------------------------------------

/** Group by domain, folders alphabetical, DEFAULT_DOMAIN last. */
export function groupLibraryByDomain(entries: readonly LibraryEntry[]): LibraryDomainGroup[] {
  const byDomain = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    const list = byDomain.get(entry.domain);
    if (list) list.push(entry);
    else byDomain.set(entry.domain, [entry]);
  }
  return [...byDomain.entries()]
    .map(([domain, list]) => ({ domain, entries: list }))
    .sort((left, right) => {
      // General is where everything unfiled lands, so it is the least
      // informative heading and belongs at the bottom rather than under G.
      if (left.domain === DEFAULT_DOMAIN) return 1;
      if (right.domain === DEFAULT_DOMAIN) return -1;
      return left.domain.localeCompare(right.domain);
    });
}

/** Case-insensitive match on the title, any path, or any contributing agent. */
export function filterLibrary(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(entry =>
    entry.title.toLowerCase().includes(q)
    || entry.domain.toLowerCase().includes(q)
    || entry.sources.some(source =>
      source.path.toLowerCase().includes(q)
      || (source.agent?.name || '').toLowerCase().includes(q)),
  );
}

/** Only documents that more than one place contributes. */
export function multiSourceEntries(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return entries.filter(entry => entry.sources.length > 1);
}

/**
 * How a source disagrees with the primary, before either body is fetched.
 *
 * Cheap and honest: equal non-empty hashes mean identical, unequal non-empty
 * hashes mean different, and anything else is UNKNOWN. The compare view can
 * fetch both bodies and diff them; this is what the LIST can say without doing
 * that for every row.
 */
export type SourceAgreement = 'identical' | 'different' | 'unknown';

export function compareToPrimary(entry: LibraryEntry, source: LibrarySource): SourceAgreement {
  if (source.id === entry.primary.id) return 'identical';
  const a = entry.primary.contentHash;
  const b = source.contentHash;
  if (!a || !b) return 'unknown';
  return a === b ? 'identical' : 'different';
}

/** Human phrasing for a source row, e.g. "Scout · docs/setup.md · 4 KB". */
export function describeSource(source: LibrarySource): string {
  const parts: string[] = [];
  parts.push(source.agent ? source.agent.name : 'This workspace');
  if (source.path) parts.push(source.path);
  if (source.byteSize > 0) parts.push(formatLibraryBytes(source.byteSize));
  return parts.join(' · ');
}

export function formatLibraryBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A selection that no longer exists must not hold the detail pane open.
 *
 * A daemon disconnecting or a document being deleted can remove the entry under
 * a selected row, and a stale selection leaves a pane describing something that
 * is gone. Same rule, same reason as selectionStillExists in skillsView.ts.
 */
export function librarySelectionStillExists(key: string | null, entries: readonly LibraryEntry[]): boolean {
  if (!key) return false;
  return entries.some(entry => entry.key === key);
}

/**
 * Below this the two panes cannot both hold a readable column, so the detail
 * takes the whole surface with a back affordance. Same number the skills and
 * memory browsers use — it is the same interaction, and three browse surfaces
 * that break at different widths feel like three different apps.
 */
export const LIBRARY_SPLIT_MIN_WIDTH = 960;
