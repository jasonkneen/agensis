import type { CursorPresence } from '../../hooks/useMultiplayerCursors';

interface CursorOverlayProps {
  cursors: CursorPresence[];
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

export function CursorOverlay({ cursors }: CursorOverlayProps) {
  if (cursors.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[9999] overflow-hidden">
      {cursors.map(cursor => (
        <div
          key={cursor.id}
          style={{
            position: 'absolute',
            left: `${cursor.x}%`,
            top: `${cursor.y}%`,
            transition: 'left 80ms linear, top 80ms linear',
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
      ))}
    </div>
  );
}
