import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Search, Bot, ChevronLeft, FolderTree, Radio, X } from 'lucide-react';
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
  type SkillEntry,
  type SkillsSelection,
} from '../../lib/skillsView';
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

interface SkillsWindowContentProps {
  agents: WorkspaceAgent[];
  agentConnections: AgentConnection[];
  systemCapabilities: SystemCapabilities | null;
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
export function SkillsWindowContent({ agents, agentConnections, systemCapabilities }: SkillsWindowContentProps) {
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

  const skillEntries = useMemo(
    () => buildSkillEntries(agents, agentConnections),
    [agents, agentConnections],
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

  const totalSkills = skillEntries.length;
  const totalLibraryEntries = libraries.reduce((sum, l) => sum + l.count, 0);
  const isEmpty = totalSkills === 0 && libraries.length === 0;

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
            <EmptyTitle>No skills yet</EmptyTitle>
            <EmptyDescription>
              Skills appear here once your agents advertise them or a connected daemon enumerates its skill libraries.
            </EmptyDescription>
          </EmptyHeader>
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
                        <Badge variant="secondary" className="ml-auto shrink-0">{skill.agents.length}</Badge>
                      </div>
                      {/* The agent chips are the row's whole content in the wide
                          list; beside a detail pane they are noise, since the
                          pane lists the same agents with more about each. */}
                      {!compact && (
                        <div className="mt-1.5 flex flex-wrap gap-1 pl-5.5">
                          {skill.agents.map(agent => (
                            <span key={agent.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              <Bot className="size-3" />
                              {agent.name}
                            </span>
                          ))}
                        </div>
                      )}
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

  // The preview. There is no per-skill document to render — a skill here is a
  // NAME a machine or a form claims, not a file we hold — so this shows
  // everything actually known about it rather than inventing a body. The most
  // useful line is the source: whether a connected machine advertised the skill
  // itself, or somebody typed it into the agent's form.
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
                <div>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where this comes from</h4>
                  {selectedSkill.source === 'synced' ? (
                    <p className="flex items-start gap-2 text-sm text-foreground">
                      <Radio className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                      <span>A connected daemon advertised this skill itself, so a machine really has it.</span>
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Configured on the agent, not advertised by a live connection. Nothing is connected to confirm it.
                    </p>
                  )}
                </div>

                <div>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agents with this skill</h4>
                  <div className="space-y-1.5">
                    {selectedSkill.agents.map(agent => (
                      <div key={agent.id} className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5">
                        <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-foreground">{agent.name}</div>
                          {agent.handle && <div className="truncate text-[11px] text-muted-foreground">@{agent.handle}</div>}
                        </div>
                        <Badge variant="outline" className="shrink-0 text-[11px]">{agent.runMode}</Badge>
                        {agent.connected && (
                          <span className="size-2 shrink-0 rounded-full bg-emerald-500" title="Connected" aria-label="Connected" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {selectedLibrary && (
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
                <p className="text-xs text-muted-foreground">
                  Enumerated on a connected machine. agensis lists what the daemon reported; the files themselves stay on that machine.
                </p>
              </>
            )}
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
