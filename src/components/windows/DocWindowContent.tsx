import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Bold, Italic, List, ListOrdered, Code, Heading1, Heading2, Quote, Star, Trash2, Image as ImageIcon, Pencil, MessageCircle, History } from 'lucide-react';
import type { Document, DocumentVersion } from '../../types';
import { DocumentCommentsPanel } from '../editor/DocumentCommentsPanel';
import { DocumentVersionHistoryPanel } from '../editor/DocumentVersionHistoryPanel';
import { useDocumentVersions } from '../../hooks/useDocumentVersions';

interface DocWindowContentProps {
  document: Document;
  workspaceId?: string;
  userId?: string;
  currentUserEmail?: string;
  onSave: (id: string, updates: { title?: string; content?: string }) => void;
  onAutoSave: (id: string, updates: { title?: string; content?: string }) => void;
  onToggleFavorite: (id: string, current: boolean) => void;
  onDelete: (id: string) => void;
  onTitleChange: (title: string) => void;
  onCommentCreated?: (docTitle?: string) => void;
}

type FormatAction = 'bold' | 'italic' | 'h1' | 'h2' | 'ul' | 'ol' | 'code' | 'quote';

function execFormat(action: FormatAction) {
  switch (action) {
    case 'bold': document.execCommand('bold'); break;
    case 'italic': document.execCommand('italic'); break;
    case 'code': document.execCommand('insertHTML', false, '<code>code</code>'); break;
    case 'h1': document.execCommand('formatBlock', false, 'h1'); break;
    case 'h2': document.execCommand('formatBlock', false, 'h2'); break;
    case 'ul': document.execCommand('insertUnorderedList'); break;
    case 'ol': document.execCommand('insertOrderedList'); break;
    case 'quote': document.execCommand('formatBlock', false, 'blockquote'); break;
  }
}

function insertImage(url: string) {
  const html = `<div class="doc-image-wrap" contenteditable="false"><img src="${url}" class="doc-image" draggable="false" /><div class="doc-image-resize-handle"></div></div><p><br></p>`;
  document.execCommand('insertHTML', false, html);
}

function insertSketchCanvas() {
  const html = `<div class="doc-sketch-wrap" contenteditable="false"><canvas class="doc-sketch-canvas" data-sketch=""></canvas><div class="doc-sketch-toolbar"><button type="button" class="doc-sketch-clear">Clear</button></div><div class="doc-image-resize-handle"></div></div><p><br></p>`;
  document.execCommand('insertHTML', false, html);
}

function restoreSketchCanvas(canvas: HTMLCanvasElement, dataUrl?: string) {
  const sketch = dataUrl ?? canvas.dataset.sketch ?? '';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!sketch) return;

  const img = new Image();
  img.onload = () => {
    const c = canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = sketch;
}

function sizeSketchCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.round(rect.width * dpr));
  const nextHeight = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === nextWidth && canvas.height === nextHeight) return;

  const sketch = canvas.dataset.sketch ?? '';
  canvas.width = nextWidth;
  canvas.height = nextHeight;
  restoreSketchCanvas(canvas, sketch);
}

function hydrateSketchCanvases(root: HTMLElement | null) {
  if (!root) return;
  root.querySelectorAll('.doc-sketch-canvas').forEach(node => {
    requestAnimationFrame(() => sizeSketchCanvas(node as HTMLCanvasElement));
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

const TOOLBAR: Array<{ action?: FormatAction; icon?: React.ReactNode; label?: string; divider?: boolean; custom?: string }> = [
  { action: 'h1', icon: <Heading1 size={13} />, label: 'H1' },
  { action: 'h2', icon: <Heading2 size={13} />, label: 'H2' },
  { divider: true },
  { action: 'bold', icon: <Bold size={13} />, label: 'Bold' },
  { action: 'italic', icon: <Italic size={13} />, label: 'Italic' },
  { action: 'code', icon: <Code size={13} />, label: 'Code' },
  { action: 'quote', icon: <Quote size={13} />, label: 'Quote' },
  { divider: true },
  { action: 'ul', icon: <List size={13} />, label: 'Bullets' },
  { action: 'ol', icon: <ListOrdered size={13} />, label: 'Numbers' },
  { divider: true },
  { custom: 'sketch', icon: <Pencil size={13} />, label: 'Sketch' },
  { custom: 'image', icon: <ImageIcon size={13} />, label: 'Insert Image' },
];

export function DocWindowContent({
  document: doc,
  workspaceId,
  userId,
  currentUserEmail,
  onAutoSave,
  onToggleFavorite,
  onDelete,
  onTitleChange,
  onCommentCreated,
}: DocWindowContentProps) {
  const [title, setTitle] = useState(doc.title);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const lastSnapshotContentRef = useRef<string>(doc.content || '');
  const lastSnapshotTimeRef = useRef<number>(Date.now());

  const { createSnapshot } = useDocumentVersions(
    doc.id,
    workspaceId ?? null,
    userId,
  );
  const sketchDrawRef = useRef<{
    canvas: HTMLCanvasElement;
    move: (ev: MouseEvent) => void;
    up: () => void;
  } | null>(null);

  const triggerAutoSave = useCallback((newTitle?: string, newContent?: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const savedTitle = newTitle ?? title;
      const savedContent = newContent ?? contentRef.current?.innerHTML ?? '';
      onAutoSave(doc.id, {
        title: savedTitle,
        content: savedContent,
      });

      // Auto-snapshot: if content changed by >= 100 chars and >= 60s since last snapshot
      const charDiff = Math.abs(savedContent.length - lastSnapshotContentRef.current.length);
      const timeSinceLastSnapshot = Date.now() - lastSnapshotTimeRef.current;
      if (charDiff >= 100 && timeSinceLastSnapshot >= 60000) {
        lastSnapshotContentRef.current = savedContent;
        lastSnapshotTimeRef.current = Date.now();
        createSnapshot(savedTitle, savedContent);
      }
    }, 800);
  }, [doc.id, title, onAutoSave, createSnapshot]);

  useEffect(() => {
    setTitle(doc.title);
    if (contentRef.current) {
      contentRef.current.innerHTML = doc.content || '';
      hydrateSketchCanvases(contentRef.current);
    }
    lastSnapshotContentRef.current = doc.content || '';
    lastSnapshotTimeRef.current = Date.now();
  }, [doc.id]);

  const handleRestoreVersion = useCallback((version: DocumentVersion) => {
    if (contentRef.current) {
      contentRef.current.innerHTML = version.content;
      hydrateSketchCanvases(contentRef.current);
    }
    setTitle(version.title);
    onTitleChange(version.title);
    triggerAutoSave(version.title, version.content);
  }, [onTitleChange, triggerAutoSave]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const handleResize = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('doc-image-resize-handle')) return;

      e.preventDefault();
      const imageWrap = target.closest('.doc-image-wrap') as HTMLElement | null;
      const sketchWrap = target.closest('.doc-sketch-wrap') as HTMLElement | null;
      const img = imageWrap?.querySelector('.doc-image') as HTMLElement | null;
      const sketchCanvas = sketchWrap?.querySelector('.doc-sketch-canvas') as HTMLCanvasElement | null;
      const resizable = img || sketchCanvas;
      if (!resizable) return;

      const startY = e.clientY;
      const startH = resizable.getBoundingClientRect().height;

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY;
        const newH = Math.max(60, startH + delta);
        (resizable as HTMLElement).style.height = `${newH}px`;
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (sketchCanvas) {
          sizeSketchCanvas(sketchCanvas);
          sketchCanvas.dataset.sketch = sketchCanvas.toDataURL('image/png');
        }
        triggerAutoSave(undefined, el.innerHTML);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    const handleSketchDrawStart = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const canvas = target.closest('.doc-sketch-canvas') as HTMLCanvasElement | null;
      if (!canvas) return;

      e.preventDefault();
      e.stopPropagation();
      sizeSketchCanvas(canvas);

      const rect = canvas.getBoundingClientRect();
      const toPoint = (clientX: number, clientY: number) => ({
        x: ((clientX - rect.left) / rect.width) * canvas.width,
        y: ((clientY - rect.top) / rect.height) * canvas.height,
      });

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const start = toPoint(e.clientX, e.clientY);
      const strokeWidth = Math.max(2, (canvas.width / rect.width) * 2);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);

      const move = (ev: MouseEvent) => {
        const point = toPoint(ev.clientX, ev.clientY);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      };

      const up = () => {
        ctx.closePath();
        canvas.dataset.sketch = canvas.toDataURL('image/png');
        triggerAutoSave(undefined, el.innerHTML);
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        sketchDrawRef.current = null;
      };

      sketchDrawRef.current = { canvas, move, up };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };

    const handleSketchClear = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const clearButton = target.closest('.doc-sketch-clear') as HTMLButtonElement | null;
      if (!clearButton) return;
      e.preventDefault();
      e.stopPropagation();
      const wrap = clearButton.closest('.doc-sketch-wrap');
      const canvas = wrap?.querySelector('.doc-sketch-canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.dataset.sketch = '';
      triggerAutoSave(undefined, el.innerHTML);
    };

    el.addEventListener('mousedown', handleResize);
    el.addEventListener('mousedown', handleSketchDrawStart);
    el.addEventListener('click', handleSketchClear);
    return () => {
      el.removeEventListener('mousedown', handleResize);
      el.removeEventListener('mousedown', handleSketchDrawStart);
      el.removeEventListener('click', handleSketchClear);
      if (sketchDrawRef.current) {
        document.removeEventListener('mousemove', sketchDrawRef.current.move);
        document.removeEventListener('mouseup', sketchDrawRef.current.up);
        sketchDrawRef.current = null;
      }
    };
  }, [triggerAutoSave]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
    onTitleChange(e.target.value);
    triggerAutoSave(e.target.value, undefined);
  };

  const handleContentInput = () => {
    triggerAutoSave(undefined, contentRef.current?.innerHTML || '');
  };

  const handleImageInsert = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await fileToDataUrl(file);
      contentRef.current?.focus();
      insertImage(dataUrl);
    }
    handleContentInput();
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      await handleImageInsert(imageFiles);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      e.preventDefault();
      await handleImageInsert(imageFiles);
    }
  };

  const handleImageButtonClick = () => {
    imageInputRef.current?.click();
  };

  const handleSketchInsert = () => {
    contentRef.current?.focus();
    insertSketchCanvas();
    hydrateSketchCanvases(contentRef.current);
    handleContentInput();
  };

  const handleImageFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await handleImageInsert(e.target.files);
      e.target.value = '';
    }
  };

  const canShowComments = Boolean(workspaceId && currentUserEmail);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '2px',
        padding: '4px 8px', borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--canvas-elevated)', overflowX: 'auto', flexShrink: 0,
      }}>
        {TOOLBAR.map((item, idx) => (
          item.divider ? (
            <div key={idx} style={{ width: '1px', height: '16px', background: 'var(--border-strong)', margin: '0 3px', flexShrink: 0 }} />
          ) : item.custom === 'image' || item.custom === 'sketch' ? (
            <button
              key={item.custom}
              title={item.label}
              onClick={item.custom === 'image' ? handleImageButtonClick : handleSketchInsert}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '26px', height: '26px',
                background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer', color: 'var(--text-secondary)', transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--canvas-raised)'; e.currentTarget.style.color = 'var(--accent)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              {item.icon}
            </button>
          ) : (
            <button
              key={item.action}
              title={item.label}
              onMouseDown={e => { e.preventDefault(); execFormat(item.action!); handleContentInput(); }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '26px', height: '26px',
                background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer', color: 'var(--text-secondary)', transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--canvas-raised)'; e.currentTarget.style.color = 'var(--accent)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              {item.icon}
            </button>
          )
        ))}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleImageFileInput}
          style={{ display: 'none' }}
        />
        <div style={{ flex: 1 }} />
        {canShowComments && (
          <button
            onClick={() => {
              if (!commentsOpen) {
                const sel = window.getSelection();
                const selectedText = sel?.toString()?.trim() || '';
                setPendingAnchor(selectedText);
              }
              setCommentsOpen(v => !v);
              if (!commentsOpen) setHistoryOpen(false);
            }}
            title={commentsOpen ? 'Hide comments' : 'Comment (select text first to anchor)'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '26px', height: '26px',
              background: commentsOpen ? 'var(--accent-subtle)' : 'transparent',
              border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              color: commentsOpen ? 'var(--accent)' : 'var(--text-muted)',
            }}
            onMouseEnter={e => { if (!commentsOpen) e.currentTarget.style.color = 'var(--accent)'; }}
            onMouseLeave={e => { if (!commentsOpen) e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <MessageCircle size={12} />
          </button>
        )}
        {workspaceId && (
          <button
            onClick={() => {
              setHistoryOpen(v => !v);
              if (!historyOpen) setCommentsOpen(false);
            }}
            title={historyOpen ? 'Hide version history' : 'Version history'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '26px', height: '26px',
              background: historyOpen ? 'var(--accent-subtle)' : 'transparent',
              border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              color: historyOpen ? 'var(--accent)' : 'var(--text-muted)',
            }}
            onMouseEnter={e => { if (!historyOpen) e.currentTarget.style.color = 'var(--accent)'; }}
            onMouseLeave={e => { if (!historyOpen) e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <History size={12} />
          </button>
        )}
        <button
          onClick={() => onToggleFavorite(doc.id, doc.is_favorite)}
          title={doc.is_favorite ? 'Unfavorite' : 'Favorite'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', background: 'transparent',
            border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            color: doc.is_favorite ? 'var(--warning)' : 'var(--text-muted)',
          }}
        >
          <Star size={12} fill={doc.is_favorite ? 'var(--warning)' : 'none'} />
        </button>
        <button
          onClick={() => onDelete(doc.id)}
          title="Delete"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', background: 'transparent',
            border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            color: 'var(--text-muted)',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--error)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', minWidth: 0 }}>
          <input
            type="text"
            value={title}
            onChange={handleTitleChange}
            placeholder="Untitled"
            style={{
              background: 'none', border: 'none', outline: 'none',
              fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)',
              width: '100%', marginBottom: '12px', letterSpacing: '-0.02em',
              lineHeight: 1.2, fontFamily: 'inherit',
            }}
          />
          <div
            ref={contentRef}
            contentEditable
            suppressContentEditableWarning
            className="doc-editor"
            onInput={handleContentInput}
            onPaste={handlePaste}
            onDrop={handleDrop}
            data-placeholder="Start writing..."
            style={{
              minHeight: '200px', outline: 'none', fontSize: '13px',
              lineHeight: '1.7', color: 'var(--text-primary)',
            }}
          />
        </div>
        {commentsOpen && canShowComments && workspaceId && currentUserEmail && (
          <DocumentCommentsPanel
            documentId={doc.id}
            workspaceId={workspaceId}
            userId={userId}
            currentUserEmail={currentUserEmail}
            documentTitle={doc.title}
            pendingAnchor={pendingAnchor}
            onAnchorConsumed={() => setPendingAnchor('')}
            onClose={() => setCommentsOpen(false)}
            onCommentCreated={onCommentCreated}
          />
        )}
        {historyOpen && workspaceId && (
          <DocumentVersionHistoryPanel
            documentId={doc.id}
            workspaceId={workspaceId}
            userId={userId}
            onRestore={handleRestoreVersion}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
