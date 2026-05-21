import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Send, Plus, Mic, Sparkles, FileText, X, Layers, CornerDownRight
} from 'lucide-react';
import { ModelSelector } from '../chat/ModelSelector';
import { ChatThreadPanel } from '../chat/ChatThreadPanel';
import type { Message, MemoryFact, Document, CanvasGroup, CanvasObject, WorkspaceAgent } from '../../types';

interface ChatWindowContentProps {
  messages: Message[];
  topLevelMessages?: Message[];
  threadMessages?: Message[];
  threadReplyCounts?: Record<string, number>;
  activeThreadId?: string | null;
  streaming: boolean;
  memoryFacts: MemoryFact[];
  documents: Document[];
  agents?: WorkspaceAgent[];
  selectedAgent?: WorkspaceAgent | null;
  onSelectAgent?: (agent: WorkspaceAgent | null) => void;
  canvasGroups?: CanvasGroup[];
  canvasObjects?: CanvasObject[];
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void;
  onOpenThread?: (messageId: string) => void;
  onCloseThread?: () => void;
  onSendThreadReply?: (content: string, model: string) => void;
}

export function ChatWindowContent({
  messages,
  topLevelMessages,
  threadMessages = [],
  threadReplyCounts = {},
  activeThreadId,
  streaming,
  memoryFacts,
  documents,
  agents = [],
  selectedAgent,
  onSelectAgent,
  canvasGroups = [],
  canvasObjects = [],
  onSendMessage,
  onOpenThread,
  onCloseThread,
  onSendThreadReply,
}: ChatWindowContentProps) {
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('auto');
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [linkedGroups, setLinkedGroups] = useState<CanvasGroup[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [docPickerQuery, setDocPickerQuery] = useState('');
  const [groupPickerQuery, setGroupPickerQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const [hashStartPos, setHashStartPos] = useState(-1);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const filteredDocs = useMemo(() => {
    const q = docPickerQuery.toLowerCase();
    return documents.filter(d => d.title.toLowerCase().includes(q));
  }, [documents, docPickerQuery]);

  const filteredGroups = useMemo(() => {
    const q = groupPickerQuery.toLowerCase();
    return canvasGroups.filter(g => g.name.toLowerCase().includes(q));
  }, [canvasGroups, groupPickerQuery]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const buildGroupContext = (groups: CanvasGroup[]): string => {
    return groups.map(g => {
      const groupObjs = canvasObjects.filter(o => o.group_id === g.id);
      const desc = groupObjs.map(o => {
        if (o.type === 'text') return `Text: "${o.text_content}"`;
        if (o.type === 'image') return `Image: ${o.file_name || o.src || 'unnamed'}`;
        return `${o.type} shape`;
      }).join(', ');
      return `[Canvas Group "${g.name}": ${desc || 'empty'}]`;
    }).join('\n');
  };

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    let content = input.trim();
    if (linkedGroups.length > 0) {
      content = buildGroupContext(linkedGroups) + '\n\n' + content;
    }
    onSendMessage(content, selectedModel, memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
    setInput('');
    setLinkedDocs([]);
    setLinkedGroups([]);
    inputRef.current?.focus();
  };

  const handleDocSelect = (doc: Document) => {
    if (!linkedDocs.find(d => d.id === doc.id)) {
      setLinkedDocs(prev => [...prev, doc]);
    }
    const before = input.slice(0, atStartPos);
    const after = input.slice(inputRef.current?.selectionStart || input.length);
    setInput(before + after);
    setShowDocPicker(false);
    setDocPickerQuery('');
    setAtStartPos(-1);
    inputRef.current?.focus();
  };

  const handleGroupSelect = (group: CanvasGroup) => {
    if (!linkedGroups.find(g => g.id === group.id)) {
      setLinkedGroups(prev => [...prev, group]);
    }
    const before = input.slice(0, hashStartPos);
    const after = input.slice(inputRef.current?.selectionStart || input.length);
    setInput(before + after);
    setShowGroupPicker(false);
    setGroupPickerQuery('');
    setHashStartPos(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showDocPicker) {
      if (e.key === 'Escape') { e.preventDefault(); setShowDocPicker(false); return; }
      if (e.key === 'Enter' && filteredDocs.length > 0) { e.preventDefault(); handleDocSelect(filteredDocs[0]); return; }
    }
    if (showGroupPicker) {
      if (e.key === 'Escape') { e.preventDefault(); setShowGroupPicker(false); return; }
      if (e.key === 'Enter' && filteredGroups.length > 0) { e.preventDefault(); handleGroupSelect(filteredGroups[0]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    if (showDocPicker && atStartPos >= 0) {
      const afterAt = val.slice(atStartPos + 1);
      if (afterAt.indexOf(' ') === -1) { setDocPickerQuery(afterAt); }
      else { setShowDocPicker(false); setDocPickerQuery(''); setAtStartPos(-1); }
    }
    if (showGroupPicker && hashStartPos >= 0) {
      const afterHash = val.slice(hashStartPos + 1);
      if (afterHash.indexOf(' ') === -1) { setGroupPickerQuery(afterHash); }
      else { setShowGroupPicker(false); setGroupPickerQuery(''); setHashStartPos(-1); }
    }
    const cursor = e.target.selectionStart || 0;
    if (val[cursor - 1] === '@' && !showDocPicker) {
      setShowDocPicker(true);
      setDocPickerQuery('');
      setAtStartPos(cursor - 1);
    }
    if (val[cursor - 1] === '#' && !showGroupPicker) {
      setShowGroupPicker(true);
      setGroupPickerQuery('');
      setHashStartPos(cursor - 1);
    }
  };

  const displayMessages = topLevelMessages ?? messages;
  const parentMessage = activeThreadId ? messages.find(m => m.id === activeThreadId) : null;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
        {displayMessages.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: '8px',
          }}>
            <div style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background: 'var(--canvas-raised)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Sparkles size={18} style={{ color: 'var(--text-muted)' }} />
            </div>
            <p style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', margin: 0 }}>Ready to chat</p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>Type a message below to begin</p>
          </div>
        ) : (
          <>
            {displayMessages.map((msg, idx) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                isStreaming={streaming && idx === displayMessages.length - 1 && msg.role === 'assistant'}
                replyCount={threadReplyCounts[msg.id]}
                onOpenThread={onOpenThread ? () => onOpenThread(msg.id) : undefined}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <div style={{ padding: '8px 10px 10px', borderTop: '1px solid var(--border-subtle)' }}>
        {(linkedDocs.length > 0 || linkedGroups.length > 0) && (
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
            {linkedDocs.map(doc => (
              <span key={doc.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                padding: '2px 6px', background: 'var(--accent-subtle)',
                border: '1px solid var(--accent-border)', borderRadius: 'var(--radius-sm)',
                fontSize: '10px', color: 'var(--accent)', fontWeight: 500,
              }}>
                <FileText size={9} />{doc.title}
                <button onClick={() => setLinkedDocs(prev => prev.filter(d => d.id !== doc.id))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', padding: 0, display: 'flex' }}>
                  <X size={9} />
                </button>
              </span>
            ))}
            {linkedGroups.map(group => (
              <span key={group.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                padding: '2px 6px', background: `${group.color}15`,
                border: `1px solid ${group.color}40`, borderRadius: 'var(--radius-sm)',
                fontSize: '10px', color: group.color, fontWeight: 500,
              }}>
                <Layers size={9} />{group.name}
                <button onClick={() => setLinkedGroups(prev => prev.filter(g => g.id !== group.id))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: group.color, padding: 0, display: 'flex' }}>
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div style={{ position: 'relative' }}>
          {showDocPicker && filteredDocs.length > 0 && (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0,
              marginBottom: '4px', background: 'var(--canvas-overlay)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-lg)', maxHeight: '160px', overflowY: 'auto', zIndex: 50,
            }}>
              {filteredDocs.map(doc => (
                <button key={doc.id} onClick={() => handleDocSelect(doc)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '6px 10px', background: 'transparent', border: 'none',
                    cursor: 'pointer', color: 'var(--text-primary)', fontSize: '12px', textAlign: 'left',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <FileText size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  {doc.title}
                </button>
              ))}
            </div>
          )}

          {showGroupPicker && filteredGroups.length > 0 && (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0,
              marginBottom: '4px', background: 'var(--canvas-overlay)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-lg)', maxHeight: '160px', overflowY: 'auto', zIndex: 50,
            }}>
              {filteredGroups.map(group => {
                const objCount = canvasObjects.filter(o => o.group_id === group.id).length;
                return (
                  <button key={group.id} onClick={() => handleGroupSelect(group)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '6px 10px', background: 'transparent', border: 'none',
                      cursor: 'pointer', color: 'var(--text-primary)', fontSize: '12px', textAlign: 'left',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${group.color}10`)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Layers size={12} style={{ color: group.color, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{group.name}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{objCount} object{objCount !== 1 ? 's' : ''}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{
            background: 'var(--canvas-raised)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Chat with AI... @ docs, # groups"
              disabled={streaming}
              rows={1}
              style={{
                width: '100%', background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text-primary)', fontSize: '12px', padding: '8px 10px 4px',
                resize: 'none', fontFamily: 'inherit', lineHeight: '1.5',
                maxHeight: '80px', overflowY: 'auto',
              }}
              onInput={e => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <button style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px', background: 'none', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }} title="Attach">
                  <Plus size={13} />
                </button>
                <button style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px', background: 'none', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }} title="Voice">
                  <Mic size={13} />
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {agents.length > 0 && onSelectAgent && (
                  <select
                    value={selectedAgent?.id || ''}
                    onChange={e => {
                      const agent = agents.find(a => a.id === e.target.value) || null;
                      onSelectAgent(agent);
                    }}
                    title="Select AI agent"
                    style={{
                      background: 'var(--canvas-raised)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      color: selectedAgent ? 'var(--accent)' : 'var(--text-muted)',
                      fontSize: '10px',
                      padding: '2px 4px',
                      cursor: 'pointer',
                      maxWidth: '80px',
                    }}
                  >
                    <option value="">Hatch AI</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.avatar} {a.name}</option>
                    ))}
                  </select>
                )}
                <ModelSelector value={selectedAgent?.model || selectedModel} onChange={setSelectedModel} />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || streaming}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: '26px', height: '26px', borderRadius: '50%',
                    background: input.trim() && !streaming ? 'var(--accent)' : 'var(--canvas-overlay)',
                    border: 'none', cursor: input.trim() && !streaming ? 'pointer' : 'not-allowed',
                    color: input.trim() && !streaming ? 'white' : 'var(--text-muted)',
                    transition: 'all var(--transition-fast)', flexShrink: 0,
                  }}
                >
                  <Send size={11} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
      {activeThreadId && parentMessage && onCloseThread && onSendThreadReply && (
        <ChatThreadPanel
          parentMessage={parentMessage}
          threadMessages={threadMessages}
          streaming={streaming}
          onSendReply={onSendThreadReply}
          onClose={onCloseThread}
        />
      )}
    </div>
  );
}

function MessageBubble({ msg, isStreaming, replyCount, onOpenThread }: { msg: Message; isStreaming?: boolean; replyCount?: number; onOpenThread?: () => void }) {
  const isUser = msg.role === 'user';
  return (
    <div className="msg-animate" style={{
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: '12px', gap: '3px',
    }}>
      {!isUser && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingLeft: '2px' }}>
          <div style={{
            width: '16px', height: '16px', borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--accent), #60a5fa)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Sparkles size={8} color="white" />
          </div>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500 }}>Hatch AI</span>
        </div>
      )}
      <div style={{
        maxWidth: '90%', padding: isUser ? '6px 10px' : '8px 10px',
        borderRadius: isUser ? '12px 12px 4px 12px' : '4px 12px 12px 12px',
        background: isUser ? 'var(--accent)' : 'var(--canvas-raised)',
        border: isUser ? 'none' : '1px solid var(--border)',
        color: isUser ? 'white' : 'var(--text-primary)',
        fontSize: '12px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {msg.content || (isStreaming && (
          <div style={{ display: 'flex', gap: '3px', alignItems: 'center', padding: '2px 0' }}>
            {[0, 1, 2].map(i => (
              <div key={i} className="pulse-dot" style={{
                width: '4px', height: '4px', borderRadius: '50%',
                background: 'var(--accent)', animationDelay: `${i * 0.2}s`,
              }} />
            ))}
          </div>
        ))}
        {isStreaming && msg.content && <span className="typing-cursor" />}
      </div>
      {onOpenThread && msg.content && !isStreaming && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
          <button
            onClick={onOpenThread}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '3px',
              color: 'var(--text-muted)', fontSize: '10px', padding: '2px 4px',
              borderRadius: 'var(--radius-sm)',
              transition: 'color var(--transition-fast)',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            <CornerDownRight size={10} />
            {replyCount ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
          </button>
        </div>
      )}
    </div>
  );
}
