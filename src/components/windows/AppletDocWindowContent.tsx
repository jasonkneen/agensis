import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Code2, Eye, LayoutTemplate, Star, Trash2 } from 'lucide-react';
import type { Document } from '../../types';
import { extractHtmlFromDocContent } from '../../lib/canvasApps';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface AppletDocWindowContentProps {
  document: Document;
  onAutoSave: (id: string, updates: { title?: string; content?: string }) => void;
  onToggleFavorite: (id: string, current: boolean) => void;
  onDelete: (id: string) => void;
  onTitleChange: (title: string) => void;
  onAddToCanvas?: (doc: Document) => void;
  // NET-06 made the documents LIST metadata-only — `document.content` is
  // `undefined` for a doc opened from Sidebar/search/picker, not just empty.
  // This fetches (and caches) the one doc's body on demand; see useDocuments.
  fetchDocumentContent: (id: string, force?: boolean) => Promise<string>;
}

// Applets are stored as documents (folder === APPLETS_FOLDER, see canvasApps.ts)
// so the Canvas Apps picker can list them, but their body is source code, not
// prose — the normal DocWindowContent is a contentEditable rich-text editor
// that runs sanitizeHtml() on every autosave, which strips <script>/<style>
// tags. Opening a saved applet there would silently corrupt it on first edit.
// This is a plain-text code editor + live iframe preview instead: autosave
// writes the raw text back untouched, and nothing here ever parses the body
// as HTML except the sandboxed preview iframe.
export const AppletDocWindowContent = React.memo(function AppletDocWindowContent({
  document: doc,
  onAutoSave,
  onToggleFavorite,
  onDelete,
  onTitleChange,
  onAddToCanvas,
  fetchDocumentContent,
}: AppletDocWindowContentProps) {
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content || '');
  const [loadingContent, setLoadingContent] = useState(doc.content === undefined);
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the async fetch below from clobbering an edit the user already made
  // while the body was still in flight (fetch is not instant, autosave is 800ms).
  const editedRef = useRef(false);

  useEffect(() => {
    setTitle(doc.title);
    editedRef.current = false;
    // NET-06: the documents LIST is metadata-only, so `doc.content` is
    // `undefined` for a doc opened by id (Sidebar, picker) — fetch the body on
    // demand instead of rendering blank code/preview forever.
    if (doc.content !== undefined) {
      setContent(doc.content);
      setLoadingContent(false);
      return;
    }
    let cancelled = false;
    setLoadingContent(true);
    fetchDocumentContent(doc.id).then(body => {
      if (cancelled || editedRef.current) return;
      setContent(body);
      setLoadingContent(false);
    });
    return () => { cancelled = true; };
  }, [doc.id, doc.content, fetchDocumentContent]);

  const triggerAutoSave = useCallback((newTitle?: string, newContent?: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onAutoSave(doc.id, {
        title: newTitle ?? title,
        content: newContent ?? content,
      });
    }, 800);
  }, [doc.id, title, content, onAutoSave]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setTitle(next);
    onTitleChange(next);
    triggerAutoSave(next, undefined);
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    editedRef.current = true;
    setContent(next);
    triggerAutoSave(undefined, next);
  };

  const previewHtml = extractHtmlFromDocContent(content);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="doc-toolbar flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card/65 px-2 backdrop-blur-md">
        <Button
          type="button"
          onClick={() => setView('preview')}
          title="Preview"
          variant={view === 'preview' ? 'secondary' : 'ghost'}
          size="icon-sm"
        >
          <Eye />
        </Button>
        <Button
          type="button"
          onClick={() => setView('code')}
          title="Edit code"
          variant={view === 'code' ? 'secondary' : 'ghost'}
          size="icon-sm"
        >
          <Code2 />
        </Button>
        <div className="flex-1" />
        {onAddToCanvas && (
          <Button
            type="button"
            onClick={() => onAddToCanvas(doc)}
            title="Add to canvas"
            variant="ghost"
            size="sm"
          >
            <LayoutTemplate data-icon="inline-start" />
            Add to canvas
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

      <div className="px-6 pt-5">
        <Input
          type="text"
          value={title}
          onChange={handleTitleChange}
          placeholder="Untitled applet"
          className="doc-title-input mb-3 h-auto w-full border-0 bg-transparent px-0 py-0 text-2xl font-bold shadow-none focus-visible:ring-0"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-6 pb-5">
        {loadingContent ? (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
            Loading applet source…
          </div>
        ) : view === 'preview' ? (
          previewHtml ? (
            <iframe
              title={title}
              srcDoc={previewHtml}
              sandbox="allow-forms allow-modals allow-popups allow-scripts"
              className="h-full w-full rounded-md border border-border bg-white"
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              No ```html code block found in this applet's source yet — switch to Code to add one.
            </div>
          )
        ) : (
          <textarea
            value={content}
            onChange={handleContentChange}
            spellCheck={false}
            placeholder="```html&#10;<!doctype html>...&#10;```"
            className="h-full w-full resize-none rounded-md border border-border bg-muted/20 p-3 font-mono text-[12.5px] leading-relaxed text-foreground outline-none"
          />
        )}
      </div>
    </div>
  );
});
