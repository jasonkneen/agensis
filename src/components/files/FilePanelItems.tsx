// The Files side panel — rows and the detail pane. Extracted from
// ChatWindowContent so it can be rendered in a unit test (tests/unit/filePanelItems.test.ts)
// without pulling the whole chat window in behind it.
//
// What this file deliberately does NOT do:
//
//   It does not describe a file it has not read. The previous version of the
//   detail pane rendered a five-swatch "PALETTE" derived from a hash of the file
//   NAME, and three lines of generated verse built from the same string
//   ("<name> waits in place / Uploaded light marks the path / Hands reshape the
//   file"). Neither had ever seen the file's bytes. A palette that is not the
//   image's palette is the product asserting something false about the user's
//   file, so both are gone — replaced by the image itself, and by metadata that
//   came from the row. Where there is nothing true to show, this says so.
//
//   It does not put file bytes behind a public URL. /backend/files/:id/content
//   requires an Authorization header, which an <img src> cannot send, so the
//   bytes come through useAuthenticatedObjectUrl into a blob: URL — the same
//   path message attachments use.
//
//   It does not trust `name` or `type`. The name is sanitised at this render
//   boundary (safeAttachmentName: one line, no control or bidi-override
//   characters, length-capped) and rendered as text, never as HTML. The type is
//   matched against the closed raster-image allowlist shared with attachments,
//   so an unexpected value routes to an icon rather than to an <img>; it is
//   never used for anything security-relevant.

import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  Bot,
  Code2,
  File as FileIcon,
  FileImage,
  FileText,
  Folder,
  TriangleAlert,
} from 'lucide-react';
import { apiUrl } from '../../lib/backendClient';
import { useAuthenticatedObjectUrl } from '../../hooks/useAuthenticatedObjectUrl';
import {
  ATTACHMENT_UNAVAILABLE_LABEL,
  attachmentContentPath,
  safeAttachmentName,
} from '../../lib/messageAttachments';
import {
  describeFileType,
  formatDimensions,
  formatUploadedDate,
  formatUploadedDateTime,
  isPreviewableImageFile,
  panelFileName,
  panelFilePath,
  panelFileSourceLabel,
  splitFileNameForDisplay,
  type SelectedPanelFile,
} from '../../lib/uploadedFiles';
import { formatBytes, type ProjectFileEntry, type ProjectFileSource } from '../chat/ComposerAddContent';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { CreateTaskInput } from '../../hooks/useTasks';
import type { UploadedFile, WorkspaceAgent } from '../../types';

function fileTypeIcon(type: string | null | undefined, className: string) {
  const value = String(type || '').toLowerCase();
  if (value.startsWith('image/')) return <FileImage className={className} aria-hidden />;
  if (value.includes('pdf') || value.startsWith('text/')) return <FileText className={className} aria-hidden />;
  if (value.includes('javascript') || value.includes('typescript') || value.includes('json')) {
    return <Code2 className={className} aria-hidden />;
  }
  if (value.includes('zip') || value.includes('tar')) return <Archive className={className} aria-hidden />;
  return <FileIcon className={className} aria-hidden />;
}

/**
 * Middle-truncating file name. `head` ellipsises, `tail` never shrinks — these
 * files are `Screenshot 2026-07-27 at 10.16.32.png` and the seconds at the end
 * are the only thing that tells two of them apart, so truncating the tail (what
 * a plain `truncate` does) removes exactly the information the row exists to
 * carry. The full name is on the row's `title`.
 */
export function FileNameText({ name, className }: { name: string; className?: string }) {
  const { head, tail } = splitFileNameForDisplay(name);
  return (
    <span className={cn('flex min-w-0 items-baseline', className)}>
      {/* `whitespace-pre` rather than Tailwind's `truncate`, whose `nowrap`
          collapses a trailing space at the box edge — "… at " + "10.16.32.png"
          rendered as "at10.16.32.png". */}
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}

/**
 * Fetch only once the element is on screen. The panel can hold a hundred rows
 * and the bytes route serves the ORIGINAL image (there is no resized-thumbnail
 * route), so mounting must not fire a hundred multi-megabyte downloads.
 */
function useInViewport<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    // jsdom (and any browser without the API) simply shows everything.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}

/** Small image preview for a list row; falls back to the type icon. */
function UploadedFileThumb({ file }: { file: UploadedFile }) {
  const { ref, visible } = useInViewport<HTMLSpanElement>();
  const [decodeFailed, setDecodeFailed] = useState(false);
  const isImage = isPreviewableImageFile(file);
  const href = apiUrl(attachmentContentPath(file.id));
  const { src, error } = useAuthenticatedObjectUrl(isImage && visible ? href : null);
  // `type` is client-supplied, so bytes that claim to be a PNG need not decode
  // as one. A broken-image glyph is the exact thing this panel must not show.
  const showImage = isImage && Boolean(src) && !error && !decodeFailed;
  return (
    <span
      ref={ref}
      className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/50 text-muted-foreground"
    >
      {showImage
        ? (
          <img
            src={src}
            alt=""
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
            onError={() => setDecodeFailed(true)}
          />
        )
        : fileTypeIcon(file.type, 'size-3.5')}
    </span>
  );
}

export function UploadedFileRow({ file, onOpen }: { file: UploadedFile; onOpen: () => void }) {
  const name = safeAttachmentName(file.name);
  const uploadedOn = formatUploadedDate(file.created_at);
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-foreground hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      onClick={onOpen}
      title={name}
    >
      <UploadedFileThumb file={file} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <FileNameText name={name} />
        <span className="text-[0.68rem] text-muted-foreground">
          {formatBytes(file.size)}
          {uploadedOn ? ` · ${uploadedOn}` : ''}
        </span>
      </span>
    </button>
  );
}

export function ProjectFileRow({
  file,
  source,
  onOpen,
}: {
  file: ProjectFileEntry;
  source: ProjectFileSource;
  onOpen: () => void;
}) {
  const displayName = safeAttachmentName(file.path.split('/').filter(Boolean).pop() || file.name || file.path);
  const folderPath = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : source.label;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-foreground hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      onClick={onOpen}
      title={file.path}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded border border-border bg-muted/50 text-muted-foreground">
        {source.kind === 'agent' ? <Bot className="size-3.5" aria-hidden /> : fileTypeIcon('', 'size-3.5')}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <FileNameText name={displayName} />
        <span className="truncate text-[0.68rem] text-muted-foreground">
          {formatBytes(file.size)}
          {folderPath ? ` · ${folderPath}` : ''}
        </span>
      </span>
    </button>
  );
}

/**
 * The file's actual bytes, or an honest sentence. Never a placeholder that
 * implies content the panel has not seen.
 */
function FilePreview({
  selectedFile,
  onDimensions,
}: {
  selectedFile: SelectedPanelFile;
  onDimensions: (width: number, height: number) => void;
}) {
  const [decodeFailed, setDecodeFailed] = useState(false);
  const isUploadedImage = selectedFile.kind === 'uploaded' && isPreviewableImageFile(selectedFile.file);
  const href = selectedFile.kind === 'uploaded' ? apiUrl(attachmentContentPath(selectedFile.file.id)) : '';
  const { src, loading, error: fetchFailed } = useAuthenticatedObjectUrl(isUploadedImage ? href : null);
  // Bytes that arrived but do not decode are as unavailable as bytes that never
  // arrived — `type` is client-supplied and a browser may simply not support
  // this one. Either way the answer is a sentence, not a broken-image glyph.
  const error = fetchFailed || decodeFailed;

  // A "project" file is a path on somebody else's machine; there are no bytes to
  // fetch. Anything that is not a raster image the browser will render safely
  // (SVG included, deliberately) has no preview either.
  if (!isUploadedImage) {
    return (
      <PreviewShell>
        <span className="text-xs text-muted-foreground">No preview available</span>
      </PreviewShell>
    );
  }

  // The row exists but its storage object does not (deleted blob, a Netlify-only
  // deploy where /backend/files has no route). Say so instead of leaving a
  // broken-image glyph.
  if (error) {
    return (
      <PreviewShell>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5" aria-hidden />
          {ATTACHMENT_UNAVAILABLE_LABEL}
        </span>
      </PreviewShell>
    );
  }

  if (!src) {
    return (
      <PreviewShell>
        {loading ? <Spinner /> : <span className="text-xs text-muted-foreground">No preview available</span>}
      </PreviewShell>
    );
  }

  return (
    <div className={cn(PREVIEW_BOX, 'border-solid bg-muted/25 p-2')}>
      <img
        src={src}
        alt={safeAttachmentName(selectedFile.file.name)}
        className="max-h-full w-auto max-w-full object-contain"
        onLoad={event => {
          const image = event.currentTarget;
          onDimensions(image.naturalWidth, image.naturalHeight);
        }}
        onError={() => setDecodeFailed(true)}
      />
    </div>
  );
}

// ONE height for every state the preview can be in — spinner, image, "no
// preview", "unavailable". The box is reserved before the bytes arrive, so a
// decode never resizes it and the details below it never jump. (The list rows
// get this for free: their thumbnail is a fixed 28px box with object-cover, so
// a decoding image cannot change a row's height either.)
const PREVIEW_BOX = 'flex h-48 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/20';

function PreviewShell({ children }: { children: React.ReactNode }) {
  return <div className={PREVIEW_BOX}>{children}</div>;
}

function defaultInstruction(selectedFile: SelectedPanelFile) {
  return `Modify ${panelFileName(selectedFile)} based on the requested outcome. Preserve the existing style and report what changed.`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[0.68rem] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-xs text-foreground" title={value}>{value}</span>
    </div>
  );
}

export function FileDetailPanel({
  selectedFile,
  agents,
  onOpenUploaded,
  onCreateTask,
  onTaskCreated,
}: {
  selectedFile: SelectedPanelFile;
  agents: WorkspaceAgent[];
  onOpenUploaded: (file: UploadedFile) => Promise<void>;
  onCreateTask?: (input: CreateTaskInput) => void | Promise<unknown>;
  onTaskCreated: () => void;
}) {
  const defaultAgentId = agents[0]?.id || '';
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [instructions, setInstructions] = useState(() => defaultInstruction(selectedFile));
  const [saving, setSaving] = useState(false);
  const [dimensions, setDimensions] = useState('');

  // Reset everything derived from the file when the file changes. Today the
  // panel happens to unmount between selections (the list is behind a Back
  // button), and that is the ONLY reason this was not already visible: without
  // it, `dimensions` measured from the previous image stays on screen and the
  // pane reports a PDF as "160 x 100". Owning the reset here means the pane
  // cannot be made to lie by a caller that keeps it mounted.
  const fileKey = selectedFile.kind === 'uploaded'
    ? selectedFile.file.id
    : `${selectedFile.source.id}:${selectedFile.file.path}`;
  const [shownFor, setShownFor] = useState(fileKey);
  if (shownFor !== fileKey) {
    setShownFor(fileKey);
    setDimensions('');
    setInstructions(defaultInstruction(selectedFile));
  }

  const fileName = safeAttachmentName(panelFileName(selectedFile));
  const sourceLabel = panelFileSourceLabel(selectedFile);
  const sourcePath = panelFilePath(selectedFile);
  const size = selectedFile.file.size;
  const selectedAgent = agents.find(agent => agent.id === agentId);

  // The name IS the path for an uploaded file, so showing both is the same
  // string twice. Only a project file has a path worth its own line.
  const pathLine = selectedFile.kind === 'project' ? sourcePath : '';
  const typeLabel = selectedFile.kind === 'uploaded' ? describeFileType(selectedFile.file.type) : '';
  const whenLabel = selectedFile.kind === 'uploaded'
    ? formatUploadedDateTime(selectedFile.file.created_at)
    : formatUploadedDateTime(selectedFile.file.mtime);

  const handleCreateTask = async () => {
    if (!onCreateTask || saving) return;
    setSaving(true);
    try {
      await onCreateTask({
        title: `Modify ${fileName}`,
        description: [
          `File: ${sourcePath}`,
          `Source: ${sourceLabel}`,
          selectedAgent ? `Assigned agent: ${selectedAgent.name}` : '',
          `Instructions:\n${instructions.trim() || `Modify ${fileName}.`}`,
        ].filter(Boolean).join('\n\n'),
        status: 'in_progress',
        priority: 'normal',
        assignee_id: agentId || null,
        source_type: 'ai',
        source_id: selectedFile.kind === 'uploaded'
          ? selectedFile.file.id
          : `${selectedFile.source.id}:${selectedFile.file.path}`,
      });
      onTaskCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Keyed on the file so a fetch in flight for the previous one cannot
          settle into this one's preview. */}
      <FilePreview
        key={fileKey}
        selectedFile={selectedFile}
        onDimensions={(width, height) => setDimensions(formatDimensions(width, height))}
      />

      <div className="rounded-lg border border-border bg-muted/25 p-2.5">
        <div className="mb-1.5 flex min-w-0 items-start gap-2">
          {selectedFile.kind === 'project' && selectedFile.source.kind === 'agent'
            ? <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            : selectedFile.kind === 'project'
              ? <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              : fileTypeIcon(selectedFile.file.type, 'mt-0.5 size-4 shrink-0 text-muted-foreground')}
          <div className="min-w-0 flex-1 text-sm font-semibold" title={fileName}>
            <FileNameText name={fileName} />
          </div>
        </div>
        <div className="divide-y divide-border/60">
          <DetailRow label="Path" value={pathLine} />
          <DetailRow label="Type" value={typeLabel} />
          <DetailRow label="Size" value={formatBytes(size)} />
          <DetailRow label="Dimensions" value={dimensions} />
          <DetailRow label={selectedFile.kind === 'uploaded' ? 'Uploaded' : 'Modified'} value={whenLabel} />
          <DetailRow label="Source" value={sourceLabel} />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Assign agent</label>
        <NativeSelect value={agentId} onChange={event => setAgentId(event.target.value)} className="w-full">
          <NativeSelectOption value="">Unassigned</NativeSelectOption>
          {agents.map(agent => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              {agent.name}{agent.handle ? ` (@${agent.handle})` : ''}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Instruction</label>
        <Textarea
          value={instructions}
          onChange={event => setInstructions(event.target.value)}
          rows={5}
          className="min-h-28 resize-none text-sm"
          placeholder="Tell the assigned agent how to modify this file..."
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        {selectedFile.kind === 'uploaded' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void onOpenUploaded(selectedFile.file)}>
            Open original
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Creates an active task from this file.</span>
        )}
        <Button type="button" size="sm" onClick={handleCreateTask} disabled={!onCreateTask || saving}>
          {saving ? <Spinner /> : null}
          Create task
        </Button>
      </div>
    </div>
  );
}
