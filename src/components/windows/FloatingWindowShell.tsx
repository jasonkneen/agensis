import React, { useCallback, useRef, useState } from 'react';
import { Copy, Maximize2, Minus, MoreHorizontal, Share2, Trash2, X } from 'lucide-react';
import type { FloatingWindow } from '../../types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface FloatingWindowShellProps {
  window: FloatingWindow;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
  onUpdate: (id: string, updates: Partial<FloatingWindow>) => void;
  onMinimize: (id: string) => void;
  onShare?: () => void;
  titleIcon?: React.ReactNode;
  breadcrumb?: string;
  children: React.ReactNode;
}

export function FloatingWindowShell({
  window: win,
  onClose,
  onFocus,
  onUpdate,
  onMinimize,
  onShare,
  titleIcon,
  breadcrumb,
  children,
}: FloatingWindowShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; winW: number; winH: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    onFocus(win.id);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      winX: win.x,
      winY: win.y,
    };
    setIsDragging(true);

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      shellRef.current?.style.setProperty('transform', `translate3d(${dx}px, ${dy}px, 0)`);
    };

    const onUp = (ev: MouseEvent) => {
      if (dragRef.current) {
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        const x = Math.max(0, dragRef.current.winX + dx);
        const y = Math.max(0, dragRef.current.winY + dy);
        if (shellRef.current) {
          shellRef.current.style.left = `${x}px`;
          shellRef.current.style.top = `${y}px`;
          shellRef.current.style.removeProperty('transform');
        }
        onUpdate(win.id, {
          x,
          y,
        });
      }
      dragRef.current = null;
      setIsDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    const onCancel = () => {
      shellRef.current?.style.removeProperty('transform');
      dragRef.current = null;
      setIsDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onCancel);
  }, [win.id, win.x, win.y, onFocus, onUpdate]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFocus(win.id);
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      winW: win.width,
      winH: win.height,
    };
    setIsResizing(true);

    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current || !shellRef.current) return;
      const dx = ev.clientX - resizeRef.current.startX;
      const dy = ev.clientY - resizeRef.current.startY;
      shellRef.current.style.width = `${Math.max(300, resizeRef.current.winW + dx)}px`;
      shellRef.current.style.height = `${Math.max(250, resizeRef.current.winH + dy)}px`;
    };

    const onUp = (ev: MouseEvent) => {
      if (resizeRef.current) {
        const dx = ev.clientX - resizeRef.current.startX;
        const dy = ev.clientY - resizeRef.current.startY;
        const width = Math.max(300, resizeRef.current.winW + dx);
        const height = Math.max(250, resizeRef.current.winH + dy);
        if (shellRef.current) {
          shellRef.current.style.width = `${width}px`;
          shellRef.current.style.height = `${height}px`;
        }
        onUpdate(win.id, { width, height });
      }
      resizeRef.current = null;
      setIsResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    const onCancel = () => {
      if (shellRef.current) {
        shellRef.current.style.width = `${win.width}px`;
        shellRef.current.style.height = `${win.height}px`;
      }
      resizeRef.current = null;
      setIsResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onCancel);
  }, [win.id, win.width, win.height, onFocus, onUpdate]);

  const handleMaximize = useCallback(() => {
    onFocus(win.id);
    onUpdate(win.id, {
      x: 24,
      y: 24,
      width: Math.max(360, window.innerWidth - 72),
      height: Math.max(300, window.innerHeight - 96),
    });
  }, [win.id, onFocus, onUpdate]);

  if (win.minimized) return null;

  return (
    <div
      ref={shellRef}
      data-floating-window
      onMouseDown={() => onFocus(win.id)}
      className="absolute flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
      style={{
        left: win.x,
        top: win.y,
        width: win.width,
        height: win.height,
        zIndex: win.zIndex,
        userSelect: isDragging || isResizing ? 'none' : 'auto',
        transition: isDragging || isResizing ? 'none' : 'box-shadow 0.2s ease',
      }}
    >
      <div
        onMouseDown={handleDragStart}
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-border bg-card px-3"
      >
        {titleIcon && (
          <span className="flex shrink-0 items-center text-muted-foreground">
            {titleIcon}
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {breadcrumb && (
            <>
              <span className="truncate text-xs text-muted-foreground">{breadcrumb}</span>
              <span className="text-xs text-muted-foreground">{'>'}</span>
            </>
          )}
          <span className="truncate text-xs font-medium">{win.title}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onMinimize(win.id)}
            aria-label="Minimize"
          >
            <Minus />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Window actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={!onShare}
                  onSelect={() => onShare?.()}
                >
                  <Share2 />
                  Share
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Copy />
                  Duplicate
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={handleMaximize}>
                  <Maximize2 />
                  Maximize
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onClose(win.id)}
                >
                  <Trash2 />
                  Close window
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleMaximize}
            aria-label="Maximize"
          >
            <Maximize2 />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onClose(win.id)}
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {children}
      </div>

      <div
        onMouseDown={handleResizeStart}
        className="absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize text-muted-foreground"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className="absolute right-1 bottom-1 opacity-30"
        >
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="9" y1="4" x2="4" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="9" y1="7" x2="7" y2="9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
