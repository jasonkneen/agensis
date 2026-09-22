import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Columns3,
  CornerDownRight,
  ExternalLink,
  FileText,
  Flag,
  GanttChart,
  Link2,
  List,
  MessageSquare,
  Paperclip,
  Plus,
  Send,
  Trash2,
  Upload,
  User,
  UserPlus,
  X,
} from 'lucide-react';
import type { AgentConnection, MessageAttachment, Task, TaskComment, TaskPriority, TaskStatus, UploadedFile, WorkspaceAgent } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { TASK_PANEL_MAX_WIDTH, TASK_PANEL_MIN_WIDTH, TASK_PANEL_WIDTH_KEY, clampTaskPanelWidth, readStoredTaskPanelWidth } from '../../lib/taskPanelWidth';
import { booleanPreference, oneOf, viewPreferenceKey } from '../../lib/viewPreferences';
import { usePersistedPreference } from '../../hooks/usePersistedPreference';
import { useTaskComments } from '../../hooks/useTaskComments';
import { agentHandle } from '../../lib/agentAccent';
import { isAssigneeActive, resolveTaskCommentAuthor } from '../../lib/taskAgents';
import { parseMessageAttachments } from '../../lib/messageAttachments';
import { MessageAttachmentList } from '../chat/MessageAttachments';
import { AgentAvatar } from '../agents/AgentAvatar';
import { TaskActivityChip } from './TaskActivityChip';
import {
  applyHideDone,
  countOpenTasks,
  dependencyCandidates as resolveDependencyCandidates,
  fromDateInputValue,
  isClosedTask,
  resolveTaskFocus,
  WIDEST_TASK_FILTERS,
  taskDependsOn,
  toDateInputValue,
  type TaskAssignmentFilter,
  } from './taskSchedule';
import { Avatar, AvatarFallback } from '@agensis/ui/components/avatar';
import { Badge } from '@agensis/ui/components/badge';
import { Button } from '@agensis/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@agensis/ui/components/command';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@agensis/ui/components/empty';
import { Input } from '@agensis/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@agensis/ui/components/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from '@agensis/ui/components/item';
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from '@agensis/ui/components/marker';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@agensis/ui/components/native-select';
import { ScrollArea } from '@agensis/ui/components/scroll-area';
import { Textarea } from '@agensis/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@agensis/ui/components/toggle-group';
import { cn } from '@/lib/utils';
import { ResizeHandle } from '@/components/common/ResizeHandle';
import { MENTION_TILE, WINDOW_TOOLBAR } from '@/components/common/presentation';
import { TaskGantt, TaskKanban } from './TaskBoardViews';
import { STATUS_LABELS, taskChatSessionId } from './taskPresentation';

interface TasksWindowContentProps {
  tasks: Task[];
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  /** Live daemon connections — used to show which assigned agents are actively working. */
  agentConnections: AgentConnection[];
  currentUserEmail: string;
  workspaceId: string;
  currentUserId?: string;
  onCreateTask: (input: CreateTaskInput) => Task | null | Promise<Task | null>;
  onUpdateTask: (id: string, updates: Partial<Task>) => void;
  onToggleStatus: (task: Task) => void;
  onDeleteTask: (id: string) => void;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  /** Opens the chat a task is being worked in (source_type 'chat'). */
  onOpenSession?: (sessionId: string) => void;
  /** A task to scroll to and expand once it's in view (e.g. opened from search). */
  focusTaskId?: string;
  /** Called once the focus has been applied, so the caller can clear it. */
  onFocusTaskConsumed?: () => void;
  /**
   * Uploads to the SAME workspace file store the chat composer uses (see
   * useFiles in App.tsx) — a task attachment and a chat attachment are both
   * just uploaded_files rows referenced by id. Omitted only in contexts that
   * genuinely cannot upload (none today), in which case the drop zone hides
   * rather than offering a control that would fail.
   */
  onUploadFiles?: (files: File[]) => Promise<UploadedFile[]>;
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const TASK_COMMENT_AVATAR_COLORS = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-green-500',
  'bg-cyan-500',
  'bg-blue-500',
  'bg-violet-500',
  'bg-pink-500',
];

// Selected filter/view toggle in the Tasks toolbar: a solid WHITE pill with
// primary-coloured text, in both light and dark themes, so the active choice
// reads as a bright chip against the translucent toolbar (the default
// data-[state=on]:bg-muted was too low-contrast on the dark surface).
const TASK_TOGGLE_ACTIVE =
  'data-[state=on]:bg-white data-[state=on]:text-primary data-[state=on]:hover:bg-white data-[state=on]:hover:text-primary';

type AssignmentFilter = TaskAssignmentFilter;

type TaskView = 'list' | 'kanban' | 'gantt';

// Remembered per workspace: reopening Tasks and being shown every completed
// item again, every single time, is the whole complaint these three answer.
// Search text and the selected task stay in memory — a search box that survives
// a reload shows a filtered list with nothing on screen explaining why.
const ASSIGNMENT_FILTER_PREF = oneOf<AssignmentFilter>(['all', 'mine', 'others']);
const TASK_VIEW_PREF = oneOf<TaskView>(['list', 'kanban', 'gantt']);

// A task dispatched to an agent records the chat it is being worked in:
// source_type 'chat' + the session id. Every other source_type stores a
// different kind of id (an agent id for 'ai', a canvas object id for 'canvas'),
// so only 'chat' is safe to open as a session.
// Assignee options: people AND agents. Assigning an agent dispatches the task to
// it — that's the point of the picker, so agents can't be missing from it.
// Disabled agents are left out: they can't run.
function AssigneeOptions({ members, agents }: { members: WorkspaceMember[]; agents: WorkspaceAgent[] }) {
  const activeAgents = agents.filter(agent => agent.enabled !== false);
  return (
    <>
      <NativeSelectOption value="">Unassigned</NativeSelectOption>
      {members.length > 0 && (
        <NativeSelectOptGroup label="People">
          {members.map(member => (
            <NativeSelectOption key={member.user_id} value={member.user_id}>
              {member.email?.split('@')[0] || 'Member'}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
      {activeAgents.length > 0 && (
        <NativeSelectOptGroup label="Agents">
          {activeAgents.map(agent => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              @{agentHandle(agent)}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
    </>
  );
}

export const TasksWindowContent = memo(function TasksWindowContent({
  tasks,
  members,
  agents,
  agentConnections,
  currentUserEmail,
  workspaceId,
  currentUserId,
  onCreateTask,
  onUpdateTask,
  onToggleStatus,
  onDeleteTask,
  onUpdateAgent,
  onOpenSession,
  focusTaskId,
  onFocusTaskConsumed,
  onUploadFiles,
}: TasksWindowContentProps) {
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const creatingRef = useRef(false);
  const creationWorkspace = useRef({ workspaceId });
  if (creationWorkspace.current.workspaceId !== workspaceId) creationWorkspace.current = { workspaceId };
  const [newPriority, setNewPriority] = useState<TaskPriority>('normal');
  const [newAssignee, setNewAssignee] = useState<string>('');
  const [newAttachments, setNewAttachments] = useState<MessageAttachment[]>([]);
  const [newAttachmentDragActive, setNewAttachmentDragActive] = useState(false);
  const [newAttachmentUploading, setNewAttachmentUploading] = useState(false);
  const newAttachmentInputRef = useRef<HTMLInputElement>(null);
  const newAttachmentDragDepth = useRef(0);
  const [filter, setFilter] = usePersistedPreference(
    viewPreferenceKey('tasks.filter', workspaceId), ASSIGNMENT_FILTER_PREF, 'all' as AssignmentFilter,
  );
  const [hideDone, setHideDone] = usePersistedPreference(
    viewPreferenceKey('tasks.hide-done', workspaceId), booleanPreference, false,
  );
  const [view, setView] = usePersistedPreference(
    viewPreferenceKey('tasks.view', workspaceId), TASK_VIEW_PREF, 'list' as TaskView,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Which focus request we widened the filters FOR. Transient on purpose: the
  // widening below used to call setFilter/setHideDone, which are the PERSISTED
  // setters — so arriving from a comment or @mention link on a task that the
  // current filters hide (a done task, with "Hide done" on) silently wrote the
  // user's preference away. They set "Hide done" once, followed one link, and it
  // was off forever with nothing to point at. Overriding for the duration of the
  // focus shows the task without touching what they chose.
  const [widenedForFocus, setWidenedForFocus] = useState<string | null>(null);

  const childrenMap = useMemo(() => {
    const map: Record<string, Task[]> = {};
    tasks.forEach(task => {
      if (task.parent_id) {
        (map[task.parent_id] = map[task.parent_id] || []).push(task);
      }
    });
    return map;
  }, [tasks]);

  const allTopLevel = useMemo(() => tasks.filter(task => !task.parent_id), [tasks]);

  const focusRowId = useMemo(() => {
    if (!focusTaskId) return undefined;
    const target = tasks.find(t => t.id === focusTaskId);
    return target?.parent_id || focusTaskId;
  }, [focusTaskId, tasks]);

  // The filters actually in force: the user's, unless a focus request needed
  // them widened to reach its task.
  const focusWidened = Boolean(focusRowId) && widenedForFocus === focusRowId;
  const effectiveFilter = focusWidened ? WIDEST_TASK_FILTERS.filter : filter;
  const effectiveHideDone = focusWidened ? WIDEST_TASK_FILTERS.hideDone : hideDone;

  const filteredTopLevel = useMemo(() => {
    const me = currentUserId || members.find(member => member.email === currentUserEmail)?.user_id || '';
    let list = allTopLevel;
    const filter = effectiveFilter;
    if (filter === 'mine') {
      list = me ? allTopLevel.filter(task => task.assignee_id === me) : [];
    } else if (filter === 'others') {
      list = allTopLevel.filter(task => task.assignee_id && task.assignee_id !== me);
    }
    // Cascades into `grouped` below, so it covers list/kanban/gantt in one place.
    // "Done" here means closed — done AND cancelled; see isClosedTask.
    return applyHideDone(list, effectiveHideDone);
  }, [allTopLevel, effectiveFilter, effectiveHideDone, members, currentUserEmail, currentUserId]);

  const grouped = useMemo(() => {
    const groups: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], done: [], cancelled: [] };
    filteredTopLevel.forEach(task => {
      // Defensive: a task with an unknown/legacy status (e.g. from an offline
      // cache or a future migration) would make groups[status] undefined and
      // crash on .push. Fall unknown statuses back into 'todo'.
      const bucket = groups[task.status] ?? groups.todo;
      bucket.push(task);
    });
    return groups;
  }, [filteredTopLevel]);

  useEffect(() => {
    setNewTitle(''); setNewPriority('normal'); setNewAssignee(''); setNewAttachments([]);
    setCreating(false); setCreateError(false); creatingRef.current = false;
  }, [workspaceId]);

  const handleAdd = async () => {
    if (!newTitle.trim() || newAttachmentUploading || creatingRef.current) return;
    const ownerWorkspace = creationWorkspace.current;
    creatingRef.current = true;
    setCreating(true); setCreateError(false);
    try {
      const task = await onCreateTask({
        title: newTitle.trim(),
        priority: newPriority,
        assignee_id: newAssignee || null,
        source_type: 'manual',
        attachments: newAttachments,
      });
      if (creationWorkspace.current !== ownerWorkspace) return;
      if (!task) { setCreateError(true); return; }
      setNewTitle(''); setNewPriority('normal'); setNewAssignee(''); setNewAttachments([]);
    } catch {
      if (creationWorkspace.current === ownerWorkspace) setCreateError(true);
    } finally {
      if (creationWorkspace.current === ownerWorkspace) { creatingRef.current = false; setCreating(false); }
    }
  };

  const uploadNewAttachments = async (files: File[]) => {
    if (!files.length || !onUploadFiles || creatingRef.current) return;
    setNewAttachmentUploading(true);
    try {
      const uploaded = await onUploadFiles(files);
      if (uploaded.length === 0) return;
      setNewAttachments(current => parseMessageAttachments([
        ...current,
        ...uploaded.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size })),
      ]));
    } finally {
      setNewAttachmentUploading(false);
    }
  };

  const handleNewAttachmentDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-testid="task-attachment-dropzone"]')) return;
    if (!onUploadFiles || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    newAttachmentDragDepth.current += 1;
    setNewAttachmentDragActive(true);
  };

  const handleNewAttachmentDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-testid="task-attachment-dropzone"]')) return;
    if (!onUploadFiles || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleNewAttachmentDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-testid="task-attachment-dropzone"]')) return;
    if (!onUploadFiles || !event.dataTransfer?.types.includes('Files')) return;
    newAttachmentDragDepth.current = Math.max(0, newAttachmentDragDepth.current - 1);
    if (newAttachmentDragDepth.current === 0) setNewAttachmentDragActive(false);
  };

  const handleNewAttachmentDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-testid="task-attachment-dropzone"]')) return;
    if (!onUploadFiles) return;
    const files = Array.from(event.dataTransfer?.files || []);
    newAttachmentDragDepth.current = 0;
    setNewAttachmentDragActive(false);
    if (!files.length) return;
    event.preventDefault();
    void uploadNewAttachments(files);
  };

  const handleNewAttachmentFilePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await uploadNewAttachments(files);
  };

  const memberLabel = (assigneeId: string | null) => {
    if (!assigneeId) return null;
    const member = members.find(item => item.user_id === assigneeId);
    if (member) return member.email?.split('@')[0] || 'Someone';
    // assignee_id has no FK to a single table — it may point at an agent
    // instead of a workspace member (e.g. assigned via @mention).
    const agent = agents.find(item => item.id === assigneeId);
    if (agent) return agent.name || agentHandle(agent);
    return 'Someone';
  };

  // Same function the sidebar badge uses, so the two "N open" numbers can only
  // ever differ by the assignment filter the user can see in this toolbar —
  // never by what counts as a task. `filteredTopLevel` is already top-level, so
  // countOpenTasks' parent_id check is a no-op here; sharing it is the point.
  const openCount = countOpenTasks(filteredTopLevel);

  // The right-hand editor panel (Kanban/Gantt) is driven by a selected task id.
  // Resolving against live `tasks` means a deleted selection auto-closes the panel.
  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find(task => task.id === selectedTaskId) ?? null : null),
    [selectedTaskId, tasks],
  );

  // Drag-to-subtask: reparent `draggedId` under `targetId`. Guards self-drop and
  // cycles (can't nest a task under one of its own descendants).
  const handleReparent = (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    // Walk up from the target; if the dragged task is an ancestor of the target,
    // nesting would create a cycle.
    let cursor: Task | undefined = tasks.find(task => task.id === targetId);
    const seen = new Set<string>();
    while (cursor && cursor.parent_id) {
      if (cursor.parent_id === draggedId) return;
      if (seen.has(cursor.parent_id)) break;
      seen.add(cursor.parent_id);
      cursor = tasks.find(task => task.id === cursor!.parent_id);
    }
    onUpdateTask(draggedId, { parent_id: targetId });
  };

  // A focused task may be a subtask (rendered inside its parent's expanded
  // row, not as its own top-level row) — resolve to the row that actually
  // needs to scroll/expand.

  // The last focus request that reached a terminal action. Kept in a ref so it
  // does not re-trigger the effect: its only job is to stop a spent request
  // from widening the filters a second time, every time the user narrows them.
  const handledFocusRef = useRef<string | null>(null);

  // The current assignment filter or "hide done" toggle may hide the focused
  // task's row entirely — e.g. jumping in from a comment/@mention link on a
  // task that's already done. resolveTaskFocus decides whether that is worth
  // overriding the user's filters for; the rules (and the bug that produced
  // them) are documented there.
  useEffect(() => {
    const action = resolveTaskFocus({
      focusRowId,
      handledFocusId: handledFocusRef.current,
      isVisible: Boolean(focusRowId) && filteredTopLevel.some(task => task.id === focusRowId),
      filters: { filter: effectiveFilter, hideDone: effectiveHideDone },
    });
    if (action.kind === 'reset') {
      handledFocusRef.current = null;
      return;
    }
    if (action.kind === 'idle') return;
    if (action.kind === 'widen') {
      // Transient — NOT setFilter/setHideDone, which persist. See widenedForFocus.
      setWidenedForFocus(focusRowId ?? null);
      return; // re-runs once the wider list renders
    }
    // Terminal: mark the request spent BEFORE consuming, so a re-render in
    // between cannot re-enter the widening branch.
    handledFocusRef.current = focusRowId ?? null;
    if (action.kind === 'reveal') {
      // Best effort — the Board and Timeline views have no task-row element.
      document.getElementById(`task-row-${focusRowId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    onFocusTaskConsumed?.();
    // setFilter/setHideDone are stable (see usePersistedPreference) but are not
    // the useState setters the lint rule knows to ignore, so they are listed.
  }, [focusRowId, effectiveFilter, effectiveHideDone, filteredTopLevel, onFocusTaskConsumed]);

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-transparent text-foreground"
      data-testid={onUploadFiles ? 'task-window-dropzone' : undefined}
      onDragEnter={handleNewAttachmentDragEnter}
      onDragOver={handleNewAttachmentDragOver}
      onDragLeave={handleNewAttachmentDragLeave}
      onDrop={handleNewAttachmentDrop}
    >
      <div className={cn(WINDOW_TOOLBAR, 'task-window-toolbar backdrop-blur-md')}>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={filter}
          onValueChange={value => {
            if (value) setFilter(value as AssignmentFilter);
          }}
        >
          <ToggleGroupItem value="all" className={TASK_TOGGLE_ACTIVE}>All</ToggleGroupItem>
          <ToggleGroupItem value="mine" className={TASK_TOGGLE_ACTIVE}>Mine</ToggleGroupItem>
          <ToggleGroupItem value="others" title="Assigned to other workspace members" className={TASK_TOGGLE_ACTIVE}>Others</ToggleGroupItem>
        </ToggleGroup>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setHideDone(v => !v)}
          title={hideDone ? 'Show done and cancelled tasks' : 'Hide done and cancelled tasks'}
          className={cn(hideDone && 'text-primary')}
        >
          {hideDone ? 'Show done' : 'Hide done'}
        </Button>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={view}
          onValueChange={value => {
            if (value) setView(value as 'list' | 'kanban' | 'gantt');
          }}
        >
          <ToggleGroupItem value="list" title="List view" className={TASK_TOGGLE_ACTIVE}><List />List</ToggleGroupItem>
          <ToggleGroupItem value="kanban" title="Kanban board" className={TASK_TOGGLE_ACTIVE}><Columns3 />Board</ToggleGroupItem>
          <ToggleGroupItem value="gantt" title="Gantt timeline" className={TASK_TOGGLE_ACTIVE}><GanttChart />Timeline</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex-1" />
        <Badge variant="secondary">{openCount} open</Badge>
      </div>

      <div className={cn(
        'shrink-0 border-b border-border bg-card/55 p-3 backdrop-blur-md transition-colors',
        newAttachmentDragActive && 'bg-primary/10 ring-1 ring-inset ring-primary',
      )}>
        <div className="task-add-row gap-2" inert={creating}>
          <div className="min-w-0">
            <Input
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAdd();
              }}
              placeholder="Add a task..."
              className="task-title-input"
            />
          </div>
          <NativeSelect
            value={newPriority}
            onChange={e => setNewPriority(e.target.value as TaskPriority)}
            size="sm"
            className="w-32"
            aria-label="Priority"
          >
            {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map(priority => (
              <NativeSelectOption key={priority} value={priority}>{PRIORITY_LABELS[priority]}</NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            value={newAssignee}
            onChange={e => setNewAssignee(e.target.value)}
            size="sm"
            className="w-40 max-w-full"
            aria-label="Assignee"
          >
            <AssigneeOptions members={members} agents={agents} />
          </NativeSelect>
          {onUploadFiles && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => newAttachmentInputRef.current?.click()}
              disabled={newAttachmentUploading}
              aria-label="Attach files to new task"
              title="Attach files to new task"
            >
              <Paperclip />
            </Button>
          )}
          <Button type="button" size="sm" onClick={handleAdd} disabled={!newTitle.trim() || newAttachmentUploading || creating}>
            <Plus data-icon="inline-start" />
            {creating ? 'Adding…' : 'Add'}
          </Button>
        </div>
        {createError && <p role="alert" className="mt-2 text-sm text-destructive">Task could not be created. Your details are still here; try Add again.</p>}
        {onUploadFiles && (
          <input
            ref={newAttachmentInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleNewAttachmentFilePick}
          />
        )}
        {(newAttachmentDragActive || newAttachmentUploading || newAttachments.length > 0) && (
          <div className="mt-2 flex flex-col gap-1.5" data-testid="new-task-attachments" inert={creating}>
            {newAttachmentDragActive && (
              <p className="text-xs font-medium text-primary">Drop to attach to the new task</p>
            )}
            {newAttachmentUploading && (
              <p className="text-xs text-muted-foreground">Uploading attachments…</p>
            )}
            <MessageAttachmentList
              attachments={newAttachments}
              onRemove={attachment => setNewAttachments(current => current.filter(item => item.id !== attachment.id))}
              className="mt-0"
            />
          </div>
        )}
      </div>

      {view === 'list' ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            {filteredTopLevel.length === 0 ? (
              <Empty className="min-h-80 border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CheckCircle2 />
                  </EmptyMedia>
                  <EmptyTitle>No tasks here</EmptyTitle>
                  <EmptyDescription>Type above to add one.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              (['in_progress', 'todo', 'done', 'cancelled'] as TaskStatus[]).map(status => {
                const items = grouped[status];
                if (items.length === 0) return null;
                return (
                  <section key={status} className="flex flex-col gap-1.5">
                    <Marker variant="separator" className="min-h-0 text-xs">
                      <MarkerContent>{STATUS_LABELS[status]} ({items.length})</MarkerContent>
                    </Marker>
                    <ItemGroup className="gap-1">
                      {items.map(task => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          subtasks={childrenMap[task.id] || []}
                          allTasks={tasks}
                          assigneeLabel={memberLabel(task.assignee_id)}
                          assigneeActive={isAssigneeActive(task.assignee_id, agentConnections)}
                          members={members}
                          agents={agents}
                          onUpdateAgent={onUpdateAgent}
                          onOpenSession={onOpenSession}
                          workspaceId={workspaceId}
                          currentUserId={currentUserId}
                          currentUserEmail={currentUserEmail}
                          hideDone={hideDone}
                          autoExpand={task.id === focusRowId}
                          onToggle={() => onToggleStatus(task)}
                          onDelete={() => onDeleteTask(task.id)}
                          onChangeStatus={newStatus => onUpdateTask(task.id, { status: newStatus })}
                          onChangeAssignee={assigneeId => onUpdateTask(task.id, { assignee_id: assigneeId })}
                          onChangeDependsOn={next => onUpdateTask(task.id, { depends_on: next })}
                          onChangeDates={updates => onUpdateTask(task.id, updates)}
                          onAddSubtask={title => onCreateTask({ title, parent_id: task.id, source_type: 'manual' })}
                          onToggleSubtask={sub => onToggleStatus(sub)}
                          onDeleteSubtask={id => onDeleteTask(id)}
                          onUploadFiles={onUploadFiles}
                        />
                      ))}
                    </ItemGroup>
                  </section>
                );
              })
            )}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {view === 'kanban' ? (
              <TaskKanban
                columns={grouped}
                memberLabel={memberLabel}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onChangeStatus={(id, status) => onUpdateTask(id, { status })}
                onReparent={handleReparent}
              />
            ) : (
              <TaskGantt
                tasks={filteredTopLevel}
                allTasks={tasks}
                hideDone={hideDone}
                memberLabel={memberLabel}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onReschedule={(id, updates) => onUpdateTask(id, updates)}
              />
            )}
          </div>
          {selectedTask && (
            <TaskEditPanel
              task={selectedTask}
              subtasks={childrenMap[selectedTask.id] || []}
              allTasks={tasks}
              members={members}
              agents={agents}
              onUpdateAgent={onUpdateAgent}
              onOpenSession={onOpenSession}
              workspaceId={workspaceId}
              currentUserId={currentUserId}
              currentUserEmail={currentUserEmail}
              hideDone={hideDone}
              onClose={() => setSelectedTaskId(null)}
              onChangeTitle={title => onUpdateTask(selectedTask.id, { title })}
              onChangeDescription={description => onUpdateTask(selectedTask.id, { description })}
              onChangeStatus={status => onUpdateTask(selectedTask.id, { status })}
              onChangePriority={priority => onUpdateTask(selectedTask.id, { priority })}
              onChangeAssignee={assigneeId => onUpdateTask(selectedTask.id, { assignee_id: assigneeId })}
              onChangeDependsOn={next => onUpdateTask(selectedTask.id, { depends_on: next })}
              onChangeDates={updates => onUpdateTask(selectedTask.id, updates)}
              onAddSubtask={title => onCreateTask({ title, parent_id: selectedTask.id, source_type: 'manual' })}
              onToggleSubtask={sub => onToggleStatus(sub)}
              onDeleteSubtask={id => onDeleteTask(id)}
              onUploadFiles={onUploadFiles}
            />
          )}
        </div>
      )}
    </div>
  );
});

function TaskRow({
  task,
  subtasks,
  allTasks,
  assigneeLabel,
  assigneeActive,
  members,
  agents,
  onUpdateAgent,
  onOpenSession,
  workspaceId,
  currentUserId,
  currentUserEmail,
  hideDone,
  autoExpand,
  onToggle,
  onDelete,
  onChangeStatus,
  onChangeAssignee,
  onChangeDependsOn,
  onChangeDates,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  onUploadFiles,
}: {
  task: Task;
  /** ALL of this task's subtasks — the x/y badge counts the real total. */
  subtasks: Task[];
  allTasks: Task[];
  assigneeLabel: string | null;
  assigneeActive: boolean;
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onOpenSession?: (sessionId: string) => void;
  workspaceId: string;
  currentUserId?: string;
  currentUserEmail: string;
  hideDone?: boolean;
  autoExpand?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onChangeStatus: (status: TaskStatus) => void;
  onChangeAssignee: (assigneeId: string | null) => void;
  onChangeDependsOn: (next: string[]) => void;
  onChangeDates: (updates: Partial<Task>) => void;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onDeleteSubtask: (id: string) => void;
  onUploadFiles?: (files: File[]) => Promise<UploadedFile[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const done = task.status === 'done';
  const doneSubs = subtasks.filter(subtask => subtask.status === 'done').length;
  const chatSessionId = taskChatSessionId(task);

  // Re-expand whenever this row becomes the search/focus target — covers both
  // first mount and a second click on an already-mounted row.
  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);

  return (
    <div id={`task-row-${task.id}`} className={`task-card ${expanded ? 'task-card-expanded' : ''}`}>
      <Item variant="outline" className="task-row items-center">
        <ItemActions className="gap-1">
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => setExpanded(value => !value)} aria-label={expanded ? 'Collapse task' : 'Expand task'}>
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onToggle} aria-label={done ? 'Mark incomplete' : 'Mark complete'}>
            {done ? <CheckCircle2 /> : <Circle />}
          </Button>
        </ItemActions>
        <ItemContent className="min-w-0 cursor-pointer" onClick={() => setExpanded(value => !value)}>
          <ItemTitle className={done ? 'max-w-full whitespace-normal text-muted-foreground line-through' : 'max-w-full whitespace-normal'}>
            {task.title}
          </ItemTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* First in the row on purpose: "is this moving" is the question
                asked of a task list, and it should not be behind a priority
                flag and a due date. Renders nothing unless the task is in
                progress — see TaskActivityChip. */}
            <TaskActivityChip task={task} sessionId={chatSessionId} />
            {task.priority !== 'normal' && (
              <Badge variant={task.priority === 'urgent' ? 'destructive' : 'secondary'}>
                <Flag />
                {task.priority}
              </Badge>
            )}
            {task.due_date && (
              <Badge variant="outline">
                <Clock />
                {new Date(task.due_date).toLocaleDateString()}
              </Badge>
            )}
            {assigneeLabel && (
              <Badge
                variant="outline"
                className={cn(assigneeActive && 'border-amber-500/60 text-amber-600 dark:text-amber-400')}
                title={assigneeActive ? `${assigneeLabel} is working on this` : undefined}
              >
                {assigneeActive ? (
                  <span className="relative flex size-1.5" aria-hidden>
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
                  </span>
                ) : (
                  <User />
                )}
                {assigneeLabel}
                {assigneeActive && <span className="text-3xs font-medium">· working</span>}
              </Badge>
            )}
            {subtasks.length > 0 && (
              <Badge variant="outline">
                <CornerDownRight />
                {doneSubs}/{subtasks.length}
              </Badge>
            )}
            {task.source_type && task.source_type !== 'manual' && (
              <Badge variant="secondary">{task.source_type}</Badge>
            )}
          </div>
        </ItemContent>
        <ItemActions className="ml-auto flex-wrap justify-end">
          {chatSessionId && onOpenSession && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={e => { e.stopPropagation(); onOpenSession(chatSessionId); }}
              title="Open the chat this task is being worked in"
            >
              <ExternalLink data-icon="inline-start" />
              Open chat
            </Button>
          )}
          <NativeSelect
            value={task.assignee_id || ''}
            onChange={e => onChangeAssignee(e.target.value || null)}
            onClick={e => e.stopPropagation()}
            size="sm"
            className="w-32"
            aria-label="Assign task"
          >
            <AssigneeOptions members={members} agents={agents} />
          </NativeSelect>
          <NativeSelect
            value={task.status}
            onChange={e => onChangeStatus(e.target.value as TaskStatus)}
            onClick={e => e.stopPropagation()}
            size="sm"
            className="w-32"
            aria-label="Task status"
          >
            {(Object.keys(STATUS_LABELS) as TaskStatus[]).map(status => (
              <NativeSelectOption key={status} value={status}>{STATUS_LABELS[status]}</NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onDelete} aria-label="Delete task">
            <Trash2 />
          </Button>
        </ItemActions>
      </Item>

      {expanded && (
        <TaskDetail
          task={task}
          subtasks={subtasks}
          hideDone={hideDone}
          allTasks={allTasks}
          onChangeDependsOn={onChangeDependsOn}
          onChangeDates={onChangeDates}
          members={members}
          agents={agents}
          onUpdateAgent={onUpdateAgent}
          onChangeAssignee={onChangeAssignee}
          workspaceId={workspaceId}
          currentUserId={currentUserId}
          currentUserEmail={currentUserEmail}
          onAddSubtask={onAddSubtask}
          onToggleSubtask={onToggleSubtask}
          onDeleteSubtask={onDeleteSubtask}
          onUploadFiles={onUploadFiles}
        />
      )}
    </div>
  );
}

// Number of tasks shown before the user types anything. Kept small on purpose:
// the picker is "recent open tasks, then search" — a long default list is the
// checkbox wall this replaced.
const DEPENDENCY_RECENT_LIMIT = 5;
// Ceiling on search results so a broad query in a big workspace can't render
// hundreds of rows into the panel.
const DEPENDENCY_SEARCH_LIMIT = 50;

// The "Depends on" editor. Selected dependencies show as removable chips; a
// search box below defaults to the most-recently-created OPEN candidates and
// filters the full candidate set (any status) once the user types. Candidates
// already exclude this task and anything that would close a dependency cycle.
function DependencyPicker({
  task,
  allTasks,
  onChangeDependsOn,
}: {
  task: Task;
  allTasks: Task[];
  onChangeDependsOn: (next: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const dependsOn = taskDependsOn(task);

  const candidates = useMemo(
    () => resolveDependencyCandidates(task, allTasks),
    [allTasks, task],
  );

  // Newest first — the ordering both the recent list and search results use.
  const byNewest = useMemo(() => {
    return candidates
      .slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }, [candidates]);

  // Selected deps resolve from ALL tasks, not just candidates, so an existing
  // dependency always renders as a chip even in the edge case where it fell out
  // of the candidate set — the user can still see and remove it.
  const selected = useMemo(() => {
    const byId = new Map(allTasks.map(item => [item.id, item]));
    return dependsOn.map(id => byId.get(id)).filter((item): item is Task => Boolean(item));
  }, [allTasks, dependsOn]);

  const selectedIds = useMemo(() => new Set(dependsOn), [dependsOn]);

  const trimmed = query.trim().toLowerCase();
  // Empty query -> the N most recent OPEN candidates. Typing -> every candidate
  // (any status) whose title matches, capped. Already-selected tasks live in the
  // chip row above, so they're excluded from the list either way.
  const visible = useMemo(() => {
    const unselected = byNewest.filter(candidate => !selectedIds.has(candidate.id));
    if (!trimmed) {
      return unselected.filter(candidate => !isClosedTask(candidate)).slice(0, DEPENDENCY_RECENT_LIMIT);
    }
    return unselected
      .filter(candidate => String(candidate.title || '').toLowerCase().includes(trimmed))
      .slice(0, DEPENDENCY_SEARCH_LIMIT);
  }, [byNewest, selectedIds, trimmed]);

  const addDependency = (id: string) => {
    if (selectedIds.has(id)) return;
    onChangeDependsOn([...dependsOn, id]);
    setQuery('');
  };

  const removeDependency = (id: string) => {
    onChangeDependsOn(dependsOn.filter(depId => depId !== id));
  };

  return (
    <section className="flex flex-col gap-2">
      <Marker>
        <MarkerIcon>
          <Link2 />
        </MarkerIcon>
        <MarkerContent>Depends on {selected.length > 0 && `(${selected.length})`}</MarkerContent>
      </Marker>

      {candidates.length === 0 && selected.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">No other tasks to depend on yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selected.map(dep => (
                <span
                  key={dep.id}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pr-1 pl-2.5 text-xs',
                    isClosedTask(dep) && 'text-muted-foreground',
                  )}
                >
                  <span className={cn('min-w-0 truncate', isClosedTask(dep) && 'line-through')}>{dep.title}</span>
                  <button
                    type="button"
                    className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => removeDependency(dep.id)}
                    aria-label={`Remove dependency ${dep.title}`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <Command
            shouldFilter={false}
            className="rounded-xl border border-border bg-transparent p-0"
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search tasks to depend on..."
            />
            <CommandList className="max-h-[min(240px,40vh)]">
              <CommandEmpty>
                {trimmed ? 'No matching tasks.' : 'No open tasks to depend on.'}
              </CommandEmpty>
              {visible.length > 0 && (
                <CommandGroup heading={trimmed ? 'Results' : 'Recent open tasks'}>
                  {visible.map(candidate => (
                    <CommandItem
                      key={candidate.id}
                      value={candidate.id}
                      onSelect={() => addDependency(candidate.id)}
                    >
                      <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate',
                          candidate.status === 'done' && 'text-muted-foreground line-through',
                        )}
                      >
                        {candidate.title}
                      </span>
                      <Badge variant="outline" className="shrink-0">
                        {STATUS_LABELS[candidate.status] ?? candidate.status}
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </div>
      )}
    </section>
  );
}

function TaskDetail({
  task,
  subtasks,
  hideDone,
  allTasks,
  members,
  agents,
  onUpdateAgent,
  onChangeAssignee,
  onChangeDependsOn,
  onChangeDates,
  workspaceId,
  currentUserId,
  currentUserEmail,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  onUploadFiles,
}: {
  task: Task;
  subtasks: Task[];
  /** Toolbar toggle: hide closed subtasks too, so it means the same thing here. */
  hideDone?: boolean;
  allTasks: Task[];
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onChangeAssignee: (assigneeId: string | null) => void;
  onChangeDependsOn: (next: string[]) => void;
  onChangeDates: (updates: Partial<Task>) => void;
  workspaceId: string;
  currentUserId?: string;
  currentUserEmail: string;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onDeleteSubtask: (id: string) => void;
  onUploadFiles?: (files: File[]) => Promise<UploadedFile[]>;
}) {
  const [subInput, setSubInput] = useState('');
  // Local draft so typing does not round-trip through the backend on every
  // keystroke; committed on blur. Re-seeded when the row changes underneath us
  // (id) or when the stored value changes (another client, an agent edit).
  const [description, setDescription] = useState(task.description || '');
  useEffect(() => {
    setDescription(task.description || '');
  }, [task.id, task.description]);
  const commitDescription = () => {
    if (description !== (task.description || '')) onChangeDates({ description });
  };
  const [commentInput, setCommentInput] = useState('');
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [pendingMentionAgent, setPendingMentionAgent] = useState<WorkspaceAgent | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const { comments, createComment, deleteComment } = useTaskComments(task.id, workspaceId, currentUserId);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachments = useMemo(() => parseMessageAttachments(task.attachments), [task.attachments]);

  // Upload through the SAME workspace file store the chat composer uses, then
  // fold the new refs into the existing list via onChangeDates — attachments is
  // just another Task field, so it goes through the identical Partial<Task>
  // updater every other section here already uses. parseMessageAttachments does
  // the deduping/capping, so a drop that partially overlaps what's already
  // there (or a double-fire of the same drop event) can't duplicate a chip.
  const uploadAttachments = async (files: File[]) => {
    if (!files.length || !onUploadFiles) return;
    setAttachmentUploading(true);
    try {
      const uploaded = await onUploadFiles(files);
      if (uploaded.length === 0) return;
      const next = parseMessageAttachments([
        ...attachments,
        ...uploaded.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size })),
      ]);
      onChangeDates({ attachments: next });
    } finally {
      setAttachmentUploading(false);
    }
  };

  const removeAttachment = (attachment: { id: string }) => {
    onChangeDates({ attachments: attachments.filter(item => item.id !== attachment.id) });
  };

  const handleAttachmentDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files || []);
    setAttachmentDragActive(false);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadAttachments(files);
  };

  const handleAttachmentDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    if (!attachmentDragActive) setAttachmentDragActive(true);
  };

  const handleAttachmentFilePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await uploadAttachments(files);
  };

  const addSub = () => {
    if (!subInput.trim()) return;
    onAddSubtask(subInput.trim());
    setSubInput('');
  };

  // @mentioning an agent or teammate in a comment assigns the task to them —
  // mirrors the chat composer's @-mention convention. Agents not yet enabled
  // for this workspace still show up so they can be added on the fly.
  const filteredMentionAgents = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    return agents.filter(agent => agent.name.toLowerCase().includes(q) || agentHandle(agent).includes(q));
  }, [agents, mentionQuery]);

  const filteredMentionMembers = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    return members.filter(member => (member.email || '').toLowerCase().includes(q));
  }, [members, mentionQuery]);

  const closeMentionPicker = () => {
    setShowMentionPicker(false);
    setMentionQuery('');
    setMentionStart(-1);
  };

  const handleCommentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCommentInput(value);

    if (showMentionPicker && mentionStart >= 0) {
      const afterAt = value.slice(mentionStart + 1);
      if (afterAt.indexOf(' ') === -1) {
        setMentionQuery(afterAt);
      } else {
        closeMentionPicker();
      }
    }

    const cursor = e.target.selectionStart || 0;
    if (value[cursor - 1] === '@' && !showMentionPicker) {
      setShowMentionPicker(true);
      setMentionQuery('');
      setMentionStart(cursor - 1);
    }
  };

  const insertMentionHandle = (handle: string) => {
    const selectionEnd = commentInputRef.current?.selectionStart || commentInput.length;
    const before = commentInput.slice(0, Math.max(0, mentionStart));
    const after = commentInput.slice(selectionEnd);
    const suffix = after.startsWith(' ') || after.length === 0 ? after : ` ${after}`;
    setCommentInput(`${before}@${handle} ${suffix}`.replace(/\s+$/, ' '));
    closeMentionPicker();
    commentInputRef.current?.focus();
  };

  const selectMentionAgent = (agent: WorkspaceAgent) => insertMentionHandle(agentHandle(agent));
  const selectMentionMember = (member: WorkspaceMember) => insertMentionHandle((member.email?.split('@')[0] || 'member').toLowerCase());

  const addComment = () => {
    const content = commentInput.trim();
    if (!content) return;
    createComment({ content });
    setCommentInput('');
    closeMentionPicker();

    const tokens = Array.from(content.matchAll(/@([a-z0-9_.-]+)/gi)).map(m => m[1].toLowerCase());
    for (const token of tokens) {
      const member = members.find(item => (item.email?.split('@')[0] || '').toLowerCase() === token);
      if (member) {
        onChangeAssignee(member.user_id);
        return;
      }
      const agent = agents.find(item => agentHandle(item) === token);
      if (agent) {
        if (agent.enabled === false) {
          setPendingMentionAgent(agent);
        } else {
          onChangeAssignee(agent.id);
        }
        return;
      }
    }
  };

  const addMentionedAgent = () => {
    if (!pendingMentionAgent) return;
    onUpdateAgent(pendingMentionAgent.id, { enabled: true });
    onChangeAssignee(pendingMentionAgent.id);
    setPendingMentionAgent(null);
  };

  // The x/y badge on the row above counts EVERY subtask, so the hidden ones are
  // still accounted for — this only stops "Hide done" leaving them on screen.
  const visibleSubtasks = useMemo(() => applyHideDone(subtasks, Boolean(hideDone)), [subtasks, hideDone]);
  const hiddenSubtaskCount = subtasks.length - visibleSubtasks.length;

  const startValue = toDateInputValue(task.start_date);
  const dueValue = toDateInputValue(task.due_date);
  // Both dates set, and due lands before start. Rendering still copes (the span
  // clamps to at least one day) but the row is telling you something is wrong.
  const rangeInverted = Boolean(startValue && dueValue && dueValue < startValue);

  return (
    <div className="task-detail ml-8 flex flex-col gap-4 border-l py-3 pr-3 pl-5">
      {/* The task BODY, first — before scheduling furniture.
          This section did not exist, and its absence read as data loss: the
          feedback button stores the user's whole message in tasks.description
          (see insertFeedbackReport in shared/backend-core.cjs), the row above
          shows only feedbackTaskTitle's first-90-characters title, and the only
          other renderer of `description` is the edit panel — which the LIST view
          never opens (onSelectTask is wired from Kanban and Gantt only). So in
          the default view a 2000-character report was on screen as one truncated
          sentence with no way to reach the rest of it. Editable rather than
          read-only because everything else in this panel is, and it commits on
          blur through the same Partial<Task> updater the date fields use. */}
      <section className="flex flex-col gap-2">
        <Marker>
          <MarkerIcon>
            <FileText />
          </MarkerIcon>
          <MarkerContent>Description</MarkerContent>
        </Marker>
        <Textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          onBlur={commitDescription}
          placeholder="Add a description..."
          aria-label="Task description"
          className="min-h-20 resize-y whitespace-pre-wrap text-xs"
        />
      </section>

      <section className="flex flex-col gap-2">
        <Marker>
          <MarkerIcon>
            <CalendarRange />
          </MarkerIcon>
          <MarkerContent>Schedule</MarkerContent>
        </Marker>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-2xs font-medium text-muted-foreground">
            Start date
            <Input
              type="date"
              value={startValue}
              max={dueValue || undefined}
              onChange={e => onChangeDates({ start_date: fromDateInputValue(e.target.value) })}
            />
          </label>
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-2xs font-medium text-muted-foreground">
            Due date
            <Input
              type="date"
              value={dueValue}
              min={startValue || undefined}
              onChange={e => onChangeDates({ due_date: fromDateInputValue(e.target.value) })}
            />
          </label>
        </div>
        {rangeInverted && (
          <p className="px-1 text-xs text-destructive">Due date is before the start date.</p>
        )}
        {!startValue && !dueValue && (
          <p className="px-1 text-xs text-muted-foreground">
            No dates yet — the timeline shows this as a marker on the day it was created.
          </p>
        )}
      </section>

      <DependencyPicker task={task} allTasks={allTasks} onChangeDependsOn={onChangeDependsOn} />

      <section className="flex flex-col gap-2">
        <Marker>
          <MarkerIcon>
            <CornerDownRight />
          </MarkerIcon>
          <MarkerContent>Subtasks</MarkerContent>
        </Marker>
        {hiddenSubtaskCount > 0 && (
          <p className="px-1 text-xs text-muted-foreground">
            {hiddenSubtaskCount} done or cancelled {hiddenSubtaskCount === 1 ? 'subtask' : 'subtasks'} hidden.
          </p>
        )}
        {visibleSubtasks.length > 0 && (
          <ItemGroup className="gap-1">
            {visibleSubtasks.map(subtask => {
              const subDone = subtask.status === 'done';
              return (
                <Item key={subtask.id} size="xs" variant="muted" className="task-subtask-row">
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => onToggleSubtask(subtask)} aria-label="Toggle subtask">
                    {subDone ? <CheckCircle2 /> : <Circle />}
                  </Button>
                  <ItemContent className="min-w-0">
                    <ItemTitle className={subDone ? 'max-w-full whitespace-normal text-muted-foreground line-through' : 'max-w-full whitespace-normal'}>
                      {subtask.title}
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button type="button" variant="ghost" size="icon-xs" onClick={() => onDeleteSubtask(subtask.id)} aria-label="Delete subtask">
                      <Trash2 />
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
        <InputGroup className="task-input-group">
          <InputGroupAddon>
            <CornerDownRight />
          </InputGroupAddon>
          <InputGroupInput
            value={subInput}
            onChange={e => setSubInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addSub();
            }}
            placeholder="Add a subtask..."
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={addSub} disabled={!subInput.trim()}>
              Add
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </section>

      {onUploadFiles && (
        <section className="flex flex-col gap-2">
          <Marker>
            <MarkerIcon>
              <Paperclip />
            </MarkerIcon>
            <MarkerContent>Attachments {attachments.length > 0 && `(${attachments.length})`}</MarkerContent>
          </Marker>
          <MessageAttachmentList attachments={attachments} onRemove={removeAttachment} className="mt-0" />
          <div
            data-testid="task-attachment-dropzone"
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground transition-colors',
              attachmentDragActive ? 'border-primary bg-primary/5 text-foreground' : 'border-border',
            )}
            onDragOver={handleAttachmentDragOver}
            onDragLeave={() => setAttachmentDragActive(false)}
            onDrop={handleAttachmentDrop}
          >
            <Upload className="size-4" />
            {attachmentUploading ? (
              'Uploading…'
            ) : (
              <>
                Drag files here, or{' '}
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  browse
                </button>
              </>
            )}
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleAttachmentFilePick}
            />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <Marker>
          <MarkerIcon>
            <MessageSquare />
          </MarkerIcon>
          <MarkerContent>Comments {comments.length > 0 && `(${comments.length})`}</MarkerContent>
        </Marker>
        {comments.length > 0 && (
          <ItemGroup className="gap-1">
            {comments.map(comment => (
              <TaskCommentItem
                key={comment.id}
                comment={comment}
                members={members}
                agents={agents}
                currentUserId={currentUserId}
                currentUserEmail={currentUserEmail}
                onDelete={() => deleteComment(comment.id)}
              />
            ))}
          </ItemGroup>
        )}
        {pendingMentionAgent && (
          <div className="task-mention-invite flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-xs">
            <UserPlus className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              <strong className="text-foreground">{pendingMentionAgent.name}</strong> isn&apos;t active in this workspace yet.
            </span>
            <Button type="button" size="sm" onClick={addMentionedAgent}>
              Add &amp; assign
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => setPendingMentionAgent(null)} aria-label="Dismiss">
              <X />
            </Button>
          </div>
        )}
        <div className="relative">
          {showMentionPicker && (filteredMentionAgents.length > 0 || filteredMentionMembers.length > 0) && (
            <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-[min(280px,45vh)] overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
              <CommandList className="max-h-[min(220px,38vh)]">
                <CommandEmpty>No agents or teammates found.</CommandEmpty>
                {filteredMentionAgents.length > 0 && (
                  <CommandGroup heading="Agents">
                    {filteredMentionAgents.map(agent => {
                      const inactive = agent.enabled === false;
                      return (
                        <CommandItem
                          key={agent.id}
                          value={`${agent.name} ${agentHandle(agent)}`}
                          className="rounded-lg px-2 py-1.5"
                          onSelect={() => selectMentionAgent(agent)}
                        >
                          <AgentAvatar
                            avatar={agent.avatar}
                            name={agent.name}
                            initials={agent.name.slice(0, 2).toUpperCase()}
                            className={MENTION_TILE}
                            fallbackClassName="bg-transparent text-3xs text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{agent.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {inactive ? 'Not in this channel — adds them on send' : (agent.description || agent.model || 'Agent')}
                            </span>
                          </span>
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">@{agentHandle(agent)}</span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
                {filteredMentionMembers.length > 0 && (
                  <CommandGroup heading="Teammates">
                    {filteredMentionMembers.map(member => (
                      <CommandItem
                        key={member.user_id}
                        value={member.email || member.user_id}
                        className="rounded-lg px-2 py-1.5"
                        onSelect={() => selectMentionMember(member)}
                      >
                        <span className={MENTION_TILE}>
                          <User className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{member.email?.split('@')[0] || 'Member'}</span>
                          <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          )}
          <InputGroup className="task-input-group">
            <InputGroupInput
              ref={commentInputRef}
              value={commentInput}
              onChange={handleCommentChange}
              onKeyDown={e => {
                if (showMentionPicker) {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    closeMentionPicker();
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    if (filteredMentionAgents.length > 0) {
                      e.preventDefault();
                      selectMentionAgent(filteredMentionAgents[0]);
                      return;
                    }
                    if (filteredMentionMembers.length > 0) {
                      e.preventDefault();
                      selectMentionMember(filteredMentionMembers[0]);
                      return;
                    }
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) addComment();
              }}
              placeholder="Write a comment... @mention to assign"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={addComment} disabled={!commentInput.trim()} aria-label="Send comment">
                <Send />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-hand editor panel used by the Kanban board and Gantt timeline. The
// board/timeline stays visible on the left; this panel edits the selected
// task's core fields (title/description/status/priority/assignee) and then
// reuses <TaskDetail> for depends_on / subtasks / comments.
// ---------------------------------------------------------------------------
/** How far one arrow-key press moves the resize seam, px. Matches usePaneSplit. */
const RESIZE_KEY_STEP = 24;

// Drag-to-resize for the task editor. Width rules live in lib/taskPanelWidth.
function useTaskPanelWidth() {
  const [width, setWidth] = useState(readStoredTaskPanelWidth);
  const asideRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // The panel must never be wider than its container leaves room for, so also
  // clamp on container resize — not just while dragging. Otherwise shrinking the
  // window re-creates the original overflow.
  const clamp = (next: number) => clampTaskPanelWidth(
    next,
    asideRef.current?.parentElement?.clientWidth ?? null,
  );

  useEffect(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(current => clamp(current)));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = asideRef.current?.getBoundingClientRect().width ?? width;
    setDragging(true);
    // Dragging the LEFT edge: moving left grows the panel, hence startX - x.
    const onMove = (moveEvent: PointerEvent) => setWidth(clamp(startWidth + (startX - moveEvent.clientX)));
    const onUp = () => {
      setDragging(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setWidth(current => {
        try { window.localStorage.setItem(TASK_PANEL_WIDTH_KEY, String(current)); } catch { /* private mode */ }
        return current;
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // Arrow-key parity. The seam is a focusable separator, so it needs to do
  // something when focused. Left grows the panel, matching the drag above:
  // this is the panel's LEFT edge, so moving it left makes the panel wider.
  const keyResize = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? RESIZE_KEY_STEP : event.key === 'ArrowRight' ? -RESIZE_KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    setWidth(current => {
      const next = clamp(current + step);
      try { window.localStorage.setItem(TASK_PANEL_WIDTH_KEY, String(next)); } catch { /* private mode */ }
      return next;
    });
  };

  return { width, asideRef, startResize, keyResize, dragging };
}

function TaskEditPanel({
  task,
  subtasks,
  allTasks,
  members,
  agents,
  onUpdateAgent,
  onOpenSession,
  workspaceId,
  currentUserId,
  currentUserEmail,
  hideDone,
  onClose,
  onChangeTitle,
  onChangeDescription,
  onChangeStatus,
  onChangePriority,
  onChangeAssignee,
  onChangeDependsOn,
  onChangeDates,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  onUploadFiles,
}: {
  task: Task;
  subtasks: Task[];
  allTasks: Task[];
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onOpenSession?: (sessionId: string) => void;
  workspaceId: string;
  currentUserId?: string;
  currentUserEmail: string;
  hideDone?: boolean;
  onClose: () => void;
  onChangeTitle: (title: string) => void;
  onChangeDescription: (description: string) => void;
  onChangeStatus: (status: TaskStatus) => void;
  onChangePriority: (priority: TaskPriority) => void;
  onChangeAssignee: (assigneeId: string | null) => void;
  onChangeDependsOn: (next: string[]) => void;
  onChangeDates: (updates: Partial<Task>) => void;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onDeleteSubtask: (id: string) => void;
  onUploadFiles?: (files: File[]) => Promise<UploadedFile[]>;
}) {
  // Local draft for the free-text fields so typing doesn't round-trip through
  // the backend on every keystroke; commit on blur. Reset when the selection
  // changes (keyed by task.id).
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const chatSessionId = taskChatSessionId(task);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description || '');
  }, [task.id, task.title, task.description]);

  const panel = useTaskPanelWidth();

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== task.title) onChangeTitle(next);
    else if (!next) setTitle(task.title);
  };

  const commitDescription = () => {
    if (description !== (task.description || '')) onChangeDescription(description);
  };

  // min-w-0: as a flex item this otherwise defaults to min-width:auto, i.e. its
  // min-CONTENT width, which overrides `width` outright — so a single wide child
  // could push the panel past clampTaskPanelWidth's 720px ceiling and off both
  // edges of the window. With it, the clamped width below is authoritative.
  return (
    <aside
      ref={panel.asideRef}
      className="task-edit-panel relative flex min-w-0 shrink-0 flex-col border-l border-border bg-card/55 backdrop-blur-md"
      style={{ width: panel.width }}
    >
      <ResizeHandle
        orientation="vertical"
        onPointerDown={panel.startResize}
        onKeyDown={panel.keyResize}
        dragging={panel.dragging}
        aria-label="Resize task editor"
        aria-valuenow={Math.round(panel.width)}
        aria-valuemin={TASK_PANEL_MIN_WIDTH}
        aria-valuemax={TASK_PANEL_MAX_WIDTH}
        title="Drag to resize."
        className="inset-y-0 -left-1.5 z-10"
      />
      <div className={cn(WINDOW_TOOLBAR, 'justify-between')}>
        <span className="text-xs font-semibold tracking-tight text-muted-foreground">Edit task</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close editor">
          <X />
        </Button>
      </div>
      {/* The `!block` override is the second half of 746fed7, and without it that
          fix only ever clamped the empty box. Radix drops a `display:table;
          min-width:100%` wrapper inside its viewport so content can be wider than
          the pane and scroll sideways — and a table shrink-wraps to MIN-CONTENT,
          which here is 397px (`.task-detail`'s ml-8 + pl-5 + pr-3 around two
          `min-w-32` date labels). The panel itself is clamped to 318–380px, so
          every control was laid out ~80px wider than the pane and the surplus was
          clipped: half a word of "In progress", half of "Add a description…". As
          `block` the content is the viewport's width and wraps instead. Same
          override, same reason, as Sidebar and ActivityWindowContent — an inline
          style, hence the `!`. min-w-0 lets the flex children give ground rather
          than re-establishing the same floor one level down. */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        <div className="flex min-w-0 flex-col gap-4 p-3">
          <div className="flex min-w-0 flex-col gap-2">
            {/* A textarea, not an Input, purely so a long title WRAPS.
                Task titles here are routinely a full sentence ("Can't escalate,
                share or save a thread — no path from a DM to another agent or
                channel"), and on one un-wrapping line the reader could only ever
                see the middle of it. A textarea soft-wraps, so its content width
                never exceeds its box — `field-sizing-content` (see ui/textarea)
                then grows HEIGHT only, never width. Enter still commits; the
                field holds a title, not prose, so newlines are not wanted. */}
            <Textarea
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                  e.currentTarget.blur();
                }
              }}
              rows={1}
              placeholder="Task title"
              aria-label="Task title"
              className="min-h-8 resize-none py-1.5 font-medium"
            />
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={commitDescription}
              placeholder="Add a description..."
              aria-label="Task description"
              className="min-h-20 resize-y"
            />
            <div className="flex gap-2">
              <NativeSelect
                value={task.status}
                onChange={e => onChangeStatus(e.target.value as TaskStatus)}
                size="sm"
                className="flex-1"
                aria-label="Task status"
              >
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map(status => (
                  <NativeSelectOption key={status} value={status}>{STATUS_LABELS[status]}</NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect
                value={task.priority}
                onChange={e => onChangePriority(e.target.value as TaskPriority)}
                size="sm"
                className="flex-1"
                aria-label="Task priority"
              >
                {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map(priority => (
                  <NativeSelectOption key={priority} value={priority}>{PRIORITY_LABELS[priority]}</NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <NativeSelect
              value={task.assignee_id || ''}
              onChange={e => onChangeAssignee(e.target.value || null)}
              size="sm"
              aria-label="Assign task"
            >
              <AssigneeOptions members={members} agents={agents} />
            </NativeSelect>
            {chatSessionId && onOpenSession && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => onOpenSession(chatSessionId)}
              >
                <ExternalLink data-icon="inline-start" />
                Open chat
              </Button>
            )}
          </div>
          <TaskDetail
            task={task}
            subtasks={subtasks}
            hideDone={hideDone}
            allTasks={allTasks}
            members={members}
            agents={agents}
            onUpdateAgent={onUpdateAgent}
            onChangeAssignee={onChangeAssignee}
            onChangeDependsOn={onChangeDependsOn}
            onChangeDates={onChangeDates}
            workspaceId={workspaceId}
            currentUserId={currentUserId}
            currentUserEmail={currentUserEmail}
            onAddSubtask={onAddSubtask}
            onToggleSubtask={onToggleSubtask}
            onDeleteSubtask={onDeleteSubtask}
            onUploadFiles={onUploadFiles}
          />
        </div>
      </ScrollArea>
    </aside>
  );
}

function TaskCommentItem({
  comment,
  members,
  agents,
  currentUserId,
  currentUserEmail,
  onDelete,
}: {
  comment: TaskComment;
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  currentUserId?: string;
  currentUserEmail: string;
  onDelete: () => void;
}) {
  const author = resolveTaskCommentAuthor(comment, { members, agents, currentUserId, currentUserEmail });
  const isAgent = author.kind === 'agent';

  return (
    <Item size="xs" variant="muted" className="task-comment-row items-start">
      {isAgent ? (
        <AgentAvatar
          avatar={author.avatar}
          name={author.label}
          initials={author.label.slice(0, 2).toUpperCase()}
          className="size-5 rounded-full bg-primary/15 text-primary"
          fallbackClassName="bg-transparent text-[9px] text-primary"
        />
      ) : (
        <TaskCommentAvatar email={author.email} seed={comment.user_id || comment.id} />
      )}
      <ItemContent className="min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-2xs font-semibold text-foreground">{author.label}</span>
          {isAgent && (
            <Badge variant="secondary" className="h-3.5 px-1 py-0 text-[9px] leading-none">agent</Badge>
          )}
          <span className="shrink-0 text-3xs text-muted-foreground">{formatRelativeTime(comment.created_at)}</span>
        </div>
        <ItemTitle className="max-w-full whitespace-normal text-xs font-normal leading-snug">{comment.content}</ItemTitle>
      </ItemContent>
      <ItemActions className="ml-1">
        <Button type="button" variant="ghost" size="icon-xs" onClick={onDelete} aria-label="Delete comment">
          <Trash2 />
        </Button>
      </ItemActions>
    </Item>
  );
}

function TaskCommentAvatar({ email, seed }: { email?: string; seed: string }) {
  const source = email || seed || 'user';
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  }
  const color = TASK_COMMENT_AVATAR_COLORS[Math.abs(hash) % TASK_COMMENT_AVATAR_COLORS.length];

  return (
    <Avatar size="sm" className="size-5">
      <AvatarFallback className={cn(color, 'text-[9px] font-bold text-white')}>
        {taskCommentInitial(email || seed)}
      </AvatarFallback>
    </Avatar>
  );
}

function taskCommentInitial(value?: string) {
  return (value?.[0] || 'U').toUpperCase();
}

function formatRelativeTime(iso: string) {
  const date = new Date(iso);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return '';
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Kanban board — four status columns; cards drag between them via native HTML5
// drag-and-drop (the same pattern ThreadWidgetRail uses). Dropping a card on a
// column calls onChangeStatus(taskId, columnStatus) which persists through
// onUpdateTask upstream.
// ---------------------------------------------------------------------------
