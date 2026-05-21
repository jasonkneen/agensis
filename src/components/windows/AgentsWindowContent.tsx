import { useState } from 'react';
import { Bot, Plus, Trash2, Pencil, Save, X } from 'lucide-react';
import type { WorkspaceAgent } from '../../types';

interface AgentsWindowContentProps {
  agents: WorkspaceAgent[];
  onCreateAgent: (input: { name: string; avatar?: string; description?: string; system_prompt: string; model?: string }) => void;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
}

const MODEL_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

export function AgentsWindowContent({
  agents,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
}: AgentsWindowContentProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState('🤖');
  const [newDescription, setNewDescription] = useState('');
  const [newSystemPrompt, setNewSystemPrompt] = useState('');
  const [newModel, setNewModel] = useState('auto');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = () => {
    if (!newName.trim() || !newSystemPrompt.trim()) return;
    onCreateAgent({
      name: newName.trim(),
      avatar: newAvatar.trim() || '🤖',
      description: newDescription.trim(),
      system_prompt: newSystemPrompt.trim(),
      model: newModel,
    });
    setNewName('');
    setNewAvatar('🤖');
    setNewDescription('');
    setNewSystemPrompt('');
    setNewModel('auto');
    setShowCreate(false);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      onDeleteAgent(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--canvas-elevated)', flexShrink: 0,
      }}>
        <Bot size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>AI Agents</span>
        <span style={{
          fontSize: '10px',
          padding: '1px 6px',
          background: 'var(--canvas-overlay)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-muted)',
          fontWeight: 500,
        }}>
          {agents.length}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            padding: '4px 10px',
            background: showCreate ? 'var(--accent-subtle)' : 'var(--accent)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: showCreate ? 'var(--accent)' : '#fff',
            fontSize: '11px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          <Plus size={12} />
          Create Agent
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{
          padding: '12px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--canvas-elevated)',
          display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={newAvatar}
              onChange={e => setNewAvatar(e.target.value)}
              placeholder="🤖"
              style={{
                width: '40px',
                textAlign: 'center',
                background: 'var(--canvas-raised)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
                fontSize: '16px',
                padding: '4px',
              }}
            />
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Agent name"
              style={{
                flex: 1,
                background: 'var(--canvas-raised)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
                fontSize: '13px',
                padding: '6px 10px',
                outline: 'none',
              }}
            />
          </div>
          <input
            type="text"
            value={newDescription}
            onChange={e => setNewDescription(e.target.value)}
            placeholder="Short description (optional)"
            style={{
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: '12px',
              padding: '6px 10px',
              outline: 'none',
            }}
          />
          <textarea
            value={newSystemPrompt}
            onChange={e => setNewSystemPrompt(e.target.value)}
            placeholder="System prompt..."
            rows={3}
            style={{
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: '12px',
              padding: '6px 10px',
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <select
              value={newModel}
              onChange={e => setNewModel(e.target.value)}
              style={{
                background: 'var(--canvas-raised)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                fontSize: '11px',
                padding: '4px 8px',
                cursor: 'pointer',
              }}
            >
              {MODEL_OPTIONS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => setShowCreate(false)}
              style={{
                padding: '5px 12px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                fontSize: '11px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || !newSystemPrompt.trim()}
              style={{
                padding: '5px 12px',
                background: newName.trim() && newSystemPrompt.trim() ? 'var(--accent)' : 'var(--canvas-overlay)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                color: newName.trim() && newSystemPrompt.trim() ? '#fff' : 'var(--text-muted)',
                fontSize: '11px',
                fontWeight: 500,
                cursor: newName.trim() && newSystemPrompt.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Agent list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {agents.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: '8px', padding: '40px 16px', textAlign: 'center',
          }}>
            <Bot size={32} style={{ color: 'var(--text-muted)', opacity: 0.35 }} />
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              No agents yet. Create one to get started.
            </p>
          </div>
        ) : (
          agents.map(agent => (
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
            />
          ))
        )}
      </div>
    </div>
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
}: {
  agent: WorkspaceAgent;
  isEditing: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Partial<WorkspaceAgent>) => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [editName, setEditName] = useState(agent.name);
  const [editAvatar, setEditAvatar] = useState(agent.avatar);
  const [editDescription, setEditDescription] = useState(agent.description);
  const [editSystemPrompt, setEditSystemPrompt] = useState(agent.system_prompt);
  const [editModel, setEditModel] = useState(agent.model);

  const handleSave = () => {
    onSave({
      name: editName.trim(),
      avatar: editAvatar.trim() || '🤖',
      description: editDescription.trim(),
      system_prompt: editSystemPrompt.trim(),
      model: editModel,
    });
  };

  if (isEditing) {
    return (
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', flexDirection: 'column', gap: '8px',
      }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={editAvatar}
            onChange={e => setEditAvatar(e.target.value)}
            style={{
              width: '40px',
              textAlign: 'center',
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: '16px',
              padding: '4px',
            }}
          />
          <input
            type="text"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              padding: '6px 10px',
              outline: 'none',
            }}
          />
        </div>
        <input
          type="text"
          value={editDescription}
          onChange={e => setEditDescription(e.target.value)}
          placeholder="Short description (optional)"
          style={{
            background: 'var(--canvas-raised)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: '12px',
            padding: '6px 10px',
            outline: 'none',
          }}
        />
        <textarea
          value={editSystemPrompt}
          onChange={e => setEditSystemPrompt(e.target.value)}
          rows={3}
          style={{
            background: 'var(--canvas-raised)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: '12px',
            padding: '6px 10px',
            outline: 'none',
            resize: 'vertical',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <select
            value={editModel}
            onChange={e => setEditModel(e.target.value)}
            style={{
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: '11px',
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            {MODEL_OPTIONS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <div style={{ flex: 1 }} />
          <button
            onClick={onCancelEdit}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '5px 12px',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: '11px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <X size={11} />
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!editName.trim() || !editSystemPrompt.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '5px 12px',
              background: editName.trim() && editSystemPrompt.trim() ? 'var(--accent)' : 'var(--canvas-overlay)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: editName.trim() && editSystemPrompt.trim() ? '#fff' : 'var(--text-muted)',
              fontSize: '11px',
              fontWeight: 500,
              cursor: editName.trim() && editSystemPrompt.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            <Save size={11} />
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => { setHovered(true); onCancelDelete(); }}
      onMouseLeave={() => { setHovered(false); onCancelDelete(); }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '8px 14px',
        background: hovered ? 'var(--canvas-raised)' : 'transparent',
        transition: 'background var(--transition-fast)',
      }}
    >
      <span style={{ fontSize: '20px', lineHeight: 1, flexShrink: 0, marginTop: '1px' }}>
        {agent.avatar || '🤖'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '13px',
          color: 'var(--text-primary)',
          fontWeight: 500,
          wordBreak: 'break-word',
          lineHeight: 1.4,
        }}>
          {agent.name}
        </div>
        {agent.description && (
          <div style={{
            fontSize: '11px',
            color: 'var(--text-muted)',
            lineHeight: 1.4,
            marginTop: '2px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {agent.description}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
          <span style={{
            fontSize: '9px',
            padding: '1px 6px',
            background: 'var(--canvas-overlay)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.03em',
            fontWeight: 500,
          }}>
            {agent.model || 'auto'}
          </span>
        </div>
      </div>
      <div style={{
        display: 'flex', gap: '4px', alignItems: 'center',
        opacity: hovered ? 1 : 0,
        transition: 'opacity var(--transition-fast)',
      }}>
        <button
          onClick={onEdit}
          title="Edit agent"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            display: 'flex',
            padding: '3px',
          }}
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={onDelete}
          title={confirmDelete ? 'Click again to confirm' : 'Delete agent'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: confirmDelete ? '#ef4444' : 'var(--text-muted)',
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
