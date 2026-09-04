import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Code2, Columns2, Eye, LayoutTemplate, Star, Trash2 } from 'lucide-react';
import type { Document } from '../../types';
import { extractHtmlFromDocContent } from '../../lib/canvasApps';
import { usePaneSplit } from '../../hooks/usePaneSplit';
import { viewPreferenceKey } from '../../lib/viewPreferences';
import { Button } from '@agensis/ui/components/button';
import { Input } from '@agensis/ui/components/input';

// Lazy: CodeMirror and its grammars stay out of the main bundle. The
// service-worker precache size is a known sore point, and most sessions never
// open an applet's code — the editor loads the first time someone does.
const AppletCodeEditor = React.lazy(() => import('./AppletCodeEditor'));

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
  const [view, setView] = useState<'preview' | 'code' | 'split'>('preview');
  const appletSplit = usePaneSplit({
    preferenceKey: viewPreferenceKey('applet.split', doc.id),
    direction: 'row',
    bounds: { minLeading: 320, minTrailing: 320, defaultRatio: 0.5 },
    label: 'Resize applet editor',
  });
  const splitWide = appletSplit.containerSize >= 720;
  // Guards remote revisions from clobbering an edit the user already made
  // while the body was in flight (fetch is not instant, autosave is 800ms).
  const localDirtyRef = useRef(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  const contentRef = useRef(content);
  contentRef.current = content;
  const documentRevisionRef = useRef(`${doc.version ?? ''}:${doc.updated_at ?? ''}`);

  useEffect(() => {
    const revision = `${doc.version ?? ''}:${doc.updated_at ?? ''}`;
    const revisionChanged = documentRevisionRef.current !== revision;
    documentRevisionRef.current = revision;
    // NET-06: the documents LIST is metadata-only, so `doc.content` is
    // `undefined` for a doc opened by id (Sidebar, picker) — fetch the body on
    // demand instead of rendering blank code/preview forever.
    let cancelled = false;
    const applyBody = (body: string) => {
      if (cancelled) return;
      const remoteBody = body || '';
      if (localDirtyRef.current) {
        const isLocalSaveAck = remoteBody === contentRef.current && titleRef.current === doc.title;
        if (!isLocalSaveAck) {
          // Keep the pending local save. The existing last-writer behavior is
          // safer than silently discarding the user's edit on a conflict.
          setLoadingContent(false);
          return;
        }
        localDirtyRef.current = false;
        setLoadingContent(false);
        return;
      }
      setTitle(doc.title);
      setContent(remoteBody);
      setLoadingContent(false);
    };

    if (doc.content !== undefined && !revisionChanged) {
      applyBody(doc.content);
    } else {
      // A revision refresh should leave the currently mounted editor/preview
      // in place while the body request is in flight; hiding it would reset a
      // CodeMirror selection even when the revision turns out to be our ack.
      if (!revisionChanged) setLoadingContent(true);
      fetchDocumentContent(doc.id, revisionChanged).then(applyBody);
    }
    return () => { cancelled = true; };
  }, [doc.id, doc.title, doc.content, doc.version, doc.updated_at, fetchDocumentContent]);

  const triggerAutoSave = useCallback((newTitle?: string, newContent?: string) => {
    localDirtyRef.current = true;
    // useDocuments owns the one 800ms debounce. Pass the captured edit now so
    // closing this editor cannot strand its last change in a local timer.
    onAutoSave(doc.id, {
      title: newTitle ?? title,
      content: newContent ?? content,
    });
  }, [doc.id, title, content, onAutoSave]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    localDirtyRef.current = true;
    setTitle(next);
    onTitleChange(next);
    triggerAutoSave(next, undefined);
  };

  const handleContentChange = useCallback((next: string) => {
    localDirtyRef.current = true;
    setContent(next);
    triggerAutoSave(undefined, next);
  }, [triggerAutoSave]);

  // In split view the iframe would otherwise be torn down and rebuilt on every
  // keystroke — srcDoc changes reload the document, so a running applet would
  // restart mid-word. The preview follows the code at a short lag instead.
  const [previewSource, setPreviewSource] = useState(content);
  useEffect(() => {
    if (view !== 'split') { setPreviewSource(content); return; }
    const timer = setTimeout(() => setPreviewSource(content), 600);
    return () => clearTimeout(timer);
  }, [content, view]);
  const previewHtml = extractHtmlFromDocContent(view === 'split' ? previewSource : content);

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
        <Button
          type="button"
          onClick={() => setView('split')}
          title="Code and preview side by side"
          variant={view === 'split' ? 'secondary' : 'ghost'}
          size="icon-sm"
        >
          <Columns2 />
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
          className="doc-title-input mb-3 h-auto w-full border-0 bg-transparent px-0 py-0 text-xl font-semibold tracking-tight shadow-none focus-visible:ring-0"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-6 pb-5">
        {loadingContent ? (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
            Loading applet source…
          </div>
        ) : (
          // Split is editor + preview in one grid; the solo views are the same
          // two panes with one column hidden, so all three share the mounts and
          // switching view never resets the editor's cursor or the iframe.
          <div
            ref={appletSplit.containerRef}
            className={view === 'split'
              ? splitWide
                ? 'relative flex h-full min-h-0 gap-3'
                : 'flex h-full min-h-0 flex-col gap-3'
              : 'h-full min-h-0'}
          >
            {view !== 'preview' && (
              <div
                className={view === 'split'
                  ? splitWide ? 'min-h-0 min-w-0 shrink-0' : 'min-h-0 min-w-0 flex-1'
                  : 'h-full min-h-0 min-w-0'}
                style={view === 'split' && splitWide
                  ? { width: `${appletSplit.size}px`, maxWidth: 'calc(100% - 320px)' }
                  : undefined}
              >
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center rounded-md border border-border bg-muted/20 text-sm text-muted-foreground">
                      Loading editor…
                    </div>
                  }
                >
                  <AppletCodeEditor value={content} onChange={handleContentChange} ariaLabel={`Source of ${title || 'applet'}`} />
                </Suspense>
              </div>
            )}
            {view === 'split' && splitWide && (
              <button
                {...appletSplit.dividerProps}
                style={{ left: `${appletSplit.size + 6}px` }}
                className="group/split absolute inset-y-0 z-30 -ml-1.5 w-3 touch-none cursor-col-resize outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span
                  aria-hidden="true"
                  className="mx-auto block h-full w-px bg-transparent transition-colors group-hover/split:bg-border group-focus-visible/split:bg-primary/70"
                />
              </button>
            )}
            {view !== 'code' && (
              <div
                className={view === 'split' ? 'min-h-0 min-w-0 flex-1' : 'h-full min-h-0 min-w-0'}
              >
                {previewHtml ? (
                  <iframe
                    title={title}
                    srcDoc={previewHtml}
                    sandbox="allow-forms allow-modals allow-popups allow-scripts"
                    className="h-full w-full rounded-md border border-border bg-white"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                    No ```html code block found in this applet's source yet
                    {view === 'split' ? ' — it will appear here as you type one.' : ' — switch to Code to add one.'}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
