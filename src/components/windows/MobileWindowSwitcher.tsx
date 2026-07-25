import { Activity, Bot, Brain, Clock, FileText, ListTodo, Menu, MessageSquare, Sparkles, Users, X, type LucideIcon } from 'lucide-react';
import type { FloatingWindow, FloatingWindowType } from '../../types';
import { cn } from '@/lib/utils';

const TYPE_ICON: Record<FloatingWindowType, LucideIcon> = {
  chat: MessageSquare,
  document: FileText,
  memory: Brain,
  skills: Sparkles,
  tasks: ListTodo,
  activity: Activity,
  agents: Bot,
  users: Users,
  schedules: Clock,
};

interface MobileWindowSwitcherProps {
  windows: FloatingWindow[];
  activeWindowId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onOpenMenu: () => void;
}

// The phone workspace shows one full-screen window at a time; this bottom bar is
// how you move between the open ones (the free-floating canvas has no place on a
// 390px screen). The leading ☰ opens the sidebar drawer — it's the one piece of
// chrome that must stay reachable even when no windows are open, so the bar
// always renders on phones.
export function MobileWindowSwitcher({ windows, activeWindowId, onFocus, onClose, onOpenMenu }: MobileWindowSwitcherProps) {
  const open = windows.filter(win => !win.minimized);

  return (
    <div
      data-mobile-window-switcher
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-[11500] flex items-center gap-1.5 overflow-x-auto border-t border-border bg-card/85 px-2 py-1.5 backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' }}
    >
      <button
        type="button"
        onClick={onOpenMenu}
        className="control-outer-ring flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background/60 text-muted-foreground hover:text-foreground"
        aria-label="Open menu"
      >
        <Menu size={16} />
      </button>

      {open.map(win => {
        const Icon = TYPE_ICON[win.type] ?? MessageSquare;
        const isActive = win.id === activeWindowId;
        return (
          <div
            key={win.id}
            className={cn(
              'control-outer-ring group flex h-8 shrink-0 items-center gap-1.5 rounded-lg border pl-2 pr-1 text-xs transition-colors',
              isActive
                ? 'border-primary/70 bg-primary/15 text-foreground'
                : 'border-border bg-background/60 text-muted-foreground',
            )}
          >
            <button
              type="button"
              onClick={() => onFocus(win.id)}
              className="flex min-w-0 items-center gap-1.5"
              aria-label={`Switch to ${win.title}`}
              aria-current={isActive}
            >
              <Icon size={13} className="shrink-0" />
              <span className="max-w-28 truncate font-medium">{win.title}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(win.id)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground"
              aria-label={`Close ${win.title}`}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}

      {open.length === 0 && (
        <span className="px-1 text-xs text-muted-foreground">No open windows — tap ☰ to start</span>
      )}
    </div>
  );
}
