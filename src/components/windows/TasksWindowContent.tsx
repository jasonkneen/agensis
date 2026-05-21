import { useState, useMemo } from 'react';
import { CheckCircle2, Circle, Plus, Trash2, Flag, Clock, User } from 'lucide-react';
import type { Task, TaskStatus, TaskPriority } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { CreateTaskInput } from '../../hooks/useTasks';

interface TasksWindowContentProps {
  tasks: Task[];
  members: WorkspaceMember[];
  currentUserEmail: string;
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
  onCreateTask,
  onUpdateTask,
  onToggleStatus,
  onDeleteTask,
}: TasksWindowContentProps) {
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('normal');
  const [newAssignee, setNewAssignee] = useState<string>('');
  const [filter, setFilter] = useState<'open' | 'all' | 'mine'>('open');

  const filteredTasks = useMemo(() => {
    if (filter === 'open') return tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
    if (filter === 'mine') {
      const me = members.find(m => m.email === currentUserEmail);
      if (!me) return [];
      return tasks.filter(t => t.assignee_id === me.user_id);
    }
    return tasks;
  }, [tasks, filter, members, currentUserEmail]);

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], done: [], cancelled: [] };
    filteredTasks.forEach(t => g[t.status].push(t));
    return g;
  }, [filteredTasks]);

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
          {filteredTasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length} open
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
        {filteredTasks.length === 0 ? (
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
                    assigneeLabel={memberLabel(task.assignee_id)}
                    members={members}
                    onToggle={() => onToggleStatus(task)}
                    onDelete={() => onDeleteTask(task.id)}
                    onChangeStatus={(newStatus) => onUpdateTask(task.id, { status: newStatus })}
                    onChangeAssignee={(assigneeId) => onUpdateTask(task.id, { assignee_id: assigneeId })}
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
  assigneeLabel,
  members,
  onToggle,
  onDelete,
  onChangeStatus,
  onChangeAssignee,
}: {
  task: Task;
  assigneeLabel: string | null;
  members: WorkspaceMember[];
  onToggle: () => void;
  onDelete: () => void;
  onChangeStatus: (status: TaskStatus) => void;
  onChangeAssignee: (assigneeId: string | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const done = task.status === 'done';

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '8px 14px',
        background: hovered ? 'var(--canvas-raised)' : 'transparent',
        transition: 'background var(--transition-fast)',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          marginTop: '1px',
          color: done ? 'var(--accent)' : 'var(--text-muted)',
          flexShrink: 0,
        }}
      >
        {done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '13px',
          color: done ? 'var(--text-muted)' : 'var(--text-primary)',
          textDecoration: done ? 'line-through' : 'none',
          wordBreak: 'break-word',
          lineHeight: 1.4,
        }}>
          {task.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
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
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            display: 'flex',
            padding: '3px',
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
