import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  Check,
  Code2,
  Command,
  Copy,
  Database,
  Globe,
  Link2,
  Monitor,
  Pencil,
  Plus,
  Power,
  Rocket,
  Save,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
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
  ItemDescription,
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
import { AGENT_AVATAR_CHOICES } from '../../lib/agentAvatars';
import { fetchFeaturedOpenPets, isImageAvatar, type OpenPet } from '../../lib/openpets';

interface AgentsWindowContentProps {
  agents: WorkspaceAgent[];
  webhooks: AgentWebhook[];
  connections?: AgentConnection[];
  focusedAgentKey?: string | null;
  onCreateAgent: (input: {
    name: string;
    avatar?: string;
    openpet_avatar_id?: string | null;
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

export function AgentsWindowContent({
  agents,
  webhooks,
  connections = [],
  focusedAgentKey,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onCreateWebhook,
  onUpdateWebhook,
}: AgentsWindowContentProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(DEFAULT_AGENT_AVATAR);
  const [newOpenPetAvatarId, setNewOpenPetAvatarId] = useState('');
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
  const normalizedFocusedAgentKey = normalizeAgentKey(focusedAgentKey);

  useEffect(() => {
    getSystemCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreateAgent({
      name: newName.trim(),
      avatar: newAvatar.trim() || DEFAULT_AGENT_AVATAR,
      openpet_avatar_id: newOpenPetAvatarId,
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
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Bot className="size-4 text-primary" />
        <span className="text-sm font-semibold">AI Agents</span>
        <Badge variant="secondary">{agents.length}</Badge>
        <div className="flex-1" />
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

      {showCreate && (
        <div className="shrink-0 border-b border-border bg-card p-3">
          <AgentForm
            name={newName}
            avatar={newAvatar}
            openPetAvatarId={newOpenPetAvatarId}
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
              setNewAvatar(pet.thumbnail);
              setNewOpenPetAvatarId(pet.id);
            }}
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

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
        ) : (
          <ItemGroup className="gap-1">
            {agents.map(agent => (
              <AgentRow
                key={agent.id}
                agent={agent}
                focused={agentMatchesKey(agent, normalizedFocusedAgentKey)}
                isEditing={editingId === agent.id}
                confirmDelete={confirmDeleteId === agent.id}
                onEdit={() => setEditingId(editingId === agent.id ? null : agent.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={(updates) => {
                  onUpdateAgent(agent.id, updates);
                  setEditingId(null);
                }}
                onDelete={() => handleDelete(agent.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                capabilities={capabilities}
                webhooks={webhooks.filter(webhook => webhook.agent_id === agent.id)}
                connections={connections.filter(connection => connection.agent_id === agent.id)}
                onCreateWebhook={() => onCreateWebhook({ agent_id: agent.id, name: `${agent.name} webhook` })}
                onToggleWebhook={(webhook, enabled) => onUpdateWebhook(webhook.id, { enabled })}
              />
            ))}
          </ItemGroup>
        )}
      </div>
    </div>
  );
}

function AgentForm({
  name,
  avatar,
  openPetAvatarId,
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
    <FieldGroup className="gap-3">
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
          <div className="agent-avatar-grid grid max-h-72 grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2 overflow-y-auto pr-1">
            {AGENT_AVATAR_CHOICES.map(choice => (
              <button
                key={choice.id}
                type="button"
                className={cn(
                  'flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-muted/40 p-1 transition hover:border-primary/60',
                  avatar === choice.src && 'border-primary ring-2 ring-primary/40',
                )}
                onClick={() => onAvatarChange(choice.src)}
                title={choice.label}
                aria-label={`Use ${choice.label} avatar`}
              >
                <img src={choice.src} alt="" className="size-full rounded-md object-contain" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="openpets" className="mt-0">
          {openPets.length > 0 ? (
            <div className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] gap-2 overflow-y-auto pr-1">
              {openPets.map(pet => (
                <button
                  key={pet.id}
                  type="button"
                  className={cn(
                    'flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-muted/40 p-1 transition hover:border-primary/60',
                    openPetAvatarId === pet.id && 'border-primary ring-2 ring-primary/40',
                  )}
                  onClick={() => onOpenPetAvatarChange(pet)}
                  title={pet.displayName}
                  aria-label={`Use ${pet.displayName} OpenPets avatar`}
                >
                  <img src={pet.thumbnail} alt="" className="size-full object-contain" loading="lazy" draggable={false} />
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
  isEditing,
  confirmDelete,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onCancelDelete,
  capabilities,
  webhooks,
  connections,
  onCreateWebhook,
  onToggleWebhook,
}: {
  agent: WorkspaceAgent;
  focused: boolean;
  isEditing: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Partial<WorkspaceAgent>) => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  capabilities: SystemCapabilities | null;
  webhooks: AgentWebhook[];
  connections: AgentConnection[];
  onCreateWebhook: () => Promise<AgentWebhook | null>;
  onToggleWebhook: (webhook: AgentWebhook, enabled: boolean) => Promise<AgentWebhook | null>;
}) {
  const [editName, setEditName] = useState(agent.name);
  const [editAvatar, setEditAvatar] = useState(agent.avatar || DEFAULT_AGENT_AVATAR);
  const [editOpenPetAvatarId, setEditOpenPetAvatarId] = useState(agent.openpet_avatar_id || '');
  const [editHandle, setEditHandle] = useState(agent.handle || agentHandle(agent.name));
  const [editDescription, setEditDescription] = useState(agent.description || '');
  const [editSystemPrompt, setEditSystemPrompt] = useState(agent.system_prompt || '');
  const [editSoul, setEditSoul] = useState(agent.soul || '');
  const [editInstructions, setEditInstructions] = useState(agent.instructions || '');
  const [editTools, setEditTools] = useState(joinList(agent.tools));
  const [editSkills, setEditSkills] = useState(joinList(agent.skills));
  const [editModel, setEditModel] = useState(agent.model || 'auto');
  const [editRunMode, setEditRunMode] = useState<'builtin' | 'daemon'>(agent.run_mode === 'daemon' ? 'daemon' : 'builtin');
  const [creatingWebhook, setCreatingWebhook] = useState(false);
  const [connectionCommand, setConnectionCommand] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const activeConnections = connections.filter(connection => connection.status !== 'offline');

  const handleSave = () => {
    onSave({
      name: editName.trim(),
      avatar: editAvatar.trim() || DEFAULT_AGENT_AVATAR,
      openpet_avatar_id: editOpenPetAvatarId,
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

  const handleCreateWebhook = async () => {
    setCreatingWebhook(true);
    try {
      await onCreateWebhook();
    } finally {
      setCreatingWebhook(false);
    }
  };

  const handleConnectionCommand = async () => {
    try {
      const response = await fetch(apiUrl(`/backend/agents/${agent.id}/connection-command`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...apiAuthHeaders(),
        },
        body: JSON.stringify({
          handle: editHandle || agent.handle || agentHandle(agent.name),
          baseUrl: apiBaseUrl(),
        }),
      });
      const payload = await response.json().catch(() => null);
      const command = payload?.data?.portableCommand || payload?.data?.command || payload?.data?.localCommand || '';
      if (!response.ok || !command) return;
      setConnectionCommand(command);
      setEditRunMode('daemon');
      await navigator.clipboard?.writeText(command);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      // Copy affordance stays idle; the backend error is not useful inline here.
    }
  };

  if (isEditing) {
    return (
      <Item variant="outline" className="items-stretch">
        <ItemContent>
          <AgentForm
            name={editName}
            avatar={editAvatar}
            openPetAvatarId={editOpenPetAvatarId}
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
              setEditAvatar(pet.thumbnail);
              setEditOpenPetAvatarId(pet.id);
            }}
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
      className={cn('hover:bg-muted/50', focused && 'border-primary/60 bg-primary/10 ring-1 ring-primary/30')}
      onMouseEnter={onCancelDelete}
    >
      <ItemMedia className="size-9 overflow-hidden rounded-full bg-muted text-base">
        <AgentAvatarPreview value={agent.avatar || DEFAULT_AGENT_AVATAR} className="size-full" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full truncate">{agent.name}</ItemTitle>
        {agent.description ? (
          <ItemDescription>{agent.description}</ItemDescription>
        ) : (
          <ItemDescription>No description</ItemDescription>
        )}
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">@{agent.handle || agentHandle(agent.name)}</Badge>
          <Badge variant={agent.run_mode === 'daemon' ? 'default' : 'secondary'}>
            {agent.run_mode === 'daemon' ? 'remote daemon' : 'built-in'}
          </Badge>
          <Badge variant="secondary">{displayModel(agent.model)}</Badge>
          <Badge variant={activeConnections.length > 0 ? 'default' : 'secondary'}>
            {activeConnections.length > 0 ? `${activeConnections.length} connected` : 'not connected'}
          </Badge>
          {(agent.tools || []).slice(0, 3).map(tool => <Badge key={tool} variant="outline">{tool}</Badge>)}
        </div>
        {activeConnections.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {activeConnections.slice(0, 3).map(connection => (
              <div key={connection.id} className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                <Monitor className="size-3 shrink-0" />
                <span className="font-medium text-foreground">{connection.status}</span>
                <span className="truncate">{connection.host || 'daemon'}</span>
                {connection.cwd && <span className="truncate opacity-75">{connection.cwd}</span>}
              </div>
            ))}
          </div>
        )}
        {connectionCommand && (
          <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <Terminal className="size-3 shrink-0" />
            <code className="min-w-0 flex-1 truncate">{connectionCommand}</code>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void navigator.clipboard?.writeText(connectionCommand)}
              aria-label={`Copy connection command for ${agent.name}`}
            >
              <Copy />
            </Button>
          </div>
        )}
        {webhooks.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {webhooks.map(webhook => {
              const url = webhookUrl(webhook.token);
              return (
                <div
                  key={webhook.id}
                  className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                >
                  <Link2 className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={url}>{url}</span>
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
      <ItemActions className="ml-auto">
        <Button
          type="button"
          variant={copyState === 'copied' ? 'secondary' : 'outline'}
          size="sm"
          onClick={handleConnectionCommand}
          aria-label={`Copy connection command for ${agent.name}`}
        >
          {copyState === 'copied' ? <Check data-icon="inline-start" /> : <Terminal data-icon="inline-start" />}
          {copyState === 'copied' ? 'Copied' : 'Connect'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={handleCreateWebhook}
          disabled={creatingWebhook}
          aria-label={`Create webhook for ${agent.name}`}
        >
          <Link2 />
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

function modelOptions(current: string) {
  if (!current || AI_MODELS.some(model => model.id === current)) {
    return AI_MODELS;
  }
  return [{ id: current, label: current, description: 'Saved model' }, ...AI_MODELS];
}

function AgentAvatarPreview({ value, className }: { value?: string | null; className?: string }) {
  const avatar = value || DEFAULT_AGENT_AVATAR;
  const iconChoice = getAgentIconChoice(avatar);
  if (isImageAvatar(avatar)) {
    return <img src={avatar} alt="" className={cn('size-full object-contain', className)} loading="lazy" draggable={false} />;
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

function joinList(value: string[] | null | undefined) {
  return (value || []).join(', ');
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
