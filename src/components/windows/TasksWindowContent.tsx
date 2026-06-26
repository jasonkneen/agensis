import { useState, useMemo } from 'react';
import {
  CheckCircle2, Circle, Plus, Trash2, Flag, Clock, User,
  ChevronRight, ChevronDown, MessageSquare, CornerDownRight, Send,
} from 'lucide-react';
import type { Task, TaskStatus, TaskPriority } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { useTaskComments } from '../../hooks/useTaskComments';

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

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: 'var(--text-muted)',
  normal: 'var(--text-secondary)',
  high: '#f59e0b',
  urgent: '#ef4444',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

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
  const [filter, setFilter] = useState<'open' | 'all' | 'mine'>('open');

  // Children indexed by parent. Built from ALL tasks so a visible parent always
  // shows its subtasks even when a filter would otherwise hide them.
  const childrenMap = useMemo(() => {
    const m: Record<string, Task[]> = {};
    tasks.forEach(t => {
      if (t.parent_id) (m[t.parent_id] = m[t.parent_id] || []).push(t);
    });
    return m;
  }, [tasks]);

  const filteredTopLevel = useMemo(() => {
    const topLevel = tasks.filter(t => !t.parent_id);
    if (filter === 'open') return topLevel.filter(t => t.status !== 'done' && t.status !== 'cancelled');
    if (filter === 'mine') {
      const me = members.find(m => m.email === currentUserEmail);
      if (!me) return [];
      return topLevel.filter(t => t.assignee_id === me.user_id);
    }
    return topLevel;
  }, [tasks, filter, members, currentUserEmail]);

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], done: [], cancelled: [] };
    filteredTopLevel.forEach(t => g[t.status].push(t));
    return g;
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
    const m = members.find(mm => mm.user_id === assigneeId);
    return m?.email?.split('@')[0] || 'Someone';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--canvas-elevated)', flexShrink: 0,
      }}>
        {(['open', 'mine', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '4px 10px',
              background: filter === f ? 'var(--accent-subtle)' : 'transparent',
              border: filter === f ? '1px solid var(--accent-border)' : '1px solid transparent',
              borderRadius: 'var(--radius-sm)',
              color: filter === f ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {filteredTopLevel.filter(t => t.status !== 'done' && t.status !== 'cancelled').length} open
        </span>
      </div>

      {/* Add task row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        <Plus size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          type="text"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="Add a task..."
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text-primary)',
            fontSize: '13px',
          }}
        />
        <select
          value={newPriority}
          onChange={e => setNewPriority(e.target.value as TaskPriority)}
          style={{
            background: 'var(--canvas-raised)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-secondary)',
            fontSize: '11px',
            padding: '3px 6px',
            cursor: 'pointer',
          }}
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
        {members.length > 0 && (
          <select
            value={newAssignee}
            onChange={e => setNewAssignee(e.target.value)}
            style={{
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: '11px',
              padding: '3px 6px',
              cursor: 'pointer',
              maxWidth: '90px',
            }}
          >
            <option value="">Unassigned</option>
            {members.map(m => (
              <option key={m.user_id} value={m.user_id}>
                {m.email?.split('@')[0] || 'Member'}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={handleAdd}
          disabled={!newTitle.trim()}
          style={{
            padding: '5px 12px',
            background: newTitle.trim() ? 'var(--accent)' : 'var(--canvas-overlay)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: newTitle.trim() ? '#fff' : 'var(--text-muted)',
            fontSize: '11px',
            fontWeight: 500,
            cursor: newTitle.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Add
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filteredTopLevel.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '8px', padding: '40px 16px', textAlign: 'center',
          }}>
            <CheckCircle2 size={32} style={{ color: 'var(--text-muted)', opacity: 0.35 }} />
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              No tasks here. Type above to add one.
            </p>
          </div>
        ) : (
          (['in_progress', 'todo', 'done', 'cancelled'] as TaskStatus[]).map(status => {
            const items = grouped[status];
            if (items.length === 0) return null;
            return (
              <div key={status} style={{ padding: '8px 0' }}>
                <div style={{
                  padding: '4px 14px',
                  fontSize: '10px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  letterSpacing: '0.04em',
                }}>
                  {STATUS_LABELS[status]} ({items.length})
                </div>
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
                    onChangeStatus={(newStatus) => onUpdateTask(task.id, { status: newStatus })}
                    onChangeAssignee={(assigneeId) => onUpdateTask(task.id, { assignee_id: assigneeId })}
                    onAddSubtask={(title) => onCreateTask({ title, parent_id: task.id, source_type: 'manual' })}
                    onToggleSubtask={(sub) => onToggleStatus(sub)}
                    onDeleteSubtask={(id) => onDeleteTask(id)}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>
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
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const done = task.status === 'done';
  const doneSubs = subtasks.filter(s => s.status === 'done').length;

  return (
    <div>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '6px',
          padding: '8px 14px',
          background: hovered ? 'var(--canvas-raised)' : 'transparent',
          transition: 'background var(--transition-fast)',
        }}
      >
        <button
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Collapse' : 'Expand'}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            marginTop: '2px', color: 'var(--text-muted)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '14px',
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          onClick={onToggle}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0, marginTop: '1px',
            color: done ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0,
          }}
        >
          {done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
        </button>
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
          <div style={{
            fontSize: '13px',
            color: done ? 'var(--text-muted)' : 'var(--text-primary)',
            textDecoration: done ? 'line-through' : 'none',
            wordBreak: 'break-word',
            lineHeight: 1.4,
          }}>
            {task.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px', flexWrap: 'wrap' }}>
            {task.priority !== 'normal' && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                fontSize: '10px', color: PRIORITY_COLORS[task.priority], fontWeight: 500,
              }}>
                <Flag size={9} />
                {task.priority}
              </span>
            )}
            {task.due_date && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                fontSize: '10px', color: 'var(--text-muted)',
              }}>
                <Clock size={9} />
                {new Date(task.due_date).toLocaleDateString()}
              </span>
            )}
            {assigneeLabel && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                fontSize: '10px', color: 'var(--text-muted)',
              }}>
                <User size={9} />
                {assigneeLabel}
              </span>
            )}
            {subtasks.length > 0 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                fontSize: '10px', color: 'var(--text-muted)',
              }}>
                <CornerDownRight size={9} />
                {doneSubs}/{subtasks.length}
              </span>
            )}
            {task.source_type && task.source_type !== 'manual' && (
              <span style={{
                fontSize: '9px',
                padding: '1px 5px',
                background: 'var(--canvas-overlay)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.03em',
              }}>
                {task.source_type}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px', opacity: hovered ? 1 : 0, transition: 'opacity var(--transition-fast)' }}>
          {members.length > 0 && (
            <select
              value={task.assignee_id || ''}
              onChange={e => onChangeAssignee(e.target.value || null)}
              onClick={e => e.stopPropagation()}
              title="Assign to"
              style={{
                background: 'var(--canvas-raised)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                fontSize: '10px',
                padding: '2px 4px',
                cursor: 'pointer',
                maxWidth: '75px',
              }}
            >
              <option value="">Unassigned</option>
              {members.map(m => (
                <option key={m.user_id} value={m.user_id}>
                  {m.email?.split('@')[0] || 'Member'}
                </option>
              ))}
            </select>
          )}
          <select
            value={task.status}
            onChange={e => onChangeStatus(e.target.value as TaskStatus)}
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: '10px',
              padding: '2px 4px',
              cursor: 'pointer',
            }}
          >
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button
            onClick={onDelete}
            title="Delete task"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', display: 'flex', padding: '3px',
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

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
    <div style={{
      padding: '8px 14px 12px 34px',
      background: 'var(--canvas-elevated)',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      {/* Subtasks */}
      <div style={{
        fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
        color: 'var(--text-muted)', letterSpacing: '0.04em', marginBottom: '4px',
      }}>
        Subtasks
      </div>
      {subtasks.map(sub => {
        const subDone = sub.status === 'done';
        return (
          <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' }}>
            <button
              onClick={() => onToggleSubtask(sub)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: subDone ? 'var(--accent)' : 'var(--text-muted)', display: 'flex', flexShrink: 0,
              }}
            >
              {subDone ? <CheckCircle2 size={13} /> : <Circle size={13} />}
            </button>
            <span style={{
              flex: 1, fontSize: '12px',
              color: subDone ? 'var(--text-muted)' : 'var(--text-primary)',
              textDecoration: subDone ? 'line-through' : 'none', wordBreak: 'break-word',
            }}>
              {sub.title}
            </span>
            <button
              onClick={() => onDeleteSubtask(sub.id)}
              title="Delete subtask"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: '2px' }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
        <CornerDownRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          type="text"
          value={subInput}
          onChange={e => setSubInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addSub(); }}
          placeholder="Add a subtask..."
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--text-primary)', fontSize: '12px',
          }}
        />
        <button
          onClick={addSub}
          disabled={!subInput.trim()}
          style={{
            padding: '3px 8px',
            background: subInput.trim() ? 'var(--accent)' : 'var(--canvas-overlay)',
            border: 'none', borderRadius: 'var(--radius-sm)',
            color: subInput.trim() ? '#fff' : 'var(--text-muted)',
            fontSize: '10px', fontWeight: 500, cursor: subInput.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Add
        </button>
      </div>

      {/* Comments */}
      <div style={{
        fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
        color: 'var(--text-muted)', letterSpacing: '0.04em', margin: '12px 0 4px',
        display: 'flex', alignItems: 'center', gap: '5px',
      }}>
        <MessageSquare size={11} />
        Comments {comments.length > 0 && `(${comments.length})`}
      </div>
      {comments.map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '4px 0' }}>
          <div style={{
            width: '5px', height: '5px', borderRadius: '50%', marginTop: '6px',
            background: 'var(--accent)', flexShrink: 0,
          }} />
          <span style={{ flex: 1, fontSize: '12px', color: 'var(--text-primary)', wordBreak: 'break-word', lineHeight: 1.4 }}>
            {c.content}
          </span>
          <button
            onClick={() => deleteComment(c.id)}
            title="Delete comment"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: '2px' }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
        <input
          type="text"
          value={commentInput}
          onChange={e => setCommentInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addComment(); }}
          placeholder="Write a comment..."
          style={{
            flex: 1, background: 'var(--canvas-raised)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', outline: 'none', padding: '5px 8px',
            color: 'var(--text-primary)', fontSize: '12px',
          }}
        />
        <button
          onClick={addComment}
          disabled={!commentInput.trim()}
          title="Send"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', borderRadius: 'var(--radius-sm)',
            background: commentInput.trim() ? 'var(--accent)' : 'var(--canvas-overlay)',
            border: 'none', cursor: commentInput.trim() ? 'pointer' : 'not-allowed',
            color: commentInput.trim() ? '#fff' : 'var(--text-muted)', flexShrink: 0,
          }}
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  );
}
