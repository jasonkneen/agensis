import type { ReactNode } from 'react';
import { Bot, Command as CommandIcon, FileText, FolderOpen, HardDrive, Layers, Paperclip, Sparkles, Upload, Wrench, X } from 'lucide-react';
import type { CanvasGroup, Document, UploadedFile, WorkspaceAgent } from '../../types';
import { Button } from '@/components/ui/button';
import { agentHandle } from '../../lib/agentAccent';

export type ComposerContextOption = {
  id: string;
  label: string;
  detail: string;
};

export type ProjectFileEntry = {
  path: string;
  name: string;
  size: number;
  mtime: string;
  kind: 'file';
  sourceId?: string;
  sourceKind?: 'workspace' | 'agent';
  sourceLabel?: string;
  sourceRoot?: string;
  agentId?: string | null;
  connectionId?: string | null;
  handle?: string;
  status?: string;
};

export type ProjectFileSource = {
  id: string;
  kind: 'workspace' | 'agent';
  label: string;
  root: string;
  files: ProjectFileEntry[];
  agent_id?: string | null;
  connection_id?: string | null;
  handle?: string;
  host?: string;
  status?: string;
};

export type LinkedFile = {
  id: string;
  kind: 'uploaded' | 'project';
  name: string;
  path: string;
  sourceLabel: string;
  size: number;
  // Set for kind 'uploaded' only. `id` above is prefixed (`uploaded:<id>`) for
  // React keys and dedupe, so it cannot be used to address the file — these two
  // carry the real uploaded_files.id and its MIME type, which is what a stored
  // MessageAttachment needs (see lib/messageAttachments.ts). A 'project' file is
  // a path on somebody's machine; there is nothing to fetch, so it has neither.
  fileId?: string;
  mimeType?: string;
};

export function linkedUploadedFile(file: UploadedFile): LinkedFile {
  return {
    id: `uploaded:${file.id}`,
    kind: 'uploaded',
    name: file.name,
    path: file.name,
    sourceLabel: 'Uploaded file',
    size: file.size || 0,
    fileId: file.id,
    mimeType: file.type,
  };
}

export function linkedProjectFile(file: ProjectFileEntry, source: ProjectFileSource): LinkedFile {
  return {
    id: `project:${source.id}:${file.path}`,
    kind: 'project',
    name: file.name || file.path.split('/').pop() || file.path,
    path: file.path,
    sourceLabel: source.label,
    size: file.size || 0,
  };
}

export function buildFileContext(files: LinkedFile[]) {
  return [
    '[Linked files]',
    ...files.map(file => `- ${file.name} (${file.sourceLabel}): ${file.path}`),
  ].join('\n');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

export function ComposerAddContent({
  documents,
  agents,
  uploadedFiles,
  projectFiles,
  canvasGroups,
  skillOptions,
  toolOptions,
  uploadEnabled,
  uploadStatus,
  onUploadFiles,
  onUploadFolder,
  onOpenFiles,
  onAddUploadedFile,
  onAddProjectFile,
  onAddDocument,
  onAddGroup,
  onAddAgent,
  onAddSkill,
  onAddTool,
}: {
  documents: Document[];
  agents: WorkspaceAgent[];
  uploadedFiles: UploadedFile[];
  projectFiles: Array<{ file: ProjectFileEntry; source: ProjectFileSource }>;
  canvasGroups: CanvasGroup[];
  skillOptions: ComposerContextOption[];
  toolOptions: ComposerContextOption[];
  uploadEnabled: boolean;
  uploadStatus: string;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onOpenFiles: () => void;
  onAddUploadedFile: (file: UploadedFile) => void;
  onAddProjectFile: (file: ProjectFileEntry, source: ProjectFileSource) => void;
  onAddDocument: (doc: Document) => void;
  onAddGroup: (group: CanvasGroup) => void;
  onAddAgent: (agent: WorkspaceAgent) => void;
  onAddSkill: (skill: ComposerContextOption) => void;
  onAddTool: (tool: ComposerContextOption) => void;
}) {
  return (
    <div className="max-h-[inherit] overflow-y-auto p-2">
      <div className="px-2 pb-2">
        <div className="text-sm font-medium">Add to message</div>
        <div className="text-xs text-muted-foreground">Attach files, link context, or route the prompt.</div>
      </div>

      <ComposerAddSection title="Folder / files">
        <div className="grid grid-cols-2 gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={onUploadFiles} disabled={!uploadEnabled}>
            <Upload data-icon="inline-start" />
            Files
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onUploadFolder} disabled={!uploadEnabled}>
            <FolderOpen data-icon="inline-start" />
            Folder
          </Button>
        </div>
        {uploadStatus && <div className="px-1 pt-1 text-xs text-muted-foreground">{uploadStatus}</div>}
        <ComposerAddRow
          icon={<Paperclip />}
          label="Browse file list"
          detail="Uploaded, workspace, and connected agent files"
          onClick={onOpenFiles}
        />
        {uploadedFiles.slice(0, 4).map(file => (
          <ComposerAddRow
            key={file.id}
            icon={<Paperclip />}
            label={file.name}
            detail={`Uploaded · ${formatBytes(file.size || 0)}`}
            onClick={() => onAddUploadedFile(file)}
          />
        ))}
        {projectFiles.slice(0, 6).map(({ file, source }) => (
          <ComposerAddRow
            key={`${source.id}:${file.path}`}
            icon={source.kind === 'agent' ? <Bot /> : <HardDrive />}
            label={file.path}
            detail={`${source.label} · ${formatBytes(file.size || 0)}`}
            onClick={() => onAddProjectFile(file, source)}
          />
        ))}
      </ComposerAddSection>

      <ComposerAddSection title="Agents">
        {agents.length > 0 ? agents.slice(0, 8).map(agent => (
          <ComposerAddRow
            key={agent.id}
            icon={<Bot />}
            label={agent.name}
            detail={`@${agentHandle(agent)}`}
            onClick={() => onAddAgent(agent)}
          />
        )) : (
          <ComposerAddEmpty>No agents yet.</ComposerAddEmpty>
        )}
      </ComposerAddSection>

      <ComposerAddSection title="Documents and canvas">
        {documents.slice(0, 6).map(doc => (
          <ComposerAddRow
            key={doc.id}
            icon={<FileText />}
            label={doc.title}
            detail="Document context"
            onClick={() => onAddDocument(doc)}
          />
        ))}
        {canvasGroups.slice(0, 6).map(group => (
          <ComposerAddRow
            key={group.id}
            icon={<Layers />}
            label={group.name}
            detail="Canvas group context"
            onClick={() => onAddGroup(group)}
          />
        ))}
        {documents.length === 0 && canvasGroups.length === 0 && <ComposerAddEmpty>No documents or canvas groups yet.</ComposerAddEmpty>}
      </ComposerAddSection>

      <ComposerAddSection title="Skills">
        {skillOptions.length > 0 ? skillOptions.map(skill => (
          <ComposerAddRow
            key={skill.id}
            icon={<Sparkles />}
            label={skill.label}
            detail={skill.detail}
            onClick={() => onAddSkill(skill)}
          />
        )) : (
          <ComposerAddEmpty>No detected skills.</ComposerAddEmpty>
        )}
      </ComposerAddSection>

      <ComposerAddSection title="Tools">
        {toolOptions.length > 0 ? toolOptions.map(tool => (
          <ComposerAddRow
            key={tool.id}
            icon={tool.detail.includes('command') ? <CommandIcon /> : <Wrench />}
            label={tool.label}
            detail={tool.detail}
            onClick={() => onAddTool(tool)}
          />
        )) : (
          <ComposerAddEmpty>No detected tools.</ComposerAddEmpty>
        )}
      </ComposerAddSection>
    </div>
  );
}

function ComposerAddSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1 border-t border-border px-2 py-2 first:border-t-0">
      <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

function ComposerAddRow({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none"
      onClick={onClick}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function ComposerAddEmpty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1 text-xs text-muted-foreground">{children}</div>;
}

export function FileChip({ name, label, onRemove }: { name: string; label?: string; onRemove: () => void }) {
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase().slice(0, 4) : null;
  return (
    <span className="inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-xs text-foreground">
      {ext && (
        <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[10px] font-bold leading-none text-primary">
          {ext}
        </span>
      )}
      <span className="min-w-0 truncate">{label || name}</span>
      <button
        type="button"
        className="ml-0.5 shrink-0 rounded p-0.5 hover:bg-muted-foreground/20"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}
