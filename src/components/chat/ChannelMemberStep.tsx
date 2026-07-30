import { useEffect, useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { apiAuthHeaders, apiUrl } from '@/lib/backendClient';
import { agentAccentColor, agentHandle } from '@/lib/agentAccent';
import { skillAgentInitials } from '@/lib/skillsView';
import { workspaceInitials } from '@/lib/workspaceRail';
import {
  buildSuggestionIndex,
  suggestChannelMembers,
  SUGGESTION_LIMIT,
} from '@/lib/channelMemberSuggestions';
import { chorusNote } from '@/lib/channelCreateFlow';
import type { ConversationMode } from '@/lib/channelMentions';
import type { AgentConnection, ChatSession, WorkspaceAgent } from '@/types';

// ---------------------------------------------------------------------------
// Step 2 of channel creation: who is in it.
//
// The suggestions come from the NAME typed in step 1, ranked locally by
// src/lib/channelMemberSuggestions.ts — no request, no model call, no cost.
// Each one carries the token it matched, rendered as a chip, so the ranking is
// auditable in a glance rather than something to take on faith.
//
// NOTHING IS PRESELECTED. That is a deliberate reading of "suggest some":
// adding an agent to the roster changes who ANSWERS in the room (the server
// dispatches to it), so a room that quietly seeded itself with five agents
// would start talking to a user who never chose that. This dialog's own copy
// promises "nothing is created until you choose one", and channelTemplates.ts
// calls its templates "honest starting points, not hidden magic". "Add all"
// gives the one-tap path without making it the default.
//
// Avatars are initials on a solid colour. NEVER an emoji — house rule. The
// colour comes from agentAccentColor so an agent is the same colour here as in
// every other surface.
// ---------------------------------------------------------------------------

export interface MemberChoice {
  id: string;
  name: string;
  kind: 'user' | 'agent';
  handle: string | null;
  user_id: string | null;
  agent_id: string | null;
  status: string | null;
  initials: string;
  color: string;
}

interface WorkspaceMemberRow {
  user_id: string;
  email: string;
  role: string;
}

/** People get a neutral chip. Agents own the accent palette; a colleague is not an agent. */
const PERSON_COLOR = 'var(--muted-foreground)';

function agentChoice(agent: WorkspaceAgent, status: string | null): MemberChoice {
  return {
    id: `agent:${agent.id}`,
    name: agent.name || agentHandle(agent),
    kind: 'agent',
    handle: agentHandle(agent),
    user_id: null,
    agent_id: agent.id,
    status,
    initials: skillAgentInitials(agent),
    color: agentAccentColor(agent),
  };
}

function personChoice(row: WorkspaceMemberRow): MemberChoice {
  // The email local-part is the only name the members route returns. Better than
  // showing a raw address in a roster, and it is what the invite list shows too.
  const label = String(row.email || '').split('@')[0] || 'Member';
  return {
    id: `user:${row.user_id}`,
    name: label,
    kind: 'user',
    handle: null,
    user_id: row.user_id,
    agent_id: null,
    status: row.role || null,
    initials: workspaceInitials(label),
    color: PERSON_COLOR,
  };
}

function Avatar({ choice, size = 'md' }: { choice: Pick<MemberChoice, 'initials' | 'color' | 'kind'>; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-md font-semibold text-white',
        size === 'sm' ? 'size-5 text-[9px]' : 'size-8 text-[11px]',
        choice.kind === 'user' && 'bg-muted text-muted-foreground',
      )}
      style={choice.kind === 'agent' ? { backgroundColor: choice.color } : undefined}
    >
      {choice.initials}
    </span>
  );
}

interface Props {
  channelName: string;
  workspaceId: string | null;
  agents: WorkspaceAgent[];
  agentConnections: AgentConnection[];
  sessions: ChatSession[];
  conversationMode: ConversationMode;
  selected: MemberChoice[];
  onSelectedChange: (next: MemberChoice[]) => void;
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
}

export function ChannelMemberStep({
  channelName, workspaceId, agents, agentConnections, sessions,
  conversationMode, selected, onSelectedChange, onBack, onCreate, creating,
}: Props) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<MemberChoice[]>([]);

  // People are fetched HERE, on step entry, rather than mounted app-wide: the
  // list is needed on one screen that opens rarely, and useWorkspaceUsers also
  // pulls the invite list, which this step has no use for and which a non-admin
  // may not be allowed to read at all.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/members`),
          { headers: apiAuthHeaders() },
        );
        const json = await res.json().catch(() => null);
        if (cancelled || !Array.isArray(json?.data)) return;
        setPeople((json.data as WorkspaceMemberRow[]).filter(row => row.user_id).map(personChoice));
      } catch {
        // A members list that will not load is an empty People section, never a
        // broken step — the agents half is the part this feature is about.
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  const agentChoices = useMemo(() => {
    const live = new Map<string, string>();
    for (const conn of agentConnections) {
      if (conn.status === 'offline' || !conn.agent_id) continue;
      live.set(conn.agent_id, conn.status);
    }
    return agents
      .filter(agent => agent.enabled !== false)
      .map(agent => agentChoice(agent, live.get(agent.id) || agent.run_mode || 'built-in'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, agentConnections]);

  // Rebuilt only when the workspace's agents/connections/channels change — NOT
  // per keystroke, and not when the name changes.
  const index = useMemo(
    () => buildSuggestionIndex(agents, agentConnections, sessions),
    [agents, agentConnections, sessions],
  );

  const selectedIds = useMemo(() => new Set(selected.map(choice => choice.id)), [selected]);

  const suggestions = useMemo(
    () => suggestChannelMembers(index, channelName, {
      selectedAgentIds: selected.filter(c => c.agent_id).map(c => c.agent_id as string),
    }),
    [index, channelName, selected],
  );

  const suggestionChoices = useMemo(() => {
    const byAgentId = new Map(agentChoices.map(choice => [choice.agent_id as string, choice]));
    return suggestions
      .map(suggestion => {
        const choice = byAgentId.get(suggestion.agentId);
        return choice ? { suggestion, choice } : null;
      })
      .filter((row): row is { suggestion: typeof suggestions[number]; choice: MemberChoice } => row !== null);
  }, [suggestions, agentChoices]);

  const anyMatched = suggestionChoices.some(row => row.suggestion.matched);

  const filteredPeople = useMemo(() => filterChoices(people, query), [people, query]);
  const filteredAgents = useMemo(() => filterChoices(agentChoices, query), [agentChoices, query]);

  const toggle = (choice: MemberChoice) => {
    onSelectedChange(
      selectedIds.has(choice.id)
        ? selected.filter(item => item.id !== choice.id)
        : [...selected, choice],
    );
  };

  const addAllSuggested = () => {
    const additions = suggestionChoices
      .map(row => row.choice)
      .filter(choice => !selectedIds.has(choice.id));
    if (additions.length > 0) onSelectedChange([...selected, ...additions]);
  };

  const note = chorusNote(selected.filter(choice => choice.kind === 'agent').length, conversationMode);

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selected.map(choice => (
              <button
                key={choice.id}
                type="button"
                onClick={() => toggle(choice)}
                className="control-outer-ring flex items-center gap-1.5 rounded-full border border-border bg-card/60 py-1 pl-1 pr-2 text-xs transition hover:bg-muted/60"
                aria-label={`Remove ${choice.name}`}
              >
                <Avatar choice={choice} size="sm" />
                <span className="max-w-[10rem] truncate">{choice.name}</span>
                <X aria-hidden className="size-3 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}

        {suggestionChoices.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {anyMatched ? 'Suggested' : 'Most used here'}
              </div>
              <Button type="button" variant="ghost" size="xs" onClick={addAllSuggested}>
                Add all {Math.min(suggestionChoices.length, SUGGESTION_LIMIT)}
              </Button>
            </div>
            {/* When nothing matched the name, say so. Presenting the fallback as
                if it were a match is the one way this list can lie. */}
            {!anyMatched && (
              <p className="text-xs text-muted-foreground">
                Nothing in this workspace matches that name, so these are the agents you put in
                channels most.
              </p>
            )}
            <div className="space-y-1">
              {suggestionChoices.map(({ suggestion, choice }) => (
                <MemberRow
                  key={choice.id}
                  choice={choice}
                  selected={selectedIds.has(choice.id)}
                  onToggle={() => toggle(choice)}
                  subtitle={`@${choice.handle}`}
                  chip={suggestion.reason.label}
                />
              ))}
            </div>
          </section>
        )}

        <div className="flex items-center gap-2">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search people and agents"
            aria-label="Search people and agents"
          />
        </div>

        <MemberList title="People" choices={filteredPeople} selectedIds={selectedIds} onToggle={toggle} />
        <MemberList title="Agents" choices={filteredAgents} selectedIds={selectedIds} onToggle={toggle} />

        {filteredPeople.length === 0 && filteredAgents.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Nobody matches that search.</p>
        )}
      </div>

      {note && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-foreground">
          {note}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {selected.length === 0
            ? 'You can add people later from the channel header.'
            : `${selected.length} to add`}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onBack} disabled={creating}>
            Back
          </Button>
          {/* Always enabled: an empty channel is legitimate, and is exactly what
              creation produced before this step existed. */}
          <Button type="button" size="sm" onClick={onCreate} disabled={creating}>
            {creating ? 'Creating…' : 'Create channel'}
          </Button>
        </div>
      </div>
    </>
  );
}

function filterChoices(choices: MemberChoice[], query: string): MemberChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return choices;
  return choices.filter(choice => `${choice.name} ${choice.handle ?? ''}`.toLowerCase().includes(q));
}

function MemberList({
  title, choices, selectedIds, onToggle,
}: {
  title: string;
  choices: MemberChoice[];
  selectedIds: Set<string>;
  onToggle: (choice: MemberChoice) => void;
}) {
  if (choices.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="space-y-1">
        {choices.map(choice => (
          <MemberRow
            key={choice.id}
            choice={choice}
            selected={selectedIds.has(choice.id)}
            onToggle={() => onToggle(choice)}
            subtitle={choice.handle ? `@${choice.handle}` : choice.status ?? ''}
          />
        ))}
      </div>
    </section>
  );
}

function MemberRow({
  choice, selected, onToggle, subtitle, chip,
}: {
  choice: MemberChoice;
  selected: boolean;
  onToggle: () => void;
  subtitle: string;
  chip?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        'control-outer-ring flex w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition',
        selected ? 'border-primary bg-primary/10' : 'border-border bg-card/40 hover:bg-muted/50',
      )}
    >
      <Avatar choice={choice} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{choice.name}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      {chip && (
        <span className="hidden shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground sm:block">
          {chip}
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">
        {selected ? <Check aria-hidden className="size-4 text-primary" /> : <span className="text-xs">Add</span>}
      </span>
    </button>
  );
}
