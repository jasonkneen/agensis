// The workspace switcher that replaced the workspace rail.
//
// The rail was a 52px column of letter tiles down the far left: space spent
// all day on a choice made a few times a day. Now:
// - the sidebar's title IS the switcher — the current workspace and desktop,
//   on an obvious button that opens one picker for both;
// - workspaces you PIN sit under Search: one to three as wide buttons, four or
//   more as a grid of rounded tiles, so the ones you live in stay one click away.
// Pins are per-browser (localStorage), like the rail's hide/order prefs were.

import React from 'react';
import { Check, ChevronsUpDown, Eye, LayoutGrid, Monitor, Pencil, Pin, PinOff, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@agensis/ui/components/popover';
import { cn } from '@/lib/utils';
import { buildWorkspaceRail, type WorkspaceRailSource, type WorkspaceRailTile } from '@/lib/workspaceRail';

const PINS_KEY = 'agensis_pinned_workspaces';
/** At this many pins the wide buttons become a grid of tiles. */
export const PIN_GRID_AT = 4;

function readPins(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function usePinnedWorkspaces() {
  const [pins, setPins] = React.useState<string[]>(readPins);
  const togglePin = React.useCallback((id: string) => {
    setPins(prev => {
      const next = prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id];
      try { localStorage.setItem(PINS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return { pins, togglePin };
}

export interface DesktopOption {
  id: string;
  name: string;
}

function Tile({ tile, className }: { tile: Pick<WorkspaceRailTile, 'glyph' | 'color'>; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('workspace-tile-swatch flex shrink-0 items-center justify-center rounded-[9px] font-semibold tracking-tight text-white', className)}
      style={{ backgroundColor: tile.color }}
    >
      {tile.glyph}
    </span>
  );
}

export interface WorkspaceSwitcherProps {
  workspaces: readonly WorkspaceRailSource[];
  hiddenWorkspaces?: readonly WorkspaceRailSource[];
  activeWorkspaceId: string | null | undefined;
  onSelectWorkspace: (id: string) => void;
  onRenameWorkspace?: (id: string, name: string) => void;
  onHideWorkspace?: (id: string) => void;
  onRestoreWorkspace?: (id: string) => void;
  onCreateWorkspace?: () => void;
  desktops: readonly DesktopOption[];
  activeDesktopId: string | null | undefined;
  onSelectDesktop?: (id: string) => void;
  onOpenDesktopGrid?: () => void;
  pins: readonly string[];
  onTogglePin: (id: string) => void;
}

/** The sidebar title: current workspace + desktop, opening the picker. */
export function WorkspaceSwitcher({
  workspaces,
  hiddenWorkspaces = [],
  activeWorkspaceId,
  onSelectWorkspace,
  onRenameWorkspace,
  onHideWorkspace,
  onRestoreWorkspace,
  onCreateWorkspace,
  desktops,
  activeDesktopId,
  onSelectDesktop,
  onOpenDesktopGrid,
  pins,
  onTogglePin,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const model = React.useMemo(() => buildWorkspaceRail(workspaces, activeWorkspaceId), [workspaces, activeWorkspaceId]);
  const all = [...model.tiles, ...model.systemTiles];
  const active = all.find(t => t.active);
  const activeDesktop = desktops.find(d => d.id === activeDesktopId);

  const close = () => { setOpen(false); setRenamingId(null); };

  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setRenamingId(null); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-workspace-switcher
          aria-label="Switch workspace or desktop"
          title={[active?.name, activeDesktop?.name].filter(Boolean).join(' · ')}
          className="workspace-switcher-trigger flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/70"
        >
          {active && <Tile tile={active} className="size-7 text-[0.6875rem]" />}
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">{active?.name ?? 'Workspace'}</span>
            {activeDesktop && <span className="truncate text-xs text-muted-foreground">{activeDesktop.name}</span>}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="workspace-switcher-panel w-72 p-2">
        <div className="ui-section-label px-1.5 pb-1.5">Workspaces</div>
        <div className="flex flex-col gap-1" role="listbox" aria-label="Workspaces">
          {all.map(tile => {
            const pinned = pins.includes(tile.id);
            if (renamingId === tile.id && onRenameWorkspace) {
              return (
                <form
                  key={tile.id}
                  className="flex items-center gap-2 rounded-lg px-1.5 py-1"
                  onSubmit={event => {
                    event.preventDefault();
                    const name = String(new FormData(event.currentTarget).get('name') || '').trim();
                    if (name && name !== tile.name) onRenameWorkspace(tile.id, name);
                    setRenamingId(null);
                  }}
                >
                  <Tile tile={tile} className="size-7 text-[0.6875rem]" />
                  <input
                    name="name"
                    defaultValue={tile.name}
                    autoFocus
                    aria-label={`Rename ${tile.name}`}
                    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setRenamingId(null); } }}
                    onBlur={event => event.currentTarget.form?.requestSubmit()}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </form>
              );
            }
            return (
              <div
                key={tile.id}
                data-switcher-option
                data-selected={tile.active ? 'true' : undefined}
                className={cn('group/ws flex items-center gap-1 rounded-lg pr-1 transition-colors', !tile.active && 'hover:bg-muted/60')}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={tile.active}
                  onClick={() => { onSelectWorkspace(tile.id); close(); }}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Tile tile={tile} className="size-7 text-[0.6875rem]" />
                  <span className="min-w-0 flex-1 truncate">{tile.name}</span>
                  {tile.active && <Check className="size-4 shrink-0" aria-hidden />}
                </button>
                {onRenameWorkspace && (
                  <button
                    type="button"
                    onClick={() => setRenamingId(tile.id)}
                    aria-label={`Rename ${tile.name}`}
                    title="Rename"
                    className="switcher-row-action rounded-md p-1 opacity-0 outline-none transition-opacity group-hover/ws:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
                {onHideWorkspace && !tile.active && !tile.isSystem && (
                  <button
                    type="button"
                    onClick={() => onHideWorkspace(tile.id)}
                    aria-label={`Hide ${tile.name}`}
                    title="Hide from this list"
                    className="switcher-row-action rounded-md p-1 opacity-0 outline-none transition-opacity group-hover/ws:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
                  >
                    <Eye className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onTogglePin(tile.id)}
                  aria-pressed={pinned}
                  aria-label={pinned ? `Unpin ${tile.name}` : `Pin ${tile.name} to the sidebar`}
                  title={pinned ? 'Unpin' : 'Pin to the sidebar'}
                  className={cn(
                    'switcher-pin rounded-md p-1 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring',
                    pinned ? 'opacity-100' : 'opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
                  )}
                >
                  {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                </button>
              </div>
            );
          })}
        </div>

        {hiddenWorkspaces.length > 0 && onRestoreWorkspace && (
          <details className="mt-1 px-1.5 text-xs text-muted-foreground">
            <summary className="cursor-pointer py-1">Hidden ({hiddenWorkspaces.length})</summary>
            <div className="flex flex-col gap-0.5 pb-1">
              {hiddenWorkspaces.map(ws => (
                <button key={ws.id} type="button" onClick={() => onRestoreWorkspace(ws.id)} className="truncate rounded-md px-1.5 py-1 text-left hover:bg-muted/60 hover:text-foreground">
                  Show {ws.name}
                </button>
              ))}
            </div>
          </details>
        )}

        {desktops.length > 0 && (
          <>
            <div className="ui-section-label mt-3 px-1.5 pb-1.5">Desktops</div>
            <div className="flex flex-col gap-1" role="listbox" aria-label="Desktops">
              {desktops.map(desktop => {
                const selected = desktop.id === activeDesktopId;
                return (
                  <button
                    key={desktop.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-switcher-option
                    data-selected={selected ? 'true' : undefined}
                    onClick={() => { onSelectDesktop?.(desktop.id); close(); }}
                    className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', !selected && 'hover:bg-muted/60')}
                  >
                    <Monitor className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{desktop.name}</span>
                    {selected && <Check className="size-4 shrink-0" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
          {onOpenDesktopGrid && (
            <button type="button" onClick={() => { onOpenDesktopGrid(); close(); }} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground">
              <LayoutGrid className="size-4" aria-hidden /> All desktops
            </button>
          )}
          {onCreateWorkspace && (
            <button type="button" onClick={() => { onCreateWorkspace(); close(); }} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground">
              <Plus className="size-4" aria-hidden /> New workspace
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Pinned workspaces under Search: wide buttons up to three, then a tile grid. */
export function PinnedWorkspaces({
  workspaces,
  activeWorkspaceId,
  pins,
  onSelectWorkspace,
}: {
  workspaces: readonly WorkspaceRailSource[];
  activeWorkspaceId: string | null | undefined;
  pins: readonly string[];
  onSelectWorkspace: (id: string) => void;
}) {
  const model = React.useMemo(() => buildWorkspaceRail(workspaces, activeWorkspaceId), [workspaces, activeWorkspaceId]);
  const byId = new Map([...model.tiles, ...model.systemTiles].map(t => [t.id, t]));
  const tiles = pins.map(id => byId.get(id)).filter((t): t is WorkspaceRailTile => Boolean(t));
  if (tiles.length === 0) return null;
  const grid = tiles.length >= PIN_GRID_AT;
  return (
    <div
      data-pinned-workspaces={grid ? 'grid' : 'wide'}
      role="group"
      aria-label="Pinned workspaces"
      className={cn('mx-2 mb-2', grid ? 'grid grid-cols-5 gap-1.5' : 'flex flex-col gap-1')}
    >
      {tiles.map(tile => (
        <button
          key={tile.id}
          type="button"
          data-pinned-workspace
          data-active={tile.active ? 'true' : undefined}
          aria-current={tile.active ? 'true' : undefined}
          aria-label={`${tile.name} workspace`}
          title={tile.name}
          onClick={() => onSelectWorkspace(tile.id)}
          className={cn(
            'flex min-w-0 items-center outline-none transition focus-visible:ring-2 focus-visible:ring-ring',
            grid
              ? 'aspect-square justify-center rounded-xl'
              : cn('gap-2 rounded-lg px-1.5 py-1 text-left text-sm font-medium', tile.active ? 'bg-muted/70' : 'hover:bg-muted/50'),
          )}
        >
          <Tile
            tile={tile}
            className={cn(grid ? 'size-full rounded-xl text-[0.8125rem]' : 'size-6 rounded-[7px] text-[0.625rem]', !tile.active && grid && 'opacity-70 hover:opacity-100')}
          />
          {!grid && <span className="min-w-0 flex-1 truncate">{tile.name}</span>}
        </button>
      ))}
    </div>
  );
}
