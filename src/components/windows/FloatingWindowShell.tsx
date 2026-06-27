import React, { useCallback, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Lock, Maximize2, Minus, MoreHorizontal, Share2, Trash2, Unlock, X } from 'lucide-react';
import type { FloatingWindow, PresenceVisibilityMode } from '../../types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface FloatingWindowShellProps {
  window: FloatingWindow;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
  onUpdate: (id: string, updates: Partial<FloatingWindow>) => void;
  onMinimize: (id: string) => void;
  onShare?: () => void;
  presenceMode?: PresenceVisibilityMode;
  currentUserId?: string;
  canControl?: boolean;
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
  presenceMode = 'visible',
  currentUserId,
  canControl = true,
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
    if (!canControl) return;
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
  }, [win.id, win.x, win.y, onFocus, onUpdate, canControl]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (!canControl) return;
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
  }, [win.id, win.width, win.height, onFocus, onUpdate, canControl]);

  const handleMaximize = useCallback(() => {
    if (!canControl) return;
    onFocus(win.id);
    onUpdate(win.id, {
      x: 24,
      y: 24,
      width: Math.max(360, window.innerWidth - 72),
      height: Math.max(300, window.innerHeight - 96),
    });
  }, [win.id, onFocus, onUpdate, canControl]);

  if (win.minimized) return null;

  const isDimmed = presenceMode === 'dimmed' || presenceMode === 'hidden';
  const dimmedOpacity = presenceMode === 'hidden' ? 0.22 : 0.35;
  const canTogglePrivacy = !win.ownerUserId || win.ownerUserId === currentUserId;
  const canToggleLock = !win.ownerUserId || win.ownerUserId === currentUserId;
  const privacyBlanked = Boolean(win.isPrivate && win.ownerUserId && win.ownerUserId !== currentUserId);

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
        opacity: isDimmed ? dimmedOpacity : 1,
        filter: isDimmed ? 'saturate(0.55)' : undefined,
        userSelect: isDragging || isResizing ? 'none' : 'auto',
        transition: isDragging || isResizing ? 'none' : 'box-shadow 0.2s ease',
      }}
    >
      <div
        onMouseDown={handleDragStart}
        className={cn(
          'flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3',
          canControl ? 'cursor-grab' : 'cursor-default',
        )}
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
            variant={win.isPrivate ? 'secondary' : 'ghost'}
            size="icon-xs"
            onClick={() => {
              if (canTogglePrivacy) onUpdate(win.id, { isPrivate: !win.isPrivate });
            }}
            disabled={!canTogglePrivacy}
            aria-label={win.isPrivate ? 'Window privacy on' : 'Window privacy off'}
            title={win.isPrivate ? 'Privacy on' : 'Privacy off'}
          >
            {win.isPrivate ? <EyeOff /> : <Eye />}
          </Button>

          <Button
            type="button"
            variant={win.locked ? 'secondary' : 'ghost'}
            size="icon-xs"
            onClick={() => {
              if (canToggleLock) onUpdate(win.id, { locked: !win.locked });
            }}
            disabled={!canToggleLock}
            aria-label={win.locked ? 'Window locked' : 'Window unlocked'}
            title={win.locked ? 'Locked for others' : 'Unlocked for collaborators'}
          >
            {win.locked ? <Lock /> : <Unlock />}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onMinimize(win.id)}
            disabled={!canControl}
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
                <DropdownMenuItem
                  disabled={!canControl}
                  onSelect={() => onUpdate(win.id, { shared: !win.shared })}
                >
                  <Share2 />
                  {win.shared ? 'Stop sharing this window' : 'Share this window'}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={!canControl} onSelect={handleMaximize}>
                  <Maximize2 />
                  Maximize
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!canControl}
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
            disabled={!canControl}
            aria-label="Maximize"
          >
            <Maximize2 />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onClose(win.id)}
            disabled={!canControl}
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
      </div>

      <div className={cn('relative min-h-0 flex-1 overflow-hidden', !canControl && 'pointer-events-none')}>
        {privacyBlanked ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-muted/40 p-6 text-center">
            <EyeOff className="size-6 text-muted-foreground" />
            <div className="text-sm font-medium">Private window</div>
            <div className="max-w-64 text-xs text-muted-foreground">
              This user has blanked the contents of this window.
            </div>
          </div>
        ) : children}
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
