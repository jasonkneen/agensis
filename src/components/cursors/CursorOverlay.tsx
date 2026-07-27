import type { CursorPresence } from '../../hooks/useMultiplayerCursors';
import type { PresenceVisibilityMode } from '../../types';

interface CursorOverlayProps {
  cursors: CursorPresence[];
  getMode?: (id: string) => PresenceVisibilityMode;
}

function CursorSvg({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="20"
      viewBox="0 0 16 20"
      fill="none"
      className="block"
    >
      <path
        d="M1 1L1 15.5L5.5 11.5L9.5 19L12.5 17.5L8.5 10L14 9.5L1 1Z"
        fill={color}
        stroke="white"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CursorOverlay({ cursors, getMode }: CursorOverlayProps) {
  if (cursors.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[var(--z-cursors)] overflow-hidden">
      {cursors.map(cursor => {
        const mode = getMode?.(cursor.id) ?? 'visible';
        const dimmed = mode === 'dimmed' || mode === 'hidden';

        return (
          <div
            key={cursor.id}
            style={{
              position: 'absolute',
              left: `${cursor.x}%`,
              top: `${cursor.y}%`,
              opacity: mode === 'hidden' ? 0.22 : dimmed ? 0.35 : 1,
              filter: dimmed ? 'saturate(0.55)' : undefined,
              transition: 'left 80ms linear, top 80ms linear, opacity 120ms ease',
              willChange: 'left, top',
            }}
          >
            <CursorSvg color={cursor.color} />
            <div
              className="absolute top-3.5 left-3.5 whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium leading-snug text-white shadow"
              style={{
                background: cursor.color,
              }}
            >
              {cursor.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
