import React, { useState, useMemo } from 'react';
import { MessageCircle, Send, Check, Trash2, CornerDownRight, X } from 'lucide-react';
import type { DocumentComment } from '../../types';
import type { CreateCommentInput } from '../../hooks/useDocumentComments';

interface DocumentCommentsProps {
  comments: DocumentComment[];
  topLevel: DocumentComment[];
  replyMap: Record<string, DocumentComment[]>;
  currentUserId?: string;
  currentUserEmail: string;
  pendingAnchor?: string;
  onAnchorConsumed?: () => void;
  onCreate: (input: CreateCommentInput) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onClose?: () => void;
}

function userInitial(email?: string): string {
  return (email?.[0] || 'U').toUpperCase();
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return date.toLocaleDateString();
}

export function DocumentComments({
  comments,
  topLevel,
  replyMap,
  currentUserEmail,
  pendingAnchor,
  onAnchorConsumed,
  onCreate,
  onResolve,
  onDelete,
  onClose,
}: DocumentCommentsProps) {
  const [newContent, setNewContent] = useState('');
  const [anchorText, setAnchorText] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  // When a pending anchor arrives from the doc selection, absorb it
  if (pendingAnchor && pendingAnchor !== anchorText) {
    setAnchorText(pendingAnchor);
    onAnchorConsumed?.();
  }

  const visibleTopLevel = useMemo(
    () => topLevel.filter(c => showResolved || !c.resolved),
    [topLevel, showResolved],
  );

  const unresolvedCount = topLevel.filter(c => !c.resolved).length;

  const handleSubmit = () => {
    if (!newContent.trim()) return;
    onCreate({
      content: newContent.trim(),
      parent_id: replyTo,
      anchor_text: replyTo ? undefined : anchorText || undefined,
    });
    setNewContent('');
    setAnchorText('');
    setReplyTo(null);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

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
        <MessageCircle size={13} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          Comments
        </span>
        {unresolvedCount > 0 && (
          <span style={{
            fontSize: '10px',
            padding: '1px 6px',
            background: 'var(--accent-subtle)',
            color: 'var(--accent)',
            borderRadius: '999px',
            fontWeight: 600,
          }}>
            {unresolvedCount}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowResolved(v => !v)}
          title={showResolved ? 'Hide resolved' : 'Show resolved'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: showResolved ? 'var(--accent)' : 'var(--text-muted)',
            fontSize: '10px',
            padding: '2px 4px',
          }}
        >
          {showResolved ? 'Hide resolved' : 'Show all'}
        </button>
        {onClose && (
          <button
            onClick={onClose}
            title="Close comments"
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
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
        {visibleTopLevel.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '24px 8px',
            textAlign: 'center',
          }}>
            <MessageCircle size={22} style={{ color: 'var(--text-muted)', opacity: 0.35 }} />
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
              {comments.length === 0
                ? 'No comments yet. Start a conversation about this doc.'
                : 'No unresolved comments.'}
            </p>
          </div>
        ) : (
          visibleTopLevel.map(comment => (
            <CommentThread
              key={comment.id}
              comment={comment}
              replies={replyMap[comment.id] || []}
              isReplyTarget={replyTo === comment.id}
              onStartReply={() => setReplyTo(comment.id)}
              onCancelReply={() => setReplyTo(null)}
              onResolve={onResolve}
              onDelete={onDelete}
            />
          ))
        )}
      </div>

      <div style={{
        padding: '10px 12px',
        borderTop: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        {anchorText && !replyTo && (
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '6px',
            marginBottom: '6px',
            padding: '4px 6px',
            background: 'var(--canvas-overlay)',
            borderLeft: '2px solid var(--accent)',
            borderRadius: '2px',
            fontSize: '10px',
            fontStyle: 'italic',
            color: 'var(--text-muted)',
          }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
              &ldquo;{anchorText.slice(0, 120)}{anchorText.length > 120 ? '...' : ''}&rdquo;
            </span>
            <button
              onClick={() => setAnchorText('')}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                display: 'flex',
                padding: 0,
                flexShrink: 0,
              }}
            >
              <X size={10} />
            </button>
          </div>
        )}
        {replyTo && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginBottom: '6px',
            fontSize: '10px',
            color: 'var(--text-muted)',
          }}>
            <CornerDownRight size={10} />
            Replying to comment
            <button
              onClick={() => setReplyTo(null)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                marginLeft: 'auto',
                display: 'flex',
                padding: 0,
              }}
            >
              <X size={10} />
            </button>
          </div>
        )}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '6px',
          background: 'var(--canvas-raised)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: '6px 8px',
        }}>
          <Avatar email={currentUserEmail} size={18} />
          <textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            onKeyDown={handleKey}
            placeholder={replyTo ? 'Reply...' : 'Add a comment...'}
            rows={2}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: '12px',
              resize: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.4,
              minHeight: '32px',
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!newContent.trim()}
            title="Send (Cmd+Enter)"
            style={{
              background: newContent.trim() ? 'var(--accent)' : 'var(--canvas-overlay)',
              border: 'none',
              borderRadius: '50%',
              width: '22px',
              height: '22px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: newContent.trim() ? '#fff' : 'var(--text-muted)',
              cursor: newContent.trim() ? 'pointer' : 'not-allowed',
              flexShrink: 0,
            }}
          >
            <Send size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}

function CommentThread({
  comment,
  replies,
  isReplyTarget,
  onStartReply,
  onCancelReply,
  onResolve,
  onDelete,
}: {
  comment: DocumentComment;
  replies: DocumentComment[];
  isReplyTarget: boolean;
  onStartReply: () => void;
  onCancelReply: () => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{
      marginBottom: '10px',
      padding: '8px 10px',
      background: isReplyTarget ? 'var(--accent-subtle)' : 'var(--canvas-raised)',
      border: `1px solid ${isReplyTarget ? 'var(--accent-border)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-md)',
      opacity: comment.resolved ? 0.6 : 1,
    }}>
      <CommentBody comment={comment} onResolve={onResolve} onDelete={onDelete} />

      {comment.anchor_text && (
        <div style={{
          marginTop: '4px',
          padding: '4px 6px',
          background: 'var(--canvas-overlay)',
          borderLeft: '2px solid var(--accent)',
          fontSize: '10px',
          fontStyle: 'italic',
          color: 'var(--text-muted)',
          borderRadius: '2px',
        }}>
          “{comment.anchor_text.slice(0, 120)}{comment.anchor_text.length > 120 ? '…' : ''}”
        </div>
      )}

      {replies.length > 0 && (
        <div style={{
          marginTop: '6px',
          paddingLeft: '12px',
          borderLeft: '1px solid var(--border-subtle)',
        }}>
          {replies.map(r => (
            <div key={r.id} style={{ marginTop: '6px' }}>
              <CommentBody comment={r} onResolve={onResolve} onDelete={onDelete} compact />
            </div>
          ))}
        </div>
      )}

      {!comment.resolved && (
        <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
          <button
            onClick={isReplyTarget ? onCancelReply : onStartReply}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              fontSize: '10px',
              padding: '2px 4px',
            }}
          >
            {isReplyTarget ? 'Cancel' : 'Reply'}
          </button>
        </div>
      )}
    </div>
  );
}

function CommentBody({
  comment,
  onResolve,
  onDelete,
  compact,
}: {
  comment: DocumentComment;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: '6px' }}>
      <Avatar email={''} seed={comment.user_id || comment.id} size={compact ? 16 : 20} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
          <span style={{ fontSize: compact ? '10px' : '11px', fontWeight: 600, color: 'var(--text-primary)' }}>
            Teammate
          </span>
          <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
            {formatTime(comment.created_at)}
          </span>
          <div style={{ flex: 1 }} />
          {!compact && (
            <button
              onClick={() => onResolve(comment.id, !comment.resolved)}
              title={comment.resolved ? 'Reopen' : 'Resolve'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: comment.resolved ? 'var(--accent)' : 'var(--text-muted)',
                display: 'flex',
                padding: '2px',
              }}
            >
              <Check size={11} />
            </button>
          )}
          <button
            onClick={() => onDelete(comment.id)}
            title="Delete"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              display: 'flex',
              padding: '2px',
            }}
          >
            <Trash2 size={10} />
          </button>
        </div>
        <p style={{
          fontSize: compact ? '11px' : '12px',
          color: 'var(--text-primary)',
          margin: 0,
          lineHeight: 1.4,
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
        }}>
          {comment.content}
        </p>
      </div>
    </div>
  );
}

function Avatar({ email, seed, size }: { email: string; seed?: string; size: number }) {
  const source = email || seed || 'user';
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  const color = colors[Math.abs(hash) % colors.length];
  return (
    <div style={{
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      background: color,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: `${Math.floor(size * 0.5)}px`,
      fontWeight: 700,
      flexShrink: 0,
    }}>
      {userInitial(email || source)}
    </div>
  );
}
