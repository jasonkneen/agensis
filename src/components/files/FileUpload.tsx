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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) onUpload(dropped);
  }, [onUpload]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      onUpload(Array.from(e.target.files));
    }
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
              <p className="text-xs text-muted-foreground">PDF, images, text, and code</p>
            </div>
          </div>

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
