import React, { useCallback, useRef, useState } from 'react';
import {
  Archive,
  Code2,
  File,
  FileText,
  Image,
  LayoutGrid,
  List,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type { UploadedFile } from '../../types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

interface FileUploadProps {
  files: UploadedFile[];
  onUpload: (files: File[]) => void;
  onDelete: (id: string) => void;
}

// --- Client-side upload validation -----------------------------------------
//
// SECURITY NOTE: this is a client-side guard for UX and casual misuse only and
// is trivially bypassable. The SERVER-SIDE upload handler MUST independently
// enforce the same MIME allowlist and size caps (and ideally sniff content),
// since browser-reported `file.type` is untrusted and easily spoofed. That
// back-end enforcement is owned by another track — this note is the handoff.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB per upload batch

// Allowlist keyed by extension -> acceptable MIME types. One extension can
// legitimately map to several (or be reported as ""), so we validate the
// extension first and only cross-check `file.type` when the browser supplies
// a non-empty value. NOTE: archives (zip/tar) are intentionally excluded even
// though getFileIcon() can render them — the app advertises "PDF, images,
// text, and code", so we keep the allowlist to images/pdf/text/code/docs.
const ALLOWED_EXTENSIONS: Record<string, string[]> = {
  // Images
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  svg: ['image/svg+xml'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
  // Documents
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  // Text / data
  txt: ['text/plain'],
  md: ['text/markdown', 'text/plain', 'text/x-markdown'],
  csv: ['text/csv', 'application/vnd.ms-excel'],
  rtf: ['application/rtf', 'text/rtf'],
  // Code (browsers often report "" or text/plain for these)
  json: ['application/json', 'text/json', 'text/plain'],
  js: ['text/javascript', 'application/javascript', 'text/plain'],
  mjs: ['text/javascript', 'application/javascript', 'text/plain'],
  ts: ['text/typescript', 'application/typescript', 'video/mp2t', 'text/plain'],
  tsx: ['text/plain'],
  jsx: ['text/plain'],
  html: ['text/html'],
  css: ['text/css', 'text/plain'],
  xml: ['application/xml', 'text/xml'],
  yml: ['text/yaml', 'application/yaml', 'text/plain'],
  yaml: ['text/yaml', 'application/yaml', 'text/plain'],
};

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Returns an error string if the file is rejected, or null if it passes. */
function validateFile(file: File): string | null {
  const ext = getExtension(file.name);
  const allowedMimes = ALLOWED_EXTENSIONS[ext];

  if (!ext || !allowedMimes) {
    return `"${file.name}" has an unsupported file type.`;
  }
  // Only cross-check the browser-provided MIME when it is present. An empty
  // `file.type` is common for code/text files and must NOT cause a rejection.
  if (file.type && !allowedMimes.includes(file.type)) {
    return `"${file.name}" — file type "${file.type}" does not match its .${ext} extension.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `"${file.name}" is too large (max ${formatBytes(MAX_FILE_BYTES)} per file).`;
  }
  return null;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getFileIcon(type: string) {
  if (type.startsWith('image/')) return <Image data-icon="inline-start" className="size-4 text-green-500" />;
  if (type.includes('pdf') || type.includes('text')) return <FileText data-icon="inline-start" className="size-4 text-primary" />;
  if (type.includes('javascript') || type.includes('typescript') || type.includes('json')) {
    return <Code2 data-icon="inline-start" className="size-4 text-yellow-500" />;
  }
  if (type.includes('zip') || type.includes('tar')) return <Archive data-icon="inline-start" className="size-4 text-violet-500" />;
  return <File data-icon="inline-start" className="size-4 text-muted-foreground" />;
}

export function FileUpload({ files, onUpload, onDelete }: FileUploadProps) {
  const [dragging, setDragging] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [search, setSearch] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Validate a batch, upload only the files that pass, and surface a clear
  // error for any that are rejected. All-valid batches behave exactly as before.
  const processUpload = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;

    const accepted: File[] = [];
    const errors: string[] = [];
    let runningTotal = 0;

    for (const file of incoming) {
      const reason = validateFile(file);
      if (reason) {
        errors.push(reason);
        continue;
      }
      if (runningTotal + file.size > MAX_TOTAL_BYTES) {
        errors.push(`"${file.name}" skipped — exceeds the ${formatBytes(MAX_TOTAL_BYTES)} total upload limit.`);
        continue;
      }
      runningTotal += file.size;
      accepted.push(file);
    }

    setUploadError(errors.length > 0 ? errors.join(' ') : null);
    if (accepted.length > 0) onUpload(accepted);
  }, [onUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    processUpload(Array.from(e.dataTransfer.files));
  }, [processUpload]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processUpload(Array.from(e.target.files));
    }
    // Reset so re-selecting the same file still fires onChange.
    e.target.value = '';
  };

  const filteredFiles = files.filter(f => f.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <section className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b px-6 py-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Files</h2>
            <p className="text-xs text-muted-foreground">{files.length} files uploaded</p>
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={value => {
                if (value) setViewMode(value as 'grid' | 'list');
              }}
              variant="outline"
              size="sm"
              spacing={0}
            >
              <ToggleGroupItem value="list" aria-label="List view" title="List view" className="min-w-7 px-0">
                <List data-icon="inline-start" className="size-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="grid" aria-label="Grid view" title="Grid view" className="min-w-7 px-0">
                <LayoutGrid data-icon="inline-start" className="size-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
            <Button type="button" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload data-icon="inline-start" className="size-3.5" />
              Upload
            </Button>
            <Input ref={fileInputRef} type="file" multiple onChange={handleFileInput} className="hidden" />
          </div>
        </div>

        <InputGroup>
          <InputGroupAddon align="inline-start">
            <Search data-icon="inline-start" className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            placeholder="Search files..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </InputGroup>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-6">
          <div
            role="button"
            tabIndex={0}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-7 text-center transition-colors',
              dragging ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:border-primary/50',
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <Upload data-icon="inline-start" className={cn('size-5', dragging && 'text-primary')} />
            </span>
            <div>
              <p className="text-sm font-medium">{dragging ? 'Drop files here' : 'Drag and drop files'}</p>
              <p className="text-xs text-muted-foreground">PDF, images, text, and code — up to {formatBytes(MAX_FILE_BYTES)} each</p>
            </div>
          </div>

          {uploadError && (
            <Alert variant="destructive">
              <AlertDescription>{uploadError}</AlertDescription>
            </Alert>
          )}

          {filteredFiles.length === 0 && files.length > 0 ? (
            <Empty className="min-h-40 border-0">
              <EmptyHeader>
                <EmptyTitle>No files match "{search}"</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : filteredFiles.length > 0 ? (
            viewMode === 'list' ? (
              <div className="space-y-2">
                {filteredFiles.map(file => (
                  <Item key={file.id} variant="outline">
                    <ItemMedia variant="icon" className="size-8 rounded-md border bg-muted">
                      {getFileIcon(file.type)}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="max-w-full truncate">{file.name}</ItemTitle>
                      <ItemDescription>
                        {formatBytes(file.size)} - {new Date(file.created_at).toLocaleDateString()}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button type="button" variant="ghost" size="icon-xs" onClick={() => onDelete(file.id)} title="Delete file">
                        <Trash2 data-icon="inline-start" className="size-3.5" />
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                {filteredFiles.map(file => (
                  <Card key={file.id} size="sm" className="relative">
                    <CardContent className="flex flex-col gap-2 p-3">
                      <span className="flex size-9 items-center justify-center rounded-md bg-muted">{getFileIcon(file.type)}</span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-2 right-2"
                        onClick={() => onDelete(file.id)}
                        title="Delete file"
                      >
                        <Trash2 data-icon="inline-start" className="size-3" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )
          ) : (
            <Empty className="min-h-40 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <File className="size-4" />
                </EmptyMedia>
                <EmptyTitle>No files uploaded</EmptyTitle>
                <EmptyDescription>Upload files to keep workspace context close at hand.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
