import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@agensis/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@agensis/ui/components/dialog';
import { Input } from '@agensis/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@agensis/ui/components/native-select';
import { Textarea } from '@agensis/ui/components/textarea';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { CreateProjectInput, Project } from '../../hooks/useProjects';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { PROJECT_COLORS, PROJECT_ICONS, PROJECT_TEMPLATES } from '../../lib/pm/projectTemplates';
import { AssigneeOptions } from '../windows/AssigneeOptions';
import { ProjectIconTile } from './projectIcons';
import { projectIcon } from './projectIconMap';

// The New project dialog from the approved project mock. gr8r-studio's structure
// (name, description, icon, colour, lead, dates, templates with starter tasks)
// plus what agensis adds: each starter task can be assigned to a person or an
// agent, and an agent can be given a first task to draft the plan. Agents are
// never attached to the project itself, only to its tasks.

interface StarterTask {
  title: string;
  include: boolean;
  assigneeId: string;
}

/** A three-letter key from the name, e.g. "Website Redesign" gives "WEB". */
function deriveKey(name: string): string {
  const word = name.trim().split(/\s+/)[0] ?? '';
  return word.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
}

function dateToIso(value: string): string | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

export function NewProjectDialog({
  open,
  onOpenChange,
  members,
  agents,
  currentUserId,
  createProject,
  createTask,
  updateProject,
  onCreateChannel,
  onCreateBrief,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  currentUserId?: string;
  createProject: (input: CreateProjectInput) => Promise<unknown>;
  createTask: (input: CreateTaskInput) => unknown;
  /** Saves the channel and brief ids on the project. Needed for the two options below. */
  updateProject?: (id: string, updates: Partial<Pick<Project, 'channel_id' | 'brief_document_id'>>) => unknown;
  /** Creates a channel and returns its id, or null if it could not be made. Hides the option when absent. */
  onCreateChannel?: (name: string, description: string) => Promise<string | null>;
  /** Creates a brief document and returns its id, or null. Hides the option when absent. */
  onCreateBrief?: (title: string, content: string) => Promise<string | null>;
  onCreated?: (project: Project) => void;
}) {
  const activeAgents = useMemo(() => agents.filter(agent => agent.enabled !== false), [agents]);
  const firstAgentId = activeAgents[0]?.id ?? '';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<string>('folder');
  const [color, setColor] = useState('indigo');
  const [leadId, setLeadId] = useState(currentUserId ?? '');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [templateId, setTemplateId] = useState('blank');
  const [starters, setStarters] = useState<StarterTask[]>([]);
  const [draftPlan, setDraftPlan] = useState(false);
  const [draftAgentId, setDraftAgentId] = useState(firstAgentId);
  const [makeChannel, setMakeChannel] = useState(false);
  const [makeBrief, setMakeBrief] = useState(false);
  // Set once the project exists but an extra could not be made, so the dialog stays open to say so.
  const [created, setCreated] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const template = PROJECT_TEMPLATES.find(item => item.id === templateId) ?? PROJECT_TEMPLATES[0];

  // Picking a template loads its starter tasks. Tasks an agent suits are
  // pre-assigned to the first available agent; each one stays editable.
  useEffect(() => {
    setStarters(
      template.tasks.map(task => ({
        title: task.title,
        include: true,
        assigneeId: task.agent ? firstAgentId : '',
      })),
    );
  }, [template, firstAgentId]);

  // Reset when the dialog opens, so a cancelled draft does not leak into the next one.
  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setIcon('folder');
    setColor('indigo');
    setLeadId(currentUserId ?? '');
    setStartDate('');
    setDueDate('');
    setTemplateId('blank');
    setDraftPlan(false);
    setDraftAgentId(firstAgentId);
    setMakeChannel(false);
    setMakeBrief(false);
    setCreated(null);
    setError('');
  }, [open, currentUserId, firstAgentId]);

  const setStarter = (index: number, patch: Partial<StarterTask>) =>
    setStarters(current => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const row = (await createProject({
        name: trimmed,
        project_key: deriveKey(trimmed),
        description: description.trim(),
        icon,
        color,
        lead_id: leadId || null,
        start_date: dateToIso(startDate),
        due_date: dateToIso(dueDate),
      })) as Project | null;
      if (!row?.id) throw new Error('The project could not be saved.');
      // Starter tasks belong to the project. In order, so the list keeps the template's sequence.
      for (const starter of starters) {
        if (!starter.include) continue;
        await createTask({ title: starter.title, project_id: row.id, assignee_id: starter.assigneeId || null });
      }
      if (draftPlan && draftAgentId) {
        await createTask({ title: 'Draft project plan', project_id: row.id, assignee_id: draftAgentId, priority: 'high' });
      }
      // The optional extras come after the project and its tasks exist, so a failure here can
      // never lose the project. It is reported, and the dialog stays open to say which one failed.
      const failed: string[] = [];
      const links: Partial<Pick<Project, 'channel_id' | 'brief_document_id'>> = {};
      if (makeChannel && onCreateChannel) {
        const id = await onCreateChannel(trimmed, description.trim()).catch(() => null);
        if (id) links.channel_id = id;
        else failed.push('the channel');
      }
      if (makeBrief && onCreateBrief) {
        const id = await onCreateBrief(`${trimmed} brief`, description.trim()).catch(() => null);
        if (id) links.brief_document_id = id;
        else failed.push('the brief document');
      }
      if (Object.keys(links).length && updateProject) await updateProject(row.id, links);
      if (failed.length) {
        setCreated({ ...row, ...links });
        setError(`The project was created, but ${failed.join(' and ')} could not be made. You can add ${failed.length > 1 ? 'them' : 'it'} later.`);
        return;
      }
      onCreated?.({ ...row, ...links });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
    } finally {
      setBusy(false);
    }
  };

  const agentTaskCount = (items: { agent?: boolean }[]) => (activeAgents.length ? items.filter(item => item.agent).length : 0);

  return (
    <Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project groups tasks, a channel and documents for one body of work. Agents take part by being assigned its tasks.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-3 pb-5"
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-end gap-3">
            <ProjectIconTile icon={icon} color={color} size="lg" />
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium">
              Project name
              <Input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Website Redesign"
                aria-label="Project name"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Description
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What is this project about? Agents read this when they pick up one of its tasks."
              rows={2}
              aria-label="Description"
            />
          </label>

          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <div className="min-w-60 flex-1">
              <span className="mb-1.5 block text-sm font-medium">Icon</span>
              <div className="grid grid-cols-8 gap-1" role="radiogroup" aria-label="Icon">
                {PROJECT_ICONS.map(name => {
                  const Icon = projectIcon(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      role="radio"
                      aria-checked={icon === name}
                      aria-label={name}
                      onClick={() => setIcon(name)}
                      className={cn(
                        'grid h-9 place-items-center rounded-lg border text-muted-foreground transition-colors hover:text-foreground',
                        icon === name ? 'border-primary/50 bg-primary/10 text-primary' : 'border-transparent',
                      )}
                    >
                      <Icon className="size-4" />
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <span className="mb-1.5 block text-sm font-medium">Color</span>
              <div className="grid grid-cols-4 gap-x-4 gap-y-3" role="radiogroup" aria-label="Color">
                {Object.entries(PROJECT_COLORS).map(([key, hex]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={color === key}
                    aria-label={key}
                    onClick={() => setColor(key)}
                    className="grid size-6 place-items-center rounded-full text-white"
                    style={{ backgroundColor: hex, boxShadow: color === key ? `0 0 0 2px var(--background), 0 0 0 4px ${hex}` : undefined }}
                  >
                    {color === key && <Check className="size-3" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Lead
              <NativeSelect value={leadId} onChange={e => setLeadId(e.target.value)} aria-label="Lead">
                <NativeSelectOption value="">No lead</NativeSelectOption>
                {members.map(member => (
                  <NativeSelectOption key={member.user_id} value={member.user_id}>
                    {member.email?.split('@')[0] || 'Member'}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Start date
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} aria-label="Start date" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Target date
              <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} aria-label="Target date" />
            </label>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium">Template</span>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="Template">
              {PROJECT_TEMPLATES.map(item => {
                const Icon = projectIcon(item.icon);
                const forAgents = agentTaskCount(item.tasks);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={templateId === item.id}
                    onClick={() => setTemplateId(item.id)}
                    className={cn(
                      'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors hover:bg-muted/50',
                      templateId === item.id ? 'border-primary/50 ring-2 ring-primary/15' : 'border-border',
                    )}
                  >
                    <Icon className="mb-1 size-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">{item.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.tasks.length ? `${item.tasks.length} starter tasks${forAgents ? ` · ${forAgents} for agents` : ''}` : item.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {starters.length > 0 && (
            <div className="rounded-xl border border-border bg-muted/30">
              <div className="flex items-center border-b border-border px-3.5 py-2.5 text-xs text-muted-foreground">
                <span>
                  Starter tasks for <b className="mx-1 font-medium text-foreground">{template.name}</b> · untick to skip, or change who does it
                </span>
                <span className="ml-auto">{starters.filter(item => item.include).length} tasks</span>
              </div>
              {starters.map((starter, index) => (
                <div key={starter.title} className="flex items-center gap-3 border-b border-border px-3.5 py-2 text-sm last:border-b-0">
                  <input
                    type="checkbox"
                    aria-label={`Include ${starter.title}`}
                    className="size-3.5 accent-primary"
                    checked={starter.include}
                    onChange={e => setStarter(index, { include: e.target.checked })}
                  />
                  <span className={cn('min-w-0 flex-1 truncate', !starter.include && 'text-muted-foreground line-through')}>{starter.title}</span>
                  <NativeSelect
                    size="sm"
                    className="w-40"
                    value={starter.assigneeId}
                    disabled={!starter.include}
                    onChange={e => setStarter(index, { assigneeId: e.target.value })}
                    aria-label={`Assignee for ${starter.title}`}
                  >
                    <AssigneeOptions members={members} agents={agents} />
                  </NativeSelect>
                </div>
              ))}
            </div>
          )}

          {activeAgents.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-border p-3">
              <input
                id="new-project-draft-plan"
                type="checkbox"
                className="mt-1 size-3.5 accent-primary"
                checked={draftPlan}
                onChange={e => setDraftPlan(e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="new-project-draft-plan" className="block text-sm font-medium">
                  Add a task for an agent to draft the plan
                </label>
                <p className="text-xs text-muted-foreground">Creates "Draft project plan", assigned to the agent you pick, as the first task.</p>
              </div>
              <NativeSelect
                size="sm"
                className="w-40"
                value={draftAgentId}
                disabled={!draftPlan}
                onChange={e => setDraftAgentId(e.target.value)}
                aria-label="Agent to draft the plan"
              >
                {activeAgents.map(agent => (
                  <NativeSelectOption key={agent.id} value={agent.id}>
                    {agent.name || 'Agent'}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}

          {(onCreateChannel || onCreateBrief) && (
            <div>
              <span className="mb-1.5 block text-sm font-medium">Set up alongside</span>
              <div className="flex flex-col gap-2">
                {onCreateChannel && (
                  <label className="flex items-start gap-3 rounded-xl border border-border p-3">
                    <input type="checkbox" className="mt-1 size-3.5 accent-primary" checked={makeChannel} onChange={e => setMakeChannel(e.target.checked)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">Create a project channel</span>
                      <span className="block text-xs text-muted-foreground">A channel named after the project, linked from its page.</span>
                    </span>
                  </label>
                )}
                {onCreateBrief && (
                  <label className="flex items-start gap-3 rounded-xl border border-border p-3">
                    <input type="checkbox" className="mt-1 size-3.5 accent-primary" checked={makeBrief} onChange={e => setMakeBrief(e.target.checked)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">Create a project brief document</span>
                      <span className="block text-xs text-muted-foreground">Starts from your description, and agents can read it as context.</span>
                    </span>
                  </label>
                )}
              </div>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </form>

        <DialogFooter className="items-center border-t border-border px-6 py-3.5 sm:justify-between">
          <span className="text-xs text-muted-foreground">Everything here can be changed later</span>
          <div className="flex gap-2">
            {created ? (
              <Button
                type="button"
                onClick={() => {
                  onCreated?.(created);
                  onOpenChange(false);
                }}
              >
                Open the project
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="button" onClick={() => void submit()} disabled={!name.trim() || busy}>
                  {busy ? 'Creating…' : 'Create project'}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
