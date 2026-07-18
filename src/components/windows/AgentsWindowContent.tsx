import { memo, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  Check,
  Code2,
  Command,
  Copy,
  Database,
  Globe,
  KeyRound,
  Link2,
  Monitor,
  Pencil,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  Save,
  ShieldCheck,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  Upload,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AI_MODELS, type AgentConnection, type AgentWebhook, type WorkspaceAgent } from '../../types';
import { apiAuthHeaders, apiBaseUrl, apiUrl, getSystemCapabilities, type SystemCapabilities } from '../../lib/backendClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { AGENT_ACCENT_CHOICES, DEFAULT_AGENT_ACCENT, agentAccentColor, agentAccentPaletteColor, agentAccentStyle, validAgentAccentColor } from '../../lib/agentAccent';
import { AGENT_AVATAR_CHOICES } from '../../lib/agentAvatars';
import { fetchFeaturedOpenPets, isImageAvatar, isPetSpritesheetAvatar, openPetAvatarSrc, renderablePetAssetUrl, type OpenPet } from '../../lib/openpets';

interface AgentsWindowContentProps {
  agents: WorkspaceAgent[];
  webhooks: AgentWebhook[];
  connections?: AgentConnection[];
  focusedAgentKey?: string | null;
  onCreateAgent: (input: {
    name: string;
    avatar?: string;
    openpet_avatar_id?: string | null;
    accent_color?: string | null;
    description?: string;
    system_prompt: string;
    soul?: string;
    instructions?: string;
    tools?: string[];
    skills?: string[];
    handle?: string;
    model?: string;
    run_mode?: 'builtin' | 'daemon';
  }) => void;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
  onCreateWebhook: (input: { agent_id?: string | null; name: string }) => Promise<AgentWebhook | null>;
  onUpdateWebhook: (id: string, updates: Partial<AgentWebhook>) => Promise<AgentWebhook | null>;
  onOpenConnections: () => void;
}

const DEFAULT_AGENT_AVATAR = 'AI';
const AGENT_ICON_CHOICES: Array<{ value: string; label: string; icon: LucideIcon }> = [
  { value: 'icon:bot', label: 'Bot', icon: Bot },
  { value: 'icon:sparkles', label: 'Sparkles', icon: Sparkles },
  { value: 'icon:brain', label: 'Brain', icon: Brain },
  { value: 'icon:terminal', label: 'Terminal', icon: Terminal },
  { value: 'icon:code', label: 'Code', icon: Code2 },
  { value: 'icon:command', label: 'Command', icon: Command },
  { value: 'icon:wrench', label: 'Tools', icon: Wrench },
  { value: 'icon:database', label: 'Data', icon: Database },
  { value: 'icon:shield', label: 'Shield', icon: ShieldCheck },
  { value: 'icon:rocket', label: 'Rocket', icon: Rocket },
  { value: 'icon:globe', label: 'Globe', icon: Globe },
  { value: 'icon:monitor', label: 'Monitor', icon: Monitor },
];

export const AgentsWindowContent = memo(function AgentsWindowContent({
  agents,
  webhooks,
  connections = [],
  focusedAgentKey,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onCreateWebhook,
  onUpdateWebhook,
  onOpenConnections,
}: AgentsWindowContentProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [connectAgentId, setConnectAgentId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(DEFAULT_AGENT_AVATAR);
  const [newOpenPetAvatarId, setNewOpenPetAvatarId] = useState('');
  const [newAccentColor, setNewAccentColor] = useState(DEFAULT_AGENT_ACCENT);
  const [newHandle, setNewHandle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSystemPrompt, setNewSystemPrompt] = useState('');
  const [newSoul, setNewSoul] = useState('');
  const [newInstructions, setNewInstructions] = useState('');
  const [newTools, setNewTools] = useState('');
  const [newSkills, setNewSkills] = useState('');
  const [newModel, setNewModel] = useState('auto');
  const [newRunMode, setNewRunMode] = useState<'builtin' | 'daemon'>('builtin');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [statusFilter, setStatusFilter] = useState<Set<AgentPresence>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const normalizedFocusedAgentKey = normalizeAgentKey(focusedAgentKey);
  const focusedAgent = agents.find(agent => agentMatchesKey(agent, normalizedFocusedAgentKey)) || null;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(focusedAgent?.id || agents[0]?.id || null);
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId) || focusedAgent || agents[0] || null;
  const connectAgent = agents.find(agent => agent.id === connectAgentId) || null;

  const presenceByAgent = new Map<string, AgentPresence>(
    agents.map(agent => [
      agent.id,
      agentPresenceStatus(agent, connections.filter(connection => connection.agent_id === agent.id)),
    ]),
  );
  const presenceCounts = AGENT_PRESENCE_FILTERS.reduce<Record<AgentPresence, number>>((acc, filter) => {
    acc[filter.key] = 0;
    return acc;
  }, { busy: 0, idle: 0, disconnected: 0, inactive: 0 });
  presenceByAgent.forEach(status => { presenceCounts[status] += 1; });
  const statusVisibleAgents = statusFilter.size === 0
    ? agents
    : agents.filter(agent => statusFilter.has(presenceByAgent.get(agent.id) as AgentPresence));
  const searchQuery = searchTerm.trim().toLowerCase();
  const visibleAgents = searchQuery === ''
    ? statusVisibleAgents
    : statusVisibleAgents.filter(agent =>
      `${agent.name} ${agent.handle || ''} ${agent.description || ''}`.toLowerCase().includes(searchQuery));

  const toggleStatusFilter = (key: AgentPresence) => {
    setStatusFilter(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    getSystemCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  useEffect(() => {
    if (focusedAgent?.id) setSelectedAgentId(focusedAgent.id);
  }, [focusedAgent?.id]);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId(null);
      return;
    }
    if (!selectedAgentId || !agents.some(agent => agent.id === selectedAgentId)) {
      setSelectedAgentId(focusedAgent?.id || agents[0].id);
    }
  }, [agents, focusedAgent?.id, selectedAgentId]);

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreateAgent({
      name: newName.trim(),
      avatar: newAvatar.trim() || DEFAULT_AGENT_AVATAR,
      openpet_avatar_id: newOpenPetAvatarId,
      accent_color: validAgentAccentColor(newAccentColor),
      handle: newHandle.trim() || agentHandle(newName),
      description: newDescription.trim(),
      system_prompt: newSystemPrompt.trim(),
      soul: newSoul.trim(),
      instructions: newInstructions.trim(),
      tools: splitList(newTools),
      skills: splitList(newSkills),
      model: newModel,
      run_mode: newRunMode,
    });
    setNewName('');
    setNewAvatar(DEFAULT_AGENT_AVATAR);
    setNewOpenPetAvatarId('');
    setNewAccentColor(agentAccentPaletteColor(agents.length + 1));
    setNewHandle('');
    setNewDescription('');
    setNewSystemPrompt('');
    setNewSoul('');
    setNewInstructions('');
    setNewTools('');
    setNewSkills('');
    setNewModel('auto');
    setNewRunMode('builtin');
    setShowCreate(false);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      onDeleteAgent(id);
      setConfirmDeleteId(null);
      return;
    }
    setConfirmDeleteId(id);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/65 px-3 py-2 backdrop-blur-md">
        <div className="relative min-w-0 max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search agents"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenConnections}
          >
            <Plug data-icon="inline-start" />
            Connect a client
          </Button>
          <Button
            type="button"
            size="sm"
            variant={showCreate ? 'outline' : 'default'}
            onClick={() => setShowCreate(!showCreate)}
          >
            <Plus data-icon="inline-start" />
            Create Agent
          </Button>
        </div>
      </div>
      <AgentConnectDialog
        agent={connectAgent}
        open={connectAgentId != null}
        onOpenChange={(o) => { if (!o) setConnectAgentId(null); }}
        webhooks={connectAgent ? webhooks.filter(webhook => webhook.agent_id === connectAgent.id) : []}
        onCreateWebhook={() => connectAgent ? onCreateWebhook({ agent_id: connectAgent.id, name: `${connectAgent.name} webhook` }) : Promise.resolve(null)}
        onToggleWebhook={(webhook, enabled) => onUpdateWebhook(webhook.id, { enabled })}
      />

      <div className="agents-window-body min-h-0 flex-1 overflow-hidden p-2">
        <div className="agents-master-detail h-full min-h-0">
          <div className="agents-list-pane min-h-0 overflow-y-auto pr-2 pb-2">
            {showCreate && (
              <div className="agents-inline-create mb-2 rounded-lg border bg-card/55 p-3 backdrop-blur-md">
                <AgentForm
                  name={newName}
                  avatar={newAvatar}
                  openPetAvatarId={newOpenPetAvatarId}
                  accentColor={newAccentColor}
                  handle={newHandle}
                  description={newDescription}
                  systemPrompt={newSystemPrompt}
                  soul={newSoul}
                  instructions={newInstructions}
                  tools={newTools}
                  skills={newSkills}
                  model={newModel}
                  runMode={newRunMode}
                  capabilities={capabilities}
                  onNameChange={setNewName}
                  onAvatarChange={(value) => {
                    setNewAvatar(value);
                    setNewOpenPetAvatarId('');
                  }}
                  onOpenPetAvatarChange={(pet) => {
                    setNewAvatar(openPetAvatarSrc(pet));
                    setNewOpenPetAvatarId(pet.id);
                  }}
                  onAccentColorChange={setNewAccentColor}
                  onHandleChange={setNewHandle}
                  onDescriptionChange={setNewDescription}
                  onSystemPromptChange={setNewSystemPrompt}
                  onSoulChange={setNewSoul}
                  onInstructionsChange={setNewInstructions}
                  onToolsChange={setNewTools}
                  onSkillsChange={setNewSkills}
                  onModelChange={setNewModel}
                  onRunModeChange={setNewRunMode}
                  onCancel={() => setShowCreate(false)}
                  onSubmit={handleCreate}
                  submitLabel="Create"
                  submitIcon={<Plus data-icon="inline-start" />}
                />
              </div>
            )}

            {agents.length > 0 && (
              <div className="agents-status-filter mb-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setStatusFilter(new Set())}
                  aria-pressed={statusFilter.size === 0}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                    statusFilter.size === 0
                      ? 'border-primary/60 bg-primary/15 text-foreground'
                      : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  All
                  <span className="tabular-nums opacity-70">{agents.length}</span>
                </button>
                {(() => {
                  const activeCount = presenceCounts.busy + presenceCounts.idle;
                  const isActiveFilter = statusFilter.size === 2 && statusFilter.has('busy') && statusFilter.has('idle');
                  return (
                    <button
                      type="button"
                      onClick={() => setStatusFilter(new Set(['busy', 'idle']))}
                      aria-pressed={isActiveFilter}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                        isActiveFilter
                          ? 'border-primary/60 bg-primary/15 text-foreground'
                          : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                      Active
                      <span className="tabular-nums opacity-70">{activeCount}</span>
                    </button>
                  );
                })()}
                {AGENT_PRESENCE_FILTERS.map(filter => {
                  const active = statusFilter.has(filter.key);
                  return (
                    <button
                      key={filter.key}
                      type="button"
                      onClick={() => toggleStatusFilter(filter.key)}
                      aria-pressed={active}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                        active
                          ? 'border-primary/60 bg-primary/15 text-foreground'
                          : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      <span className={cn('size-1.5 rounded-full', filter.tone)} aria-hidden />
                      {filter.label}
                      <span className="tabular-nums opacity-70">{presenceCounts[filter.key]}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {agents.length === 0 ? (
              <Empty className="h-full border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bot />
                  </EmptyMedia>
                  <EmptyTitle>No agents yet</EmptyTitle>
                  <EmptyDescription>Create an agent, copy its connection command, and run it where the daemon should execute.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : visibleAgents.length === 0 ? (
              <Empty className="border-0 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bot />
                  </EmptyMedia>
                  <EmptyTitle>No agents match</EmptyTitle>
                  <EmptyDescription>{searchQuery ? `No agents match "${searchTerm.trim()}".` : `No agents are ${AGENT_PRESENCE_FILTERS.filter(f => statusFilter.has(f.key)).map(f => f.label.toLowerCase()).join(' or ')}. Adjust the filter above.`}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="gap-1">
                {visibleAgents.map(agent => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    focused={agentMatchesKey(agent, normalizedFocusedAgentKey)}
                    selected={selectedAgent?.id === agent.id}
                    isEditing={editingId === agent.id}
                    confirmDelete={confirmDeleteId === agent.id}
                    onSelect={() => {
                      setSelectedAgentId(agent.id);
                      setShowCreate(false);
                      setEditingId(null);
                    }}
                    onEdit={() => {
                      setSelectedAgentId(agent.id);
                      setShowCreate(false);
                      setEditingId(editingId === agent.id ? null : agent.id);
                    }}
                    onCancelEdit={() => setEditingId(null)}
                    onSave={(updates) => {
                      onUpdateAgent(agent.id, updates);
                      setEditingId(null);
                    }}
                    onDelete={() => handleDelete(agent.id)}
                    onCancelDelete={() => setConfirmDeleteId(null)}
                    onToggleEnabled={() => onUpdateAgent(agent.id, { enabled: agent.enabled === false })}
                    capabilities={capabilities}
                    webhooks={webhooks.filter(webhook => webhook.agent_id === agent.id)}
                    connections={connections.filter(connection => connection.agent_id === agent.id)}
                    onConnect={() => setConnectAgentId(agent.id)}
                    onToggleWebhook={(webhook, enabled) => onUpdateWebhook(webhook.id, { enabled })}
                  />
                ))}
              </ItemGroup>
            )}
          </div>

          <aside className="agents-detail-pane min-h-0 overflow-hidden rounded-lg border bg-card/55 backdrop-blur-md">
            {showCreate ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
                  <Plus className="size-4 text-primary" />
                  <span className="text-sm font-semibold">Create agent</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <AgentForm
                    name={newName}
                    avatar={newAvatar}
                    openPetAvatarId={newOpenPetAvatarId}
                    accentColor={newAccentColor}
                    handle={newHandle}
                    description={newDescription}
                    systemPrompt={newSystemPrompt}
                    soul={newSoul}
                    instructions={newInstructions}
                    tools={newTools}
                    skills={newSkills}
                    model={newModel}
                    runMode={newRunMode}
                    capabilities={capabilities}
                    onNameChange={setNewName}
                    onAvatarChange={(value) => {
                      setNewAvatar(value);
                      setNewOpenPetAvatarId('');
                    }}
                    onOpenPetAvatarChange={(pet) => {
                      setNewAvatar(openPetAvatarSrc(pet));
                      setNewOpenPetAvatarId(pet.id);
                    }}
                    onAccentColorChange={setNewAccentColor}
                    onHandleChange={setNewHandle}
                    onDescriptionChange={setNewDescription}
                    onSystemPromptChange={setNewSystemPrompt}
                    onSoulChange={setNewSoul}
                    onInstructionsChange={setNewInstructions}
                    onToolsChange={setNewTools}
                    onSkillsChange={setNewSkills}
                    onModelChange={setNewModel}
                    onRunModeChange={setNewRunMode}
                    onCancel={() => setShowCreate(false)}
                    onSubmit={handleCreate}
                    submitLabel="Create"
                    submitIcon={<Plus data-icon="inline-start" />}
                  />
                </div>
              </div>
            ) : (
              <AgentDetailPane
                agent={selectedAgent}
                isEditing={Boolean(selectedAgent && editingId === selectedAgent.id)}
                confirmDelete={Boolean(selectedAgent && confirmDeleteId === selectedAgent.id)}
                onEdit={() => selectedAgent && setEditingId(selectedAgent.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={(updates) => {
                  if (!selectedAgent) return;
                  onUpdateAgent(selectedAgent.id, updates);
                  setEditingId(null);
                }}
                onDelete={() => selectedAgent && handleDelete(selectedAgent.id)}
                onToggleEnabled={() => selectedAgent && onUpdateAgent(selectedAgent.id, { enabled: selectedAgent.enabled === false })}
                capabilities={capabilities}
                webhooks={selectedAgent ? webhooks.filter(webhook => webhook.agent_id === selectedAgent.id) : []}
                connections={selectedAgent ? connections.filter(connection => connection.agent_id === selectedAgent.id) : []}
                onConnect={() => selectedAgent && setConnectAgentId(selectedAgent.id)}
                onToggleWebhook={(webhook, enabled) => onUpdateWebhook(webhook.id, { enabled })}
              />
            )}
          </aside>
        </div>
      </div>
    </div>
  );
});

function AgentForm({
  name,
  avatar,
  openPetAvatarId,
  accentColor,
  handle,
  description,
  systemPrompt,
  soul,
  instructions,
  tools,
  skills,
  model,
  runMode,
  capabilities,
  onNameChange,
  onAvatarChange,
  onOpenPetAvatarChange,
  onAccentColorChange,
  onHandleChange,
  onDescriptionChange,
  onSystemPromptChange,
  onSoulChange,
  onInstructionsChange,
  onToolsChange,
  onSkillsChange,
  onModelChange,
  onRunModeChange,
  onCancel,
  onSubmit,
  submitLabel,
  submitIcon,
}: {
  name: string;
  avatar: string;
  openPetAvatarId: string;
  accentColor: string;
  handle: string;
  description: string;
  systemPrompt: string;
  soul: string;
  instructions: string;
  tools: string;
  skills: string;
  model: string;
  runMode: 'builtin' | 'daemon';
  capabilities: SystemCapabilities | null;
  onNameChange: (value: string) => void;
  onAvatarChange: (value: string) => void;
  onOpenPetAvatarChange: (pet: OpenPet) => void;
  onAccentColorChange: (value: string) => void;
  onHandleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onSoulChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
  onToolsChange: (value: string) => void;
  onSkillsChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onRunModeChange: (value: 'builtin' | 'daemon') => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitIcon: React.ReactNode;
}) {
  const options = modelOptions(model);
  const canSubmit = Boolean(name.trim());
  const [openPets, setOpenPets] = useState<OpenPet[]>([]);
  const [avatarTab, setAvatarTab] = useState<'icon' | 'avatar' | 'openpets' | 'upload'>('icon');
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFeaturedOpenPets().then(pets => {
      if (!cancelled) setOpenPets(pets);
    }).catch(() => {
      if (!cancelled) setOpenPets([]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUploadAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onAvatarChange(reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <FieldGroup className="agent-form-fields gap-3">
      <div className="grid grid-cols-[4.5rem_1fr_10rem] gap-2">
        <Field>
          <FieldLabel>Preview</FieldLabel>
          <div className="grid aspect-square place-items-center overflow-hidden rounded-xl border bg-muted text-lg font-semibold">
            <AgentAvatarPreview value={avatar} className="size-full" />
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-name">Name</FieldLabel>
          <Input
            id="agent-name"
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder="Agent name"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-handle">Handle</FieldLabel>
          <Input
            id="agent-handle"
            value={handle}
            onChange={e => onHandleChange(e.target.value)}
            placeholder={`@${agentHandle(name || 'agent')}`}
          />
        </Field>
      </div>

      <Tabs value={avatarTab} onValueChange={value => setAvatarTab(value as typeof avatarTab)} className="agent-avatar-tabs gap-3">
        <TabsList className="grid h-10 w-full grid-cols-4 rounded-xl">
          <TabsTrigger value="icon">Icon</TabsTrigger>
          <TabsTrigger value="avatar">Avatar</TabsTrigger>
          <TabsTrigger value="openpets">OpenPets</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
        </TabsList>
        <TabsContent value="icon" className="mt-0">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-2">
            {AGENT_ICON_CHOICES.map(choice => {
              const Icon = choice.icon;
              return (
                <button
                  key={choice.value}
                  type="button"
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-lg border bg-muted/40 transition hover:border-primary/60',
                    avatar === choice.value && 'border-primary ring-2 ring-primary/40',
                  )}
                  onClick={() => onAvatarChange(choice.value)}
                  title={choice.label}
                  aria-label={`Use ${choice.label} icon`}
                >
                  <Icon className="size-5" />
                </button>
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="avatar" className="mt-0">
          <div className="agent-avatar-grid grid max-h-72 grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-2 overflow-y-auto pr-1">
            {AGENT_AVATAR_CHOICES.map(choice => (
              <button
                key={choice.id}
                type="button"
                className={cn(
                  'agent-avatar-tile flex aspect-square items-center justify-center rounded-lg border bg-muted/40 p-1.5 transition hover:border-primary/60',
                  avatar === choice.src && 'border-primary ring-2 ring-primary/40',
                )}
                onClick={() => onAvatarChange(choice.src)}
                title={choice.label}
                aria-label={`Use ${choice.label} avatar`}
              >
                <img src={choice.src} alt="" className="agent-avatar-tile-image" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="openpets" className="mt-0">
          {openPets.length > 0 ? (
            <div className="agent-avatar-grid grid max-h-72 grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-2 overflow-y-auto pr-1">
              {openPets.map(pet => (
                <button
                  key={pet.id}
                  type="button"
                  className={cn(
                    'agent-avatar-tile flex aspect-square items-center justify-center rounded-lg border bg-muted/40 p-1.5 transition hover:border-primary/60',
                    openPetAvatarId === pet.id && 'border-primary ring-2 ring-primary/40',
                  )}
                  onClick={() => onOpenPetAvatarChange(pet)}
                  title={pet.displayName}
                  aria-label={`Use ${pet.displayName} OpenPets avatar`}
                >
                  <AgentAvatarPreview value={openPetAvatarSrc(pet)} className="size-full" />
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">No OpenPets available.</div>
          )}
        </TabsContent>
        <TabsContent value="upload" className="mt-0">
          <button
            type="button"
            className="flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 text-sm text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
            onClick={() => uploadInputRef.current?.click()}
          >
            <Upload className="size-5" />
            Choose an image
            <span className="text-xs text-muted-foreground/80">PNG, JPG, GIF</span>
          </button>
          <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadAvatar} />
        </TabsContent>
      </Tabs>

      <Field>
        <FieldLabel htmlFor="agent-accent-color">Accent color</FieldLabel>
        <div className="agent-accent-picker flex min-w-0 flex-wrap items-center gap-2">
          {AGENT_ACCENT_CHOICES.map(choice => (
            <button
              key={choice}
              type="button"
              className={cn(
                'agent-accent-swatch size-8 rounded-lg border transition',
                validAgentAccentColor(accentColor) === choice && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
              )}
              style={{ backgroundColor: choice }}
              onClick={() => onAccentColorChange(choice)}
              aria-label={`Use accent ${choice}`}
              title={choice}
            />
          ))}
          <input
            id="agent-accent-color"
            type="color"
            value={validAgentAccentColor(accentColor)}
            onChange={event => onAccentColorChange(event.target.value)}
            className="agent-accent-color-input h-8 w-10 cursor-pointer rounded-lg border border-input bg-transparent p-1"
            aria-label="Custom accent color"
          />
        </div>
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-description">Description</FieldLabel>
        <Input
          id="agent-description"
          value={description}
          onChange={e => onDescriptionChange(e.target.value)}
          placeholder="Short description"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-system-prompt">System Prompt</FieldLabel>
        <Textarea
          id="agent-system-prompt"
          value={systemPrompt}
          onChange={e => onSystemPromptChange(e.target.value)}
          placeholder="Optional system prompt"
          rows={4}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-soul">Soul</FieldLabel>
        <Input
          id="agent-soul"
          value={soul}
          onChange={e => onSoulChange(e.target.value)}
          placeholder="Tone, taste, and decision style"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
        <Textarea
          id="agent-instructions"
          value={instructions}
          onChange={e => onInstructionsChange(e.target.value)}
          placeholder="Operational instructions, constraints, and handoff rules"
          rows={3}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-tools">Tools</FieldLabel>
        <Input
          id="agent-tools"
          value={tools}
          onChange={e => onToolsChange(e.target.value)}
          placeholder="claude, codex, opencode"
        />
        {capabilities && (
          <div className="flex flex-wrap gap-1">
            {capabilities.clis.filter(cli => cli.available).slice(0, 10).map(cli => (
              <Button key={cli.id} type="button" variant="outline" size="xs" onClick={() => onToolsChange(addToken(tools, cli.id))}>
                {cli.label}
              </Button>
            ))}
          </div>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-skills">Skills</FieldLabel>
        <Input
          id="agent-skills"
          value={skills}
          onChange={e => onSkillsChange(e.target.value)}
          placeholder="codex-user-skills, claude-agents"
        />
        {capabilities && (
          <div className="flex flex-wrap gap-1">
            {capabilities.skills.filter(skill => skill.available).slice(0, 10).map(skill => (
              <Button key={skill.id} type="button" variant="outline" size="xs" onClick={() => onSkillsChange(addToken(skills, skill.id))}>
                {skill.label}
              </Button>
            ))}
          </div>
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          value={runMode}
          onChange={e => onRunModeChange(e.target.value === 'daemon' ? 'daemon' : 'builtin')}
          size="sm"
          className="max-w-48"
          aria-label="Agent runtime"
        >
          <NativeSelectOption value="builtin">Built-in</NativeSelectOption>
          <NativeSelectOption value="daemon">Remote daemon</NativeSelectOption>
        </NativeSelect>
        <NativeSelect
          value={model}
          onChange={e => onModelChange(e.target.value)}
          size="sm"
          className="max-w-56"
          aria-label="Built-in agent model"
        >
          {options.map(option => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <div className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          <X data-icon="inline-start" />
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onSubmit} disabled={!canSubmit}>
          {submitIcon}
          {submitLabel}
        </Button>
      </div>
    </FieldGroup>
  );
}

function AgentRow({
  agent,
  focused,
  selected,
  isEditing,
  confirmDelete,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onCancelDelete,
  onToggleEnabled,
  onSelect,
  capabilities,
  webhooks,
  connections,
  onConnect,
  onToggleWebhook,
}: {
  agent: WorkspaceAgent;
  focused: boolean;
  selected: boolean;
  isEditing: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Partial<WorkspaceAgent>) => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onToggleEnabled: () => void;
  onSelect: () => void;
  capabilities: SystemCapabilities | null;
  webhooks: AgentWebhook[];
  connections: AgentConnection[];
  onConnect: () => void;
  onToggleWebhook: (webhook: AgentWebhook, enabled: boolean) => Promise<AgentWebhook | null>;
}) {
  const [editName, setEditName] = useState(agent.name);
  const [editAvatar, setEditAvatar] = useState(agent.avatar || DEFAULT_AGENT_AVATAR);
  const [editOpenPetAvatarId, setEditOpenPetAvatarId] = useState(agent.openpet_avatar_id || '');
  const [editAccentColor, setEditAccentColor] = useState(agentAccentColor(agent));
  const [editHandle, setEditHandle] = useState(agent.handle || agentHandle(agent.name));
  const [editDescription, setEditDescription] = useState(agent.description || '');
  const [editSystemPrompt, setEditSystemPrompt] = useState(agent.system_prompt || '');
  const [editSoul, setEditSoul] = useState(agent.soul || '');
  const [editInstructions, setEditInstructions] = useState(agent.instructions || '');
  const [editTools, setEditTools] = useState(joinList(agent.tools));
  const [editSkills, setEditSkills] = useState(joinList(agent.skills));
  const [editModel, setEditModel] = useState(agent.model || 'auto');
  const [editRunMode, setEditRunMode] = useState<'builtin' | 'daemon'>(agent.run_mode === 'daemon' ? 'daemon' : 'builtin');
  const activeConnections = connections.filter(connection => connection.status !== 'offline');
  const tools = normalizeList(agent.tools);
  const skills = normalizeList(agent.skills);
  const accent = agentAccentColor(agent);
  const agentActive = isAgentActive(agent);
  const handleLabel = `@${agent.handle || agentHandle(agent.name)}`;
  const modelLabel = displayModel(agent.model);
  const busy = activeConnections.some(connection => connection.status === 'busy');
  // The agent's self-declared status.json note (folded into heartbeat metadata by the
  // daemon). Surfaced on hover over the connection dot so the simplified row keeps the
  // "what is it doing right now" signal without spending row height on it.
  const selfNote = activeConnections
    .map(connection => {
      const status = typeof connection.metadata?.agentStatus === 'string' ? connection.metadata.agentStatus : '';
      const note = typeof connection.metadata?.agentNote === 'string' ? connection.metadata.agentNote : '';
      return [status, note].filter(Boolean).join(' — ');
    })
    .find(Boolean) || '';

  const handleSave = () => {
    onSave({
      name: editName.trim(),
      avatar: editAvatar.trim() || DEFAULT_AGENT_AVATAR,
      openpet_avatar_id: editOpenPetAvatarId,
      accent_color: validAgentAccentColor(editAccentColor),
      handle: editHandle.trim() || agentHandle(editName),
      description: editDescription.trim(),
      system_prompt: editSystemPrompt.trim(),
      soul: editSoul.trim(),
      instructions: editInstructions.trim(),
      tools: splitList(editTools),
      skills: splitList(editSkills),
      model: editModel,
      run_mode: editRunMode,
    });
  };

  if (isEditing) {
    return (
      <Item variant="outline" className="agents-inline-editor items-stretch" style={agentAccentStyle(agent)}>
        <ItemContent>
          <AgentForm
            name={editName}
            avatar={editAvatar}
            openPetAvatarId={editOpenPetAvatarId}
            accentColor={editAccentColor}
            handle={editHandle}
            description={editDescription}
            systemPrompt={editSystemPrompt}
            soul={editSoul}
            instructions={editInstructions}
            tools={editTools}
            skills={editSkills}
            model={editModel}
            runMode={editRunMode}
            capabilities={capabilities}
            onNameChange={setEditName}
            onAvatarChange={(value) => {
              setEditAvatar(value);
              setEditOpenPetAvatarId('');
            }}
            onOpenPetAvatarChange={(pet) => {
              setEditAvatar(openPetAvatarSrc(pet));
              setEditOpenPetAvatarId(pet.id);
            }}
            onAccentColorChange={setEditAccentColor}
            onHandleChange={setEditHandle}
            onDescriptionChange={setEditDescription}
            onSystemPromptChange={setEditSystemPrompt}
            onSoulChange={setEditSoul}
            onInstructionsChange={setEditInstructions}
            onToolsChange={setEditTools}
            onSkillsChange={setEditSkills}
            onModelChange={setEditModel}
            onRunModeChange={setEditRunMode}
            onCancel={onCancelEdit}
            onSubmit={handleSave}
            submitLabel="Save"
            submitIcon={<Save data-icon="inline-start" />}
          />
        </ItemContent>
      </Item>
    );
  }

  return (
    <Item
      variant="default"
      data-agent-selected={selected || focused ? 'true' : undefined}
      className={cn(
        'agents-list-card cursor-pointer hover:bg-muted/50',
        !agentActive && 'opacity-60',
        focused && 'border-primary/60 bg-primary/10 ring-1 ring-primary/30',
        selected && 'border-primary/70 bg-primary/10 ring-1 ring-primary/30',
      )}
      style={agentAccentStyle(agent)}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={onCancelDelete}
    >
      <ItemMedia className="size-9 overflow-hidden rounded-full bg-muted text-base">
        <AgentAvatarPreview value={agent.avatar || DEFAULT_AGENT_AVATAR} className="size-full" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full truncate">
          <span className="agent-accent-dot" style={{ backgroundColor: accent }} aria-hidden />
          {agent.name}
        </ItemTitle>
        {/* Compact feature strip: identity + iconised features. Full text detail
            (description, model name, tool/skill lists, connections, webhooks) lives
            in the detail pane on the right. Keeps the list row short and scannable. */}
        <div className="agent-feature-icons mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <span className="min-w-0 truncate text-xs opacity-70" title={handleLabel}>{handleLabel}</span>
          <FeatureIcon
            icon={agent.run_mode === 'daemon' ? Monitor : Bot}
            label={agent.run_mode === 'daemon' ? 'Remote daemon' : 'Built-in agent'}
          />
          <FeatureIcon icon={Brain} label={`Model: ${modelLabel}`} />
          {tools.length > 0 && (
            <FeatureIcon icon={Wrench} label={`Tools: ${tools.join(', ')}`} count={tools.length} />
          )}
          {skills.length > 0 && (
            <FeatureIcon icon={Sparkles} label={`Skills: ${skills.join(', ')}`} count={skills.length} />
          )}
          {webhooks.length > 0 && (
            <FeatureIcon icon={Link2} label={`${webhooks.length} webhook${webhooks.length === 1 ? '' : 's'}`} count={webhooks.length} />
          )}
          <ConnectionDot count={activeConnections.length} busy={busy} title={selfNote || undefined} />
          {!agentActive && <FeatureIcon icon={Power} label="Deactivated" muted />}
        </div>
        {activeConnections.length > 0 && (
          <div className="agents-list-expanded-meta mt-2 flex flex-col gap-1">
            {activeConnections.slice(0, 3).map(connection => {
              // Self-declared status the agent wrote to its status.json, folded into the
              // heartbeat metadata by the daemon (agentStatus / agentNote).
              const agentStatus = typeof connection.metadata?.agentStatus === 'string' ? connection.metadata.agentStatus : '';
              const agentNote = typeof connection.metadata?.agentNote === 'string' ? connection.metadata.agentNote : '';
              const selfStatus = [agentStatus, agentNote].filter(Boolean).join(' — ');
              return (
                <div key={connection.id} className="agent-meta-row flex min-w-0 flex-col gap-0.5 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground" title={[connection.status, connection.host, connection.cwd].filter(Boolean).join(' - ')}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Monitor className="size-3 shrink-0" />
                    <span className="shrink-0 font-medium text-foreground">Daemon</span>
                    <span className="shrink-0">{connection.status}</span>
                    <span className="min-w-0 flex-1 truncate opacity-75">{connection.host || connection.cwd || 'remote'}</span>
                  </div>
                  {selfStatus && (
                    <div className="min-w-0 truncate pl-[18px] italic opacity-90" title={selfStatus}>{selfStatus}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {webhooks.length > 0 && (
          <div className="agents-list-expanded-meta mt-2 flex flex-col gap-1.5">
            {webhooks.map(webhook => {
              const url = webhookUrl(webhook.token);
              return (
                <div
                  key={webhook.id}
                  className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                >
                  <Link2 className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={url}>Webhook URL</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void navigator.clipboard?.writeText(url)}
                    aria-label={`Copy webhook for ${agent.name}`}
                  >
                    <Copy />
                  </Button>
                  <Button
                    type="button"
                    variant={webhook.enabled ? 'secondary' : 'ghost'}
                    size="icon-xs"
                    onClick={() => onToggleWebhook(webhook, !webhook.enabled)}
                    aria-label={webhook.enabled ? `Disable webhook for ${agent.name}` : `Enable webhook for ${agent.name}`}
                    title={webhook.enabled ? 'Enabled' : 'Disabled'}
                  >
                    <Power />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </ItemContent>
      <ItemActions className="agents-list-row-actions ml-11 mt-2 basis-full justify-end pr-1">
        <Button
          type="button"
          variant={agentActive ? 'secondary' : 'ghost'}
          size="icon-xs"
          onClick={(event) => {
            event.stopPropagation();
            onToggleEnabled();
          }}
          aria-label={agentActive ? `Deactivate ${agent.name}` : `Activate ${agent.name}`}
          title={agentActive ? 'Deactivate agent' : 'Activate agent'}
        >
          <Power />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onConnect();
          }}
          disabled={!agentActive}
          aria-label={`Connect ${agent.name}`}
        >
          <Plug data-icon="inline-start" />
          Connect
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onEdit} aria-label={`Edit ${agent.name}`}>
          <Pencil />
        </Button>
        <Button
          type="button"
          variant={confirmDelete ? 'destructive' : 'ghost'}
          size="icon-xs"
          onClick={onDelete}
          aria-label={confirmDelete ? `Confirm delete ${agent.name}` : `Delete ${agent.name}`}
        >
          <Trash2 />
        </Button>
      </ItemActions>
    </Item>
  );
}

function AgentDetailPane({
  agent,
  isEditing,
  confirmDelete,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onToggleEnabled,
  capabilities,
  webhooks,
  connections,
  onConnect,
  onToggleWebhook,
}: {
  agent: WorkspaceAgent | null;
  isEditing: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Partial<WorkspaceAgent>) => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  capabilities: SystemCapabilities | null;
  webhooks: AgentWebhook[];
  connections: AgentConnection[];
  onConnect: () => void;
  onToggleWebhook: (webhook: AgentWebhook, enabled: boolean) => Promise<AgentWebhook | null>;
}) {
  const [editName, setEditName] = useState('');
  const [editAvatar, setEditAvatar] = useState(DEFAULT_AGENT_AVATAR);
  const [editOpenPetAvatarId, setEditOpenPetAvatarId] = useState('');
  const [editAccentColor, setEditAccentColor] = useState(DEFAULT_AGENT_ACCENT);
  const [editHandle, setEditHandle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSystemPrompt, setEditSystemPrompt] = useState('');
  const [editSoul, setEditSoul] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editTools, setEditTools] = useState('');
  const [editSkills, setEditSkills] = useState('');
  const [editModel, setEditModel] = useState('auto');
  const [editRunMode, setEditRunMode] = useState<'builtin' | 'daemon'>('builtin');

  useEffect(() => {
    if (!agent) return;
    setEditName(agent.name);
    setEditAvatar(agent.avatar || DEFAULT_AGENT_AVATAR);
    setEditOpenPetAvatarId(agent.openpet_avatar_id || '');
    setEditAccentColor(agentAccentColor(agent));
    setEditHandle(agent.handle || agentHandle(agent.name));
    setEditDescription(agent.description || '');
    setEditSystemPrompt(agent.system_prompt || '');
    setEditSoul(agent.soul || '');
    setEditInstructions(agent.instructions || '');
    setEditTools(joinList(agent.tools));
    setEditSkills(joinList(agent.skills));
    setEditModel(agent.model || 'auto');
    setEditRunMode(agent.run_mode === 'daemon' ? 'daemon' : 'builtin');
  }, [agent?.id]);

  if (!agent) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>Select an agent</EmptyTitle>
          <EmptyDescription>Choose an agent from the list to view details or edit its setup.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const activeConnections = connections.filter(connection => connection.status !== 'offline');
  const tools = normalizeList(agent.tools);
  const skills = normalizeList(agent.skills);
  const agentActive = isAgentActive(agent);

  const handleSave = () => {
    onSave({
      name: editName.trim(),
      avatar: editAvatar.trim() || DEFAULT_AGENT_AVATAR,
      openpet_avatar_id: editOpenPetAvatarId,
      accent_color: validAgentAccentColor(editAccentColor),
      handle: editHandle.trim() || agentHandle(editName),
      description: editDescription.trim(),
      system_prompt: editSystemPrompt.trim(),
      soul: editSoul.trim(),
      instructions: editInstructions.trim(),
      tools: splitList(editTools),
      skills: splitList(editSkills),
      model: editModel,
      run_mode: editRunMode,
    });
  };

  if (isEditing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" style={agentAccentStyle(agent)}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <Pencil className="size-4 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">Edit {agent.name}</span>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onCancelEdit} aria-label="Close editor">
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <AgentForm
            name={editName}
            avatar={editAvatar}
            openPetAvatarId={editOpenPetAvatarId}
            accentColor={editAccentColor}
            handle={editHandle}
            description={editDescription}
            systemPrompt={editSystemPrompt}
            soul={editSoul}
            instructions={editInstructions}
            tools={editTools}
            skills={editSkills}
            model={editModel}
            runMode={editRunMode}
            capabilities={capabilities}
            onNameChange={setEditName}
            onAvatarChange={(value) => {
              setEditAvatar(value);
              setEditOpenPetAvatarId('');
            }}
            onOpenPetAvatarChange={(pet) => {
              setEditAvatar(openPetAvatarSrc(pet));
              setEditOpenPetAvatarId(pet.id);
            }}
            onAccentColorChange={setEditAccentColor}
            onHandleChange={setEditHandle}
            onDescriptionChange={setEditDescription}
            onSystemPromptChange={setEditSystemPrompt}
            onSoulChange={setEditSoul}
            onInstructionsChange={setEditInstructions}
            onToolsChange={setEditTools}
            onSkillsChange={setEditSkills}
            onModelChange={setEditModel}
            onRunModeChange={setEditRunMode}
            onCancel={onCancelEdit}
            onSubmit={handleSave}
            submitLabel="Save"
            submitIcon={<Save data-icon="inline-start" />}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={agentAccentStyle(agent)}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Bot className="size-4 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">Agent details</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onEdit} aria-label={`Edit ${agent.name}`}>
          <Pencil />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="agent-detail-summary flex min-w-0 items-stretch gap-3 rounded-lg border bg-muted/25 p-3">
          <div className="agent-detail-avatar grid min-h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted text-lg font-semibold sm:w-28">
            <AgentAvatarPreview value={agent.avatar || DEFAULT_AGENT_AVATAR} className="size-full" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{agent.name}</div>
            <div className="text-sm text-muted-foreground">@{agent.handle || agentHandle(agent.name)}</div>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{agent.description || 'No description'}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge variant={agent.run_mode === 'daemon' ? 'default' : 'outline'}>
                {agent.run_mode === 'daemon' ? 'remote daemon' : 'built-in'}
              </Badge>
              <Badge variant="outline">{displayModel(agent.model)}</Badge>
              <ConnectionDot count={activeConnections.length} busy={activeConnections.some(c => c.status === 'busy')} />
              {!agentActive && <Badge variant="secondary">deactivated</Badge>}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant={agentActive ? 'secondary' : 'outline'}
            size="sm"
            onClick={onToggleEnabled}
          >
            <Power data-icon="inline-start" />
            {agentActive ? 'Deactivate' : 'Activate'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onConnect}
            disabled={!agentActive}
          >
            <Plug data-icon="inline-start" />
            Connect
          </Button>
          <Button
            type="button"
            variant={confirmDelete ? 'destructive' : 'ghost'}
            size="sm"
            onClick={onDelete}
          >
            <Trash2 data-icon="inline-start" />
            {confirmDelete ? 'Confirm delete' : 'Delete'}
          </Button>
        </div>

        <div className="mt-3 grid gap-3">
          <AgentDetailSection title="Runtime">
            <AgentDetailField label="Mode" value={agent.run_mode === 'daemon' ? 'Remote daemon' : 'Built-in'} />
            <AgentDetailField label="Model" value={displayModel(agent.model)} />
            <AgentDetailField label="Updated" value={formatAgentDate(agent.updated_at)} />
          </AgentDetailSection>

          {activeConnections.length > 0 && (
            <AgentDetailSection title="Connections">
              <div className="space-y-1.5">
                {activeConnections.map(connection => {
                  // A freshly-connected daemon can arrive with `capabilities` present but its
                  // skills/clis/mcpServers arrays not yet populated (the capability payload lands on
                  // a later heartbeat). Coerce every field to an array before reading `.length` so a
                  // single in-flight connection row can never white-screen the whole workspace.
                  const caps = connection.capabilities;
                  const capSkills = Array.isArray(caps?.skills) ? caps.skills : [];
                  const capClis = Array.isArray(caps?.clis) ? caps.clis : [];
                  const capMcpServers = Array.isArray(caps?.mcpServers) ? caps.mcpServers : [];
                  const capSharedModels = Array.isArray(caps?.sharedModels) ? caps.sharedModels : [];
                  const hasCapabilities = capSkills.length > 0 || capClis.length > 0 || capMcpServers.length > 0 || capSharedModels.length > 0;
                  return (
                    <div key={connection.id} className="rounded-md border bg-muted/35 px-2 py-1.5 text-xs">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Monitor className="size-3 shrink-0" />
                        <span className="font-medium text-foreground">{connection.status}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{connection.host || connection.cwd || 'remote'}</span>
                        {connection.last_seen_at && (
                          <span className="shrink-0 text-muted-foreground/70" title={`Last heartbeat: ${formatAgentDate(connection.last_seen_at)}`}>
                            HB {formatRelativeTime(connection.last_seen_at)}
                          </span>
                        )}
                      </div>
                      {connection.cwd && <div className="mt-1 truncate text-muted-foreground" title={connection.cwd}>{connection.cwd}</div>}
                      {hasCapabilities && (
                        <div className="mt-1.5 space-y-1">
                          {capSkills.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">Skills:</span>
                              {capSkills.slice(0, 8).map(s => (
                                <span key={s} className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{s}</span>
                              ))}
                              {capSkills.length > 8 && <span className="text-muted-foreground/60">+{capSkills.length - 8}</span>}
                            </div>
                          )}
                          {capClis.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">CLIs:</span>
                              {capClis.map(c => (
                                <span key={c} className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono text-muted-foreground">{c}</span>
                              ))}
                            </div>
                          )}
                          {capMcpServers.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">MCP:</span>
                              {capMcpServers.slice(0, 6).map(m => (
                                <span key={m} className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{m}</span>
                              ))}
                              {capMcpServers.length > 6 && <span className="text-muted-foreground/60">+{capMcpServers.length - 6}</span>}
                            </div>
                          )}
                          {capSharedModels.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">Shared models:</span>
                              {capSharedModels.slice(0, 6).map(model => (
                                <span key={model.id} className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{model.name || model.id}</span>
                              ))}
                              {capSharedModels.length > 6 && <span className="text-muted-foreground/60">+{capSharedModels.length - 6}</span>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </AgentDetailSection>
          )}

          <AgentDetailTokenSection title="Tools" items={tools} empty="No tools configured" />
          <AgentDetailTokenSection title="Skills" items={skills} empty="No skills configured" />

          {agent.system_prompt && (
            <AgentDetailSection title="System prompt">
              <p className="max-h-36 overflow-auto whitespace-pre-wrap text-sm leading-relaxed">{agent.system_prompt}</p>
            </AgentDetailSection>
          )}
          {agent.instructions && (
            <AgentDetailSection title="Instructions">
              <p className="max-h-36 overflow-auto whitespace-pre-wrap text-sm leading-relaxed">{agent.instructions}</p>
            </AgentDetailSection>
          )}
          {agent.soul && (
            <AgentDetailSection title="Soul">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{agent.soul}</p>
            </AgentDetailSection>
          )}

          {webhooks.length > 0 && (
            <AgentDetailSection title="Webhooks">
              <div className="space-y-1.5">
                {webhooks.map(webhook => {
                  const url = webhookUrl(webhook.token);
                  return (
                    <div key={webhook.id} className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/35 px-2 py-1 text-xs">
                      <Link2 className="size-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate" title={url}>{webhook.name}</span>
                      <Button type="button" variant="ghost" size="icon-xs" onClick={() => void navigator.clipboard?.writeText(url)} aria-label={`Copy webhook for ${agent.name}`}>
                        <Copy />
                      </Button>
                      <Button
                        type="button"
                        variant={webhook.enabled ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        onClick={() => onToggleWebhook(webhook, !webhook.enabled)}
                        aria-label={webhook.enabled ? `Disable webhook for ${agent.name}` : `Enable webhook for ${agent.name}`}
                        title={webhook.enabled ? 'Enabled' : 'Disabled'}
                      >
                        <Power />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </AgentDetailSection>
          )}
        </div>
      </div>
    </div>
  );
}

interface SkillManifest {
  mcp: { endpoint: string; transport: string; tokenPlaceholder: string; configTemplate: unknown };
  install: { skillUrl: string; curlSkill: string; claudeMcpAdd: string };
  prompt: string;
  tools: Array<{ name: string; description: string }>;
}

type ConnectTab = 'cli' | 'mcp' | 'webhook';

// A short benefit line + a caveat, shown at the top of each Connect tab so the
// human picks the right connection method without guessing.
function ConnectExplainer({ benefit, note }: { benefit: string; note: string }) {
  return (
    <div className="rounded-lg border bg-muted/25 p-3 text-xs">
      <p className="text-foreground">{benefit}</p>
      <p className="mt-1.5 flex items-start gap-1.5 text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3 shrink-0" />
        <span>{note}</span>
      </p>
    </div>
  );
}

// One unified per-agent Connect dialog: CLI (local daemon), MCP client, or Webhook.
// Every tab is auto-scoped to `agent`, so there is no picker — you open it from the
// agent you want to connect. Replaces the old scattered Connect / Configure MCP /
// Webhook buttons and the workspace ConfigureMcpDialog.
function AgentConnectDialog({
  agent,
  open,
  onOpenChange,
  webhooks,
  onCreateWebhook,
  onToggleWebhook,
}: {
  agent: WorkspaceAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  webhooks: AgentWebhook[];
  onCreateWebhook: () => Promise<AgentWebhook | null>;
  onToggleWebhook: (webhook: AgentWebhook, enabled: boolean) => Promise<AgentWebhook | null>;
}) {
  const [tab, setTab] = useState<ConnectTab>('cli');

  // CLI (local daemon)
  const [cliCommand, setCliCommand] = useState('');
  const [cliError, setCliError] = useState('');
  const [cliBusy, setCliBusy] = useState(false);

  // MCP client
  const [manifest, setManifest] = useState<SkillManifest | null>(null);
  const [loadError, setLoadError] = useState('');
  const [token, setToken] = useState('');
  const [generating, setGenerating] = useState(false);
  const [tokenError, setTokenError] = useState('');

  // Webhook
  const [creatingWebhook, setCreatingWebhook] = useState(false);

  const handle = agent ? (agent.handle || agentHandle(agent.name)) : '';

  // Reset everything per-open: never carry a command/token across opens.
  useEffect(() => {
    if (!open) return;
    setTab('cli');
    setCliCommand('');
    setCliError('');
    setManifest(null);
    setLoadError('');
    setToken('');
    setTokenError('');
  }, [open, agent?.id]);

  // Load the MCP skill manifest once the dialog is open for an agent.
  useEffect(() => {
    if (!open || !agent) return;
    let cancelled = false;
    const params = new URLSearchParams({ name: agent.name, handle });
    fetch(apiUrl(`/backend/skill?${params.toString()}`), { headers: { ...apiAuthHeaders() } })
      .then(async (res) => {
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !payload?.data) {
          setLoadError('Could not load the MCP skill manifest from the backend.');
          return;
        }
        setManifest(payload.data as SkillManifest);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not reach the backend to load MCP details.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, agent?.id, agent?.name, handle]);

  if (!agent) return null;

  const placeholder = manifest?.mcp.tokenPlaceholder || 'aga_YOUR_AGENT_TOKEN';
  const withToken = (text: string) => (token ? text.split(placeholder).join(token) : text);
  const configJson = manifest ? withToken(JSON.stringify(manifest.mcp.configTemplate, null, 2)) : '';
  const claudeMcpAdd = manifest ? withToken(manifest.install.claudeMcpAdd) : '';

  const handleGenerateCli = async () => {
    setCliBusy(true);
    setCliError('');
    try {
      const response = await fetch(apiUrl(`/backend/agents/${agent.id}/connection-command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ handle, baseUrl: apiBaseUrl() }),
      });
      const payload = await response.json().catch(() => null);
      const command = payload?.data?.portableCommand || payload?.data?.command || payload?.data?.localCommand || '';
      if (!response.ok || !command) {
        setCliError(payload?.error?.message || 'Daemon websocket backend is not available.');
        return;
      }
      setCliCommand(command);
      void navigator.clipboard?.writeText(command);
    } catch {
      setCliError('Could not create a daemon connection command.');
    } finally {
      setCliBusy(false);
    }
  };

  const handleGenerateToken = async () => {
    setGenerating(true);
    setTokenError('');
    try {
      const response = await fetch(apiUrl(`/backend/agents/${agent.id}/connection-command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ handle, baseUrl: apiBaseUrl() }),
      });
      const payload = await response.json().catch(() => null);
      const newToken = payload?.data?.token || '';
      if (!response.ok || !newToken) {
        setTokenError(payload?.error?.message || 'Could not mint an agent token.');
        return;
      }
      setToken(newToken);
    } catch {
      setTokenError('Could not reach the backend to mint a token.');
    } finally {
      setGenerating(false);
    }
  };

  const handleCreateWebhook = async () => {
    setCreatingWebhook(true);
    try {
      await onCreateWebhook();
    } finally {
      setCreatingWebhook(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Plug className="size-4 text-primary" />
            Connect {agent.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Choose how something connects to @{handle} — a local CLI daemon, an MCP client, or an HTTP webhook.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as ConnectTab)} className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-4 pt-3">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="cli" className="gap-1.5"><Terminal className="size-3.5" />CLI</TabsTrigger>
              <TabsTrigger value="mcp" className="gap-1.5"><Plug className="size-3.5" />MCP</TabsTrigger>
              <TabsTrigger value="webhook" className="gap-1.5"><Link2 className="size-3.5" />Webhook</TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* CLI — local daemon */}
            <TabsContent value="cli" className="mt-0 space-y-4">
              <ConnectExplainer
                benefit={`Full power. Runs @${handle} on your machine with real tools — edit files, run shells, local MCP. Best for coding agents.`}
                note="Needs the agensis CLI installed, and the agent only runs while your daemon is up."
              />
              <McpDialogSection icon={Terminal} title="Daemon connect command">
                <p className="text-xs text-muted-foreground">
                  Generate a one-line command, then run it where the daemon should execute. It&apos;s copied to your clipboard.
                </p>
                <Button type="button" size="sm" className="mt-2" onClick={handleGenerateCli} disabled={cliBusy}>
                  <RefreshCw data-icon="inline-start" className={cliBusy ? 'animate-spin' : undefined} />
                  {cliCommand ? 'Regenerate command' : 'Generate connect command'}
                </Button>
                {cliCommand && <CopyBlock value={cliCommand} className="mt-2" />}
                {cliError && <div className="mt-2 text-xs text-destructive">{cliError}</div>}
              </McpDialogSection>
            </TabsContent>

            {/* MCP client */}
            <TabsContent value="mcp" className="mt-0 space-y-4">
              <ConnectExplainer
                benefit={`Plug any MCP client (Claude Code, Cursor, Codex) into @${handle} with one token — no daemon required.`}
                note="The token authenticates as this agent; generating a new one replaces the old token."
              />
              {loadError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {loadError}
                </div>
              )}

              {/* Token */}
              <McpDialogSection icon={KeyRound} title="1. API key (agent token)">
                <p className="text-xs text-muted-foreground">
                  The token authenticates the agent as @{handle}. Tokens are stored hashed and shown
                  once — copy it now.
                </p>
                <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>Generating a token replaces the agent&apos;s previous one. If a daemon is
                    running for this agent, update it with the new token too.</span>
                </div>
                {token ? (
                  <CopyField value={token} label="Agent token" mono />
                ) : (
                  <div className="mt-2 text-xs text-muted-foreground">
                    No token generated yet — the config below uses a <code>{placeholder}</code> placeholder.
                  </div>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={token ? 'outline' : 'default'}
                  className="mt-2"
                  onClick={handleGenerateToken}
                  disabled={generating}
                >
                  <RefreshCw data-icon="inline-start" className={generating ? 'animate-spin' : undefined} />
                  {token ? 'Regenerate token' : 'Generate token'}
                </Button>
                {tokenError && <div className="mt-2 text-xs text-destructive">{tokenError}</div>}
              </McpDialogSection>

              {/* Endpoint + config */}
              <McpDialogSection icon={Globe} title="2. MCP endpoint & config">
                {manifest && <CopyField value={manifest.mcp.endpoint} label="Endpoint" mono />}
                <p className="mt-3 mb-1 text-xs text-muted-foreground">
                  Claude Code one-liner:
                </p>
                {manifest && <CopyBlock value={claudeMcpAdd} />}
                <p className="mt-3 mb-1 text-xs text-muted-foreground">
                  Or paste into your MCP client config (Claude Code <code>.mcp.json</code>, Codex
                  <code> ~/.codex/config.toml</code>, etc.):
                </p>
                {manifest && <CopyBlock value={configJson} />}
              </McpDialogSection>

              {/* Prompt */}
              <McpDialogSection icon={Sparkles} title="3. Agent prompt (optional)">
                <p className="text-xs text-muted-foreground">
                  Paste this into the agent so it knows it&apos;s now an agensis teammate and how to behave.
                </p>
                {manifest && <CopyBlock value={manifest.prompt} className="mt-2 max-h-44" />}
              </McpDialogSection>

              {/* Skill / marketplace */}
              <McpDialogSection icon={Wrench} title="4. Install as a skill (agentskills.io)">
                <p className="text-xs text-muted-foreground">
                  Give the agent durable know-how via the open Agent Skills format. Drop the skill into
                  any compatible client:
                </p>
                {manifest && <CopyBlock value={manifest.install.curlSkill} className="mt-2" />}
                <p className="mt-2 text-xs text-muted-foreground">
                  Claude Code plugin marketplace (git-hosted): add this repo, then install the
                  <code> agensis</code> plugin:
                </p>
                <CopyBlock
                  value={'/plugin marketplace add <your-org>/agensis\n/plugin install agensis@agensis'}
                  className="mt-2"
                />
              </McpDialogSection>
            </TabsContent>

            {/* Webhook */}
            <TabsContent value="webhook" className="mt-0 space-y-4">
              <ConnectExplainer
                benefit={`Trigger @${handle} over HTTP from anything — CI, cron, Zapier, a curl one-liner.`}
                note="One-way fire-and-forget, not a live connection. Treat the URL as a secret — anyone with it can post to this agent."
              />
              <McpDialogSection icon={Link2} title="Webhook URLs">
                {webhooks.length > 0 ? (
                  <div className="space-y-1.5">
                    {webhooks.map(webhook => {
                      const url = webhookUrl(webhook.token);
                      return (
                        <div key={webhook.id} className="flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
                          <Link2 className="size-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate" title={url}>{webhook.name}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => void navigator.clipboard?.writeText(url)}
                            aria-label={`Copy webhook for ${agent.name}`}
                          >
                            <Copy />
                          </Button>
                          <Button
                            type="button"
                            variant={webhook.enabled ? 'secondary' : 'ghost'}
                            size="icon-xs"
                            onClick={() => onToggleWebhook(webhook, !webhook.enabled)}
                            aria-label={webhook.enabled ? `Disable webhook for ${agent.name}` : `Enable webhook for ${agent.name}`}
                            title={webhook.enabled ? 'Enabled' : 'Disabled'}
                          >
                            <Power />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No webhooks yet. Create one to get a signed URL.</p>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={webhooks.length ? 'outline' : 'default'}
                  className="mt-2"
                  onClick={handleCreateWebhook}
                  disabled={creatingWebhook}
                >
                  <Plus data-icon="inline-start" />
                  {creatingWebhook ? 'Creating…' : 'Create webhook'}
                </Button>
              </McpDialogSection>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function McpDialogSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-muted/25 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </div>
      {children}
    </section>
  );
}

function CopyField({ value, label, mono }: { value: string; label: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <code className={cn('min-w-0 flex-1 truncate', mono && 'font-mono')} title={value}>{value}</code>
      <Button type="button" variant="ghost" size="icon-xs" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function CopyBlock({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className={cn('relative rounded-md border bg-background', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1 z-10"
        onClick={copy}
        aria-label="Copy"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <pre className="max-h-full overflow-auto whitespace-pre-wrap break-words p-2 pr-8 text-xs leading-relaxed">{value}</pre>
    </div>
  );
}

function ConnectionDot({ count, busy = false, title }: { count: number; busy?: boolean; title?: string }) {
  const connected = count > 0;
  // Match the three-tier presence palette used by the sidebar dots and the
  // notifications bell: online = emerald, busy = amber (pulsing), offline = grey.
  const tone = !connected ? 'bg-muted-foreground/40' : busy ? 'bg-amber-500' : 'bg-emerald-500';
  const baseLabel = !connected
    ? 'Not connected'
    : busy
      ? `${count} daemon ${count === 1 ? 'connection' : 'connections'} · working`
      : `${count} daemon ${count === 1 ? 'connection' : 'connections'}`;
  // `title` carries the agent's self-declared status note when present, appended so the
  // hover tooltip shows both the connection state and what the agent is doing.
  const label = title ? `${baseLabel} — ${title}` : baseLabel;
  return (
    <Badge variant="outline" className="gap-1 px-1.5" title={label} aria-label={label}>
      <span className={cn('size-1.5 rounded-full', tone, busy && 'animate-pulse')} aria-hidden />
      {connected && count > 1 ? count : null}
    </Badge>
  );
}

// A single iconised feature in the compact agent-list row: an icon with a hover
// tooltip and an optional count. The label (full text) is what the detail pane spells
// out; here it is only a tooltip so the row stays short.
function FeatureIcon({
  icon: Icon,
  label,
  count,
  muted = false,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  muted?: boolean;
}) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-xs', muted && 'opacity-50')}
      title={label}
      aria-label={label}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {typeof count === 'number' && count > 1 ? <span className="tabular-nums">{count}</span> : null}
    </span>
  );
}

function AgentDetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="agent-detail-section rounded-lg border bg-muted/25 p-3">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

function AgentDetailField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/60 py-1.5 first:pt-0 last:border-b-0 last:pb-0">
      <span className="shrink-0 text-sm font-semibold text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium" title={value}>{value}</span>
    </div>
  );
}

function AgentDetailTokenSection({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <AgentDetailSection title={title}>
      {items.length > 0 ? (
        <div className="agent-token-row flex flex-wrap gap-1.5">
          {items.map(item => <Badge key={item} variant="outline" className="agent-token-chip" title={item}>{item}</Badge>)}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{empty}</div>
      )}
    </AgentDetailSection>
  );
}

function formatAgentDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Compact "time since last heartbeat" for the profile panel — "3s" / "5m" / "2h" / "4d".
function formatRelativeTime(value?: string | null) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function modelOptions(current: string) {
  if (!current || AI_MODELS.some(model => model.id === current)) {
    return AI_MODELS;
  }
  return [{ id: current, label: current, description: 'Saved model' }, ...AI_MODELS];
}

function AgentAvatarPreview({ value, className }: { value?: string | null; className?: string }) {
  const avatar = value || DEFAULT_AGENT_AVATAR;
  const iconChoice = getAgentIconChoice(avatar);
  if (isPetSpritesheetAvatar(avatar)) {
    return (
      <span className={cn('animated-pet-avatar-shell', className)}>
        <span className="animated-pet-avatar" style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }} />
      </span>
    );
  }
  if (isImageAvatar(avatar)) {
    return <img src={renderablePetAssetUrl(avatar)} alt="" className={cn('size-full object-contain', className)} loading="lazy" draggable={false} />;
  }
  if (iconChoice) {
    const Icon = iconChoice.icon;
    return (
      <span className={cn('grid size-full place-items-center text-muted-foreground', className)}>
        <Icon className="size-5" />
      </span>
    );
  }
  return (
    <span className={cn('grid size-full place-items-center text-sm font-semibold', className)}>
      {avatar.slice(0, 2).toUpperCase()}
    </span>
  );
}

function getAgentIconChoice(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase();
  return AGENT_ICON_CHOICES.find(choice => choice.value === normalized) || null;
}

function displayModel(model?: string | null) {
  const option = AI_MODELS.find(entry => entry.id === model);
  return option?.label || model || 'Auto';
}

function splitList(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeList(value: unknown): string[] {
  const out: string[] = [];

  const objectToken = (input: Record<string, unknown>) => {
    for (const key of ['label', 'name', 'id', 'type']) {
      const token = input[key];
      if (typeof token === 'string' && token.trim()) return token.trim();
    }
    return '';
  };

  const visit = (input: unknown, depth: number) => {
    if (input == null) return;
    if (Array.isArray(input)) {
      input.forEach(item => visit(item, depth));
      return;
    }
    if (typeof input === 'object') {
      const token = objectToken(input as Record<string, unknown>);
      if (token) visit(token, depth);
      return;
    }

    const str = String(input).trim();
    if (!str) return;

    // Unwrap values that have been JSON-stringified one or more times
    // (e.g. `["[\"[]\"]"]`), which would otherwise leak through as literal tokens.
    if (depth < 8 && (str.startsWith('[') || str.startsWith('{') || str.startsWith('"'))) {
      try {
        const parsed = JSON.parse(str);
        if (typeof parsed !== 'string' || parsed !== str) {
          visit(parsed, depth + 1);
          return;
        }
      } catch {
        // Not JSON — fall through and treat as a plain token.
      }
    }

    for (const part of str.includes(',') ? str.split(',') : [str]) {
      const token = part.trim();
      if (token && token !== '[]' && token !== '{}' && token !== '""') out.push(token);
    }
  };

  visit(value, 0);
  return Array.from(new Set(out));
}

function joinList(value: unknown) {
  return normalizeList(value).join(', ');
}

function addToken(value: string, token: string) {
  const next = new Set(splitList(value));
  next.add(token);
  return Array.from(next).join(', ');
}

function normalizeAgentKey(value?: string | null) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function agentMatchesKey(agent: WorkspaceAgent, key: string) {
  if (!key) return false;
  return [
    agent.id,
    agent.handle,
    agent.name,
    agentHandle(agent.name),
  ].some(value => normalizeAgentKey(value) === key);
}

function isAgentActive(agent: Pick<WorkspaceAgent, 'enabled'>) {
  return agent.enabled !== false;
}

type AgentPresence = 'busy' | 'idle' | 'disconnected' | 'inactive';

// One mutually-exclusive presence per agent, derived from the enabled flag and
// live daemon connections. Every agent lands in exactly one bucket.
function agentPresenceStatus(agent: WorkspaceAgent, connections: AgentConnection[]): AgentPresence {
  if (!isAgentActive(agent)) return 'inactive';
  const live = connections.filter(connection => connection.status !== 'offline');
  if (live.length === 0) return 'disconnected';
  return live.some(connection => connection.status === 'busy') ? 'busy' : 'idle';
}

const AGENT_PRESENCE_FILTERS: Array<{ key: AgentPresence; label: string; tone: string }> = [
  { key: 'busy', label: 'Busy', tone: 'bg-amber-500' },
  { key: 'idle', label: 'Idle', tone: 'bg-emerald-500' },
  { key: 'disconnected', label: 'Disconnected', tone: 'bg-muted-foreground/40' },
  { key: 'inactive', label: 'Inactive', tone: 'bg-rose-500' },
];

function agentHandle(value: string) {
  return String(value || 'agent')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

function webhookUrl(token: string) {
  const relative = apiUrl(`/backend/webhooks/${token}`);
  if (typeof window === 'undefined') return relative;
  return new URL(relative, window.location.origin).toString();
}
