import React, { useState } from 'react';
import {
  Search, Sparkles, FileText, Paperclip, FolderPlus,
  PanelLeftClose, PanelLeft, MessageSquare, Brain, LogOut,
  CheckCircle2, Activity, Bot, LayoutTemplate,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import type { ThemeMode } from '../../hooks/useTheme';
import type { Workspace, Document, ChatSession, FloatingWindow } from '../../types';

interface SidebarProps {
  workspace: Workspace | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenCommandPalette: () => void;
  onNewChat: () => void;
  onNewDocument: () => void;
  onUploadFile: () => void;
  onCreateWorkspace: () => void;
  onDocumentOpen: (doc: Document) => void;
  onSessionOpen: (session: ChatSession) => void;
  onOpenMemory: () => void;
  onOpenTasks?: () => void;
  onOpenActivity?: () => void;
  onOpenAgents?: () => void;
  onOpenTemplates?: () => void;
  openTaskCount?: number;
  recents: Document[];
  sessions: ChatSession[];
  floatingWindows: FloatingWindow[];
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  userEmail: string;
  onSignOut: () => void;
}

export function Sidebar({
  workspace,
  collapsed,
  onToggleCollapse,
  onOpenCommandPalette,
  onNewChat,
  onNewDocument,
  onUploadFile,
  onCreateWorkspace,
  onDocumentOpen,
  onSessionOpen,
  onOpenMemory,
  onOpenTasks,
  onOpenActivity,
  onOpenAgents,
  onOpenTemplates,
  openTaskCount = 0,
  recents,
  sessions,
  themeMode,
  onThemeChange,
  userEmail,
  onSignOut,
}: SidebarProps) {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  const userInitial = (userEmail[0] || 'U').toUpperCase();

  if (collapsed) {
    return (
      <aside style={{
        width: '52px',
        background: 'var(--canvas-elevated)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        height: '100%',
        flexShrink: 0,
        padding: '10px 0',
        gap: '4px',
      }}>
        <button
          onClick={onToggleCollapse}
          title="Expand sidebar"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            padding: '8px',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            marginBottom: '8px',
          }}
        >
          <PanelLeft size={16} />
        </button>
        <IconButton icon={<Search size={16} />} title="Search" onClick={onOpenCommandPalette} />
        <IconButton icon={<Sparkles size={16} />} title="New Chat" onClick={onNewChat} />
        <IconButton icon={<FileText size={16} />} title="New Document" onClick={onNewDocument} />
        {onOpenTasks && <IconButton icon={<CheckCircle2 size={16} />} title={`Tasks${openTaskCount ? ` (${openTaskCount})` : ''}`} onClick={onOpenTasks} />}
        {onOpenActivity && <IconButton icon={<Activity size={16} />} title="Activity" onClick={onOpenActivity} />}
        {onOpenAgents && <IconButton icon={<Bot size={16} />} title="AI Agents" onClick={onOpenAgents} />}
        {onOpenTemplates && <IconButton icon={<LayoutTemplate size={16} />} title="Templates" onClick={onOpenTemplates} />}
        <IconButton icon={<Brain size={16} />} title="Memory" onClick={onOpenMemory} />
        <div style={{ flex: 1 }} />
        <IconButton icon={<LogOut size={16} />} title="Sign out" onClick={onSignOut} />
      </aside>
    );
  }

  return (
    <aside style={{
      width: '200px',
      background: 'var(--canvas-elevated)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '10px 10px 6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <button
          onClick={onToggleCollapse}
          title="Collapse sidebar"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            padding: '4px',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            flexShrink: 0,
          }}
        >
          <PanelLeftClose size={15} />
        </button>
        <button
          onClick={onOpenCommandPalette}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 8px',
            background: 'var(--canvas-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: '12px',
            transition: 'border-color var(--transition-fast)',
          }}
        >
          <Search size={12} />
          <span>Search...</span>
        </button>
      </div>

      <div style={{ padding: '4px 8px 8px' }}>
        <ActionRow icon={<Sparkles size={14} />} label="Chat with AI" onClick={onNewChat} hovered={hoveredItem === 'chat'} onHover={() => setHoveredItem('chat')} onLeave={() => setHoveredItem(null)} />
        <ActionRow icon={<FileText size={14} />} label="Write a document" onClick={onNewDocument} hovered={hoveredItem === 'doc'} onHover={() => setHoveredItem('doc')} onLeave={() => setHoveredItem(null)} />
        <ActionRow icon={<Paperclip size={14} />} label="Upload a file" onClick={onUploadFile} hovered={hoveredItem === 'upload'} onHover={() => setHoveredItem('upload')} onLeave={() => setHoveredItem(null)} />
        <ActionRow icon={<FolderPlus size={14} />} label="Create a workspace" onClick={onCreateWorkspace} hovered={hoveredItem === 'ws'} onHover={() => setHoveredItem('ws')} onLeave={() => setHoveredItem(null)} />
        <ActionRow icon={<Brain size={14} />} label="Memory" onClick={onOpenMemory} hovered={hoveredItem === 'memory'} onHover={() => setHoveredItem('memory')} onLeave={() => setHoveredItem(null)} />
        {onOpenTasks && (
          <ActionRow
            icon={<CheckCircle2 size={14} />}
            label={openTaskCount > 0 ? `Tasks · ${openTaskCount}` : 'Tasks'}
            onClick={onOpenTasks}
            hovered={hoveredItem === 'tasks'}
            onHover={() => setHoveredItem('tasks')}
            onLeave={() => setHoveredItem(null)}
          />
        )}
        {onOpenActivity && (
          <ActionRow
            icon={<Activity size={14} />}
            label="Activity"
            onClick={onOpenActivity}
            hovered={hoveredItem === 'activity'}
            onHover={() => setHoveredItem('activity')}
            onLeave={() => setHoveredItem(null)}
          />
        )}
        {onOpenAgents && (
          <ActionRow
            icon={<Bot size={14} />}
            label="AI Agents"
            onClick={onOpenAgents}
            hovered={hoveredItem === 'agents'}
            onHover={() => setHoveredItem('agents')}
            onLeave={() => setHoveredItem(null)}
          />
        )}
        {onOpenTemplates && (
          <ActionRow
            icon={<LayoutTemplate size={14} />}
            label="Canvas Templates"
            onClick={onOpenTemplates}
            hovered={hoveredItem === 'templates'}
            onHover={() => setHoveredItem('templates')}
            onLeave={() => setHoveredItem(null)}
          />
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {recents.length === 0 && sessions.length === 0 ? (
          <div style={{ padding: '20px 8px', textAlign: 'center' }}>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 2px', fontWeight: 500 }}>No items yet</p>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0, opacity: 0.7 }}>Create your first document or chat</p>
          </div>
        ) : (
          <>
            {sessions.length > 0 && (
              <SectionLabel label="Chats" />
            )}
            {sessions.slice(0, 6).map(session => (
              <ItemRow
                key={session.id}
                icon={<MessageSquare size={13} />}
                label={session.title}
                onClick={() => onSessionOpen(session)}
              />
            ))}
            {recents.length > 0 && (
              <SectionLabel label="Documents" />
            )}
            {recents.slice(0, 6).map(doc => (
              <ItemRow
                key={doc.id}
                icon={<FileText size={13} />}
                label={doc.title}
                onClick={() => onDocumentOpen(doc)}
              />
            ))}
          </>
        )}
      </div>

      <div style={{
        padding: '8px 10px',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        <ThemeToggle mode={themeMode} onModeChange={onThemeChange} />
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <div style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            fontWeight: 600,
            color: 'white',
            flexShrink: 0,
          }}>{userInitial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--text-primary)',
              margin: 0,
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>{userEmail}</p>
            <p style={{ fontSize: '10px', color: 'var(--text-muted)', margin: 0 }}>
              {workspace?.name || 'Personal'}
            </p>
          </div>
          <button
            onClick={onSignOut}
            title="Sign out"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: '4px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              flexShrink: 0,
              transition: 'color var(--transition-fast)',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--error)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function IconButton({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: '36px',
        height: '36px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--radius-sm)',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--text-muted)',
        transition: 'all var(--transition-fast)',
      }}
    >
      {icon}
    </button>
  );
}

function ActionRow({
  icon, label, onClick, hovered, onHover, onLeave,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  hovered: boolean;
  onHover: () => void;
  onLeave: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '7px 8px',
        background: hovered ? 'var(--canvas-raised)' : 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        color: hovered ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: '13px',
        textAlign: 'left',
        transition: 'all var(--transition-fast)',
      }}
    >
      <span style={{ display: 'flex', color: hovered ? 'var(--accent)' : 'var(--text-muted)', transition: 'color var(--transition-fast)' }}>{icon}</span>
      {label}
    </button>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <p style={{
      fontSize: '11px',
      fontWeight: 500,
      color: 'var(--text-muted)',
      margin: '12px 4px 4px',
      letterSpacing: '0.02em',
    }}>
      {label}
    </p>
  );
}

function ItemRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 8px',
        background: 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        color: 'var(--text-secondary)',
        fontSize: '12px',
        textAlign: 'left',
        transition: 'background var(--transition-fast)',
        overflow: 'hidden',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--canvas-raised)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ flexShrink: 0, color: 'var(--text-muted)', display: 'flex' }}>{icon}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}
