import React, { useState } from 'react';
import { InlineRename } from '@/components/common/InlineRename';
import { ArrowDown, ArrowUp, Building2, EyeOff, Pencil, Plus, RotateCcw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@agensis/ui/components/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@agensis/ui/components/context-menu';
import { cn } from '@/lib/utils';
import {
  buildWorkspaceRail,
  clampWorkspaceRailWidth,
  isWorkspaceRailExpanded,
  nudgeWorkspaceRailWidth,
  toggleWorkspaceRailWidth,
  workspaceRailFocusOrder,
  workspaceRailKeyTarget,
  WORKSPACE_RAIL_COLLAPSED_WIDTH,
  WORKSPACE_RAIL_MAX_WIDTH,
  type WorkspaceRailSource,
  type WorkspaceRailTile,
} from '../../lib/workspaceRail';
import { ResizeHandle } from '@/components/common/ResizeHandle';

/**
 * The workspace switcher: a vertical strip pinned to the far left,
 * outside the sidebar, one rounded-square tile per workspace.
 *
 * It is RESIZABLE. Collapsed it is the icon strip it has always been; dragged
 * wider each tile gains its workspace's name. It stays a FLAT LIST of
 * workspaces — one row per project, nothing nested underneath.
 *
 * Desktops deliberately do NOT hang off these rows. A workspace is a project
 * (its own agents, channels, documents); a desktop is a saved view *of* the
 * workspace you are already in — window positions, wallpaper, applets — and
 * switching desktop changes none of that content. Indenting views under
 * projects in one tree says they are the same kind of thing one level apart,
 * which is the hierarchy users would then reason from and be wrong. A desktop
 * switcher belongs in the workspace's own chrome, next to the desktop name the
 * sidebar header already shows.
 *
 * All of the "what does this tile say / where does it sit / how wide may the
 * rail be" logic lives in `src/lib/workspaceRail.ts` and is unit-tested there.
 * This file is the painter.
 *
 * Keyboard: the tiles are a single tab stop with a roving tabindex (arrows move
 * between tiles, Enter/Space switches). The resize handle is its own tab stop
 * and owns its arrow keys. The rail deliberately binds **no global chord**:
 * Cmd/Ctrl+1…9, the obvious chord for a numbered switcher, already belongs to the huddle agent
 * switcher (`src/lib/huddleAgents.ts`), and two features fighting over one
 * binding is worse than one feature having none.
 *
 * Width is carried by a CSS custom property rather than a React style value.
 * A drag can then move the rail every frame without re-rendering App (whose
 * `leadingInset` this feeds), and — the part that actually matters — a React
 * render landing mid-drag cannot clobber the width the pointer is holding.
 */

/** How far one arrow key moves the resize handle. */
const RESIZE_KEY_STEP = 24;

const RAIL_WIDTH_STYLE: React.CSSProperties = {
  width: `var(--workspace-rail-width, ${WORKSPACE_RAIL_COLLAPSED_WIDTH}px)`,
};

interface WorkspaceRailProps {
  workspaces: readonly WorkspaceRailSource[];
  activeWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  /** Omit to make the rail read-only. Resolves false when the write is rejected. */
  onRenameWorkspace?: (workspaceId: string, name: string) => Promise<boolean> | boolean;
 onCreateWorkspace: () => void;
 /** True while the workspace list/repair is settling. */
 loading?: boolean;
 /** A recoverable load error shown instead of an empty-looking rail. */
 loadError?: string | null;
 onRetry?: () => void;
  /** Omitted for everyone but the system owner — the server decides, not us. */
  onOpenTenants?: () => void;
  /**
   * Desktop shell traffic-light band. The rail is now the leftmost chrome, so it
   * is what sits under the macOS window buttons and it takes the clearance.
   */
  titlebarInset?: number;
  /**
   * Current rail width. Owned by App because the canvas viewport's left inset is
   * derived from it (Sidebar's `leadingInset`) — a width kept privately here
   * would put every floating window in the wrong place.
   */
  width?: number;
  /** Called once per drag, on release, with the clamped width to persist. */
  onWidthChange?: (width: number) => void;
  /** Phone: the rail rides inside the off-canvas drawer, where resizing is noise. */
  resizable?: boolean;
  /**
   * Reorder an ordinary workspace tile by one step. Omit to make the rail
   * unorderable. `up` moves it toward the top of the list.
   */
  onReorderWorkspace?: (workspaceId: string, direction: 'up' | 'down') => void;
  /**
   * Reorder by drag-and-drop: drop the dragged tile immediately before or after
   * the tile it landed on. Omit to disable dragging — the menu's Move up/down
   * still works. Ordinary tiles only; the System tile below the divider never
   * moves (a spatial switcher's triage destination stays put).
   */
  onReorderWorkspaceTo?: (draggedId: string, targetId: string, place: 'before' | 'after') => void;
  /**
   * Hide a workspace from THIS user's rail (a reversible view preference, not a
   * delete — the workspace and its content are untouched). Omit to hide the
   * action. Never offered for the active tile or the System workspace.
   */
  onHideWorkspace?: (workspaceId: string) => void;
  /**
   * Workspaces the user has hidden, surfaced in a "Hidden" menu so they can be
   * added back. Empty/omitted → no restore affordance is shown.
   */
  hiddenWorkspaces?: readonly WorkspaceRailSource[];
  /** Add a hidden workspace back to the rail. Required for the Hidden menu to act. */
  onRestoreWorkspace?: (workspaceId: string) => void;
}

export const WorkspaceRail = React.memo(function WorkspaceRail({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onRenameWorkspace,
 onCreateWorkspace,
 loading = false,
 loadError = null,
 onRetry,
  onOpenTenants,
  titlebarInset = 0,
  width = WORKSPACE_RAIL_COLLAPSED_WIDTH,
  onWidthChange,
  resizable = true,
  onReorderWorkspace,
  onReorderWorkspaceTo,
  onHideWorkspace,
  hiddenWorkspaces,
  onRestoreWorkspace,
}: WorkspaceRailProps) {
  const model = React.useMemo(
    () => buildWorkspaceRail(workspaces, activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );
  const focusOrder = React.useMemo(() => workspaceRailFocusOrder(model), [model]);
  const tileRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const navRef = React.useRef<HTMLElement | null>(null);

  // While the pointer is down the rail's width is the DOM's, not React's; see
  // the file header. `dragExpanded` is the one thing a drag does re-render, and
  // only when the shape actually flips (setState bails on an equal boolean).
  const draggingRef = React.useRef(false);
  const frameRef = React.useRef<number | null>(null);
  const teardownRef = React.useRef<(() => void) | null>(null);
  const [dragExpanded, setDragExpanded] = React.useState<boolean | null>(null);
  const expanded = dragExpanded ?? isWorkspaceRailExpanded(width);

  // Drag-and-drop reorder. The dragged id is carried in a ref (the drop handler
  // needs it synchronously and must not close over a stale render), while
  // `draggingId`/`dropTarget` drive the paint (the source tile dims, the target
  // shows a before/after insertion bar). Native HTML5 drag, so a plain
  // left-drag reorders and right-click still opens the tile's menu.
  const reorderable = Boolean(onReorderWorkspaceTo);
  const dragIdRef = React.useRef<string | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; place: 'before' | 'after' } | null>(null);

  const handleTileDragStart = React.useCallback((id: string) => {
    dragIdRef.current = id;
    setDraggingId(id);
    setDropTarget(null);
  }, []);
  const handleTileDragOver = React.useCallback((id: string, place: 'before' | 'after') => {
    if (!dragIdRef.current || dragIdRef.current === id) {
      setDropTarget(null);
      return;
    }
    setDropTarget(prev => (prev && prev.id === id && prev.place === place ? prev : { id, place }));
  }, []);
  const handleTileDrop = React.useCallback((id: string, place: 'before' | 'after') => {
    const dragged = dragIdRef.current;
    dragIdRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
    if (dragged && dragged !== id) onReorderWorkspaceTo?.(dragged, id, place);
  }, [onReorderWorkspaceTo]);
  const handleTileDragEnd = React.useCallback(() => {
    dragIdRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  const applyWidth = React.useCallback((next: number) => {
    navRef.current?.style.setProperty('--workspace-rail-width', `${next}px`);
  }, []);

  // Layout effect, not effect: the committed width must be on the element before
  // the first paint, or a rail the user left expanded flashes open from 52px.
  React.useLayoutEffect(() => {
    if (draggingRef.current) return;
    applyWidth(clampWorkspaceRailWidth(width));
  }, [applyWidth, width]);

  React.useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    teardownRef.current?.();
  }, []);

  const commitWidth = React.useCallback((next: number) => {
    applyWidth(next);
    setDragExpanded(null);
    onWidthChange?.(next);
  }, [applyWidth, onWidthChange]);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = clampWorkspaceRailWidth(width);
    let latest = startWidth;
    draggingRef.current = true;

    const handleMove = (moveEvent: PointerEvent) => {
      latest = clampWorkspaceRailWidth(startWidth + moveEvent.clientX - startX);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        applyWidth(latest);
        setDragExpanded(latest > WORKSPACE_RAIL_COLLAPSED_WIDTH);
      });
    };

    const handleUp = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      draggingRef.current = false;
      teardownRef.current = null;
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      commitWidth(latest);
    };

    teardownRef.current = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  }, [applyWidth, commitWidth, width]);

  const handleResizeKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    const current = clampWorkspaceRailWidth(width);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = nudgeWorkspaceRailWidth(current, RESIZE_KEY_STEP);
    else if (event.key === 'ArrowLeft') next = nudgeWorkspaceRailWidth(current, -RESIZE_KEY_STEP);
    else if (event.key === 'Home') next = WORKSPACE_RAIL_COLLAPSED_WIDTH;
    else if (event.key === 'End') next = WORKSPACE_RAIL_MAX_WIDTH;
    else if (event.key === 'Enter' || event.key === ' ') next = toggleWorkspaceRailWidth(current);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    commitWidth(clampWorkspaceRailWidth(next));
  }, [commitWidth, width]);

  const registerTile = React.useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) tileRefs.current.set(id, node);
    else tileRefs.current.delete(id);
  }, []);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    // The resize handle owns its own arrow keys — the roving tabindex must not
    // yank focus back to a tile while the handle is being driven.
    if (event.target instanceof Element && event.target.closest('[data-workspace-rail-nested]')) return;
    const currentIndex = focusOrder.findIndex(tile => tileRefs.current.get(tile.id) === document.activeElement);
    const target = workspaceRailKeyTarget(event.key, currentIndex, focusOrder.length);
    if (target === null) return;
    event.preventDefault();
    tileRefs.current.get(focusOrder[target].id)?.focus();
  }, [focusOrder]);

  // Roving tabindex: exactly one tile is reachable by Tab — the active one, so
  // tabbing into the rail lands where you already are rather than at the top.
  const tabbableId = model.activeId ?? focusOrder[0]?.id ?? null;
  const hasTiles = model.tiles.length > 0 || model.systemTiles.length > 0;
  const showLoading = loading && !hasTiles;
  const showError = !loading && !hasTiles && Boolean(loadError);

  // Reorder/hide are only meaningful for ordinary tiles: `position` carries the
  // row's place among them so the menu can grey out "Move up" on the first tile
  // and "Move down" on the last. System tiles pass null — they sit below the
  // divider and are neither reorderable nor hideable.
  const renderRow = (tile: WorkspaceRailTile, position: { index: number; total: number } | null) => (
    <WorkspaceRow
      key={tile.id}
      tile={tile}
      expanded={expanded}
      tabbable={tile.id === tabbableId}
      onSelect={onSelectWorkspace}
      registerRef={registerTile}
      onRename={onRenameWorkspace}
      position={tile.isSystem ? null : position}
      onReorder={tile.isSystem ? undefined : onReorderWorkspace}
      onHide={tile.isSystem ? undefined : onHideWorkspace}
      hiddenWorkspaces={hiddenWorkspaces}
      onRestore={onRestoreWorkspace}
      // System tiles never drag: they are partitioned below the divider and
      // reordering them would fight that partition.
      reorderable={tile.isSystem ? false : reorderable}
      isDragging={draggingId === tile.id}
      dropIndicator={dropTarget && dropTarget.id === tile.id ? dropTarget.place : null}
      onTileDragStart={handleTileDragStart}
      onTileDragOver={handleTileDragOver}
      onTileDrop={handleTileDrop}
      onTileDragEnd={handleTileDragEnd}
    />
  );

  // bg-card/85 is deliberately more opaque than the sidebar's bg-card/45: the
  // sidebar's own content hides the backdrop bleeding through it, and a
  // mostly-empty column at the same alpha reads as a hole punched in the chrome
  // rather than as part of it.
  //
  // Depth and elevation are NOT set here: `[data-workspace-rail]` in index.css
  // owns both, next to the `[data-sidebar-panel]` rule it has to be read
  // against. The rail is the top of the three shell columns and casts onto the
  // sidebar — see the ladder in src/lib/chromeDepth.ts. `relative` stays,
  // because the accent wash below is absolutely positioned against it.
  //
  // No horizontal padding: the active tile's left marker overhangs its button
  // by 6px into the 8px channel, and a padded scroll container would clip it
  // away with overflow-x-hidden. Each row carries the inset instead.
  return (
    <nav
      ref={navRef}
      data-workspace-rail
      data-expanded={expanded ? 'true' : undefined}
      aria-label="Workspaces"
      aria-busy={showLoading ? 'true' : undefined}
      className="relative flex h-full shrink-0 flex-col gap-1.5 overflow-hidden border-r border-border bg-card/85 py-2 text-card-foreground"
      style={{ ...RAIL_WIDTH_STYLE, paddingTop: titlebarInset ? titlebarInset + 8 : undefined }}
      onKeyDown={handleKeyDown}
    >
      {/* macOS runs this window with `titleBarStyle: 'hiddenInset'`, which
          removes the system title bar — so the window is draggable ONLY where
          the renderer says it is. `titlebarInset` above already reserves this
          band for the traffic lights; without a drag region in it there is
          nothing anywhere to grab and the window cannot be moved at all. Out of
          flow and behind the rows, so it covers no control. */}
      {titlebarInset ? (
        <div
          aria-hidden="true"
          data-titlebar-drag=""
          className="titlebar-drag-region absolute inset-x-0 top-0"
          style={{ height: titlebarInset }}
        />
      ) : null}

      {/* Theme-accent wash, matching the sidebar it sits beside. Decorative,
          non-interactive, out of flow — not a flex item. */}
      <div aria-hidden="true" className="sidebar-accent-wash" />

      {/* Only the workspace tiles scroll. "+" and Tenants are pinned to the
          bottom of the rail (below this container) so both are always reachable
          without scrolling to the end of a long list — the tiles overflow past
          them rather than pushing them off-screen. */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {showLoading ? (
          <div role="status" className="flex min-h-24 flex-col items-center justify-center gap-2 px-2 text-center text-xs text-muted-foreground">
            <span aria-hidden="true" className="size-9 animate-pulse rounded-lg bg-muted" />
            <span>Loading workspaces…</span>
          </div>
        ) : showError ? (
          <div role="status" className="flex min-h-24 flex-col items-center justify-center gap-2 px-2 text-center text-xs text-muted-foreground">
            <span>{loadError}</span>
            {onRetry && (
              <button
                type="button"
                className="rounded-md px-2 py-1 font-medium text-foreground underline underline-offset-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onRetry}
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <>
            {model.tiles.map((tile, index) => renderRow(tile, { index, total: model.tiles.length }))}

            {model.systemTiles.length > 0 && (
             <>
            {/* The System workspace is an ordinary workspace — same tile, same
                interactions — but it is a triage destination rather than a place
                you work, and it appears/disappears as membership changes. Below a
                divider it cannot shuffle the position of the workspaces you use
                every day, which is the whole point of a spatial switcher. */}
            <div
              aria-hidden="true"
              className={cn(
                'my-0.5 h-px shrink-0 bg-border',
                // Collapsed it is a stub under the tiles; expanded a stub
                // floating mid-column reads as a stray mark, so it spans the
                // row inset like every other row.
                expanded ? 'mx-2' : 'mx-auto w-6',
              )}
            />
              {model.systemTiles.map(tile => renderRow(tile, null))}
             </>
            )}
          </>
        )}

        {/* The restore list for hidden workspaces now lives in the right-click
            menu on any workspace tile (see WorkspaceRow) rather than as a
            standing button here — hiding is a right-click action, so unhiding
            belongs on the same menu instead of a permanent row in the rail. */}
      </div>

      {/* "+" — pinned to the bottom of the rail, next to Tenants, rather than
          scrolling as the last row of the tile list. On an account with enough
          workspaces to overflow it stays put and reachable instead of hiding
          below the fold. It still mirrors a WorkspaceRow (tile-shaped glyph then
          label) so it reads as "add one more of these". It is NOT a drop target
          for reordering — dragging a tile past the last one lands it at the end. */}
      <div className="w-full shrink-0 px-2 pt-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-workspace-rail-create
              onClick={onCreateWorkspace}
              disabled={loading}
              aria-label="Add new workspace"
              className={cn(
                'group relative flex h-9 shrink-0 items-center rounded-lg text-muted-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                expanded ? 'min-w-0 flex-1 gap-2 pr-2 text-left hover:bg-muted/40 hover:text-foreground' : 'mx-auto w-9 justify-center',
              )}
            >
              {/* The "+" sits in the same 36px rounded square a workspace tile
                  uses (WorkspaceRow's swatch), dashed so it reads as an empty
                  slot to fill rather than an existing workspace's identity. */}
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-[11px] border border-dashed border-border transition-all duration-150 group-hover:rounded-[7px] group-hover:border-foreground/40"
              >
                <Plus className="size-4" />
              </span>
              {expanded && <span className="min-w-0 flex-1 truncate text-[0.8125rem] tracking-tight">Add new</span>}
            </button>
          </TooltipTrigger>
          {/* Redundant once the button says what it does. */}
          {!expanded && <TooltipContent side="right">Create workspace</TooltipContent>}
        </Tooltip>
      </div>

      {/* Tenants — the owner-only admin surface, pinned below "+" at the very
          bottom of the rail. Rendering is gated
          on the SERVER's answer (useTenantAccess), never on a client-side email
          comparison. Hiding it is cosmetic anyway: every /backend/tenants route
          re-checks, so a hidden button is a tidiness measure and the route is
          the actual control. */}
      {onOpenTenants && (
        <div className="w-full shrink-0 px-2 pb-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-workspace-rail-tenants
                onClick={onOpenTenants}
                aria-label="Tenants"
                className={cn(
                  'flex h-9 items-center rounded-[11px] border border-transparent text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  expanded ? 'w-full gap-2 px-2.5' : 'mx-auto w-9 justify-center',
                )}
              >
                <Building2 className="size-4 shrink-0" />
                {expanded && <span className="truncate text-[0.8125rem]">Tenants</span>}
              </button>
            </TooltipTrigger>
            {!expanded && <TooltipContent side="right">Tenants</TooltipContent>}
          </Tooltip>
        </div>
      )}

      {resizable && (
        <ResizeHandle
          orientation="vertical"
          data-workspace-rail-nested
          data-workspace-rail-resizer
          aria-label="Resize workspace rail"
          aria-valuenow={clampWorkspaceRailWidth(width)}
          aria-valuemin={WORKSPACE_RAIL_COLLAPSED_WIDTH}
          aria-valuemax={WORKSPACE_RAIL_MAX_WIDTH}
          title={`Drag to resize · double-click to ${expanded ? 'collapse' : 'expand'}`}
          className="inset-y-0 right-0 z-20 w-1.5"
          onPointerDown={handleResizeStart}
          onDoubleClick={() => commitWidth(toggleWorkspaceRailWidth(clampWorkspaceRailWidth(width)))}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </nav>
  );
});

function WorkspaceRow({
  tile,
  expanded,
  tabbable,
  onSelect,
  registerRef,
  onRename,
  position,
  onReorder,
  onHide,
  hiddenWorkspaces,
  onRestore,
  reorderable = false,
  isDragging = false,
  dropIndicator = null,
  onTileDragStart,
  onTileDragOver,
  onTileDrop,
  onTileDragEnd,
}: {
  tile: WorkspaceRailTile;
  expanded: boolean;
  tabbable: boolean;
  onSelect: (workspaceId: string) => void;
  registerRef: (id: string, node: HTMLButtonElement | null) => void;
  onRename?: (workspaceId: string, name: string) => Promise<boolean> | boolean;
  /** Place among the ORDINARY tiles; null for a system tile (no reorder/hide). */
  position?: { index: number; total: number } | null;
  onReorder?: (workspaceId: string, direction: 'up' | 'down') => void;
  onHide?: (workspaceId: string) => void;
  /** Rail-global hidden list, surfaced as a restore submenu on every tile's menu. */
  hiddenWorkspaces?: readonly WorkspaceRailSource[];
  onRestore?: (workspaceId: string) => void;
  /** True when this tile may be picked up and dropped to reorder. */
  reorderable?: boolean;
  /** True while THIS tile is the one being dragged (dims it). */
  isDragging?: boolean;
  /** Which edge of this tile the drop would land on, or null for no indicator. */
  dropIndicator?: 'before' | 'after' | null;
  onTileDragStart?: (id: string) => void;
  onTileDragOver?: (id: string, place: 'before' | 'after') => void;
  onTileDrop?: (id: string, place: 'before' | 'after') => void;
  onTileDragEnd?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  // The rail is a vertical list, so before/after is decided by the pointer's Y
  // against the row's midpoint. During an inline rename the row swaps to a text
  // field, so dragging is suppressed there (renaming is truthy on that branch).
  const dropPlaceFromEvent = (event: React.DragEvent): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };
  const dragProps = reorderable && !renaming
    ? {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        event.dataTransfer.effectAllowed = 'move';
        // Some browsers refuse a drag with no payload; the id is also our own
        // source of truth (carried in the rail's ref), so this is belt-and-braces.
        try { event.dataTransfer.setData('text/plain', tile.id); } catch { /* ignore */ }
        onTileDragStart?.(tile.id);
      },
      onDragOver: (event: React.DragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onTileDragOver?.(tile.id, dropPlaceFromEvent(event));
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        onTileDrop?.(tile.id, dropPlaceFromEvent(event));
      },
      onDragEnd: () => onTileDragEnd?.(),
    }
    : {};
  const button = (
    <button
      ref={node => registerRef(tile.id, node)}
      type="button"
      data-workspace-rail-tile={tile.id}
      data-active={tile.active ? 'true' : undefined}
      aria-current={tile.active ? 'true' : undefined}
      aria-label={tile.isSystem ? `${tile.name} workspace (system)` : `${tile.name} workspace`}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect(tile.id)}
      className={cn(
        'group relative flex h-9 shrink-0 items-center rounded-lg transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        expanded
          ? cn('min-w-0 flex-1 gap-2 pr-2 text-left', tile.active ? 'bg-muted/70' : 'hover:bg-muted/40')
          : 'w-9 justify-center',
      )}
    >
      {/* Bright left-edge marker for the workspace you are currently in.
          It lives in the 8px channel between the rail's left edge and the tile —
          pushed any further left it lands outside the rail and the scroll
          container clips it away. The button's left edge is the padding edge in
          both shapes, so the same offset works collapsed and expanded. */}
      {tile.active && (
        <span
          aria-hidden="true"
          className="absolute -left-1.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-foreground"
        />
      )}
      {/* Rounded SQUARE, never a circle. The active tile squares off further
          and the rest stay softer. Shape carries the state; the fill is
          the workspace's identity and stays constant so a tile is recognisable
          at a glance in a rail of a dozen. Inactive tiles are dimmed rather than
          recoloured, so "which one am I in" never competes with "which is which".
          The radii are literal pixels, not `rounded-xl`/`rounded-lg`: those
          resolve off the theme's --radius scale, which on a 36px tile lands at
          20px — 59% of the width, which is a circle in all but name, and it is
          what the rail has been painting. A tile must stay a square that has had
          its corners taken off, whatever a theme does to --radius. */}
      <span
        aria-hidden="true"
        className={cn(
          // The edge colour is NOT set here — see .workspace-tile-swatch in
          // src/index.css. It has to run the opposite way to the mode (darker in
          // light, lighter in dark) and stay visible against an arbitrary
          // identity fill, which is a relationship to a theme token, not a
          // literal. The transparent border stays so gaining one costs no shift.
          'workspace-tile-swatch flex size-9 shrink-0 items-center justify-center border border-transparent text-[0.8125rem] font-semibold tracking-tight text-white transition-all duration-150',
          tile.active
            ? 'rounded-[7px] shadow-sm'
            : 'rounded-[11px] opacity-60 group-hover:rounded-[7px] group-hover:opacity-100',
        )}
        style={{ backgroundColor: tile.color }}
      >
        {tile.glyph}
      </span>
      {expanded && !renaming && (
        <span
          // Double-click, not single: a single click on a rail tile SWITCHES
          // workspace, and a rename affordance that fights the primary action
          // of the control it lives on is a trap.
          onDoubleClick={onRename ? (event => { event.preventDefault(); event.stopPropagation(); setRenaming(true); }) : undefined}
          title={onRename ? 'Double-click to rename' : undefined}
          className={cn(
            'min-w-0 flex-1 truncate text-[0.8125rem] tracking-tight',
            tile.active ? 'font-medium text-foreground' : 'text-muted-foreground group-hover:text-foreground',
          )}
        >
          {tile.name}
        </span>
      )}
    </button>
  );

  if (expanded && renaming && onRename) {
    return (
      <div className="flex w-full shrink-0 items-center gap-2 px-2">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-[7px] text-[0.8125rem] font-semibold tracking-tight text-white"
          style={{ backgroundColor: tile.color }}
        >
          {tile.glyph}
        </span>
        <InlineRename
          value={tile.name}
          ariaLabel={`Rename ${tile.name}`}
          onCommit={name => onRename(tile.id, name)}
          onCancel={() => setRenaming(false)}
        />
      </div>
    );
  }

  const row = (
    <div
      className={cn(
        'relative flex w-full shrink-0 items-center px-2 transition-opacity',
        !expanded && 'justify-center',
        reorderable && !renaming && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
      {...dragProps}
    >
      {/* Insertion bar showing where a drop would land, on the pointer-nearest
          edge of this tile. Sits in the 1.5-unit row inset so it reads as a gap
          between tiles rather than a mark on one. */}
      {dropIndicator && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-1.5 h-0.5 rounded-full bg-primary',
            dropIndicator === 'before' ? '-top-0.5' : '-bottom-0.5',
          )}
        />
      )}
      {expanded ? button : (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right">
            {tile.name}
            {tile.isSystem ? ' · System' : ''}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );

  // Right-click menu. The move items stay VISIBLE-but-disabled at the ends of
  // the list rather than disappearing, so the menu keeps the same shape on
  // every tile and "why did that option move" never happens. "Remove from
  // sidebar" is disabled for the tile you are currently in — hiding your active
  // workspace would leave the rail marking a tile that is not there.
  const canMoveUp = Boolean(onReorder && position && position.index > 0);
  const canMoveDown = Boolean(onReorder && position && position.index < position.total - 1);
  const canHide = Boolean(onHide && !tile.active);
  const canRestore = Boolean(onRestore && hiddenWorkspaces && hiddenWorkspaces.length > 0);
  const hasMenu = Boolean(onRename || onReorder || onHide || canRestore);
  if (!hasMenu) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuLabel className="truncate">
          {tile.name}
          {tile.isSystem ? ' · System' : ''}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        {onRename && (
          <ContextMenuItem
            disabled={!expanded}
            onSelect={() => setRenaming(true)}
          >
            <Pencil data-icon="inline-start" />
            Rename{!expanded ? ' (widen rail)' : ''}
          </ContextMenuItem>
        )}
        {onReorder && (
          <>
            <ContextMenuItem disabled={!canMoveUp} onSelect={() => onReorder(tile.id, 'up')}>
              <ArrowUp data-icon="inline-start" />
              Move up
            </ContextMenuItem>
            <ContextMenuItem disabled={!canMoveDown} onSelect={() => onReorder(tile.id, 'down')}>
              <ArrowDown data-icon="inline-start" />
              Move down
            </ContextMenuItem>
          </>
        )}
        {onHide && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!canHide}
              onSelect={() => onHide(tile.id)}
            >
              <EyeOff data-icon="inline-start" />
              Remove from sidebar
            </ContextMenuItem>
          </>
        )}
        {/* The former "Hidden · N" rail button, moved here: a submenu of every
            workspace the user has hidden, each re-added to the sidebar on click.
            Rail-global, so it shows the same list on whichever tile is clicked. */}
        {canRestore && onRestore && hiddenWorkspaces && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <RotateCcw data-icon="inline-start" />
                Hidden workspaces · {hiddenWorkspaces.length}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-80 w-52 overflow-y-auto">
                <ContextMenuLabel>Add back to sidebar</ContextMenuLabel>
                {hiddenWorkspaces.map(workspace => (
                  <ContextMenuItem
                    key={workspace.id}
                    onSelect={() => onRestore(workspace.id)}
                  >
                    <RotateCcw data-icon="inline-start" />
                    {String(workspace.name ?? '').trim() || 'Untitled workspace'}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
