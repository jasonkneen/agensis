import React, { useState, useRef } from 'react';
import { Send, Plus, Mic, FileText, X } from 'lucide-react';
import { ModelSelector } from '../chat/ModelSelector';
import { getSetting } from '../../lib/settings';
import type { Document, MemoryFact } from '../../types';
import bg1 from '../../../images/download-21.jpg';
import bg2 from '../../../images/download-22.jpg';
import bg3 from '../../../images/download-24.jpg';
import bg4 from '../../../images/download-25.jpg';
import bg5 from '../../../images/download-26.jpg';

interface HomeCanvasProps {
  documents: Document[];
  memoryFacts: MemoryFact[];
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void;
  onOpenNewDocument: () => void;
  onOpenNewChat: () => void;
  workspaceName: string;
}

const BACKGROUND_IMAGES = [bg1, bg2, bg3, bg4, bg5];

export function HomeCanvas({
  documents,
  memoryFacts,
  onSendMessage,
}: HomeCanvasProps) {
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState(() => getSetting('ai_default_model'));
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [docPickerQuery, setDocPickerQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const filteredDocs = documents.filter(d =>
    d.title.toLowerCase().includes(docPickerQuery.toLowerCase())
  );
  const [backgroundImage] = useState(() => BACKGROUND_IMAGES[Math.floor(Math.random() * BACKGROUND_IMAGES.length)]);

  const handleSend = () => {
    if (!input.trim()) return;
    onSendMessage(input.trim(), selectedModel, memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
    setInput('');
    setLinkedDocs([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showDocPicker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowDocPicker(false);
        return;
      }
      if (e.key === 'Enter' && filteredDocs.length > 0) {
        e.preventDefault();
        handleDocSelect(filteredDocs[0]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    if (showDocPicker && atStartPos >= 0) {
      const afterAt = val.slice(atStartPos + 1);
      const spaceIdx = afterAt.indexOf(' ');
      if (spaceIdx === -1) {
        setDocPickerQuery(afterAt);
      } else {
        setShowDocPicker(false);
        setDocPickerQuery('');
        setAtStartPos(-1);
      }
    }

    const cursor = e.target.selectionStart || 0;
    if (val[cursor - 1] === '@' && !showDocPicker) {
      setShowDocPicker(true);
      setDocPickerQuery('');
      setAtStartPos(cursor - 1);
    }
  };

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      padding: '0 24px',
      pointerEvents: 'none',
    }}>
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: `url(${backgroundImage})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center center',
        backgroundRepeat: 'no-repeat',
        opacity: 'var(--home-bg-image-opacity)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--home-bg-overlay)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '24px',
        maxWidth: '640px',
        width: '100%',
        pointerEvents: 'auto',
      }}>
        <h1 style={{
          fontSize: '28px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          textAlign: 'center',
          margin: 0,
          letterSpacing: '-0.02em',
          lineHeight: 1.2,
        }}>
          What's on your mind?
        </h1>

        <div style={{ width: '100%', position: 'relative' }}>
          {showDocPicker && filteredDocs.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              marginBottom: '4px',
              background: 'var(--canvas-overlay)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-lg)',
              maxHeight: '200px',
              overflowY: 'auto',
              zIndex: 50,
            }}>
              <div style={{
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                borderBottom: '1px solid var(--border-subtle)',
              }}>
                Link a document
              </div>
              {filteredDocs.map(doc => (
                <button
                  key={doc.id}
                  onClick={() => handleDocSelect(doc)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                    fontSize: '13px',
                    textAlign: 'left',
                    transition: 'background var(--transition-fast)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <FileText size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                  <span>{doc.title}</span>
                </button>
              ))}
            </div>
          )}

          {linkedDocs.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
              {linkedDocs.map(doc => (
                <span
                  key={doc.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '3px 8px',
                    background: 'var(--accent-subtle)',
                    border: '1px solid var(--accent-border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '11px',
                    color: 'var(--accent)',
                    fontWeight: 500,
                  }}
                >
                  <FileText size={10} />
                  {doc.title}
                  <button
                    onClick={() => setLinkedDocs(prev => prev.filter(d => d.id !== doc.id))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', padding: 0, display: 'flex' }}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div style={{
            background: 'var(--canvas-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            boxShadow: 'var(--shadow-md)',
            transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Chat with AI..."
              rows={2}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--text-primary)',
                fontSize: '14px',
                padding: '14px 16px 8px',
                resize: 'none',
                fontFamily: 'inherit',
                lineHeight: '1.5',
                maxHeight: '160px',
                overflowY: 'auto',
              }}
              onInput={e => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
              }}
              onFocus={e => {
                const parent = e.currentTarget.parentElement;
                if (parent) {
                  parent.style.borderColor = 'var(--accent-border)';
                  parent.style.boxShadow = '0 0 0 3px var(--accent-subtle), var(--shadow-md)';
                }
              }}
              onBlur={e => {
                const parent = e.currentTarget.parentElement;
                if (parent) {
                  parent.style.borderColor = 'var(--border)';
                  parent.style.boxShadow = 'var(--shadow-md)';
                }
              }}
            />
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px 8px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <button
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '28px',
                    height: '28px',
                    background: 'none',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    transition: 'color var(--transition-fast)',
                  }}
                  title="Attach"
                >
                  <Plus size={16} />
                </button>
                <button
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '28px',
                    height: '28px',
                    background: 'none',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    transition: 'color var(--transition-fast)',
                  }}
                  title="Voice"
                >
                  <Mic size={15} />
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ModelSelector value={selectedModel} onChange={setSelectedModel} />
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '30px',
                    height: '30px',
                    borderRadius: '50%',
                    background: input.trim() ? 'var(--accent)' : 'var(--canvas-raised)',
                    border: 'none',
                    cursor: input.trim() ? 'pointer' : 'not-allowed',
                    color: input.trim() ? 'white' : 'var(--text-muted)',
                    transition: 'all var(--transition-fast)',
                    flexShrink: 0,
                  }}
                >
                  <Send size={13} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}>
          {[
            'Summarize my documents',
            'Help me brainstorm',
            'Write a draft',
            'Explain a concept',
          ].map(suggestion => (
            <button
              key={suggestion}
              onClick={() => {
                setInput(suggestion);
                inputRef.current?.focus();
              }}
              style={{
                padding: '6px 14px',
                background: 'var(--canvas-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-xl)',
                color: 'var(--text-secondary)',
                fontSize: '12px',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--accent-border)';
                e.currentTarget.style.color = 'var(--accent)';
                e.currentTarget.style.background = 'var(--accent-subtle)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--border)';
                e.currentTarget.style.color = 'var(--text-secondary)';
                e.currentTarget.style.background = 'var(--canvas-elevated)';
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
