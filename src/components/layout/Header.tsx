import React from 'react';
import { Search, Plus, Bell, ChevronRight, FileText, MessageSquare, Brain, LayoutGrid, CheckCircle2, Activity, Bot } from 'lucide-react';
import type { ActiveView } from '../../types';

interface HeaderProps {
  activeView: ActiveView;
  workspaceName: string;
  workspaceIcon: string;
  onViewChange: (view: ActiveView) => void;
  onNewItem: () => void;
  savedStatus: 'idle' | 'saving' | 'saved';
  onOpenCommandPalette: () => void;
}

const VIEW_LABELS: Record<ActiveView, { label: string; icon: React.ReactNode }> = {
  chat: { label: 'Chat', icon: <MessageSquare size={13} /> },
  document: { label: 'Documents', icon: <FileText size={13} /> },
  memory: { label: 'Memory', icon: <Brain size={13} /> },
  files: { label: 'Files', icon: <LayoutGrid size={13} /> },
  tasks: { label: 'Tasks', icon: <CheckCircle2 size={13} /> },
  activity: { label: 'Activity', icon: <Activity size={13} /> },
  agents: { label: 'AI Agents', icon: <Bot size={13} /> },
};

export function Header({ activeView, workspaceName, workspaceIcon, onViewChange, onNewItem, savedStatus, onOpenCommandPalette }: HeaderProps) {
  return (
    <header style={{
      height: 'var(--header-height)',
      background: 'var(--canvas-elevated)',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: '12px',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
        <span style={{ fontSize: '14px', lineHeight: 1 }}>{workspaceIcon}</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 500 }}>{workspaceName}</span>
        <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          color: 'var(--text-primary)',
          fontSize: '13px',
          fontWeight: 500,
        }}>
          {VIEW_LABELS[activeView].icon}
          <span>{VIEW_LABELS[activeView].label}</span>
        </div>
      </div>

      {activeView === 'document' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <div style={{
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: savedStatus === 'saved' ? 'var(--success)' : savedStatus === 'saving' ? 'var(--warning)' : 'var(--text-muted)',
            transition: 'background 0.3s',
          }} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {savedStatus === 'saving' ? 'Saving...' : savedStatus === 'saved' ? 'Saved' : ''}
          </span>
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        background: 'var(--canvas-raised)',
        borderRadius: 'var(--radius-md)',
        padding: '3px',
        border: '1px solid var(--border-subtle)',
      }}>
        {(Object.keys(VIEW_LABELS) as ActiveView[]).map(view => (
          <button
            key={view}
            onClick={() => onViewChange(view)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              padding: '4px 10px',
              borderRadius: '7px',
              background: activeView === view ? 'var(--canvas-overlay)' : 'transparent',
              border: activeView === view ? '1px solid var(--border)' : '1px solid transparent',
              cursor: 'pointer',
              color: activeView === view ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: '12px',
              fontWeight: activeView === view ? 500 : 400,
              transition: 'all var(--transition-fast)',
              whiteSpace: 'nowrap',
            }}
          >
            {VIEW_LABELS[view].icon}
            <span className="hidden sm:inline">{VIEW_LABELS[view].label}</span>
          </button>
        ))}
      </div>

      <button
        onClick={onOpenCommandPalette}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'var(--canvas-raised)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-md)',
          padding: '6px 12px',
          cursor: 'pointer',
          transition: 'all var(--transition-fast)',
          width: '180px',
        }}
      >
        <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{
          color: 'var(--text-muted)',
          fontSize: '13px',
          flex: 1,
          textAlign: 'left',
        }}>
          Search...
        </span>
        <kbd style={{
          fontSize: '10px',
          color: 'var(--text-muted)',
          background: 'var(--canvas-overlay)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '1px 5px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          {'\u2318'}K
        </kbd>
      </button>

      <button
        onClick={onNewItem}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          padding: '6px 12px',
          background: 'var(--accent)',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          color: 'white',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'background var(--transition-fast)',
          flexShrink: 0,
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
      >
        <Plus size={13} />
        New
      </button>

      <button style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--text-muted)',
        padding: '5px',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
      }}>
        <Bell size={15} />
      </button>

      <div style={{
        width: '30px',
        height: '30px',
        borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12px',
        fontWeight: 600,
        color: 'white',
        cursor: 'pointer',
        flexShrink: 0,
      }}>H</div>
    </header>
  );
}
