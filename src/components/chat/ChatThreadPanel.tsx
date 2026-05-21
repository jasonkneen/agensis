import { useState, useRef, useEffect } from 'react';
import { Send, X, Sparkles, CornerDownRight } from 'lucide-react';
import { ModelSelector } from './ModelSelector';
import type { Message } from '../../types';

interface ChatThreadPanelProps {
  parentMessage: Message;
  threadMessages: Message[];
  streaming: boolean;
  onSendReply: (content: string, model: string) => void;
  onClose: () => void;
}

export function ChatThreadPanel({
  parentMessage,
  threadMessages,
  streaming,
  onSendReply,
  onClose,
}: ChatThreadPanelProps) {
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('auto');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [threadMessages]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    onSendReply(input.trim(), selectedModel);
    setInput('');
    inputRef.current?.focus();
  };

  const replies = threadMessages.filter(m => m.id !== parentMessage.id);

  return (
    <div style={{
      width: '300px',
      borderLeft: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--canvas-elevated)',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        <CornerDownRight size={13} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
          Thread
        </span>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', display: 'flex', padding: '2px',
          }}
        >
          <X size={13} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {/* Parent message */}
        <div style={{
          padding: '8px 10px',
          background: 'var(--canvas-raised)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          marginBottom: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
            {parentMessage.role === 'assistant' && (
              <div style={{
                width: '14px', height: '14px', borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Sparkles size={7} color="white" />
              </div>
            )}
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500 }}>
              {parentMessage.role === 'assistant' ? 'Hatch AI' : 'You'}
            </span>
          </div>
          <p style={{
            fontSize: '12px', color: 'var(--text-primary)', margin: 0,
            lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {parentMessage.content.slice(0, 200)}{parentMessage.content.length > 200 ? '...' : ''}
          </p>
        </div>

        {replies.length === 0 && (
          <div style={{
            textAlign: 'center', padding: '16px 8px',
            color: 'var(--text-muted)', fontSize: '11px',
          }}>
            No replies yet. Start the conversation.
          </div>
        )}

        {replies.map((msg, idx) => (
          <ThreadBubble
            key={msg.id}
            msg={msg}
            isStreaming={streaming && idx === replies.length - 1 && msg.role === 'assistant'}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div style={{
        padding: '8px 10px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        <div style={{
          background: 'var(--canvas-raised)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Reply in thread..."
            disabled={streaming}
            rows={1}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text-primary)', fontSize: '11px', padding: '6px 8px',
              resize: 'none', fontFamily: 'inherit', lineHeight: '1.5',
              maxHeight: '60px', overflowY: 'auto',
            }}
            onInput={e => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 60)}px`;
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '4px 6px 6px', gap: '4px' }}>
            <ModelSelector value={selectedModel} onChange={setSelectedModel} />
            <button
              onClick={handleSend}
              disabled={!input.trim() || streaming}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '22px', height: '22px', borderRadius: '50%',
                background: input.trim() && !streaming ? 'var(--accent)' : 'var(--canvas-overlay)',
                border: 'none', cursor: input.trim() && !streaming ? 'pointer' : 'not-allowed',
                color: input.trim() && !streaming ? 'white' : 'var(--text-muted)',
                flexShrink: 0,
              }}
            >
              <Send size={10} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThreadBubble({ msg, isStreaming }: { msg: Message; isStreaming?: boolean }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: '8px',
    }}>
      {!isUser && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', paddingLeft: '2px', marginBottom: '2px' }}>
          <div style={{
            width: '14px', height: '14px', borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Sparkles size={7} color="white" />
          </div>
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 500 }}>Hatch AI</span>
        </div>
      )}
      <div style={{
        maxWidth: '92%', padding: '5px 8px',
        borderRadius: isUser ? '10px 10px 4px 10px' : '4px 10px 10px 10px',
        background: isUser ? 'var(--accent)' : 'var(--canvas-raised)',
        border: isUser ? 'none' : '1px solid var(--border)',
        color: isUser ? 'white' : 'var(--text-primary)',
        fontSize: '11px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {msg.content || (isStreaming && (
          <div style={{ display: 'flex', gap: '3px', alignItems: 'center', padding: '2px 0' }}>
            {[0, 1, 2].map(i => (
              <div key={i} className="pulse-dot" style={{
                width: '3px', height: '3px', borderRadius: '50%',
                background: 'var(--accent)', animationDelay: `${i * 0.2}s`,
              }} />
            ))}
          </div>
        ))}
        {isStreaming && msg.content && <span className="typing-cursor" />}
      </div>
    </div>
  );
}
