import React, { useState } from 'react';
import { InlineRename } from '@/components/common/InlineRename';
import { Building2, Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

/**
 * The Slack-shaped workspace switcher: a vertical strip pinned to the far left,
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
 * Cmd/Ctrl+1…9, the obvious Slack choice, already belongs to the huddle agent
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
}

export const WorkspaceRail = React.memo(function WorkspaceRail({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onRenameWorkspace,
  onCreateWorkspace,
  onOpenTenants,
  titlebarInset = 0,
  width = WORKSPACE_RAIL_COLLAPSED_WIDTH,
  onWidthChange,
  resizable = true,
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

  const renderRow = (tile: WorkspaceRailTile) => (
    <WorkspaceRow
      key={tile.id}
      tile={tile}
      expanded={expanded}
      tabbable={tile.id === tabbableId}
      onSelect={onSelectWorkspace}
      registerRef={registerTile}
      onRename={onRenameWorkspace}
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
      className="relative flex h-full shrink-0 flex-col gap-1.5 overflow-hidden border-r border-border bg-card/85 py-2 text-card-foreground"
      style={{ ...RAIL_WIDTH_STYLE, paddingTop: titlebarInset ? titlebarInset + 8 : undefined }}
      onKeyDown={handleKeyDown}
    >
      {/* Theme-accent wash, matching the sidebar it sits beside. Decorative,
          non-interactive, out of flow — not a flex item. */}
      <div aria-hidden="true" className="sidebar-accent-wash" />

      {/* Tiles AND "+" scroll together: "+" is the last row of the list rather
          than a pinned footer, so it sits directly under the last workspace.
          Tenants stays pinned below — it is an admin surface, not a workspace,
          and does not belong in the list it would otherwise appear to join. */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {model.tiles.map(renderRow)}

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
            {model.systemTiles.map(renderRow)}
          </>
        )}

        {/* "+" is the last row OF THE LIST, not a pinned footer: it reads as
            "add one more of these" directly under the last workspace, which is
            what it does. It therefore scrolls with the tiles — on an account
            with enough workspaces to overflow, reaching it means scrolling to
            the end of the list. That is the accepted trade for having it sit
            with the things it creates rather than floating below them. */}
        <div className="w-full shrink-0 px-2 pt-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-workspace-rail-create
                onClick={onCreateWorkspace}
                aria-label="Create workspace"
                className={cn(
                  // Same literal radius as a tile — see WorkspaceRow — so the
                  // "add one of these" button is the same shape as the things it adds.
                  'flex h-9 items-center rounded-[11px] border border-dashed border-border text-muted-foreground transition-colors',
                  'hover:border-foreground/40 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  expanded ? 'w-full gap-2 px-2.5' : 'mx-auto w-9 justify-center',
                )}
              >
                <Plus className="size-4 shrink-0" />
                {expanded && <span className="truncate text-[13px]">New workspace</span>}
              </button>
            </TooltipTrigger>
            {/* Redundant once the button says what it does. */}
            {!expanded && <TooltipContent side="right">Create workspace</TooltipContent>}
          </Tooltip>
        </div>
      </div>

      {/* Tenants — the owner-only admin surface, above "+". Rendering is gated
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
                {expanded && <span className="truncate text-[13px]">Tenants</span>}
              </button>
            </TooltipTrigger>
            {!expanded && <TooltipContent side="right">Tenants</TooltipContent>}
          </Tooltip>
        </div>
      )}

      {resizable && (
        <div
          data-workspace-rail-nested
          data-workspace-rail-resizer
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize workspace rail"
          aria-valuenow={clampWorkspaceRailWidth(width)}
          aria-valuemin={WORKSPACE_RAIL_COLLAPSED_WIDTH}
          aria-valuemax={WORKSPACE_RAIL_MAX_WIDTH}
          title={`Drag to resize · double-click to ${expanded ? 'collapse' : 'expand'}`}
          className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
}: {
  tile: WorkspaceRailTile;
  expanded: boolean;
  tabbable: boolean;
  onSelect: (workspaceId: string) => void;
  registerRef: (id: string, node: HTMLButtonElement | null) => void;
  onRename?: (workspaceId: string, name: string) => Promise<boolean> | boolean;
}) {
  const [renaming, setRenaming] = useState(false);
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
      {/* Bright left-edge marker, the way Slack signals the current workspace.
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
      {/* Rounded SQUARE, never a circle. Slack's tell: the active tile squares
          off further, the rest stay softer. Shape carries the state; the fill is
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
          'workspace-tile-swatch flex size-9 shrink-0 items-center justify-center border border-transparent text-[13px] font-semibold tracking-tight text-white transition-all duration-150',
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
            'min-w-0 flex-1 truncate text-[13px] tracking-tight',
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
          className="flex size-9 shrink-0 items-center justify-center rounded-[7px] text-[13px] font-semibold tracking-tight text-white"
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

  return (
    <div className={cn('flex w-full shrink-0 items-center px-2', !expanded && 'justify-center')}>
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
}
