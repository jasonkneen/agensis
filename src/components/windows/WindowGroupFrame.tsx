import { Minus, MoreHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { FloatingWindow } from '../../types';
import { GROUP_FRAME_PADDING, GROUP_HEADER_HEIGHT, type GroupBounds } from '../../lib/windowGroups';

interface WindowGroupFrameProps {
  groupId: string;
  bounds: GroupBounds;
  members: FloatingWindow[];
  /** Lowest zIndex among members — the frame sits directly beneath them. */
  baseZIndex: number;
  onMinimizeGroup: (groupId: string) => void;
  onUngroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onFocusGroup: (groupId: string, leadId: string) => void;
}

/**
 * The visible container for a tiled window group.
 *
 * A group used to be N separate cards that happened to touch, separated by a
 * transparent gutter — so the gap showed the wallpaper (and whatever window was
 * behind), which read as a rendering fault rather than a seam, and nothing tied
 * the panes together. This draws the group as ONE window: a bordered, opaque
 * surface with a single title bar that owns the controls, with the panes sitting
 * inside it. The gap between panes is now this element's own background.
 *
 * It is painted BEHIND its members (baseZIndex - 1) and is pointer-transparent
 * except for its header, so it never intercepts clicks meant for a pane.
 */
export function WindowGroupFrame({
  groupId,
  bounds,
  members,
  baseZIndex,
  onMinimizeGroup,
  onUngroup,
  onCloseGroup,
  onFocusGroup,
}: WindowGroupFrameProps) {
  // Members arrive in arbitrary order; label them the way they read on screen.
  const ordered = [...members].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lead = ordered[0];
  const label = ordered.map(w => w.title).join(' · ');

  return (
    <div
      data-window-group-frame={groupId}
      className="pointer-events-none absolute flex flex-col overflow-hidden rounded-xl border border-border bg-card/80 shadow-none backdrop-blur-xl"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zIndex: Math.max(0, baseZIndex - 1),
        padding: GROUP_FRAME_PADDING,
      }}
      onPointerDown={() => lead && onFocusGroup(groupId, lead.id)}
    >
      <div
        data-window-group-header
        className={cn(
          'pointer-events-auto flex shrink-0 flex-nowrap items-center gap-2 px-2',
          'text-xs text-muted-foreground',
        )}
        style={{ height: GROUP_HEADER_HEIGHT - GROUP_FRAME_PADDING }}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={label}>
          {label}
        </span>

        <div className="flex shrink-0 flex-nowrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon-xs" aria-label="Group actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onSelect={() => onUngroup(groupId)}>
                Ungroup windows
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onCloseGroup(groupId)}>
                Close all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => onMinimizeGroup(groupId)}
            aria-label="Minimize group"
          >
            <Minus />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => onCloseGroup(groupId)}
            aria-label="Close group"
          >
            <X />
          </Button>
        </div>
      </div>
    </div>
  );
}
