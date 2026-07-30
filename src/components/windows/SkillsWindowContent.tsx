import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Search, ChevronLeft, FileText, FolderTree, Info, Pencil, Plus, Radio, Trash2, X } from 'lucide-react';
import type { WorkspaceAgent, AgentConnection } from '../../types';
import type { SystemCapabilities } from '../../lib/backendClient';
import {
  buildLibraryEntries,
  buildSkillEntries,
  filterLibraries,
  filterSkills,
  isSelected,
  selectionStillExists,
  SKILLS_SPLIT_MIN_WIDTH,
  toggleSkillsSelection,
  type LibraryEntry,
  type SkillAgentRef,
  type SkillEntry,
  type SkillsSelection,
} from '../../lib/skillsView';
import {
  SKILL_CONTENT_MAX_BYTES,
  describeSkillSource,
  describeSkillUnavailable,
  fetchSkillContent,
  fetchSkillLibrary,
  fetchSkillLibraryEntry,
  formatSkillBytes,
  type SkillContentResult,
  type SkillLibraryListing,
} from '../../lib/skillContent';
import { useWorkspaceSkills } from '../../hooks/useWorkspaceSkills';
import { describeSkillProvenance, type WorkspaceSkillDraft } from '../../lib/workspaceSkills';
import { WorkspaceSkillEditor } from './WorkspaceSkillEditor';
import { MarkdownContent } from '../chat/MarkdownContent';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

// One agent on a skill row. Initials on the agent's own accent colour — the
// Slack-style identity the workspace tiles and agent avatars already use, and
// never an emoji.
//
// The advertised/configured distinction is FILL vs OUTLINE, because it is the
// answer to "which agents can actually use this": a filled chip is a live
// daemon that reported the skill itself, an outlined one is a claim on a
// profile that nothing has confirmed. Same information the connected dot in the
// detail pane carries, at list level where the comparison happens.
function AgentChip({ agent, onOpen }: { agent: SkillAgentRef; onOpen: () => void }) {
  const advertised = agent.source === 'advertised';
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={event => { event.stopPropagation(); onOpen(); }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      title={advertised
        ? `${agent.name} advertises this skill from a connected machine`
        : `${agent.name} has this skill configured — nothing is connected to confirm it`}
      className={`inline-flex max-w-[11rem] items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] transition-colors ${
        advertised
          ? 'bg-muted text-foreground hover:bg-muted/70'
          : 'border border-dashed border-border text-muted-foreground hover:bg-muted/40'
      }`}
    >
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white ${advertised ? '' : 'opacity-60'}`}
        style={{ backgroundColor: agent.color }}
        aria-hidden="true"
      >
        {agent.initials}
      </span>
      <span className="truncate">{agent.name}</span>
    </span>
  );
}

interface SkillsWindowContentProps {
  agents: WorkspaceAgent[];
  agentConnections: AgentConnection[];
  systemCapabilities: SystemCapabilities | null;
  workspaceId: string;
}

// Consolidated skills view: every skill any agent exposes, grouped by skill name
// with the agents that have it. Skills come from the live daemon connection
// (`capabilities.skills`, auto-refreshed via realtime + poll) with the agent's
// manually-configured `skills` as a fallback. Read-only browse surface, distinct
// from the composer `/` menu (which inserts) and per-agent profiles.
//
// Master-detail, matching the agent memory browser (AgentMemoryBrowser): above
// SKILLS_SPLIT_MIN_WIDTH the selection opens beside the list; below it the
// detail takes the whole surface with a back arrow. Same threshold and the same
// column width on purpose — it is the same interaction, and two browse surfaces
// that break at different points feel like two different apps.
//
// The preview shows the skill's REAL text wherever agensis has it — a sandbox
// skill definition, a body a daemon mirrored up, a file in a library on the
// backend host. Where it has none it says so and says why (see
// describeSkillUnavailable): most skill names in this list are names a machine
// reported, and inventing a plausible body for one would be worse than the
// empty state.
export function SkillsWindowContent({ agents, agentConnections, systemCapabilities, workspaceId }: SkillsWindowContentProps) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<SkillsSelection>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setWide(entry.contentRect.width >= SKILLS_SPLIT_MIN_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The app-side skill store. `unavailable` means the backend has not shipped
  // these routes yet — the frontend deploys ahead of Fly in this repo — and in
  // that case the page renders exactly as it did before, with no authoring
  // affordance offered against a server that would refuse it.
  const store = useWorkspaceSkills(workspaceId || null);
  /** null = closed; { skillId: '' } = authoring a new one. */
  const [editing, setEditing] = useState<{ skillId: string } | null>(null);

  const storedRefs = useMemo(
    () => store.skills.map(skill => ({ id: skill.id, name: skill.name, summary: skill.summary })),
    [store.skills],
  );
  const skillEntries = useMemo(
    () => buildSkillEntries(agents, agentConnections, undefined, storedRefs),
    [agents, agentConnections, storedRefs],
  );
  const libraries = useMemo(() => buildLibraryEntries(systemCapabilities), [systemCapabilities]);

  // A daemon disconnecting can take a skill out from under the open pane. Drop a
  // selection that no longer resolves rather than describing something gone.
  useEffect(() => {
    if (selection && !selectionStillExists(selection, skillEntries, libraries)) setSelection(null);
  }, [selection, skillEntries, libraries]);

  const filteredSkills = useMemo(() => filterSkills(skillEntries, query), [skillEntries, query]);
  const filteredLibraries = useMemo(() => filterLibraries(libraries, query), [libraries, query]);

  const selectedSkill: SkillEntry | null = selection?.kind === 'skill'
    ? skillEntries.find(s => s.name === selection.name) ?? null
    : null;
  const selectedLibrary: LibraryEntry | null = selection?.kind === 'library'
    ? libraries.find(l => l.id === selection.id) ?? null
    : null;
  const hasDetail = !!(selectedSkill || selectedLibrary);

  // The body for whatever is open. Loaded on selection rather than up front —
  // a skill document is large, most are never opened, and the list itself needs
  // no content at all to render.
  const [content, setContent] = useState<SkillContentResult | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [listing, setListing] = useState<SkillLibraryListing | null>(null);
  const [openEntry, setOpenEntry] = useState('');
  // Bumped after a store write so the open pane refetches. Writing a skill and
  // seeing the previous body is indistinguishable from the write having failed.
  const [contentReloads, setContentReloads] = useState(0);

  const selectedSkillName = selectedSkill?.name ?? '';
  const selectedLibraryId = selectedLibrary?.id ?? '';

  // One loader for all three fetches, so the "a slow response must not land on a
  // selection the user has already moved off" guard exists once instead of three
  // times. `cancelled` is checked before EVERY setState, including the loading
  // flag — an early return that leaves the spinner on is the version of this bug
  // that looks like a hang.
  const load = useCallback((run: () => Promise<SkillContentResult>) => {
    let cancelled = false;
    setContentLoading(true);
    setContent(null);
    void run().then(result => {
      if (cancelled) return;
      setContent(result);
      setContentLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedSkillName || !workspaceId) { setContent(null); setContentLoading(false); return; }
    return load(() => fetchSkillContent(workspaceId, selectedSkillName));
  }, [selectedSkillName, workspaceId, load, contentReloads]);

  // Opening a library lists its entries; the body arrives only once one is
  // picked. Changing library drops the open entry — keeping it would ask the
  // next library for a file that belongs to the previous one.
  useEffect(() => {
    setOpenEntry('');
    if (!selectedLibraryId || !workspaceId) { setListing(null); return; }
    let cancelled = false;
    void fetchSkillLibrary(workspaceId, selectedLibraryId).then(result => {
      if (!cancelled) setListing(result);
    });
    return () => { cancelled = true; };
  }, [selectedLibraryId, workspaceId]);

  useEffect(() => {
    if (!selectedLibraryId || !openEntry || !workspaceId) return;
    return load(() => fetchSkillLibraryEntry(workspaceId, selectedLibraryId, openEntry));
  }, [selectedLibraryId, openEntry, workspaceId, load]);

  const totalSkills = skillEntries.length;
  const totalLibraryEntries = libraries.reduce((sum, l) => sum + l.count, 0);
  const isEmpty = totalSkills === 0 && libraries.length === 0;
  const canAuthor = !store.unavailable;

  const selectedStored = selectedSkill?.stored
    ? store.skills.find(s => s.name.toLowerCase() === selectedSkill.name.toLowerCase()) ?? null
    : null;
  const editingSkill = editing
    ? store.skills.find(s => s.id === editing.skillId) ?? null
    : null;

  const saveDraft = async (draft: WorkspaceSkillDraft) => {
    const result = editing?.skillId
      ? await store.updateSkill(editing.skillId, draft)
      : await store.createSkill(draft);
    if (result.error) return { error: result.error };
    setEditing(null);
    // Reopen on the saved skill so the pane shows the body that was just
    // written, rather than leaving the user on a stale one and making the save
    // look like it did nothing.
    if (result.skill) setSelection({ kind: 'skill', name: result.skill.name });
    setContentReloads(n => n + 1);
    return { error: '' };
  };

  const removeStored = async (skillId: string, name: string) => {
    if (!window.confirm(`Delete the skill "${name}"? Agents will stop being able to read it.`)) return;
    const ok = await store.deleteSkill(skillId);
    if (ok) setContentReloads(n => n + 1);
  };

  if (editing) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
          <Sparkles className="size-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {editingSkill ? `Edit ${editingSkill.name}` : 'New skill'}
          </p>
        </div>
        <WorkspaceSkillEditor
          skill={editingSkill}
          existingNames={store.skills.map(s => s.name)}
          onCancel={() => setEditing(null)}
          onSave={saveDraft}
        />
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
            <EmptyTitle>No skills yet</EmptyTitle>
            <EmptyDescription>
              Skills appear here once your agents advertise them or a connected daemon enumerates its skill libraries.
              {canAuthor && ' You can also write one here — any agent can read it, connected or not.'}
            </EmptyDescription>
          </EmptyHeader>
          {canAuthor && (
            <Button type="button" size="sm" className="mt-3" onClick={() => setEditing({ skillId: '' })}>
              <Plus className="size-3.5" />
              Write a skill
            </Button>
          )}
        </Empty>
      </div>
    );
  }

  const select = (next: NonNullable<SkillsSelection>) => setSelection(prev => toggleSkillsSelection(prev, next));

  const renderList = (compact: boolean) => (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search skills or agents…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        {!compact && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {totalSkills} skill{totalSkills === 1 ? '' : 's'}
            {totalLibraryEntries > 0 ? ` · ${totalLibraryEntries} in libraries` : ''}
          </span>
        )}
        {canAuthor && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            onClick={() => setEditing({ skillId: '' })}
            aria-label="Write a skill"
            title="Write a skill"
          >
            <Plus className="size-4" />
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {filteredSkills.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent skills</h3>
              <div className="space-y-1.5">
                {filteredSkills.map(skill => {
                  const active = isSelected(selection, { kind: 'skill', name: skill.name });
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => select({ kind: 'skill', name: skill.name })}
                      aria-pressed={active}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-card/40 hover:bg-card/70'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className="size-3.5 shrink-0 text-primary" />
                        <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
                        {/* "Written here" is the one fact about a row that the
                            chips cannot carry: it means the PROCEDURE exists in
                            agensis, readable by every agent, rather than the
                            name merely being claimed by one. */}
                        {skill.stored && (
                          <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">written here</Badge>
                        )}
                        {skill.agents.length > 0 && (
                          <Badge variant="secondary" className={`shrink-0 ${skill.stored ? '' : 'ml-auto'}`}>{skill.agents.length}</Badge>
                        )}
                      </div>
                      {skill.summary && (
                        <p className="mt-1 line-clamp-2 pl-5.5 text-[11px] leading-snug text-muted-foreground">{skill.summary}</p>
                      )}
                      {/* The chips ARE the answer to "which agents can do this",
                          so they stay in the narrow column too — the earlier
                          version dropped them beside a detail pane, which is
                          exactly when you are comparing skills and need them. */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-5.5">
                        {skill.agents.map(agent => (
                          <AgentChip key={`${agent.id}:${agent.source}`} agent={agent} onOpen={() => setQuery(agent.name)} />
                        ))}
                        {skill.agents.length === 0 && (
                          <span className="text-[11px] text-muted-foreground">
                            {skill.stored
                              ? 'Readable by any agent · no agent lists it yet'
                              : 'Available in agensis · no agent has it yet'}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {filteredLibraries.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skill libraries</h3>
              <div className="space-y-1.5">
                {filteredLibraries.map(lib => {
                  const active = isSelected(selection, { kind: 'library', id: lib.id });
                  return (
                    <button
                      key={lib.id}
                      type="button"
                      onClick={() => select({ kind: 'library', id: lib.id })}
                      aria-pressed={active}
                      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-card/40 hover:bg-card/70'
                      }`}
                    >
                      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{lib.label}</div>
                        {lib.path && <div className="truncate text-[11px] text-muted-foreground">{lib.path}</div>}
                      </div>
                      <Badge variant="secondary" className="shrink-0">{lib.count}</Badge>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {filteredSkills.length === 0 && filteredLibraries.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No skills or libraries match “{query}”.</div>
          )}
        </div>
      </ScrollArea>
    </>
  );

  // The body, a spinner, or a named reason there is none. Untrusted text: it is
  // a file from somebody's machine or an agent-authored definition, so it goes
  // through MarkdownContent, which builds elements and never touches innerHTML.
  const renderContentBlock = (name: string) => {
    if (contentLoading) {
      return (
        <div className="space-y-2" aria-busy="true">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
        </div>
      );
    }
    if (!content) return null;
    if (!content.available) {
      const { title, detail } = describeSkillUnavailable(content.reason, { name });
      return (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Info className="size-3.5 shrink-0 text-muted-foreground" />
            {title}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {describeSkillSource(content)}
          {content.byteSize > 0 && ` · ${formatSkillBytes(content.byteSize)}`}
        </p>
        {content.path && <p className="break-all font-mono text-[11px] text-muted-foreground">{content.path}</p>}
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <MarkdownContent content={content.markdown} compact />
        </div>
        {content.truncated && (
          <p className="text-xs text-muted-foreground">
            Shown up to {formatSkillBytes(SKILL_CONTENT_MAX_BYTES)} — the file is longer than that on disk.
          </p>
        )}
      </div>
    );
  };

  // The preview. Content first, because content is what the pane is for; the
  // provenance and the agent list are below it as supporting detail.
  const renderDetail = (showBack: boolean) => {
    if (!hasDetail) return null;
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
          {showBack && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSelection(null)} aria-label="Back to skills">
              <ChevronLeft className="size-4" />
            </Button>
          )}
          {selectedSkill
            ? <Sparkles className="size-4 shrink-0 text-primary" />
            : <FolderTree className="size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{selectedSkill?.name ?? selectedLibrary?.label}</p>
            <p className="truncate text-xs text-muted-foreground">
              {selectedSkill
                ? `${selectedSkill.agents.length} agent${selectedSkill.agents.length === 1 ? '' : 's'}`
                : selectedLibrary?.path}
            </p>
          </div>
          {!showBack && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSelection(null)} aria-label="Close preview">
              <X className="size-4" />
            </Button>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            {selectedSkill && (
              <>
                {/* A stored body exists but something with more authority won the
                    precedence race (resolveSkillContent). Said out loud, because
                    silently showing the other body is how somebody edits a skill
                    for an hour and never sees their change. */}
                {content?.available && content.shadowsWorkspaceSkill && (
                  <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-foreground">
                    <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                    <span>
                      A skill with this name is also written here, but the body above wins —
                      {content.source === 'daemon'
                        ? ' a machine has a real file by the same name, and that file is what an agent running there loads.'
                        : ' an agensis skill definition by the same name governs a credentialed call, so its text is the one that matters.'}
                      {' '}Rename one of them if they are meant to be different skills.
                    </span>
                  </p>
                )}

                <div>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skill content</h4>
                  {renderContentBlock(selectedSkill.name)}
                </div>

                {selectedStored && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {describeSkillProvenance(selectedStored.source)}
                      {selectedStored.revision > 1 && ` · revision ${selectedStored.revision}`}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 gap-1 px-2 text-xs"
                      onClick={() => setEditing({ skillId: selectedStored.id })}
                    >
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={() => void removeStored(selectedStored.id, selectedStored.name)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                  </div>
                )}

                {/* A name nothing can supply a body for is exactly what this
                    store exists to fix, so the offer to write one belongs here
                    rather than only in the header. */}
                {canAuthor && !selectedSkill.stored && content && !content.available && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => setEditing({ skillId: '' })}
                  >
                    <Plus className="size-3.5" />
                    Write this skill here
                  </Button>
                )}

                <div>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where this comes from</h4>
                  {/* ORDER MATTERS, and `stored` comes before the advertised /
                      configured split rather than after it. A skill written here
                      that an agent ALSO lists used to fall through to
                      "nothing is connected to confirm it" — which is exactly
                      backwards: the procedure is right here, and being confirmed
                      by a machine is not what makes it readable. */}
                  {selectedSkill.stored ? (
                    <p className="text-sm text-muted-foreground">
                      Written in this workspace, so any agent can read it with <code className="font-mono text-xs">read_skill</code> whether or not a machine is connected.
                      {selectedSkill.advertised
                        ? ' A connected daemon also advertises this name from its own machine.'
                        : selectedSkill.agents.length > 0
                          ? ' Listing it on an agent only makes the agent advertise it; reading it never required that.'
                          : ' No agent lists it yet, which does not stop any of them reading it.'}
                    </p>
                  ) : selectedSkill.advertised ? (
                    <p className="flex items-start gap-2 text-sm text-foreground">
                      <Radio className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                      <span>A connected daemon advertised this skill itself, so a machine really has it.</span>
                    </p>
                  ) : selectedSkill.origin === 'catalog' ? (
                    <p className="text-sm text-muted-foreground">
                      A skill agensis ships. No agent in this workspace carries it yet — add its id to an agent&apos;s skills to give the agent its instructions.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Configured on the agent, not advertised by a live connection. Nothing is connected to confirm it.
                    </p>
                  )}
                </div>

                {selectedSkill.agents.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agents with this skill</h4>
                    <div className="space-y-1.5">
                      {selectedSkill.agents.map(agent => (
                        <div key={`${agent.id}:${agent.source}`} className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5">
                          <span
                            className="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white"
                            style={{ backgroundColor: agent.color }}
                            aria-hidden="true"
                          >
                            {agent.initials}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-foreground">{agent.name}</div>
                            {agent.handle && <div className="truncate text-[11px] text-muted-foreground">@{agent.handle}</div>}
                          </div>
                          <Badge variant={agent.source === 'advertised' ? 'secondary' : 'outline'} className="shrink-0 text-[11px]">
                            {agent.source === 'advertised' ? 'advertised' : 'configured'}
                          </Badge>
                          <Badge variant="outline" className="shrink-0 text-[11px]">{agent.runMode}</Badge>
                          {agent.connected && (
                            <span className="size-2 shrink-0 rounded-full bg-emerald-500" title="Connected" aria-label="Connected" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {selectedLibrary && (openEntry ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-7 gap-1 px-2 text-xs"
                  onClick={() => setOpenEntry('')}
                >
                  <ChevronLeft className="size-3.5" />
                  All entries
                </Button>
                <div>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{openEntry}</h4>
                  {renderContentBlock(openEntry)}
                </div>
              </>
            ) : (
              <>
                <div>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Location</h4>
                  <p className="break-all font-mono text-xs text-foreground">{selectedLibrary.path || '(no path reported)'}</p>
                </div>
                <div className="flex gap-6">
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Entries</h4>
                    <p className="text-sm text-foreground">{selectedLibrary.count}</p>
                  </div>
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Type</h4>
                    <p className="text-sm text-foreground">{selectedLibrary.type}</p>
                  </div>
                </div>

                {listing?.available && listing.entries.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open one</h4>
                    <div className="space-y-1">
                      {listing.entries.map(entry => (
                        <button
                          key={entry.entry}
                          type="button"
                          onClick={() => setOpenEntry(entry.entry)}
                          className="flex w-full items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-left transition-colors hover:bg-card/70"
                        >
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm text-foreground">{entry.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {listing && listing.available === false && (
                  <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Info className="size-3.5 shrink-0 text-muted-foreground" />
                      {describeSkillUnavailable(listing.reason ?? 'not-found', { name: selectedLibrary.label }).title}
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      {describeSkillUnavailable(listing.reason ?? 'not-found', { name: selectedLibrary.label }).detail}
                    </p>
                  </div>
                )}

                {/* This library was found by scanning the machine the agensis
                    backend runs on — NOT by asking a daemon. On the hosted app
                    that is a Fly container; run the backend yourself and it is
                    your own machine. The pane used to claim a daemon reported
                    it, which sent anyone debugging an empty list to the wrong
                    place entirely. */}
                <p className="text-xs text-muted-foreground">
                  Found on the machine running the agensis backend.
                </p>
              </>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  };

  const showFullDetail = hasDetail && !wide;
  const showSplitDetail = hasDetail && wide;

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden">
      {showFullDetail ? (
        renderDetail(true)
      ) : (
        <>
          <div
            className={
              showSplitDetail
                ? 'flex w-[340px] shrink-0 flex-col overflow-hidden border-r border-border'
                : 'flex min-w-0 flex-1 flex-col overflow-hidden'
            }
          >
            {renderList(showSplitDetail)}
          </div>
          {showSplitDetail && renderDetail(false)}
        </>
      )}
    </div>
  );
}
