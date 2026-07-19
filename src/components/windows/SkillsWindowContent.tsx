import { useMemo, useState } from 'react';
import { Sparkles, Search, Bot } from 'lucide-react';
import type { WorkspaceAgent, AgentConnection } from '../../types';
import type { SystemCapabilities } from '../../lib/backendClient';
import { Badge } from '@/components/ui/badge';
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

function normalizeSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v).trim()).filter(Boolean);
}

// Consolidated skills view: every skill any agent exposes, grouped by skill name
// with the agents that have it. Skills come from the live daemon connection
// (`capabilities.skills`, auto-refreshed via realtime + poll) with the agent's
// manually-configured `skills` as a fallback. Read-only browse surface, distinct
// from the composer `/` menu (which inserts) and per-agent profiles.
export function SkillsWindowContent({ agents, agentConnections, systemCapabilities }: SkillsWindowContentProps) {
  const [query, setQuery] = useState('');

  // Skill name -> the agents that expose it. Prefer the live connection
  // capabilities (the daemon-synced set); fall back to the agent's own skills.
  const agentSkills = useMemo(() => {
    const connByAgent = new Map<string, AgentConnection>();
    for (const conn of agentConnections) {
      const key = String(conn.agent_id || conn.handle || '').toLowerCase();
      if (key) connByAgent.set(key, conn);
    }
    const bySkill = new Map<string, WorkspaceAgent[]>();
    for (const agent of agents) {
      if (agent.enabled === false) continue;
      const conn = connByAgent.get(String(agent.id).toLowerCase())
        || connByAgent.get(String(agent.handle || '').toLowerCase());
      const synced = normalizeSkills(conn?.capabilities?.skills);
      const skills = synced.length ? synced : normalizeSkills(agent.skills);
      for (const skill of skills) {
        const list = bySkill.get(skill) || [];
        list.push(agent);
        bySkill.set(skill, list);
      }
    }
    return [...bySkill.entries()]
      .map(([name, list]) => ({ name, agents: list }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, agentConnections]);

  // Daemon-enumerated skill/agent libraries (from each connected machine).
  const libraries = useMemo(() => {
    return (systemCapabilities?.skills || [])
      .filter(lib => lib.available && (lib.type === 'skills' || lib.type === 'agents'))
      .sort((a, b) => b.count - a.count);
  }, [systemCapabilities]);

  const q = query.trim().toLowerCase();
  const filteredSkills = q
    ? agentSkills.filter(s => s.name.toLowerCase().includes(q) || s.agents.some(a => a.name.toLowerCase().includes(q)))
    : agentSkills;
  const filteredLibraries = q
    ? libraries.filter(l => l.label.toLowerCase().includes(q))
    : libraries;

  const totalSkills = agentSkills.length;
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

  return (
    <div className="flex h-full flex-col">
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
        <span className="shrink-0 text-xs text-muted-foreground">
          {totalSkills} skill{totalSkills === 1 ? '' : 's'}
          {totalLibraryEntries > 0 ? ` · ${totalLibraryEntries} in libraries` : ''}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {/* Skills consolidated across all agents. */}
          {filteredSkills.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent skills</h3>
              <div className="space-y-1.5">
                {filteredSkills.map(skill => (
                  <div key={skill.name} className="rounded-lg border border-border bg-card/40 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Sparkles className="size-3.5 shrink-0 text-primary" />
                      <span className="text-sm font-medium text-foreground">{skill.name}</span>
                      <Badge variant="secondary" className="ml-auto shrink-0">{skill.agents.length}</Badge>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1 pl-5.5">
                      {skill.agents.map(agent => (
                        <span key={agent.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          <Bot className="size-3" />
                          {agent.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Daemon-enumerated skill libraries. */}
          {filteredLibraries.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skill libraries</h3>
              <div className="space-y-1.5">
                {filteredLibraries.map(lib => (
                  <div key={lib.id} className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2">
                    <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{lib.label}</div>
                      {lib.path && <div className="truncate text-[11px] text-muted-foreground">{lib.path}</div>}
                    </div>
                    <Badge variant="secondary" className="shrink-0">{lib.count}</Badge>
                  </div>
                ))}
              </div>
            </section>
          )}

          {filteredSkills.length === 0 && filteredLibraries.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No skills or libraries match “{query}”.</div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
