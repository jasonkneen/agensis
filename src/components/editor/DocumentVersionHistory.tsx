import { History, RotateCcw, X } from 'lucide-react';
import type { DocumentVersion } from '../../types';

interface DocumentVersionHistoryProps {
  versions: DocumentVersion[];
  loading: boolean;
  onRestore: (version: DocumentVersion) => void;
  onClose: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return date.toLocaleDateString();
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

function contentPreview(content: string): string {
  const plain = stripHtml(content).trim();
  if (plain.length <= 80) return plain;
  return plain.slice(0, 80) + '...';
}

export function DocumentVersionHistory({
  versions,
  loading,
  onRestore,
  onClose,
}: DocumentVersionHistoryProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      width: '280px',
      borderLeft: '1px solid var(--border-subtle)',
      background: 'var(--canvas-elevated)',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        <History size={13} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          Version History
        </span>
        {versions.length > 0 && (
          <span style={{
            fontSize: '10px',
            padding: '1px 6px',
            background: 'var(--accent-subtle)',
            color: 'var(--accent)',
            borderRadius: '999px',
            fontWeight: 600,
          }}>
            {versions.length}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          title="Close version history"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            display: 'flex',
            padding: '2px',
          }}
        >
          <X size={12} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
        {loading ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px 8px',
          }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading...</span>
          </div>
        ) : versions.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '24px 8px',
            textAlign: 'center',
          }}>
            <History size={22} style={{ color: 'var(--text-muted)', opacity: 0.35 }} />
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
              No versions yet. Snapshots are created automatically as you edit.
            </p>
          </div>
        ) : (
          versions.map(version => (
            <div
              key={version.id}
              style={{
                marginBottom: '8px',
                padding: '8px 10px',
                background: 'var(--canvas-raised)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: 'var(--accent)',
                  background: 'var(--accent-subtle)',
                  padding: '1px 5px',
                  borderRadius: '4px',
                }}>
                  v{version.version_number}
                </span>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {version.title}
                </span>
                <span style={{ fontSize: '9px', color: 'var(--text-muted)', flexShrink: 0 }}>
                  {formatTime(version.created_at)}
                </span>
              </div>
              {version.content && (
                <p style={{
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  margin: '0 0 6px 0',
                  lineHeight: 1.4,
                  wordBreak: 'break-word',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {contentPreview(version.content)}
                </p>
              )}
              <button
                onClick={() => onRestore(version)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: 'none',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  fontSize: '10px',
                  padding: '3px 8px',
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--accent-subtle)';
                  e.currentTarget.style.color = 'var(--accent)';
                  e.currentTarget.style.borderColor = 'var(--accent-border)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'none';
                  e.currentTarget.style.color = 'var(--text-secondary)';
                  e.currentTarget.style.borderColor = 'var(--border-subtle)';
                }}
              >
                <RotateCcw size={10} />
                Restore
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
