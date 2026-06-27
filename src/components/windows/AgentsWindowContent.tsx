import { useEffect, useState } from 'react';
import { Bot, Copy, Link2, Pencil, Plus, Power, Save, Trash2, X } from 'lucide-react';
import { AI_MODELS, type AgentWebhook, type WorkspaceAgent } from '../../types';
import { apiUrl, getSystemCapabilities, type SystemCapabilities } from '../../lib/backendClient';
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
import { Textarea } from '@/components/ui/textarea';

interface AgentsWindowContentProps {
  agents: WorkspaceAgent[];
  webhooks: AgentWebhook[];
  onCreateAgent: (input: {
    name: string;
    avatar?: string;
    description?: string;
    system_prompt: string;
    soul?: string;
    instructions?: string;
    tools?: string[];
    skills?: string[];
    model?: string;
  }) => void;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
  onCreateWebhook: (input: { agent_id?: string | null; name: string }) => Promise<AgentWebhook | null>;
  onUpdateWebhook: (id: string, updates: Partial<AgentWebhook>) => Promise<AgentWebhook | null>;
}

const DEFAULT_AGENT_AVATAR = 'AI';

export function AgentsWindowContent({
  agents,
  webhooks,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onCreateWebhook,
  onUpdateWebhook,
}: AgentsWindowContentProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(DEFAULT_AGENT_AVATAR);
  const [newDescription, setNewDescription] = useState('');
  const [newSystemPrompt, setNewSystemPrompt] = useState('');
  const [newSoul, setNewSoul] = useState('');
  const [newInstructions, setNewInstructions] = useState('');
  const [newTools, setNewTools] = useState('');
  const [newSkills, setNewSkills] = useState('');
  const [newModel, setNewModel] = useState('auto');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);

  useEffect(() => {
    getSystemCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  const handleCreate = () => {
    if (!newName.trim() || !newSystemPrompt.trim()) return;
    onCreateAgent({
      name: newName.trim(),
      avatar: newAvatar.trim() || DEFAULT_AGENT_AVATAR,
      description: newDescription.trim(),
      system_prompt: newSystemPrompt.trim(),
      soul: newSoul.trim(),
      instructions: newInstructions.trim(),
      tools: splitList(newTools),
      skills: splitList(newSkills),
      model: newModel,
    });
    setNewName('');
    setNewAvatar(DEFAULT_AGENT_AVATAR);
    setNewDescription('');
    setNewSystemPrompt('');
    setNewSoul('');
    setNewInstructions('');
    setNewTools('');
    setNewSkills('');
    setNewModel('auto');
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
            description={newDescription}
            systemPrompt={newSystemPrompt}
            soul={newSoul}
            instructions={newInstructions}
            tools={newTools}
            skills={newSkills}
            model={newModel}
            capabilities={capabilities}
            onNameChange={setNewName}
            onAvatarChange={setNewAvatar}
            onDescriptionChange={setNewDescription}
            onSystemPromptChange={setNewSystemPrompt}
            onSoulChange={setNewSoul}
            onInstructionsChange={setNewInstructions}
            onToolsChange={setNewTools}
            onSkillsChange={setNewSkills}
            onModelChange={setNewModel}
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
              <EmptyDescription>Create an agent to add reusable AI tools to this workspace.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-1">
            {agents.map(agent => (
              <AgentRow
                key={agent.id}
                agent={agent}
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
  description,
  systemPrompt,
  soul,
  instructions,
  tools,
  skills,
  model,
  capabilities,
  onNameChange,
  onAvatarChange,
  onDescriptionChange,
  onSystemPromptChange,
  onSoulChange,
  onInstructionsChange,
  onToolsChange,
  onSkillsChange,
  onModelChange,
  onCancel,
  onSubmit,
  submitLabel,
  submitIcon,
}: {
  name: string;
  avatar: string;
  description: string;
  systemPrompt: string;
  soul: string;
  instructions: string;
  tools: string;
  skills: string;
  model: string;
  capabilities: SystemCapabilities | null;
  onNameChange: (value: string) => void;
  onAvatarChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onSoulChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
  onToolsChange: (value: string) => void;
  onSkillsChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitIcon: React.ReactNode;
}) {
  const options = modelOptions(model);
  const canSubmit = Boolean(name.trim() && systemPrompt.trim());

  return (
    <FieldGroup className="gap-3">
      <div className="grid grid-cols-[3rem_1fr] gap-2">
        <Field>
          <FieldLabel htmlFor="agent-avatar">Avatar</FieldLabel>
          <Input
            id="agent-avatar"
            value={avatar}
            onChange={e => onAvatarChange(e.target.value)}
            className="text-center"
          />
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
      </div>

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
          placeholder="System prompt"
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

      <div className="flex items-center gap-2">
        <NativeSelect
          value={model}
          onChange={e => onModelChange(e.target.value)}
          size="sm"
          className="max-w-56"
          aria-label="Agent model"
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
  isEditing,
  confirmDelete,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onCancelDelete,
  capabilities,
  webhooks,
  onCreateWebhook,
  onToggleWebhook,
}: {
  agent: WorkspaceAgent;
  isEditing: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Partial<WorkspaceAgent>) => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  capabilities: SystemCapabilities | null;
  webhooks: AgentWebhook[];
  onCreateWebhook: () => Promise<AgentWebhook | null>;
  onToggleWebhook: (webhook: AgentWebhook, enabled: boolean) => Promise<AgentWebhook | null>;
}) {
  const [editName, setEditName] = useState(agent.name);
  const [editAvatar, setEditAvatar] = useState(agent.avatar || DEFAULT_AGENT_AVATAR);
  const [editDescription, setEditDescription] = useState(agent.description || '');
  const [editSystemPrompt, setEditSystemPrompt] = useState(agent.system_prompt || '');
  const [editSoul, setEditSoul] = useState(agent.soul || '');
  const [editInstructions, setEditInstructions] = useState(agent.instructions || '');
  const [editTools, setEditTools] = useState(joinList(agent.tools));
  const [editSkills, setEditSkills] = useState(joinList(agent.skills));
  const [editModel, setEditModel] = useState(agent.model || 'auto');
  const [creatingWebhook, setCreatingWebhook] = useState(false);

  const handleSave = () => {
    onSave({
      name: editName.trim(),
      avatar: editAvatar.trim() || DEFAULT_AGENT_AVATAR,
      description: editDescription.trim(),
      system_prompt: editSystemPrompt.trim(),
      soul: editSoul.trim(),
      instructions: editInstructions.trim(),
      tools: splitList(editTools),
      skills: splitList(editSkills),
      model: editModel,
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

  if (isEditing) {
    return (
      <Item variant="outline" className="items-stretch">
        <ItemContent>
          <AgentForm
            name={editName}
            avatar={editAvatar}
            description={editDescription}
            systemPrompt={editSystemPrompt}
            soul={editSoul}
            instructions={editInstructions}
            tools={editTools}
            skills={editSkills}
            model={editModel}
            capabilities={capabilities}
            onNameChange={setEditName}
            onAvatarChange={setEditAvatar}
            onDescriptionChange={setEditDescription}
            onSystemPromptChange={setEditSystemPrompt}
            onSoulChange={setEditSoul}
            onInstructionsChange={setEditInstructions}
            onToolsChange={setEditTools}
            onSkillsChange={setEditSkills}
            onModelChange={setEditModel}
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
      className="hover:bg-muted/50"
      onMouseEnter={onCancelDelete}
    >
      <ItemMedia className="size-9 rounded-full bg-muted text-base">
        {agent.avatar || DEFAULT_AGENT_AVATAR}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full truncate">{agent.name}</ItemTitle>
        {agent.description ? (
          <ItemDescription>{agent.description}</ItemDescription>
        ) : (
          <ItemDescription>No description</ItemDescription>
        )}
        <div>
          <Badge variant="secondary">{displayModel(agent.model)}</Badge>
          {(agent.tools || []).slice(0, 3).map(tool => (
            <Badge key={tool} variant="outline" className="ml-1">{tool}</Badge>
          ))}
        </div>
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

function webhookUrl(token: string) {
  const relative = apiUrl(`/backend/webhooks/${token}`);
  if (typeof window === 'undefined') return relative;
  return new URL(relative, window.location.origin).toString();
}
