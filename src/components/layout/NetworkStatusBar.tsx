import { WifiOff, RefreshCw, Check, AlertCircle } from 'lucide-react';

interface NetworkStatusBarProps {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  syncError: string | null;
  onSync: () => void;
  onClearQueue: () => void;
}

const buttonStyle = {
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-inverse)',
  fontSize: '11px',
  fontWeight: 600,
  padding: '2px 8px',
  cursor: 'pointer',
} as const;

export function NetworkStatusBar({ online, syncing, pendingCount, syncError, onSync, onClearQueue }: NetworkStatusBarProps) {
  if (online && pendingCount === 0 && !syncError) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 16px',
      background: !online
        ? 'var(--error-subtle)'
        : syncError
          ? 'var(--error-subtle)'
          : (pendingCount > 0 ? 'var(--warning-subtle)' : 'var(--success-subtle)'),
      borderBottom: '1px solid var(--border-subtle)',
      fontSize: '12px',
      fontWeight: 500,
      transition: 'all 300ms ease',
      flexWrap: 'wrap',
    }}>
      {!online ? (
        <>
          <WifiOff size={13} style={{ color: 'var(--error)' }} />
          <span style={{ color: 'var(--error)' }}>
            Offline — changes will sync when you reconnect
          </span>
        </>
      ) : syncError ? (
        <>
          <AlertCircle size={13} style={{ color: 'var(--error)' }} />
          <span style={{ color: 'var(--error)' }}>
            {syncError}
            {pendingCount > 0 ? ` (${pendingCount} queued)` : ''}
          </span>
          <button
            onClick={onSync}
            style={{
              ...buttonStyle,
              marginLeft: '4px',
              background: 'var(--error)',
            }}
          >
            Retry sync
          </button>
          <button
            onClick={() => {
              if (window.confirm('Clear the offline sync queue? Unsynced local changes will be lost.')) {
                onClearQueue();
              }
            }}
            style={{
              ...buttonStyle,
              background: 'var(--text-secondary)',
            }}
          >
            Clear queue
          </button>
        </>
      ) : syncing ? (
        <>
          <RefreshCw
            size={13}
            style={{
              color: 'var(--warning)',
              animation: 'spin 1s linear infinite',
            }}
          />
          <span style={{ color: 'var(--warning)' }}>
            Syncing {pendingCount} pending change{pendingCount !== 1 ? 's' : ''}...
          </span>
        </>
      ) : pendingCount > 0 ? (
        <>
          <RefreshCw size={13} style={{ color: 'var(--warning)' }} />
          <span style={{ color: 'var(--warning)' }}>
            {pendingCount} change{pendingCount !== 1 ? 's' : ''} pending
          </span>
          <button
            onClick={onSync}
            style={{
              ...buttonStyle,
              marginLeft: '4px',
              background: 'var(--warning)',
            }}
          >
            Sync now
          </button>
        </>
      ) : (
        <>
          <Check size={13} style={{ color: 'var(--success)' }} />
          <span style={{ color: 'var(--success)' }}>All changes synced</span>
        </>
      )}
    </div>
  );
}
