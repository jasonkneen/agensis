import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Bold, Italic, List, ListOrdered, Code, Heading1, Heading2, Quote, Star, Trash2, Image as ImageIcon, Pencil, MessageCircle, History, Sparkles, ListChecks, PanelsTopLeft } from 'lucide-react';
import type { Document, DocumentVersion, Task } from '../../types';
import { stripHtml } from '../../lib/utils';
import { DocumentCommentsPanel } from '../editor/DocumentCommentsPanel';
import { DocumentVersionHistoryPanel } from '../editor/DocumentVersionHistoryPanel';
import { useDocumentVersions } from '../../hooks/useDocumentVersions';
import { apiAuthHeaders, apiUrl } from '../../lib/backendClient';
import { extractSseDataLines, parseAiStreamPayload } from '../../lib/chatStream';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { sanitizeHtml, sanitizeClipboardHtml } from '@/lib/sanitize';

interface DocWindowContentProps {
  document: Document;
  workspaceId?: string;
  userId?: string;
  currentUserEmail?: string;
  /**
   * Agent id -> name, for comments an AGENT authored. Optional: the panel
   * falls back to "Agent", which is vaguer but still true about who wrote it.
   */
  agentNames?: Record<string, string>;
  onAutoSave: (id: string, updates: { title?: string; content?: string }) => void;
  onToggleFavorite: (id: string, current: boolean) => void;
  onDelete: (id: string) => void;
  onTitleChange: (title: string) => void;
  onCommentCreated?: (docTitle?: string) => void;
  tasks?: Task[];
  onUpdateTask?: (id: string, updates: Partial<Task>) => void;
  // NET-06 made the documents LIST metadata-only — `document.content` is
  // `undefined` for a doc opened from Sidebar/search/picker, not just empty.
  // This fetches (and caches) the one doc's body on demand; see useDocuments.
  fetchDocumentContent: (id: string, force?: boolean) => Promise<string>;
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

function insertAIResponseBlock() {
  const html = `<section class="doc-ai-block" contenteditable="false">
    <div class="doc-block-header"><strong>AI response</strong><span>Ask a question against this document</span></div>
    <textarea class="doc-ai-prompt" placeholder="Ask a question..."></textarea>
    <div class="doc-block-actions"><button type="button" class="doc-ai-run">Ask</button></div>
    <div class="doc-ai-answer" aria-live="polite"></div>
  </section><p><br></p>`;
  document.execCommand('insertHTML', false, html);
}

function insertTaskListBlock(tasks: Task[]) {
  const rows = tasks.slice(0, 30).map(task => {
    const checked = task.status === 'done' ? ' checked' : '';
    return `<label class="doc-task-row"><input type="checkbox" class="doc-task-checkbox" data-task-id="${escapeHtml(task.id)}"${checked} /> <span>${escapeHtml(task.title)}</span><small>${escapeHtml(task.status.replace('_', ' '))}</small></label>`;
  }).join('');
  const html = `<section class="doc-task-block" contenteditable="false">
    <div class="doc-block-header"><strong>Task list</strong><span>${tasks.length} workspace tasks</span></div>
    <div class="doc-task-list">${rows || '<p class="doc-block-muted">No tasks yet.</p>'}</div>
  </section><p><br></p>`;
  document.execCommand('insertHTML', false, html);
}

function insertGenerativeUiBlock() {
  const spec = defaultGenerativeUiSpec();
  const encodedSpec = encodeURIComponent(JSON.stringify(spec));
  const html = `<section class="doc-generative-ui" contenteditable="false" data-spec="${encodedSpec}">
    <div class="doc-block-header"><strong>Generative UI</strong><span>Safe structured interface block</span></div>
    <div class="doc-generative-ui-render"></div>
  </section><p><br></p>`;
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
  root.querySelectorAll('.doc-generative-ui').forEach(node => {
    const block = node as HTMLElement;
    const specNode = block.querySelector('.doc-generative-ui-spec');
    const renderNode = block.querySelector('.doc-generative-ui-render') as HTMLElement | null;
    if (!renderNode) return;
    try {
      const rawSpec = block.dataset.spec
        ? decodeURIComponent(block.dataset.spec)
        : specNode?.textContent || JSON.stringify(defaultGenerativeUiSpec());
      const spec = JSON.parse(rawSpec);
      renderNode.innerHTML = sanitizeHtml(renderGenerativeUiSpec(spec));
    } catch {
      renderNode.innerHTML = sanitizeHtml(renderGenerativeUiSpec(defaultGenerativeUiSpec()));
    }
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function runDocAI(prompt: string, title: string, docHtml: string, workspaceId?: string) {
  const response = await fetch(apiUrl('/backend/ai-chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({
      workspaceId,
      model: 'auto',
      messages: [{ role: 'user', content: prompt }],
      documents: `--- Document: ${title} ---\n${stripHtml(docHtml).slice(0, 12000)}`,
    }),
  });

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || payload?.error || 'AI request failed.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let streamError = '';
  let buffer = '';

  // Decode incrementally ({ stream: true }) and carry a partial-line buffer
  // across reads, so a `data:` frame or multibyte char split across two network
  // chunks isn't dropped/corrupted; also surface the server's mid-stream error
  // frame instead of silently rendering "No response." (M12).
  const consume = (data: string) => {
    if (data === '[DONE]') return;
    try {
      const { text, error } = parseAiStreamPayload(JSON.parse(data));
      if (error) { streamError = error; return; }
      fullContent += text;
    } catch {
      // Ignore malformed stream chunks.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { data, remainder } = extractSseDataLines(buffer);
    buffer = remainder;
    for (const line of data) consume(line);
  }
  for (const line of extractSseDataLines(buffer, true).data) consume(line);

  if (streamError) throw new Error(streamError);
  return fullContent || 'No response.';
}

type GenerativeUiIssueItem = {
  title?: string;
  status?: string;
  priority?: string;
};

type GenerativeUiMetric = {
  value?: string | number;
  label?: string;
};

type GenerativeUiSpec = {
  type?: string;
  title?: string;
  description?: string;
  body?: string;
  items?: GenerativeUiIssueItem[];
  metrics?: GenerativeUiMetric[];
};

function renderGenerativeUiSpec(spec: GenerativeUiSpec) {
  if (spec?.type === 'issue-list') {
    const items = Array.isArray(spec.items) ? spec.items : [];
    return `<div class="doc-gen-panel">
      <div class="doc-gen-heading">
        <strong>${escapeHtml(spec.title || 'Generated interface')}</strong>
        <span>${escapeHtml(spec.description || 'Structured output')}</span>
      </div>
      <div class="doc-gen-list">
        ${items.map((item) => `<div class="doc-gen-item">
          <span>${escapeHtml(item.title || 'Untitled')}</span>
          <small>${escapeHtml(item.status || 'open')} / ${escapeHtml(item.priority || 'normal')}</small>
        </div>`).join('')}
      </div>
    </div>`;
  }

  if (spec?.type === 'metric-grid') {
    const metrics = Array.isArray(spec.metrics) ? spec.metrics : [];
    return `<div class="doc-gen-metrics">
      ${metrics.map((metric) => `<div class="doc-gen-metric">
        <strong>${escapeHtml(String(metric.value || ''))}</strong>
        <span>${escapeHtml(metric.label || '')}</span>
      </div>`).join('')}
    </div>`;
  }

  if (spec?.type === 'callout') {
    return `<div class="doc-gen-callout">
      <strong>${escapeHtml(spec.title || 'Note')}</strong>
      <p>${escapeHtml(spec.body || '')}</p>
    </div>`;
  }

  return '<div class="doc-block-muted">Unsupported generative UI type.</div>';
}

function defaultGenerativeUiSpec() {
  return {
    type: 'issue-list',
    title: 'Generated interface',
    description: 'Structured JSON rendered through the local component catalog',
    items: [
      { title: 'Define the interface schema', status: 'open', priority: 'high' },
      { title: 'Connect to workspace data', status: 'planned', priority: 'normal' },
    ],
  };
}

const TOOLBAR: Array<{ action?: FormatAction; icon?: React.ReactNode; label?: string; divider?: boolean; custom?: string }> = [
  { action: 'h1', icon: <Heading1 />, label: 'H1' },
  { action: 'h2', icon: <Heading2 />, label: 'H2' },
  { divider: true },
  { action: 'bold', icon: <Bold />, label: 'Bold' },
  { action: 'italic', icon: <Italic />, label: 'Italic' },
  { action: 'code', icon: <Code />, label: 'Code' },
  { action: 'quote', icon: <Quote />, label: 'Quote' },
  { divider: true },
  { action: 'ul', icon: <List />, label: 'Bullets' },
  { action: 'ol', icon: <ListOrdered />, label: 'Numbers' },
  { divider: true },
  { custom: 'sketch', icon: <Pencil />, label: 'Sketch' },
  { custom: 'image', icon: <ImageIcon />, label: 'Insert Image' },
  { divider: true },
  { custom: 'ai-response', icon: <Sparkles />, label: 'AI Response' },
  { custom: 'task-list', icon: <ListChecks />, label: 'Task List' },
  { custom: 'generative-ui', icon: <PanelsTopLeft />, label: 'Generative UI' },
];

export const DocWindowContent = React.memo(function DocWindowContent({
  document: doc,
  workspaceId,
  userId,
  currentUserEmail,
  agentNames,
  onAutoSave,
  onToggleFavorite,
  onDelete,
  onTitleChange,
  onCommentCreated,
  tasks = [],
  onUpdateTask,
  fetchDocumentContent,
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
      // Sanitize on write (defence-in-depth): the DB stores clean HTML, so a future
      // reader that forgets to sanitize can't reintroduce stored XSS.
      const savedContent = sanitizeHtml(newContent ?? contentRef.current?.innerHTML ?? '');
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
    let cancelled = false;
    const applyBody = (body: string) => {
      if (cancelled) return;
      if (contentRef.current) {
        contentRef.current.innerHTML = sanitizeHtml(body || '');
        hydrateSketchCanvases(contentRef.current);
      }
      lastSnapshotContentRef.current = body || '';
      lastSnapshotTimeRef.current = Date.now();
    };
    // NET-06: the documents LIST is metadata-only, so `doc.content` is
    // `undefined` for a doc opened by id (Sidebar, search, picker) — fetch the
    // body on demand. A doc that already carries content (e.g. straight from a
    // just-created-doc response) skips the round trip.
    if (doc.content !== undefined) {
      applyBody(doc.content);
    } else {
      fetchDocumentContent(doc.id).then(applyBody);
    }
    return () => { cancelled = true; };
  }, [doc.id, doc.title, doc.content, fetchDocumentContent]);

  // Keep embedded "Task list" blocks in sync with live task status. `tasks` is
  // websocket-backed (see useTasks), so this re-runs whenever a task's status
  // changes anywhere — another user, another doc, or an agent via update_task —
  // patching the already-rendered checkbox/label in place. Deliberately does not
  // call triggerAutoSave: syncing a live prop into the DOM isn't a user edit, and
  // re-saving on every remote status change would spam doc versions/snapshots.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || tasks.length === 0) return;
    const checkboxes = el.querySelectorAll<HTMLInputElement>('.doc-task-checkbox[data-task-id]');
    checkboxes.forEach((checkbox) => {
      const taskId = checkbox.dataset.taskId;
      const task = taskId ? tasks.find(t => t.id === taskId) : undefined;
      if (!task) return;
      const isDone = task.status === 'done';
      if (checkbox.checked !== isDone) {
        checkbox.checked = isDone;
      }
      const label = task.status.replace('_', ' ');
      const small = checkbox.closest('.doc-task-row')?.querySelector('small');
      if (small && small.textContent !== label) {
        small.textContent = label;
      }
    });
  }, [tasks, doc.id]);

  const handleRestoreVersion = useCallback((version: DocumentVersion) => {
    if (contentRef.current) {
      contentRef.current.innerHTML = sanitizeHtml(version.content);
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
      const clearButton = target.closest('.doc-sketch-clear') as HTMLElement | null;
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

    const handleDocBlockClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const runButton = target.closest('.doc-ai-run') as HTMLButtonElement | null;
      if (runButton) {
        e.preventDefault();
        const block = runButton.closest('.doc-ai-block') as HTMLElement | null;
        const prompt = (block?.querySelector('.doc-ai-prompt') as HTMLTextAreaElement | null)?.value.trim() || '';
        const answer = block?.querySelector('.doc-ai-answer') as HTMLElement | null;
        if (!prompt || !answer) return;
        runButton.disabled = true;
        answer.textContent = 'Thinking...';
        try {
          answer.textContent = await runDocAI(prompt, title, el.innerHTML, workspaceId || doc.workspace_id);
        } catch (error) {
          answer.textContent = error instanceof Error ? error.message : 'AI request failed.';
        } finally {
          runButton.disabled = false;
          triggerAutoSave(undefined, el.innerHTML);
        }
        return;
      }

      const checkbox = target.closest('.doc-task-checkbox') as HTMLInputElement | null;
      if (checkbox) {
        const taskId = checkbox.dataset.taskId;
        if (taskId) {
          onUpdateTask?.(taskId, { status: checkbox.checked ? 'done' : 'todo' });
          const row = checkbox.closest('.doc-task-row');
          row?.querySelector('small')?.replaceChildren(checkbox.checked ? 'done' : 'todo');
          triggerAutoSave(undefined, el.innerHTML);
        }
      }
    };

    el.addEventListener('mousedown', handleResize);
    el.addEventListener('mousedown', handleSketchDrawStart);
    el.addEventListener('click', handleSketchClear);
    el.addEventListener('click', handleDocBlockClick);
    return () => {
      el.removeEventListener('mousedown', handleResize);
      el.removeEventListener('mousedown', handleSketchDrawStart);
      el.removeEventListener('click', handleSketchClear);
      el.removeEventListener('click', handleDocBlockClick);
      if (sketchDrawRef.current) {
        document.removeEventListener('mousemove', sketchDrawRef.current.move);
        document.removeEventListener('mouseup', sketchDrawRef.current.up);
        sketchDrawRef.current = null;
      }
    };
  }, [doc.workspace_id, triggerAutoSave, onUpdateTask, title, workspaceId]);

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
      return;
    }

    // Sanitize any pasted rich text/HTML before it lands in the contenteditable.
    const html = e.clipboardData.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitizeClipboardHtml(html));
      handleContentInput();
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
      handleContentInput();
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

  const handleAIBlockInsert = () => {
    contentRef.current?.focus();
    insertAIResponseBlock();
    handleContentInput();
  };

  const handleTaskBlockInsert = () => {
    contentRef.current?.focus();
    insertTaskListBlock(tasks);
    handleContentInput();
  };

  const handleGenerativeUIInsert = () => {
    contentRef.current?.focus();
    insertGenerativeUiBlock();
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
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="doc-toolbar flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card/65 px-2 backdrop-blur-md">
        {TOOLBAR.map((item, idx) => (
          item.divider ? (
            <Separator key={idx} orientation="vertical" className="mx-1 h-5" />
          ) : item.custom === 'image' || item.custom === 'sketch' || item.custom === 'ai-response' || item.custom === 'task-list' || item.custom === 'generative-ui' ? (
            <Button
              type="button"
              key={item.custom}
              title={item.label}
              onClick={
                item.custom === 'image' ? handleImageButtonClick
                  : item.custom === 'sketch' ? handleSketchInsert
                    : item.custom === 'ai-response' ? handleAIBlockInsert
                      : item.custom === 'task-list' ? handleTaskBlockInsert
                        : handleGenerativeUIInsert
              }
              variant="ghost"
              size="icon-sm"
            >
              {item.icon}
            </Button>
          ) : (
            <Button
              type="button"
              key={item.action}
              title={item.label}
              onMouseDown={e => { e.preventDefault(); execFormat(item.action!); handleContentInput(); }}
              variant="ghost"
              size="icon-sm"
            >
              {item.icon}
            </Button>
          )
        ))}
        <Input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleImageFileInput}
          className="hidden"
        />
        <div className="flex-1" />
        {canShowComments && (
          <Button
            type="button"
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
            variant={commentsOpen ? 'secondary' : 'ghost'}
            size="icon-sm"
          >
            <MessageCircle />
          </Button>
        )}
        {workspaceId && (
          <Button
            type="button"
            onClick={() => {
              setHistoryOpen(v => !v);
              if (!historyOpen) setCommentsOpen(false);
            }}
            title={historyOpen ? 'Hide version history' : 'Version history'}
            variant={historyOpen ? 'secondary' : 'ghost'}
            size="icon-sm"
          >
            <History />
          </Button>
        )}
        <Button
          type="button"
          onClick={() => onToggleFavorite(doc.id, doc.is_favorite)}
          title={doc.is_favorite ? 'Unfavorite' : 'Favorite'}
          variant={doc.is_favorite ? 'secondary' : 'ghost'}
          size="icon-sm"
        >
          <Star fill={doc.is_favorite ? 'currentColor' : 'none'} />
        </Button>
        <Button
          type="button"
          onClick={() => onDelete(doc.id)}
          title="Delete"
          variant="ghost"
          size="icon-sm"
        >
          <Trash2 />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="min-w-0 flex-1">
          <div className="px-6 py-5">
            <Input
              type="text"
              value={title}
              onChange={handleTitleChange}
              placeholder="Untitled"
              className="doc-title-input mb-3 h-auto w-full border-0 bg-transparent px-0 py-0 text-2xl font-bold shadow-none focus-visible:ring-0"
            />
            <div
              ref={contentRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handleContentInput}
              onPaste={handlePaste}
              onDrop={handleDrop}
              data-placeholder="Start writing..."
              className="doc-editor min-h-[200px] text-[13px] leading-[1.7] text-foreground outline-none"
            />
          </div>
        </ScrollArea>
        {commentsOpen && canShowComments && workspaceId && currentUserEmail && (
          <DocumentCommentsPanel
            documentId={doc.id}
            workspaceId={workspaceId}
            userId={userId}
            currentUserEmail={currentUserEmail}
            agentNames={agentNames}
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
});
