import { describe, expect, it } from 'vitest';
import type { AgentDocument, AgentMemoryFile, Document, WorkspaceAgent } from '../../src/types';
import {
  DEFAULT_DOMAIN,
  buildDocumentLibrary,
  compareToPrimary,
  describeSource,
  documentIdentityKey,
  filterLibrary,
  formatLibraryBytes,
  groupLibraryByDomain,
  isLibraryMemoryFile,
  libraryAgentInitials,
  librarySelectionStillExists,
  multiSourceEntries,
} from '../../src/lib/documentLibrary';

// The collation is where this feature is right or wrong. Everything the Library
// window and the sidebar render is a projection of buildDocumentLibrary, so the
// interesting failures are all in here: two copies of one README that do not
// collate, a "latest" that picks the daemon that reconnected rather than the
// file that changed, and an "identical" badge asserted on missing evidence.

function agent(id: string, name: string, extra: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id,
    workspace_id: 'ws-1',
    name,
    avatar: 'AI',
    description: '',
    system_prompt: '',
    model: 'auto',
    created_by: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...extra,
  } as WorkspaceAgent;
}

function agentDoc(overrides: Partial<AgentDocument> & Pick<AgentDocument, 'id' | 'agent_id' | 'path'>): AgentDocument {
  return {
    workspace_id: 'ws-1',
    title: '',
    domain: '',
    summary: '',
    byte_size: 100,
    truncated: false,
    content_hash: '',
    source_modified_at: null,
    last_synced: '2026-08-01T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  } as AgentDocument;
}

function workspaceDoc(overrides: Partial<Document> & Pick<Document, 'id' | 'title'>): Document {
  return {
    workspace_id: 'ws-1',
    is_favorite: false,
    folder: 'General',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  } as Document;
}

const SCOUT = agent('a-1', 'Scout');
const CODER = agent('a-2', 'Coder');

describe('documentIdentityKey', () => {
  it('collates the same filename across different directories', () => {
    // Two checkouts of one repo, seen from different working directories. This
    // is THE case the library exists for — a key that included the directory
    // would present them as two documents and hide the disagreement.
    expect(documentIdentityKey({ path: 'docs/architecture.md' }))
      .toBe(documentIdentityKey({ path: '/srv/checkouts/repo/docs/architecture.md' }));
    expect(documentIdentityKey({ path: 'setup.md' }))
      .toBe(documentIdentityKey({ path: 'docs/setup.md' }));
  });

  it('ignores case, extension and separators', () => {
    expect(documentIdentityKey({ path: 'README.md' })).toBe(documentIdentityKey({ path: 'readme.markdown' }));
    expect(documentIdentityKey({ path: 'docs\\api\\Auth Guide.md' })).toBe('auth-guide');
  });

  it('falls back to the title when there is no path', () => {
    // A workspace document has no path at all, so title is the ONLY way it can
    // join a same-named file on an agent's disk.
    expect(documentIdentityKey({ title: 'Architecture' })).toBe('architecture');
    expect(documentIdentityKey({ path: '', title: 'Architecture' }))
      .toBe(documentIdentityKey({ path: 'ARCHITECTURE.md' }));
  });

  it('never returns an empty key', () => {
    // An empty key would collapse every unnameable document into one row.
    expect(documentIdentityKey({})).toBe('untitled');
    expect(documentIdentityKey({ path: '///', title: '!!!' })).toBe('untitled');
  });
});

describe('buildDocumentLibrary', () => {
  it('makes one entry from copies held by several agents', () => {
    const entries = buildDocumentLibrary({
      agentDocuments: [
        agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'docs/setup.md', title: 'Setup' }),
        agentDoc({ id: 'd-2', agent_id: 'a-2', path: 'setup.md', title: 'Setup' }),
      ],
      agents: [SCOUT, CODER],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].sources).toHaveLength(2);
    expect(entries[0].agentCount).toBe(2);
    expect(entries[0].sources.map(source => source.agent?.name).sort()).toEqual(['Coder', 'Scout']);
  });

  it('ranks the primary by the FILE time, not the sync time', () => {
    // MUTATION: rank on last_synced. Then whichever daemon reconnected most
    // recently wins, and "latest" silently means "most recently rebooted".
    const entries = buildDocumentLibrary({
      agentDocuments: [
        agentDoc({
          id: 'd-old', agent_id: 'a-1', path: 'README.md',
          source_modified_at: '2026-07-01T00:00:00Z', last_synced: '2026-08-03T00:00:00Z',
        }),
        agentDoc({
          id: 'd-new', agent_id: 'a-2', path: 'README.md',
          source_modified_at: '2026-08-02T00:00:00Z', last_synced: '2026-08-01T00:00:00Z',
        }),
      ],
      agents: [SCOUT, CODER],
    });
    expect(entries[0].primary.rowId).toBe('d-new');
    expect(entries[0].alternates.map(source => source.rowId)).toEqual(['d-old']);
  });

  it('gives a workspace document the tie', () => {
    const stamp = '2026-08-02T00:00:00Z';
    const entries = buildDocumentLibrary({
      documents: [workspaceDoc({ id: 'w-1', title: 'Runbook', updated_at: stamp })],
      agentDocuments: [agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'runbook.md', source_modified_at: stamp })],
      agents: [SCOUT],
    });
    expect(entries[0].primary.kind).toBe('workspace');
  });

  it('calls copies identical only when every hash agrees and is known', () => {
    const same = buildDocumentLibrary({
      agentDocuments: [
        agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'a.md', content_hash: 'abc' }),
        agentDoc({ id: 'd-2', agent_id: 'a-2', path: 'a.md', content_hash: 'abc' }),
      ],
      agents: [SCOUT, CODER],
    });
    expect(same[0].identical).toBe(true);

    const differs = buildDocumentLibrary({
      agentDocuments: [
        agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'a.md', content_hash: 'abc' }),
        agentDoc({ id: 'd-2', agent_id: 'a-2', path: 'a.md', content_hash: 'zzz' }),
      ],
      agents: [SCOUT, CODER],
    });
    expect(differs[0].identical).toBe(false);

    // MUTATION: treat an unknown hash as agreement. "Identical" would then be
    // asserted on no evidence at all, which is the one answer a compare view
    // must never give.
    const unknown = buildDocumentLibrary({
      agentDocuments: [
        agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'a.md', content_hash: '' }),
        agentDoc({ id: 'd-2', agent_id: 'a-2', path: 'a.md', content_hash: '' }),
      ],
      agents: [SCOUT, CODER],
    });
    expect(unknown[0].identical).toBe(false);
  });

  it('drops sources whose agent is not in the roster', () => {
    // A document whose provenance cannot be named is one a reader cannot judge,
    // and the library's whole claim is that you can see where each copy is from.
    const entries = buildDocumentLibrary({
      agentDocuments: [agentDoc({ id: 'd-1', agent_id: 'ghost', path: 'a.md' })],
      agents: [SCOUT],
    });
    expect(entries).toHaveLength(0);
  });

  it('carries only markdown out of the memory palace', () => {
    const entries = buildDocumentLibrary({
      memoryFiles: [
        { id: 'm-1', agent_id: 'a-1', path: 'notes/plan.md', byte_size: 10 } as AgentMemoryFile,
        { id: 'm-2', agent_id: 'a-1', path: 'state/index.db', byte_size: 10 } as AgentMemoryFile,
      ],
      agents: [SCOUT],
    });
    expect(entries.map(entry => entry.title)).toEqual(['notes/plan.md']);
  });

  it('prefers a folder a person chose over one derived from a path', () => {
    const entries = buildDocumentLibrary({
      documents: [workspaceDoc({ id: 'w-1', title: 'Runbook', folder: 'Work' })],
      agentDocuments: [agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'ops/runbook.md' })],
      agents: [SCOUT],
    });
    expect(entries[0].domain).toBe('Work');
  });

  it('derives a domain from the path when nothing else supplies one', () => {
    const entries = buildDocumentLibrary({
      agentDocuments: [
        agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'docs/api/auth.md' }),
        agentDoc({ id: 'd-2', agent_id: 'a-1', path: 'top.md' }),
      ],
      agents: [SCOUT],
    });
    const byTitle = new Map(entries.map(entry => [entry.key, entry.domain]));
    expect(byTitle.get('auth')).toBe('docs');
    // A file at the root has no directory to name, so it lands in General
    // rather than under an invented heading.
    expect(byTitle.get('top')).toBe(DEFAULT_DOMAIN);
  });

  it('marks a source connected only when its agent has a live daemon', () => {
    const entries = buildDocumentLibrary({
      agentDocuments: [
        agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'a.md' }),
        agentDoc({ id: 'd-2', agent_id: 'a-2', path: 'b.md' }),
      ],
      agents: [SCOUT, CODER],
      connectedAgentIds: ['a-1'],
    });
    const connected = new Map(entries.map(entry => [entry.key, entry.primary.agent?.connected]));
    expect(connected.get('a')).toBe(true);
    expect(connected.get('b')).toBe(false);
  });

  it('produces a stable order for identical input', () => {
    // An unstable sort would reshuffle the sidebar on every realtime tick.
    const input = {
      agentDocuments: [
        agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'a.md', source_modified_at: '2026-08-01T00:00:00Z' }),
        agentDoc({ id: 'd-2', agent_id: 'a-2', path: 'a.md', source_modified_at: '2026-08-01T00:00:00Z' }),
      ],
      agents: [SCOUT, CODER],
    };
    const first = buildDocumentLibrary(input);
    const second = buildDocumentLibrary(input);
    expect(first[0].sources.map(source => source.id)).toEqual(second[0].sources.map(source => source.id));
  });
});

describe('views over the library', () => {
  const entries = buildDocumentLibrary({
    documents: [workspaceDoc({ id: 'w-1', title: 'Runbook', folder: 'Work' })],
    agentDocuments: [
      agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'docs/setup.md', title: 'Setup', content_hash: 'x' }),
      agentDoc({ id: 'd-2', agent_id: 'a-2', path: 'docs/setup.md', title: 'Setup', content_hash: 'y' }),
      agentDoc({ id: 'd-3', agent_id: 'a-1', path: 'loose.md', title: 'Loose' }),
    ],
    agents: [SCOUT, CODER],
  });

  it('sorts General last, because it is the least informative heading', () => {
    const groups = groupLibraryByDomain(entries);
    // 'docs' before 'Work' is locale ordering (d before w), not a bug — what
    // this pins is that General is last regardless of where G would sort.
    expect(groups.map(group => group.domain)).toEqual(['docs', 'Work', DEFAULT_DOMAIN]);
  });

  it('matches on title, folder, path or contributing agent', () => {
    expect(filterLibrary(entries, 'setup').map(entry => entry.title)).toEqual(['Setup']);
    expect(filterLibrary(entries, 'Coder').map(entry => entry.title)).toEqual(['Setup']);
    expect(filterLibrary(entries, 'docs/').map(entry => entry.title)).toEqual(['Setup']);
    expect(filterLibrary(entries, '')).toHaveLength(entries.length);
  });

  it('finds the documents more than one place holds', () => {
    expect(multiSourceEntries(entries).map(entry => entry.title)).toEqual(['Setup']);
  });

  it('answers agreement against the primary honestly', () => {
    const setup = entries.find(entry => entry.title === 'Setup')!;
    expect(compareToPrimary(setup, setup.primary)).toBe('identical');
    expect(compareToPrimary(setup, setup.alternates[0])).toBe('different');

    const loose = entries.find(entry => entry.title === 'Loose')!;
    // Its only source has no hash, so an alternate would be 'unknown' — but it
    // has no alternates, and the primary compares to itself.
    expect(compareToPrimary(loose, loose.primary)).toBe('identical');
  });

  it('drops a selection that no longer resolves', () => {
    expect(librarySelectionStillExists('setup', entries)).toBe(true);
    expect(librarySelectionStillExists('gone', entries)).toBe(false);
    expect(librarySelectionStillExists(null, entries)).toBe(false);
  });
});

describe('presentation helpers', () => {
  it('makes initials from letters and digits only, never an emoji', () => {
    expect(libraryAgentInitials({ name: 'Scout', handle: 'scout' })).toBe('SC');
    expect(libraryAgentInitials({ name: 'Ana Ops', handle: '' })).toBe('AO');
    expect(libraryAgentInitials({ name: '🤖', handle: '_ops' })).toBe('OP');
    expect(libraryAgentInitials({ name: '', handle: '' })).toBe('?');
  });

  it('describes a source by who has it, where, and how big', () => {
    const [entry] = buildDocumentLibrary({
      agentDocuments: [agentDoc({ id: 'd-1', agent_id: 'a-1', path: 'docs/a.md', byte_size: 2048 })],
      agents: [SCOUT],
    });
    expect(describeSource(entry.primary)).toBe('Scout · docs/a.md · 2 KB');
  });

  it('names a workspace source as the workspace', () => {
    const [entry] = buildDocumentLibrary({
      documents: [workspaceDoc({ id: 'w-1', title: 'Runbook' })],
    });
    expect(describeSource(entry.primary)).toBe('This workspace');
  });

  it('formats bytes at each scale', () => {
    expect(formatLibraryBytes(512)).toBe('512 B');
    expect(formatLibraryBytes(2048)).toBe('2 KB');
    expect(formatLibraryBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('recognises the document extensions the mirror carries', () => {
    expect(isLibraryMemoryFile({ path: 'a.md' })).toBe(true);
    // Case-insensitive: a file called README.MD on a Windows checkout is the
    // same document as readme.md on a Mac.
    expect(isLibraryMemoryFile({ path: 'a.MDX' })).toBe(true);
    expect(isLibraryMemoryFile({ path: 'a.txt' })).toBe(true);
    expect(isLibraryMemoryFile({ path: 'a.json' })).toBe(false);
  });
});
