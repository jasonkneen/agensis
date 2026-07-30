import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Users } from 'lucide-react';
import type { FloatingWindow, PresenceVisibilityMode } from '../../types';
import { windowLabel, type WorkspacePresenceUser } from '../../hooks/useWorkspacePresence';
import { CHROME_DEPTH } from '../../lib/chromeDepth';
import { cn } from '../../lib/utils';
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Separator } from '../ui/separator';

/**
 * The workspace presence roster — the panel behind the avatar pill in the
 * sidebar's bottom bar.
 *
 * ## What this replaced, and why
 *
 * It was a settings form wearing a list's clothes. Every participant rendered
 * as four-plus lines: a name, then a wrapped stack of pill chips carrying
 * whatever `activityItems` happened to hold ("Connected daemon",
 * "Host: example-host.local", "Folder: /Users/alex/Docu…"), then a row of
 * message/favourite/View buttons, then a second row of Visible/Dim/Muted
 * buttons. Six controls per participant, all at equal visual weight, none
 * primary — and three agents were enough to make a 384px panel scroll.
 *
 * The chips were the tell. `activityItems` was one `string[]` carrying two
 * unrelated things (see the type in `useWorkspacePresence`), so the panel could
 * not distinguish "reading the roadmap doc" from "runs on example-host" and
 * rendered both as chips. A truncated absolute path is not information; it is
 * noise that costs a line. That is fixed at the source — the hook now hands
 * over structured `host`/`cwd` — and this file answers the three questions a
 * person actually opens a roster to ask:
 *
 *   who is here → one row, one avatar, one name
 *   are they live → the status dot on that avatar
 *   how do I reach them → exactly one primary button per row
 *
 * Everything else — host, folder, favourites, the visibility mode, their open
 * windows — is behind the row's `⋯` disclosure. It is all still one click away;
 * none of it is in the way any more.
 *
 * ## Structural notes
 *
 * - **Radix `Popover`, not a hand-rolled portal.** The previous panel measured
 *   the trigger and portalled itself to `document.body`, which meant it carried
 *   no `[data-slot="popover-content"]` and so missed neo's opaque-surface rule —
 *   it rendered transparent over the sidebar until `22d568e` patched it by
 *   listing `.agensis-glass-panel` as well. The shared primitive is caught by
 *   both rules by construction, and there is no longer a second copy of
 *   collision/anchor/outside-click logic to keep correct.
 * - **Surface colours come from tokens** (`bg-popover`, `border`, `muted`,
 *   `accent`) so `neo-surfaces`' contrast work applies here without an edit.
 * - **No emoji anywhere.** Agent identity is initials on the agent-avatar
 *   palette colour the hook already assigns.
 */

const MODE_OPTIONS: Array<{ value: PresenceVisibilityMode; label: string }> = [
  { value: 'visible', label: 'Visible' },
  { value: 'dimmed', label: 'Dimmed' },
  { value: 'hidden', label: 'Muted' },
];

/** How long the panel stays open after the pointer leaves it. */
const HOVER_CLOSE_MS = 220;

/** Rows above this and the list scrolls; below it, the panel sizes to content. */
const MAX_LIST_HEIGHT = 'max-h-[min(60vh,22rem)]';

/**
 * Two letters on a solid colour — the house identity pattern, for humans and
 * agents alike. Agents used to get a generic bot glyph here, which made every
 * agent in the list look like every other agent.
 */
function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** The one-line answer to "what are they doing", per participant kind. */
function secondaryLine(person: WorkspacePresenceUser): string {
  if (person.kind === 'agent') {
    return person.status === 'busy' ? 'Running a job' : 'Connected';
  }
  if (person.isCurrentUser) return 'Your workspace view';
  const items = person.activityItems ?? [];
  if (items.length === 0) return 'In the workspace';
  return items.length > 1 ? `${items[0]} +${items.length - 1}` : items[0];
}

function statusDotClass(person: WorkspacePresenceUser): string {
  if (person.kind === 'agent' && person.status === 'busy') return 'bg-amber-500 animate-pulse';
  return 'bg-emerald-500';
}

function statusLabel(person: WorkspacePresenceUser): string {
  if (person.kind === 'agent') return person.status === 'busy' ? 'Busy' : 'Online';
  return 'Online';
}

function modeClass(mode: PresenceVisibilityMode): string {
  if (mode === 'dimmed') return 'opacity-45 saturate-50';
  if (mode === 'hidden') return 'opacity-25 saturate-0';
  return '';
}

interface PresenceRosterProps {
  users: WorkspacePresenceUser[];
  getMode: (id?: string | null) => PresenceVisibilityMode;
  onModeChange: (id: string, mode: PresenceVisibilityMode) => void;
  favoriteIds: string[];
  focusedUserId: string | null;
  onToggleFavorite: (id: string) => void;
  onFocusUser: (id: string | null) => void;
  onOpenRemoteWindow: (win: FloatingWindow) => void;
  onCopyInviteLink?: () => Promise<string | null>;
  onMessageAgent?: (person: WorkspacePresenceUser) => void;
}

export function PresenceRoster({
  users,
  getMode,
  onModeChange,
  favoriteIds,
  focusedUserId,
  onToggleFavorite,
  onFocusUser,
  onOpenRemoteWindow,
  onCopyInviteLink,
  onMessageAgent,
}: PresenceRosterProps) {
  const [open, setOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const hoverCloseTimer = useRef<number | null>(null);
  // A row's `⋯` menu portals to the body, so it is OUTSIDE this popover in the
  // DOM: moving the pointer onto it fires the popover's `mouseleave`, and
  // clicking an item in it is an interact-outside. Left alone, both close the
  // panel — and the menu with it, since it unmounts alongside — which makes the
  // disclosure the metadata now lives behind impossible to actually use. A ref
  // rather than state because the deferred close reads it from a timer.
  const menuOpenRef = useRef(false);

  // Hover-to-open is the behaviour this pill has always had; Radix only gives
  // us click. The close is deferred so the diagonal trip from the pill to the
  // panel doesn't dismiss it mid-move.
  const openOnHover = useCallback(() => {
    if (hoverCloseTimer.current) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
    setOpen(true);
  }, []);
  const closeOnHover = useCallback(() => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = window.setTimeout(() => {
      if (menuOpenRef.current) return;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  }, []);
  const handleMenuOpenChange = useCallback((menuOpen: boolean) => {
    menuOpenRef.current = menuOpen;
    if (menuOpen && hoverCloseTimer.current) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }, []);
  useEffect(() => () => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
  }, []);

  if (users.length === 0) return null;

  const visibleUsers = users.slice(0, 5);
  const overflow = users.length - visibleUsers.length;
  const favorites = users.filter(user => favoriteIds.includes(user.id));
  const focused = users.find(user => user.id === focusedUserId);
  const chipUsers = focused && !favorites.find(user => user.id === focused.id) ? [focused, ...favorites] : favorites;
  const showFocusControls = chipUsers.length > 0 || Boolean(focusedUserId);

  return (
    <div data-presence-panel className="relative flex flex-col items-end gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <div
          className="presence-top-row order-1 group/presence-row flex items-center gap-1 rounded-full border bg-popover/90 p-1 shadow-md backdrop-blur"
          onMouseEnter={openOnHover}
          onMouseLeave={closeOnHover}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="presence-avatar-trigger flex items-center rounded-full p-0.5 text-left transition-colors hover:bg-muted/60"
              aria-label={`${users.length} shared participants`}
              title={`${users.length} shared participants`}
            >
              <AvatarGroup className="presence-avatar-group">
                {visibleUsers.map(person => (
                  <Avatar
                    key={person.id}
                    size="sm"
                    title={`${person.name}${person.isCurrentUser ? ' (you)' : ''}`}
                    className={cn(modeClass(getMode(person.id)))}
                  >
                    <AvatarFallback
                      className="text-[10px] font-bold text-white"
                      style={{ backgroundColor: person.color }}
                    >
                      {initials(person.name)}
                    </AvatarFallback>
                    <AvatarBadge className={statusDotClass(person)} />
                  </Avatar>
                ))}
                {overflow > 0 && (
                  <AvatarGroupCount title={`${overflow} more users`} className="presence-avatar-overflow size-6 text-[10px]">
                    +{overflow}
                  </AvatarGroupCount>
                )}
              </AvatarGroup>
            </button>
          </PopoverTrigger>
          {showFocusControls && (
            <>
              <div className="mx-1 h-6 w-px bg-border" aria-hidden />
              <Button
                type="button"
                variant={focusedUserId ? 'outline' : 'default'}
                size="sm"
                className="h-8 rounded-md px-3 text-xs"
                onClick={() => onFocusUser(null)}
              >
                All
              </Button>
              {chipUsers.map(person => (
                <Button
                  key={person.id}
                  type="button"
                  variant={focusedUserId === person.id ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 max-w-40 rounded-md px-2 text-xs"
                  onClick={() => onFocusUser(focusedUserId === person.id ? null : person.id)}
                  onDoubleClick={() => onToggleFavorite(person.id)}
                  title="Double-click to remove from favorites"
                >
                  <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: person.color }} />
                  <span className="truncate">{person.name}</span>
                </Button>
              ))}
            </>
          )}
        </div>

        <PopoverContent
          data-presence-popover
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          // Hover-opening must not steal focus from whatever the user was
          // typing in — the pointer merely passed over a pill.
          onOpenAutoFocus={event => event.preventDefault()}
          // See `menuOpenRef`: a click inside a row's portaled `⋯` menu is not
          // a click outside this panel, whatever the DOM tree says.
          onInteractOutside={event => {
            const target = event.target as Element | null;
            if (target?.closest?.('[data-slot="dropdown-menu-content"]')) event.preventDefault();
          }}
          onMouseEnter={openOnHover}
          onMouseLeave={closeOnHover}
          // `.agensis-glass-panel` is redundant with the `[data-slot=
          // "popover-content"]` rule neo already carries, and that is the
          // point: whichever of the two a future theme edit touches, this
          // panel is inside it. It is what the panel was missing before.
          className="agensis-glass-panel w-80 gap-0 p-0"
          style={{ zIndex: CHROME_DEPTH.presencePanel }}
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <div className="text-sm font-medium">In this workspace</div>
            <Badge variant="secondary">{users.length}</Badge>
          </div>
          <Separator />
          <div className={cn('overflow-y-auto py-1', MAX_LIST_HEIGHT)}>
            {users.map(person => (
              <PresenceRow
                key={person.id}
                person={person}
                mode={getMode(person.id)}
                isFavorite={favoriteIds.includes(person.id)}
                isFocused={focusedUserId === person.id}
                onModeChange={onModeChange}
                onToggleFavorite={onToggleFavorite}
                onFocusUser={onFocusUser}
                onOpenRemoteWindow={onOpenRemoteWindow}
                onMessageAgent={onMessageAgent}
                onMenuOpenChange={handleMenuOpenChange}
              />
            ))}
          </div>
          {onCopyInviteLink && (
            <>
              <Separator />
              <div className="p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground hover:text-foreground"
                  onClick={async () => {
                    const url = await onCopyInviteLink();
                    if (url) {
                      setInviteCopied(true);
                      window.setTimeout(() => setInviteCopied(false), 1600);
                    }
                  }}
                >
                  <Users data-icon="inline-start" className="size-3.5" />
                  {inviteCopied ? 'Invite link copied' : 'Copy invite link'}
                </Button>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * One participant. Two text lines and at most two controls — a primary and a
 * disclosure — against the old four-plus lines and six equal-weight buttons.
 */
function PresenceRow({
  person,
  mode,
  isFavorite,
  isFocused,
  onModeChange,
  onToggleFavorite,
  onFocusUser,
  onOpenRemoteWindow,
  onMessageAgent,
  onMenuOpenChange,
}: {
  person: WorkspacePresenceUser;
  mode: PresenceVisibilityMode;
  isFavorite: boolean;
  isFocused: boolean;
  onModeChange: (id: string, mode: PresenceVisibilityMode) => void;
  onToggleFavorite: (id: string) => void;
  onFocusUser: (id: string | null) => void;
  onOpenRemoteWindow: (win: FloatingWindow) => void;
  onMessageAgent?: (person: WorkspacePresenceUser) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const isAgent = person.kind === 'agent';
  const windows = person.windows ?? [];
  // The mode is only ever named on the row when it is NOT the default. A row
  // that says "Visible" on every line teaches nothing; a row that says "Muted"
  // is the only one you were looking for.
  const modeNote = mode === 'dimmed' ? 'Dimmed' : mode === 'hidden' ? 'Muted' : null;

  return (
    <div
      data-presence-row
      className={cn(
        'flex items-center gap-2.5 px-3 py-1.5',
        isFocused ? 'bg-accent/40' : 'hover:bg-muted/50',
      )}
    >
      <Avatar className={cn('size-8', modeClass(mode))}>
        <AvatarFallback className="text-[11px] font-bold text-white" style={{ backgroundColor: person.color }}>
          {initials(person.name)}
        </AvatarFallback>
        <AvatarBadge className={statusDotClass(person)} title={statusLabel(person)} />
      </Avatar>

      <div className="min-w-0 flex-1">
        {/* The name owns the whole first line. The handle used to sit beside it
            and won the space fight, so "Sandbox Agent" rendered as "Sandbo…"
            next to a perfectly legible "@sandbox". It reads better below. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium leading-tight" title={person.name}>{person.name}</span>
          {person.isCurrentUser && <span className="shrink-0 text-[11px] text-muted-foreground">You</span>}
        </div>
        <div className="flex min-w-0 items-baseline gap-1 text-[11px] leading-tight text-muted-foreground">
          {isAgent && person.handle && <span className="shrink-0">@{person.handle} ·</span>}
          <span className="truncate" title={secondaryLine(person)}>{secondaryLine(person)}</span>
          {/* Outside the truncating run: a state marker that itself truncates
              ("· Dim…") is worse than no marker at all. */}
          {modeNote && <span className="shrink-0 text-foreground/70">· {modeNote}</span>}
        </div>
      </div>

      {/* One primary action, and it differs by kind because "reach them" does:
          an agent has a DM thread, a human has a desktop you can follow. */}
      {isAgent && onMessageAgent ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => onMessageAgent(person)}
        >
          Message
        </Button>
      ) : !person.isCurrentUser ? (
        <Button
          type="button"
          variant={isFocused ? 'default' : 'outline'}
          size="xs"
          className="shrink-0"
          onClick={() => onFocusUser(isFocused ? null : person.id)}
        >
          {isFocused ? 'Viewing' : 'View'}
        </Button>
      ) : null}

      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            title={`More for ${person.name}`}
            aria-label={`More options for ${person.name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        {/* Opens sideways into the canvas rather than down over the roster —
            a disclosure that hides the list it belongs to is a poor trade.
            Radix flips it back if there is no room out there. */}
        <DropdownMenuContent side="right" align="start" sideOffset={6} collisionPadding={12} className="w-64">
          {/* Where the three chips went. A path is only useful if you can read
              all of it, so it wraps here instead of truncating on the row. */}
          {isAgent && (person.host || person.cwd) && (
            <>
              <DropdownMenuLabel className="font-normal">
                <div className="text-[11px] font-medium text-foreground">{statusLabel(person)} daemon</div>
                {person.host && (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Host <span className="font-mono text-foreground/80">{person.host}</span>
                  </div>
                )}
                {person.cwd && (
                  <div className="mt-1 break-all font-mono text-[11px] leading-snug text-muted-foreground">
                    {person.cwd}
                  </div>
                )}
              </DropdownMenuLabel>
              {person.cwd && (
                <DropdownMenuItem onSelect={() => navigator.clipboard?.writeText(person.cwd || '')}>
                  Copy folder path
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuItem onSelect={() => onToggleFavorite(person.id)}>
            {isFavorite ? 'Remove from favourites' : 'Add to favourites'}
          </DropdownMenuItem>

          {!person.isCurrentUser && (
            <>
              <DropdownMenuSeparator />
              {/* One control with a state, rather than three buttons of equal
                  weight sitting on the row. */}
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Their activity on your canvas
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={mode}
                onValueChange={value => onModeChange(person.id, value as PresenceVisibilityMode)}
              >
                {MODE_OPTIONS.map(option => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}

          {!person.isCurrentUser && windows.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {/* The header used to explain this in two lines of prose above
                  the whole list. It only ever described these items, so it
                  lives with them now. */}
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Open a local copy — yours, not theirs
              </DropdownMenuLabel>
              {windows.slice(0, 6).map(win => (
                <DropdownMenuItem
                  key={win.id}
                  onSelect={() => onOpenRemoteWindow(win)}
                  className="truncate"
                >
                  {windowLabel(win)}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
