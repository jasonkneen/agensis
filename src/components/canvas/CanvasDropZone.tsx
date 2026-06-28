import { useState, useCallback, useRef } from 'react';
import { Upload } from 'lucide-react';
import type { CanvasObject, CanvasObjectType, UploadedFile } from '../../types';
import { apiUrl } from '../../lib/backendClient';

interface CanvasDropZoneProps {
  onAddObject: (type: CanvasObjectType, overrides?: Partial<CanvasObject>) => Promise<CanvasObject | null>;
  onUploadFiles: (files: File[]) => Promise<UploadedFile[]>;
  children: React.ReactNode;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

export function CanvasDropZone({ onAddObject, onUploadFiles, children }: CanvasDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const counterRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current--;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current = 0;
    setDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const rect = containerRef.current?.getBoundingClientRect();
    const dropX = rect ? ((e.clientX - rect.left) / rect.width) * 100 : 50;
    const dropY = rect ? ((e.clientY - rect.top) / rect.height) * 100 : 50;

    const uploadedFiles = await onUploadFiles(files);
    const uploadByName = new Map(uploadedFiles.map(file => [`${file.name}:${file.size}:${file.type}`, file]));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const uploaded = uploadByName.get(`${file.name}:${file.size}:${file.type}`) || uploadedFiles.find(item => item.name === file.name);
      const offsetX = dropX + (i * 2);
      const offsetY = dropY + (i * 2);
      const storedSrc = uploaded ? apiUrl(`/backend/files/${uploaded.id}/content`) : '';

      if (file.type.startsWith('image/')) {
        const dataUrl = storedSrc || await fileToDataUrl(file);
        await onAddObject('image', {
          x: offsetX - 10,
          y: offsetY - 8,
          width: 20,
          height: 16,
          src: dataUrl,
          file_name: file.name,
          fill: 'transparent',
          stroke: 'transparent',
          stroke_width: 0,
        });
      } else if (file.type.startsWith('video/')) {
        const dataUrl = storedSrc || await fileToDataUrl(file);
        await onAddObject('video', {
          x: offsetX - 12,
          y: offsetY - 8,
          width: 24,
          height: 16,
          src: dataUrl,
          file_name: file.name,
          fill: 'transparent',
          stroke: 'transparent',
          stroke_width: 0,
        });
      } else {
        const isPreviewable = isPreviewableFile(file);
        await onAddObject('file', {
          x: offsetX - (isPreviewable ? 16 : 7),
          y: offsetY - (isPreviewable ? 12 : 5),
          width: isPreviewable ? 32 : 14,
          height: isPreviewable ? 24 : 10,
          src: storedSrc,
          file_name: file.name,
          text_content: file.type || file.name.split('.').pop() || 'file',
          fill: 'var(--canvas-raised)',
          stroke: 'var(--border)',
          stroke_width: 1,
        });
      }
    }
  }, [onAddObject, onUploadFiles]);

  return (
    <div
      ref={containerRef}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="relative size-full"
    >
      {children}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-[9000] flex flex-col items-center justify-center gap-3 rounded-lg border-[3px] border-dashed border-primary bg-primary/10 backdrop-blur-sm">
          <div className="flex size-14 items-center justify-center rounded-full border-2 border-primary/30 bg-primary/10 text-primary">
            <Upload data-icon="inline-start" className="size-6" />
          </div>
          <div className="text-center">
            <p className="mb-1 text-base font-semibold text-primary">Drop to add to canvas</p>
            <p className="text-sm text-muted-foreground">Images, videos, and files will appear on the canvas</p>
          </div>
        </div>
      )}
    </div>
  );
}

function isPreviewableFile(file: File) {
  return file.type.startsWith('text/')
    || file.type === 'application/json'
    || /\.(md|markdown|txt|json|csv|log|html|css|js|ts|tsx|jsx)$/i.test(file.name);
}
