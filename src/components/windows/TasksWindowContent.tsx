import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  CornerDownRight,
  Flag,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  User,
} from 'lucide-react';
import type { Task, TaskPriority, TaskStatus } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { useTaskComments } from '../../hooks/useTaskComments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from '@/components/ui/marker';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface TasksWindowContentProps {
  tasks: Task[];
  members: WorkspaceMember[];
  currentUserEmail: string;
  workspaceId: string;
  currentUserId?: string;
  onCreateTask: (input: CreateTaskInput) => void;
  onUpdateTask: (id: string, updates: Partial<Task>) => void;
  onToggleStatus: (task: Task) => void;
  onDeleteTask: (id: string) => void;
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

type AssignmentFilter = 'all' | 'mine' | 'others';

export function TasksWindowContent({
  tasks,
  members,
  currentUserEmail,
  workspaceId,
  currentUserId,
  onCreateTask,
  onUpdateTask,
  onToggleStatus,
  onDeleteTask,
}: TasksWindowContentProps) {
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('normal');
  const [newAssignee, setNewAssignee] = useState<string>('');
  const [filter, setFilter] = useState<AssignmentFilter>('all');

  const childrenMap = useMemo(() => {
    const map: Record<string, Task[]> = {};
    tasks.forEach(task => {
      if (task.parent_id) {
        (map[task.parent_id] = map[task.parent_id] || []).push(task);
      }
    });
    return map;
  }, [tasks]);

  const filteredTopLevel = useMemo(() => {
    const topLevel = tasks.filter(task => !task.parent_id);
    const me = currentUserId || members.find(member => member.email === currentUserEmail)?.user_id || '';
    if (filter === 'mine') {
      if (!me) return [];
      return topLevel.filter(task => task.assignee_id === me);
    }
    if (filter === 'others') {
      return topLevel.filter(task => task.assignee_id && task.assignee_id !== me);
    }
    return topLevel;
  }, [tasks, filter, members, currentUserEmail, currentUserId]);

  const grouped = useMemo(() => {
    const groups: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], done: [], cancelled: [] };
    filteredTopLevel.forEach(task => groups[task.status].push(task));
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
    return member?.email?.split('@')[0] || 'Someone';
  };

  const openCount = filteredTopLevel.filter(task => task.status !== 'done' && task.status !== 'cancelled').length;

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
          {members.length > 0 && (
            <NativeSelect
              value={newAssignee}
              onChange={e => setNewAssignee(e.target.value)}
              size="sm"
              className="w-40 max-w-full"
              aria-label="Assignee"
            >
              <NativeSelectOption value="">Unassigned</NativeSelectOption>
              {members.map(member => (
                <NativeSelectOption key={member.user_id} value={member.user_id}>
                  {member.email?.split('@')[0] || 'Member'}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          <Button type="button" size="sm" onClick={handleAdd} disabled={!newTitle.trim()}>
            <Plus data-icon="inline-start" />
            Add
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
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
                <section key={status} className="flex flex-col gap-2">
                  <Marker variant="separator">
                    <MarkerContent>{STATUS_LABELS[status]} ({items.length})</MarkerContent>
                  </Marker>
                  <ItemGroup className="gap-1">
                    {items.map(task => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        subtasks={childrenMap[task.id] || []}
                        assigneeLabel={memberLabel(task.assignee_id)}
                        members={members}
                        workspaceId={workspaceId}
                        currentUserId={currentUserId}
                        onToggle={() => onToggleStatus(task)}
                        onDelete={() => onDeleteTask(task.id)}
                        onChangeStatus={newStatus => onUpdateTask(task.id, { status: newStatus })}
                        onChangeAssignee={assigneeId => onUpdateTask(task.id, { assignee_id: assigneeId })}
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
    </div>
  );
}

function TaskRow({
  task,
  subtasks,
  assigneeLabel,
  members,
  workspaceId,
  currentUserId,
  onToggle,
  onDelete,
  onChangeStatus,
  onChangeAssignee,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
}: {
  task: Task;
  subtasks: Task[];
  assigneeLabel: string | null;
  members: WorkspaceMember[];
  workspaceId: string;
  currentUserId?: string;
  onToggle: () => void;
  onDelete: () => void;
  onChangeStatus: (status: TaskStatus) => void;
  onChangeAssignee: (assigneeId: string | null) => void;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onDeleteSubtask: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const done = task.status === 'done';
  const doneSubs = subtasks.filter(subtask => subtask.status === 'done').length;

  return (
    <div className={`task-card ${expanded ? 'task-card-expanded' : ''}`}>
      <Item variant="outline" className="task-row items-start">
        <ItemActions className="gap-1 pt-0.5">
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
              <Badge variant="outline">
                <User />
                {assigneeLabel}
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
          {members.length > 0 && (
            <NativeSelect
              value={task.assignee_id || ''}
              onChange={e => onChangeAssignee(e.target.value || null)}
              onClick={e => e.stopPropagation()}
              size="sm"
              className="w-32"
              aria-label="Assign task"
            >
              <NativeSelectOption value="">Unassigned</NativeSelectOption>
              {members.map(member => (
                <NativeSelectOption key={member.user_id} value={member.user_id}>
                  {member.email?.split('@')[0] || 'Member'}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
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
          workspaceId={workspaceId}
          currentUserId={currentUserId}
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
  workspaceId,
  currentUserId,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
}: {
  task: Task;
  subtasks: Task[];
  workspaceId: string;
  currentUserId?: string;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onDeleteSubtask: (id: string) => void;
}) {
  const [subInput, setSubInput] = useState('');
  const [commentInput, setCommentInput] = useState('');
  const { comments, createComment, deleteComment } = useTaskComments(task.id, workspaceId, currentUserId);

  const addSub = () => {
    if (!subInput.trim()) return;
    onAddSubtask(subInput.trim());
    setSubInput('');
  };

  const addComment = () => {
    if (!commentInput.trim()) return;
    createComment({ content: commentInput.trim() });
    setCommentInput('');
  };

  return (
    <div className="task-detail ml-8 flex flex-col gap-4 border-l py-3 pr-3 pl-5">
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
              <Item key={comment.id} size="xs" variant="muted" className="task-comment-row">
                <ItemMedia className="size-2 rounded-full bg-primary" />
                <ItemContent className="min-w-0">
                  <ItemTitle className="max-w-full whitespace-normal font-normal">{comment.content}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => deleteComment(comment.id)} aria-label="Delete comment">
                    <Trash2 />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        <InputGroup className="task-input-group">
          <InputGroupInput
            value={commentInput}
            onChange={e => setCommentInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addComment();
            }}
            placeholder="Write a comment..."
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" onClick={addComment} disabled={!commentInput.trim()} aria-label="Send comment">
              <Send />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </section>
    </div>
  );
}
