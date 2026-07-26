import React from 'react';
import { Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  buildWorkspaceRail,
  workspaceRailFocusOrder,
  workspaceRailKeyTarget,
  type WorkspaceRailSource,
  type WorkspaceRailTile,
} from '../../lib/workspaceRail';
import { WORKSPACE_RAIL_WIDTH } from '../../lib/workspaceLayout';

/**
 * The Slack-shaped workspace switcher: a narrow vertical strip of icons pinned
 * to the far left, outside the sidebar, one tile per workspace.
 *
 * All of the "what does this tile say / where does it sit / what does a key
 * press do" logic lives in `src/lib/workspaceRail.ts` and is unit-tested there.
 * This file is the painter.
 *
 * Keyboard: the rail is a single tab stop with a roving tabindex (arrows move
 * between tiles, Enter/Space switches). It deliberately binds **no global
 * chord** — Cmd/Ctrl+1…9, the obvious Slack choice, already belongs to the
 * huddle agent switcher (`src/lib/huddleAgents.ts`), and two features fighting
 * over one binding is worse than one feature having none.
 */

interface WorkspaceRailProps {
  workspaces: readonly WorkspaceRailSource[];
  activeWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  /**
   * Desktop shell traffic-light band. The rail is now the leftmost chrome, so it
   * is what sits under the macOS window buttons and it takes the clearance.
   */
  titlebarInset?: number;
}

export const WorkspaceRail = React.memo(function WorkspaceRail({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  titlebarInset = 0,
}: WorkspaceRailProps) {
  const model = React.useMemo(
    () => buildWorkspaceRail(workspaces, activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );
  const focusOrder = React.useMemo(() => workspaceRailFocusOrder(model), [model]);
  const tileRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());

  const registerTile = React.useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) tileRefs.current.set(id, node);
    else tileRefs.current.delete(id);
  }, []);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const currentIndex = focusOrder.findIndex(tile => tileRefs.current.get(tile.id) === document.activeElement);
    const target = workspaceRailKeyTarget(event.key, currentIndex, focusOrder.length);
    if (target === null) return;
    event.preventDefault();
    tileRefs.current.get(focusOrder[target].id)?.focus();
  }, [focusOrder]);

  // Roving tabindex: exactly one tile is reachable by Tab — the active one, so
  // tabbing into the rail lands where you already are rather than at the top.
  const tabbableId = model.activeId ?? focusOrder[0]?.id ?? null;

  const renderTile = (tile: WorkspaceRailTile) => (
    <WorkspaceTile
      key={tile.id}
      tile={tile}
      tabbable={tile.id === tabbableId}
      onSelect={onSelectWorkspace}
      registerRef={registerTile}
    />
  );

  // bg-card/85 is deliberately more opaque than the sidebar's bg-card/45: the
  // sidebar's own content hides the backdrop bleeding through it, and a
  // mostly-empty column at the same alpha reads as a hole punched in the chrome
  // rather than as part of it.
  return (
    <nav
      data-workspace-rail
      aria-label="Workspaces"
      className="relative z-10 flex h-full shrink-0 flex-col items-center gap-1.5 overflow-hidden border-r border-border bg-card/85 py-2 text-card-foreground"
      style={{ width: WORKSPACE_RAIL_WIDTH, paddingTop: titlebarInset ? titlebarInset + 8 : undefined }}
      onKeyDown={handleKeyDown}
    >
      {/* Theme-accent wash, matching the sidebar it sits beside. Decorative,
          non-interactive, out of flow — not a flex item. */}
      <div aria-hidden="true" className="sidebar-accent-wash" />

      {/* Tiles scroll; the create button below does not. Scrolling the whole
          rail would carry "+" off the bottom on an account with enough
          workspaces to need scrolling — exactly when you want it reachable. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {model.tiles.map(renderTile)}

        {model.systemTiles.length > 0 && (
          <>
            {/* The System workspace is an ordinary workspace — same tile, same
                interactions — but it is a triage destination rather than a place
                you work, and it appears/disappears as membership changes. Below a
                divider it cannot shuffle the position of the workspaces you use
                every day, which is the whole point of a spatial switcher. */}
            <div aria-hidden="true" className="my-0.5 h-px w-6 shrink-0 bg-border" />
            {model.systemTiles.map(renderTile)}
          </>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-workspace-rail-create
            onClick={onCreateWorkspace}
            aria-label="Create workspace"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Create workspace</TooltipContent>
      </Tooltip>
    </nav>
  );
});

function WorkspaceTile({
  tile,
  tabbable,
  onSelect,
  registerRef,
}: {
  tile: WorkspaceRailTile;
  tabbable: boolean;
  onSelect: (workspaceId: string) => void;
  registerRef: (id: string, node: HTMLButtonElement | null) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
            'relative flex size-9 shrink-0 items-center justify-center border transition-all duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            // Slack's tell: the active tile squares off and fills, the rest stay
            // rounded and quiet. Shape and weight carry it — no decorative hue.
            tile.active
              ? 'rounded-lg border-foreground/25 bg-background text-foreground shadow-sm'
              : 'rounded-xl border-transparent bg-muted/50 text-muted-foreground hover:rounded-lg hover:bg-muted hover:text-foreground',
            tile.fromIcon ? 'text-base leading-none' : 'text-[11px] font-semibold tracking-tight',
          )}
        >
          {/* Bright left-edge marker, the way Slack signals the current
              workspace. It lives in the 8px channel between the rail's left
              edge and the tile — pushed any further left it lands outside the
              rail and the scroll container clips it away. */}
          {tile.active && (
            <span
              aria-hidden="true"
              className="absolute -left-1.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-foreground"
            />
          )}
          <span aria-hidden="true">{tile.glyph}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {tile.name}
        {tile.isSystem ? ' · System' : ''}
      </TooltipContent>
    </Tooltip>
  );
}
