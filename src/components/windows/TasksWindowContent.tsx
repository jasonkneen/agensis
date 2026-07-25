import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Columns3,
  CornerDownRight,
  ExternalLink,
  Flag,
  GanttChart,
  Link2,
  List,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  User,
  UserPlus,
  X,
} from 'lucide-react';
import type { AgentConnection, Task, TaskComment, TaskPriority, TaskStatus, WorkspaceAgent } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { TASK_PANEL_WIDTH_KEY, clampTaskPanelWidth, readStoredTaskPanelWidth } from '../../lib/taskPanelWidth';
import { useTaskComments } from '../../hooks/useTaskComments';
import { agentHandle } from '../../lib/agentAccent';
import { isAssigneeActive, resolveTaskCommentAuthor } from '../../lib/taskAgents';
import {
  DAY_MS,
  buildGanttRows,
  buildTaskSpans,
  dependencyCandidates as resolveDependencyCandidates,
  dueDateFromExclusiveEnd,
  fromDateInputValue,
  startOfDay,
  taskDependsOn,
  toDateInputValue,
  type GanttRow,
  type TaskSpan,
} from './taskSchedule';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from '@/components/ui/marker';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

interface TasksWindowContentProps {
  tasks: Task[];
  members: WorkspaceMember[];
  agents: WorkspaceAgent[];
  /** Live daemon connections — used to show which assigned agents are actively working. */
  agentConnections: AgentConnection[];
  currentUserEmail: string;
  workspaceId: string;
  currentUserId?: string;
  onCreateTask: (input: CreateTaskInput) => void;
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
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

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

type AssignmentFilter = 'all' | 'mine' | 'others';

// A task dispatched to an agent records the chat it is being worked in:
// source_type 'chat' + the session id. Every other source_type stores a
// different kind of id (an agent id for 'ai', a canvas object id for 'canvas'),
// so only 'chat' is safe to open as a session.
function taskChatSessionId(task: Task): string | null {
  return task.source_type === 'chat' && task.source_id ? task.source_id : null;
}

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
}: TasksWindowContentProps) {
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('normal');
  const [newAssignee, setNewAssignee] = useState<string>('');
  const [filter, setFilter] = useState<AssignmentFilter>('all');
  const [hideDone, setHideDone] = useState(false);
  const [view, setView] = useState<'list' | 'kanban' | 'gantt'>('list');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

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

  const filteredTopLevel = useMemo(() => {
    const me = currentUserId || members.find(member => member.email === currentUserEmail)?.user_id || '';
    let list = allTopLevel;
    if (filter === 'mine') {
      list = me ? allTopLevel.filter(task => task.assignee_id === me) : [];
    } else if (filter === 'others') {
      list = allTopLevel.filter(task => task.assignee_id && task.assignee_id !== me);
    }
    // Cascades into `grouped` below, so it covers list/kanban/gantt in one place.
    if (hideDone) {
      list = list.filter(task => task.status !== 'done');
    }
    return list;
  }, [allTopLevel, filter, hideDone, members, currentUserEmail, currentUserId]);

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

  const handleAdd = () => {
    if (!newTitle.trim()) return;
    onCreateTask({
      title: newTitle.trim(),
      priority: newPriority,
      assignee_id: newAssignee || null,
      source_type: 'manual',
    });
    setNewTitle('');
    setNewPriority('normal');
    setNewAssignee('');
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

  const openCount = filteredTopLevel.filter(task => task.status !== 'done' && task.status !== 'cancelled').length;

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
  const focusRowId = useMemo(() => {
    if (!focusTaskId) return undefined;
    const target = tasks.find(t => t.id === focusTaskId);
    return target?.parent_id || focusTaskId;
  }, [focusTaskId, tasks]);

  useEffect(() => {
    if (!focusRowId) return;
    // The current assignment filter or "hide done" toggle may hide the focused
    // task's row entirely — e.g. jumping in from a comment/@mention link on a
    // task that's already done.
    if (!filteredTopLevel.some(task => task.id === focusRowId)) {
      if (filter !== 'all') setFilter('all');
      if (hideDone) setHideDone(false);
      return; // re-run once the wider list renders
    }
    const node = document.getElementById(`task-row-${focusRowId}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    onFocusTaskConsumed?.();
  }, [focusRowId, filter, hideDone, filteredTopLevel, onFocusTaskConsumed]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="task-window-toolbar flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 backdrop-blur-md">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={filter}
          onValueChange={value => {
            if (value) setFilter(value as AssignmentFilter);
          }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="mine">Mine</ToggleGroupItem>
          <ToggleGroupItem value="others" title="Assigned to other workspace members">Others</ToggleGroupItem>
        </ToggleGroup>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setHideDone(v => !v)}
          title={hideDone ? 'Show done tasks' : 'Hide done tasks'}
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
          <ToggleGroupItem value="list" title="List view"><List />List</ToggleGroupItem>
          <ToggleGroupItem value="kanban" title="Kanban board"><Columns3 />Board</ToggleGroupItem>
          <ToggleGroupItem value="gantt" title="Gantt timeline"><GanttChart />Timeline</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex-1" />
        <Badge variant="secondary">{openCount} open</Badge>
      </div>

      <div className="shrink-0 border-b border-border bg-card/55 p-3 backdrop-blur-md">
        <div className="task-add-row gap-2">
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
          <Button type="button" size="sm" onClick={handleAdd} disabled={!newTitle.trim()}>
            <Plus data-icon="inline-start" />
            Add
          </Button>
        </div>
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
}: {
  task: Task;
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
                {assigneeActive && <span className="text-[10px] font-medium">· working</span>}
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
        />
      )}
    </div>
  );
}

function TaskDetail({
  task,
  subtasks,
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
}: {
  task: Task;
  subtasks: Task[];
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
}) {
  const [subInput, setSubInput] = useState('');
  const [commentInput, setCommentInput] = useState('');
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [pendingMentionAgent, setPendingMentionAgent] = useState<WorkspaceAgent | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const { comments, createComment, deleteComment } = useTaskComments(task.id, workspaceId, currentUserId);

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

  // Candidate dependencies: every other task in the workspace, minus anything
  // that (transitively) already depends on THIS one. Excluding only the DIRECT
  // dependents was not enough — A->B->C left "C depends on A" selectable, and a
  // cycle hangs any topological layout.
  const dependsOn = taskDependsOn(task);
  const dependencyCandidates = useMemo(
    () => resolveDependencyCandidates(task, allTasks),
    [allTasks, task],
  );

  const toggleDependency = (candidateId: string) => {
    const set = new Set(dependsOn);
    if (set.has(candidateId)) set.delete(candidateId);
    else set.add(candidateId);
    onChangeDependsOn(Array.from(set));
  };

  const startValue = toDateInputValue(task.start_date);
  const dueValue = toDateInputValue(task.due_date);
  // Both dates set, and due lands before start. Rendering still copes (the span
  // clamps to at least one day) but the row is telling you something is wrong.
  const rangeInverted = Boolean(startValue && dueValue && dueValue < startValue);

  return (
    <div className="task-detail ml-8 flex flex-col gap-4 border-l py-3 pr-3 pl-5">
      <section className="flex flex-col gap-2">
        <Marker>
          <MarkerIcon>
            <CalendarRange />
          </MarkerIcon>
          <MarkerContent>Schedule</MarkerContent>
        </Marker>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
            Start date
            <Input
              type="date"
              value={startValue}
              max={dueValue || undefined}
              onChange={e => onChangeDates({ start_date: fromDateInputValue(e.target.value) })}
            />
          </label>
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
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

      <section className="flex flex-col gap-2">
        <Marker>
          <MarkerIcon>
            <Link2 />
          </MarkerIcon>
          <MarkerContent>Depends on {dependsOn.length > 0 && `(${dependsOn.length})`}</MarkerContent>
        </Marker>
        {dependencyCandidates.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No other tasks to depend on yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {dependencyCandidates.map(candidate => {
              const checked = dependsOn.includes(candidate.id);
              return (
                <label
                  key={candidate.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={checked}
                    onChange={() => toggleDependency(candidate.id)}
                  />
                  <span className={cn('min-w-0 flex-1 truncate', candidate.status === 'done' && 'text-muted-foreground line-through')}>
                    {candidate.title}
                  </span>
                  <Badge variant="outline" className="shrink-0">{STATUS_LABELS[candidate.status] ?? candidate.status}</Badge>
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <Marker>
          <MarkerIcon>
            <CornerDownRight />
          </MarkerIcon>
          <MarkerContent>Subtasks</MarkerContent>
        </Marker>
        {subtasks.length > 0 && (
          <ItemGroup className="gap-1">
            {subtasks.map(subtask => {
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
                          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                            <Bot className="size-4" />
                          </span>
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
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
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

  return { width, asideRef, startResize, dragging };
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

  return (
    <aside
      ref={panel.asideRef}
      className="task-edit-panel relative flex shrink-0 flex-col border-l border-border bg-card/55 backdrop-blur-md"
      style={{ width: panel.width }}
    >
      <div
        onPointerDown={panel.startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize task editor"
        className={cn(
          'absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-primary/0 after:transition-colors',
          'hover:after:bg-primary/40',
          panel.dragging && 'after:bg-primary/60',
        )}
      />
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold tracking-tight text-muted-foreground">Edit task</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close editor">
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-2">
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                }
              }}
              placeholder="Task title"
              aria-label="Task title"
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
        <Avatar size="sm" className="size-5">
          <AvatarFallback className="bg-primary/15 text-primary">
            <Bot className="size-3" />
          </AvatarFallback>
        </Avatar>
      ) : (
        <TaskCommentAvatar email={author.email} seed={comment.user_id || comment.id} />
      )}
      <ItemContent className="min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[11px] font-semibold text-foreground">{author.label}</span>
          {isAgent && (
            <Badge variant="secondary" className="h-3.5 px-1 py-0 text-[9px] leading-none">agent</Badge>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(comment.created_at)}</span>
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

const KANBAN_COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];

function TaskKanban({
  columns,
  memberLabel,
  selectedTaskId,
  onSelectTask,
  onChangeStatus,
  onReparent,
}: {
  columns: Record<TaskStatus, Task[]>;
  memberLabel: (assigneeId: string | null) => string | null;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onChangeStatus: (id: string, status: TaskStatus) => void;
  onReparent: (draggedId: string, targetId: string) => void;
}) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  // A card the dragged task is hovering over — dropping here nests as a subtask
  // instead of changing status.
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);

  const resetDrag = () => {
    setDragTaskId(null);
    setDragOver(null);
    setDragOverCardId(null);
  };

  const dropOnColumn = (status: TaskStatus) => {
    const id = dragTaskId;
    resetDrag();
    if (!id) return;
    const from = KANBAN_COLUMNS.find(col => columns[col].some(task => task.id === id));
    if (from === status) return;
    onChangeStatus(id, status);
  };

  const dropOnCard = (targetId: string) => {
    const id = dragTaskId;
    resetDrag();
    if (!id) return;
    onReparent(id, targetId);
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex gap-3 p-3">
        {KANBAN_COLUMNS.map(status => {
          const items = columns[status];
          return (
            <div
              key={status}
              className={cn(
                'flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-border bg-card/40 p-2 transition-colors',
                dragOver === status && 'border-primary/60 bg-primary/5',
              )}
              onDragOver={e => {
                if (!dragTaskId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Card handlers stopPropagation, so reaching here means the pointer
                // is over the column background — a status drop, not a nest.
                setDragOverCardId(null);
                setDragOver(status);
              }}
              onDragLeave={e => {
                // Only clear when the pointer actually leaves the column, not on
                // moves between its children.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOver(prev => (prev === status ? null : prev));
                }
              }}
              onDrop={e => {
                e.preventDefault();
                dropOnColumn(status);
              }}
            >
              <div className="flex items-center justify-between px-1 pt-0.5">
                <span className="text-xs font-semibold tracking-tight">{STATUS_LABELS[status]}</span>
                <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4 text-muted-foreground">
                  {items.length}
                </span>
              </div>
              {dragOver === status && dragTaskId && (
                <div className="h-8 rounded-md border border-dashed border-primary/50 bg-primary/5" aria-hidden />
              )}
              {items.map(task => {
                const assignee = memberLabel(task.assignee_id);
                const deps = taskDependsOn(task);
                return (
                  <div
                    key={task.id}
                    draggable
                    onClick={() => onSelectTask(task.id)}
                    onDragStart={e => {
                      setDragTaskId(task.id);
                      // Some browsers refuse to start an HTML5 drag with no payload.
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', task.id);
                    }}
                    onDragEnd={resetDrag}
                    onDragOver={e => {
                      // Hovering a different card = nest-as-subtask intent. Stop the
                      // event reaching the column so its status-drop highlight clears.
                      if (!dragTaskId || dragTaskId === task.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      setDragOver(null);
                      setDragOverCardId(task.id);
                    }}
                    onDragLeave={e => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragOverCardId(prev => (prev === task.id ? null : prev));
                      }
                    }}
                    onDrop={e => {
                      if (!dragTaskId || dragTaskId === task.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      dropOnCard(task.id);
                    }}
                    className={cn(
                      'flex cursor-grab flex-col gap-1.5 rounded-md border border-border bg-card p-2 shadow-sm active:cursor-grabbing',
                      dragTaskId === task.id && 'opacity-50',
                      dragOverCardId === task.id && 'border-primary bg-primary/10 ring-1 ring-primary/50',
                      selectedTaskId === task.id && 'border-primary/70 ring-1 ring-primary/40',
                    )}
                  >
                    <span className={cn('text-sm', task.status === 'done' && 'text-muted-foreground line-through')}>
                      {task.title}
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
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
                      {assignee && (
                        <Badge variant="outline">
                          <User />
                          {assignee}
                        </Badge>
                      )}
                      {deps.length > 0 && (
                        <Badge variant="outline" title="Depends on other tasks">
                          <Link2 />
                          {deps.length}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// Gantt timeline — rows are tasks (parents with their children inlined and
// indented underneath), the X axis is days.
//
// What a row draws comes from buildTaskSpans in ./taskSchedule:
//   'span'   — the task has start_date and/or due_date: a real range.
//   'rollup' — a parent: the union of its own dates and every scheduled
//              descendant, drawn as a slim summary bar (not draggable — moving
//              a summary would not move the children it summarises).
//   'point'  — NO dates anywhere in its subtree: a single-day diamond marker on
//              its created_at, deliberately unlike a bar so an unscheduled task
//              is never mistaken for a real one-day span.
//
// Bars drag horizontally (day-snapped) to reschedule; the right edge resizes
// due_date only. Dependency arrows are non-interactive SVG; a task that starts
// before a dependency ends gets a violation tint. Labels sit inside the bar when
// it is wide enough and outside it when it is not, so a one-day bar still reads
// as its title instead of "T…".
// ---------------------------------------------------------------------------

const GANTT_DAY_WIDTH = 32;
const GANTT_ROW_HEIGHT = 36;
const GANTT_LABEL_WIDTH = 208;
// Room to the right of the grid for labels that don't fit inside their bar.
const GANTT_LABEL_GUTTER = 168;
// Narrower than this and the title goes outside the bar rather than being
// truncated into a single character.
const GANTT_INSIDE_LABEL_MIN = 68;

interface GanttDrag {
  taskId: string;
  mode: 'move' | 'resize';
  originX: number;
  startMs: number;
  endMs: number;
}

function TaskGantt({
  tasks,
  allTasks,
  memberLabel,
  selectedTaskId,
  onSelectTask,
  onReschedule,
}: {
  /** Rows to chart (already assignment-filtered, top-level only). */
  tasks: Task[];
  /** EVERY task in the workspace — needed to resolve children and rollups. */
  allTasks: Task[];
  memberLabel: (assigneeId: string | null) => string | null;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onReschedule: (id: string, updates: Partial<Task>) => void;
}) {
  const [drag, setDrag] = useState<GanttDrag | null>(null);
  // Preview offset (in snapped days) applied to the dragging bar before commit.
  const [previewDays, setPreviewDays] = useState(0);

  const rows = useMemo<GanttRow[]>(() => buildGanttRows(tasks, allTasks), [tasks, allTasks]);
  // Spans are resolved over ALL tasks so a parent still rolls up over a child
  // the assignment filter hides.
  const spans = useMemo(() => buildTaskSpans(allTasks), [allTasks]);
  const spanOf = (task: Task): TaskSpan => {
    const span = spans.get(task.id);
    if (span) return span;
    const day = startOfDay(new Date(task.created_at).getTime());
    return { startMs: day, endMs: day + DAY_MS, kind: 'point' };
  };

  const { windowStart, dayCount } = useMemo(() => {
    const today = startOfDay(Date.now());
    let min = today - 7 * DAY_MS;
    let max = today + 30 * DAY_MS;
    for (const row of rows) {
      const span = spans.get(row.task.id);
      if (!span) continue;
      min = Math.min(min, span.startMs);
      max = Math.max(max, span.endMs);
    }
    const days = Math.max(1, Math.round((max - min) / DAY_MS) + 1);
    return { windowStart: min, dayCount: days };
  }, [rows, spans]);

  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.task.id, i));
    return map;
  }, [rows]);

  const dayToX = (ms: number) => ((startOfDay(ms) - windowStart) / DAY_MS) * GANTT_DAY_WIDTH;
  const gridWidth = dayCount * GANTT_DAY_WIDTH;
  const contentWidth = gridWidth + GANTT_LABEL_GUTTER;
  const gridHeight = rows.length * GANTT_ROW_HEIGHT;

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const deltaDays = Math.round((e.clientX - drag.originX) / GANTT_DAY_WIDTH);
      setPreviewDays(deltaDays);
    };
    const onUp = (e: PointerEvent) => {
      const deltaDays = Math.round((e.clientX - drag.originX) / GANTT_DAY_WIDTH);
      if (deltaDays === 0) {
        // No movement — treat a plain (non-resize) press as a click that opens
        // the editor. The resize handle should never open the panel.
        if (drag.mode === 'move') onSelectTask(drag.taskId);
      } else if (drag.mode === 'move') {
        // Materialize both dates so the update shape is always {start_date, due_date}
        // — dragging an undated marker is how you schedule it in the first place.
        // drag.endMs is EXCLUSIVE, so due_date is the day before it.
        const nextStart = drag.startMs + deltaDays * DAY_MS;
        const nextEnd = drag.endMs + deltaDays * DAY_MS;
        onReschedule(drag.taskId, {
          start_date: new Date(nextStart).toISOString(),
          due_date: dueDateFromExclusiveEnd(nextEnd),
        });
      } else {
        // Resize the right edge: due_date only, floored to at least one day wide.
        const nextEnd = Math.max(drag.startMs + DAY_MS, drag.endMs + deltaDays * DAY_MS);
        onReschedule(drag.taskId, { due_date: dueDateFromExclusiveEnd(nextEnd) });
      }
      setDrag(null);
      setPreviewDays(0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, onReschedule, onSelectTask]);

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        No tasks to chart. Add one above.
      </div>
    );
  }

  // Dependency arrows: dep bar end -> task bar start, only when both are visible.
  const arrows: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; violation: boolean }> = [];
  for (const row of rows) {
    const toRow = rowIndex.get(row.task.id);
    if (toRow === undefined) continue;
    const taskStart = spanOf(row.task).startMs;
    for (const depId of taskDependsOn(row.task)) {
      const fromRow = rowIndex.get(depId);
      if (fromRow === undefined) continue;
      const depEnd = spanOf(rows[fromRow].task).endMs;
      arrows.push({
        key: `${depId}->${row.task.id}`,
        x1: dayToX(depEnd),
        y1: fromRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2,
        x2: dayToX(taskStart),
        y2: toRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2,
        violation: taskStart < depEnd,
      });
    }
  }

  // Day header ticks — label the 1st of each month plus every 7th day so the
  // axis stays readable at 32px/day without crowding.
  const ticks: Array<{ x: number; label: string }> = [];
  for (let i = 0; i < dayCount; i++) {
    const ms = windowStart + i * DAY_MS;
    const d = new Date(ms);
    if (d.getDate() === 1 || i === 0 || i % 7 === 0) {
      ticks.push({ x: i * GANTT_DAY_WIDTH, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
    }
  }
  const todayX = dayToX(Date.now());
  const todayVisible = todayX >= 0 && todayX <= gridWidth;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex" style={{ width: GANTT_LABEL_WIDTH + contentWidth }}>
        {/* Sticky task-label column */}
        <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-background" style={{ width: GANTT_LABEL_WIDTH }}>
          <div className="h-8 border-b border-border" />
          {rows.map(row => {
            const assignee = memberLabel(row.task.assignee_id);
            const span = spanOf(row.task);
            return (
              <div
                key={row.task.id}
                className={cn(
                  'flex cursor-pointer flex-col justify-center overflow-hidden border-b border-border/60 pr-2',
                  selectedTaskId === row.task.id && 'bg-primary/10',
                )}
                style={{ height: GANTT_ROW_HEIGHT, paddingLeft: 8 + row.depth * 12 }}
                onClick={() => onSelectTask(row.task.id)}
                title={row.task.title}
              >
                <span className="flex min-w-0 items-center gap-1">
                  {row.depth > 0 && <CornerDownRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className={cn(
                    'truncate text-xs',
                    row.hasChildren && 'font-medium',
                    row.task.status === 'done' && 'text-muted-foreground line-through',
                  )}>
                    {row.task.title}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
                  {span.kind === 'point' && <span className="shrink-0">unscheduled</span>}
                  {assignee && <span className="truncate">{assignee}</span>}
                </span>
              </div>
            );
          })}
        </div>

        {/* Timeline grid */}
        <div className="relative" style={{ width: contentWidth }}>
          {/* Day header */}
          <div className="relative h-8 border-b border-border" style={{ width: contentWidth }}>
            {ticks.map(tick => (
              <div
                key={tick.x}
                className="absolute top-0 flex h-full items-center border-l border-border/40 pl-1 text-[10px] text-muted-foreground"
                style={{ left: tick.x }}
              >
                {tick.label}
              </div>
            ))}
          </div>

          <div className="relative" style={{ width: contentWidth, height: gridHeight }}>
            {/* Row backgrounds */}
            {rows.map((row, i) => (
              <div
                key={row.task.id}
                className={cn(
                  'absolute left-0 border-b border-border/40',
                  selectedTaskId === row.task.id && 'bg-primary/5',
                )}
                style={{ top: i * GANTT_ROW_HEIGHT, height: GANTT_ROW_HEIGHT, width: contentWidth }}
              />
            ))}

            {/* Today marker */}
            {todayVisible && (
              <div className="absolute top-0 z-0 w-px bg-primary/40" style={{ left: todayX, height: gridHeight }} aria-hidden />
            )}

            {/* Dependency arrows */}
            <svg className="pointer-events-none absolute inset-0 overflow-visible" width={gridWidth} height={gridHeight} aria-hidden>
              <defs>
                <marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" className="fill-muted-foreground/60" />
                </marker>
              </defs>
              {arrows.map(arrow => (
                <path
                  key={arrow.key}
                  d={`M${arrow.x1},${arrow.y1} L${(arrow.x1 + arrow.x2) / 2},${arrow.y1} L${(arrow.x1 + arrow.x2) / 2},${arrow.y2} L${arrow.x2},${arrow.y2}`}
                  fill="none"
                  className={cn('stroke-[1.5]', arrow.violation ? 'stroke-destructive/70' : 'stroke-muted-foreground/40')}
                  markerEnd="url(#gantt-arrow)"
                />
              ))}
            </svg>

            {/* Bars */}
            {rows.map((row, i) => {
              const task = row.task;
              const span = spanOf(task);
              const isDragging = drag?.taskId === task.id;
              const shiftDays = isDragging ? previewDays : 0;
              const moveShift = isDragging && drag?.mode === 'move' ? shiftDays : 0;
              const resizeShift = isDragging && drag?.mode === 'resize' ? shiftDays : 0;
              const left = dayToX(span.startMs + moveShift * DAY_MS);
              const days = Math.max(1, (span.endMs - span.startMs) / DAY_MS + resizeShift);
              const width = days * GANTT_DAY_WIDTH;
              const deps = taskDependsOn(task);
              const violation = deps.some(depId => {
                const depRow = rowIndex.get(depId);
                if (depRow === undefined) return false;
                return span.startMs < spanOf(rows[depRow].task).endMs;
              });
              // A narrow bar cannot hold its title: truncating inside it is what
              // produced the "T…" / "A…" labels, so the title moves outside instead.
              const labelInside = span.kind === 'span' && width >= GANTT_INSIDE_LABEL_MIN;
              const statusTint = task.status === 'done'
                ? 'border-emerald-500/40 bg-emerald-500/25'
                : task.status === 'cancelled'
                  ? 'border-border bg-muted'
                  : 'border-primary/40 bg-primary/25';
              const tooltip = [
                task.title,
                span.kind === 'point'
                  ? 'no dates set — drag to schedule'
                  : span.kind === 'rollup'
                    ? 'rolled up from subtasks'
                    : `${new Date(span.startMs).toLocaleDateString()} → ${new Date(span.endMs - DAY_MS).toLocaleDateString()}`,
                violation ? 'starts before a dependency ends' : null,
              ].filter(Boolean).join(' — ');

              const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
                if (e.button !== 0) return;
                e.preventDefault();
                if (mode === 'resize') e.stopPropagation();
                setDrag({ taskId: task.id, mode, originX: e.clientX, startMs: span.startMs, endMs: span.endMs });
                setPreviewDays(0);
              };

              return (
                <div
                  key={task.id}
                  className="pointer-events-none absolute flex items-center gap-1.5"
                  style={{ left, top: i * GANTT_ROW_HEIGHT, height: GANTT_ROW_HEIGHT }}
                  // Which of the three shapes this row drew, and where its title
                  // ended up. Asserted by tests/unit/tasksWindowRender.test.ts —
                  // "every bar is a narrow block with a one-character label" is
                  // otherwise only visible to a human looking at the screen.
                  data-gantt-kind={span.kind}
                  data-gantt-label={labelInside ? 'inside' : 'outside'}
                  data-gantt-days={Math.round(days)}
                >
                  {span.kind === 'point' ? (
                    // Single-day marker: a diamond, NOT a bar. An undated task
                    // must not look like a real one-day span.
                    <span
                      className="pointer-events-auto grid cursor-pointer place-items-center"
                      style={{ width: GANTT_DAY_WIDTH, height: GANTT_ROW_HEIGHT }}
                      title={tooltip}
                      onPointerDown={e => startDrag(e, 'move')}
                    >
                      <span
                        className={cn(
                          'size-2.5 rotate-45 border border-dashed',
                          task.status === 'done' ? 'border-emerald-500/70 bg-emerald-500/20' : 'border-muted-foreground/70 bg-muted-foreground/15',
                          selectedTaskId === task.id && 'border-primary bg-primary/40',
                          isDragging && 'opacity-70',
                        )}
                        aria-hidden
                      />
                    </span>
                  ) : span.kind === 'rollup' ? (
                    // Summary bar: slim, with end caps, spanning its children. It
                    // is derived from them, so it CLICKS to select rather than
                    // dragging — moving a summary would move nothing real.
                    <span
                      className="pointer-events-auto relative flex cursor-pointer items-center"
                      style={{ width, height: GANTT_ROW_HEIGHT }}
                      title={tooltip}
                      onClick={() => onSelectTask(task.id)}
                    >
                      <span
                        className={cn(
                          'absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-sm bg-foreground/45',
                          selectedTaskId === task.id && 'bg-primary',
                          violation && 'bg-destructive/70',
                        )}
                        aria-hidden
                      />
                      <span className="absolute top-1/2 left-0 size-2 -translate-y-1/2 rotate-45 bg-foreground/60" aria-hidden />
                      <span className="absolute top-1/2 right-0 size-2 -translate-y-1/2 rotate-45 bg-foreground/60" aria-hidden />
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'pointer-events-auto flex cursor-pointer items-center overflow-hidden rounded-md border text-[10px] shadow-sm',
                        statusTint,
                        violation && 'ring-1 ring-destructive/60',
                        selectedTaskId === task.id && 'ring-2 ring-primary',
                        isDragging && 'opacity-80',
                      )}
                      style={{ width, height: GANTT_ROW_HEIGHT - 12 }}
                      title={tooltip}
                      onPointerDown={e => startDrag(e, 'move')}
                    >
                      {labelInside && (
                        <span className="pointer-events-none min-w-0 flex-1 truncate px-1.5">{task.title}</span>
                      )}
                      {/* Right-edge resize handle (due_date only) */}
                      <span
                        className="ml-auto h-full w-2 shrink-0 cursor-ew-resize bg-foreground/10 hover:bg-foreground/25"
                        onPointerDown={e => startDrag(e, 'resize')}
                        aria-label="Resize due date"
                      />
                    </span>
                  )}
                  {/* Labels that don't fit inside their bar sit beside it, so a
                      one-day bar still reads as its title rather than "T…". */}
                  {!labelInside && (
                    <span
                      className={cn(
                        'whitespace-nowrap text-[10px]',
                        span.kind === 'point' ? 'text-muted-foreground' : 'text-foreground/80',
                        task.status === 'done' && 'text-muted-foreground line-through',
                      )}
                    >
                      {task.title}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
