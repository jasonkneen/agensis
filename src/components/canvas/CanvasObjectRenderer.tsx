import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileText, RotateCw } from 'lucide-react';
import type { CanvasObject, Task, WorkspaceAgent } from '../../types';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { CANVAS_APPS, parseAppletState } from '../../lib/canvasApps';

interface CanvasObjectRendererProps {
  obj: CanvasObject;
  canvasWidth: number;
  canvasHeight: number;
  selected: boolean;
  onSelect: () => void;
  attachHighlight?: boolean;
  hostInteractionActive?: boolean;
  tasks?: Task[];
  agents?: WorkspaceAgent[];
  onAppletStateChange?: (stateText: string) => void;
  onAppletCreateTask?: (input: CreateTaskInput) => void;
  onAppletUpdateTask?: (id: string, updates: Partial<Task>) => void;
}

export function CanvasObjectRenderer({
  obj,
  canvasWidth,
  canvasHeight,
  selected,
  onSelect,
  attachHighlight = false,
  hostInteractionActive = false,
  tasks = [],
  agents = [],
  onAppletStateChange,
  onAppletCreateTask,
  onAppletUpdateTask,
}: CanvasObjectRendererProps) {
  void onSelect;

  const px = (obj.x / 100) * canvasWidth;
  const py = (obj.y / 100) * canvasHeight;
  const pw = (obj.width / 100) * canvasWidth;
  const ph = (obj.height / 100) * canvasHeight;

  if (obj.type === 'pen') {
    return (
      <PenStroke
        obj={obj}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        selected={selected}
        attachHighlight={attachHighlight}
      />
    );
  }

  if (obj.type === 'sticky_note') {
    return (
      <StickyNoteObject
        obj={obj}
        px={px} py={py} pw={pw} ph={ph}
        selected={selected}
        attachHighlight={attachHighlight}
      />
    );
  }

  if (obj.type === 'image' || obj.type === 'video') {
    return (
      <MediaObject
        obj={obj}
        px={px} py={py} pw={pw} ph={ph}
        selected={selected}
        attachHighlight={attachHighlight}
      />
    );
  }

  if (obj.type === 'file') {
    return (
      <FileObject
        obj={obj}
        px={px} py={py} pw={pw} ph={ph}
        selected={selected}
        attachHighlight={attachHighlight}
      />
    );
  }

  if (obj.type === 'applet') {
    return (
      <AppletObject
        obj={obj}
        px={px} py={py} pw={pw} ph={ph}
        selected={selected}
        attachHighlight={attachHighlight}
        hostInteractionActive={hostInteractionActive}
        tasks={tasks}
        agents={agents}
        onAppletStateChange={onAppletStateChange}
        onAppletCreateTask={onAppletCreateTask}
        onAppletUpdateTask={onAppletUpdateTask}
      />
    );
  }

  if (obj.type === 'text') {
    return (
      <div
        data-canvas-item-id={obj.id}
        style={{
          position: 'absolute',
          left: px,
          top: py,
          width: pw,
          minHeight: ph,
          transform: `rotate(${obj.rotation}deg)`,
          opacity: obj.opacity,
          cursor: 'move',
          padding: '8px 12px',
          color: obj.fill,
          fontSize: `${obj.font_size || Math.max(12, ph * 0.4)}px`,
          fontWeight: 500,
          lineHeight: 1.4,
          wordBreak: 'break-word',
          outline: selected ? '2px solid var(--accent)' : attachHighlight ? '2px dashed var(--accent-border)' : 'none',
          outlineOffset: '2px',
          borderRadius: 'var(--radius-sm)',
          userSelect: 'none',
          willChange: selected ? 'transform' : 'auto',
          transformOrigin: 'top left',
          backfaceVisibility: 'hidden',
        }}
      >
        {obj.text_content || 'Text'}
      </div>
    );
  }

  return (
    <ShapeObject
      obj={obj}
      px={px} py={py} pw={pw} ph={ph}
      selected={selected}
      attachHighlight={attachHighlight}
    />
  );
}

function AppletObject({
  obj, px, py, pw, ph, selected, attachHighlight, hostInteractionActive, tasks, agents, onAppletStateChange, onAppletCreateTask, onAppletUpdateTask,
}: {
  obj: CanvasObject;
  px: number; py: number; pw: number; ph: number;
  selected: boolean;
  attachHighlight: boolean;
  hostInteractionActive: boolean;
  tasks: Task[];
  agents: WorkspaceAgent[];
  onAppletStateChange?: (stateText: string) => void;
  onAppletCreateTask?: (input: CreateTaskInput) => void;
  onAppletUpdateTask?: (id: string, updates: Partial<Task>) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [crash, setCrash] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const parsed = parseAppletState(obj.text_content);
  const appId = parsed.appId || obj.file_name || 'applet';
  const appDefinition = CANVAS_APPS.find(app => app.id === appId);
  const appletHtml = appDefinition?.buildHtml() || obj.src || '<!doctype html><html><body>Empty applet</body></html>';

  const sendInit = () => {
    iframeRef.current?.contentWindow?.postMessage({
      type: 'hatch:init',
      payload: {
        state: parsed.state,
        tasks,
        agents,
        theme: readAppletTheme(),
      },
    }, '*');
  };

  useEffect(() => {
    sendInit();
  }, [obj.text_content, tasks, agents, reloadKey]);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => sendInit());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-ui-theme', 'style'],
    });
    return () => observer.disconnect();
  }, [obj.text_content, tasks, agents, reloadKey]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data || {};
      if (message.source !== 'hatch-applet') return;
      const payload = message.payload || {};
      if (message.type === 'hatch:ready') {
        setCrash(null);
        sendInit();
        return;
      }
      if (message.type === 'hatch:setState') {
        onAppletStateChange?.(JSON.stringify({ appId, state: payload.state || {} }));
        return;
      }
      if (message.type === 'hatch:createTask') {
        const title = String(payload.title || '').trim();
        if (title) {
          onAppletCreateTask?.({
            title,
            priority: payload.priority || 'normal',
            source_type: 'canvas',
            source_id: obj.id,
          });
        }
        return;
      }
      if (message.type === 'hatch:updateTask') {
        if (payload.id && payload.updates) {
          onAppletUpdateTask?.(String(payload.id), payload.updates as Partial<Task>);
        }
        return;
      }
      if (message.type === 'hatch:crash') {
        setCrash(String(payload.message || 'Applet crashed'));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [appId, obj.id, onAppletCreateTask, onAppletStateChange, onAppletUpdateTask, parsed.state, tasks, agents]);

  return (
    <div
      data-canvas-item-id={obj.id}
      style={{
        position: 'absolute',
        left: px,
        top: py,
        width: pw,
        height: ph,
        transform: `rotate(${obj.rotation}deg)`,
        opacity: obj.opacity,
        cursor: 'move',
        outline: selected ? '2px solid var(--accent)' : attachHighlight ? '2px dashed var(--accent-border)' : 'none',
        outlineOffset: '2px',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--canvas-raised)',
        border: '1px solid var(--border)',
        contain: 'layout paint style',
        boxShadow: selected ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        willChange: selected ? 'transform' : 'auto',
        transformOrigin: 'top left',
        backfaceVisibility: 'hidden',
      }}
    >
      <iframe
        key={reloadKey}
        ref={iframeRef}
        data-canvas-applet-frame
        title={obj.file_name || 'Canvas applet'}
        srcDoc={appletHtml}
        sandbox="allow-forms allow-modals allow-popups allow-scripts"
        style={{
          width: '100%',
          height: '100%',
          border: 0,
          display: 'block',
          pointerEvents: selected && !hostInteractionActive ? 'auto' : 'none',
          background: 'transparent',
        }}
      />
      {crash && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: 16,
            background: 'color-mix(in srgb, var(--background) 92%, transparent)',
            color: 'var(--foreground)',
            textAlign: 'center',
          }}
        >
          <AlertTriangle style={{ width: 22, height: 22, color: 'var(--error)' }} />
          <strong style={{ fontSize: 13 }}>Applet crashed</strong>
          <span style={{ maxWidth: 360, color: 'var(--text-secondary)', fontSize: 12 }}>{crash}</span>
          <button
            type="button"
            onClick={() => {
              setCrash(null);
              setReloadKey(key => key + 1);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--canvas-overlay)',
              color: 'var(--foreground)',
              padding: '5px 8px',
              cursor: 'pointer',
            }}
          >
            <RotateCw style={{ width: 13, height: 13 }} />
            Restart
          </button>
        </div>
      )}
    </div>
  );
}

function readAppletTheme() {
  if (typeof document === 'undefined') return null;
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    family: root.getAttribute('data-ui-theme') || 'classic',
    scheme: root.getAttribute('data-theme') || 'light',
    tokens: {
      background: token('--background'),
      foreground: token('--foreground'),
      card: token('--card'),
      cardForeground: token('--card-foreground'),
      popover: token('--popover'),
      primary: token('--primary'),
      primaryForeground: token('--primary-foreground'),
      secondary: token('--secondary'),
      muted: token('--muted'),
      mutedForeground: token('--muted-foreground'),
      border: token('--border'),
      canvasBase: token('--canvas-base'),
      canvasElevated: token('--canvas-elevated'),
      canvasRaised: token('--canvas-raised'),
      canvasOverlay: token('--canvas-overlay'),
      textPrimary: token('--text-primary'),
      textSecondary: token('--text-secondary'),
      textMuted: token('--text-muted'),
      accent: token('--accent'),
      accentHover: token('--accent-hover'),
      shadowSm: token('--shadow-sm'),
      shadowMd: token('--shadow-md'),
      shadowLg: token('--shadow-lg'),
    },
  };
}

function StickyNoteObject({
  obj, px, py, pw, ph, selected, attachHighlight,
}: {
  obj: CanvasObject;
  px: number; py: number; pw: number; ph: number;
  selected: boolean;
  attachHighlight: boolean;
}) {
  return (
    <div
      data-canvas-item-id={obj.id}
      style={{
        position: 'absolute',
        left: px,
        top: py,
        width: pw,
        height: ph,
        background: obj.fill || '#fef08a',
        borderRadius: '4px',
        transform: 'rotate(-1deg)',
        opacity: obj.opacity,
        cursor: 'move',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1)',
        outline: selected
          ? '2px solid var(--accent)'
          : attachHighlight
            ? '2px dashed var(--accent-border)'
            : 'none',
        outlineOffset: '2px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        userSelect: 'none',
        willChange: selected ? 'transform' : 'auto',
        transformOrigin: 'top left',
        backfaceVisibility: 'hidden',
      }}
    >
      <div style={{
        height: '6px',
        background: 'rgba(0,0,0,0.06)',
        flexShrink: 0,
      }} />
      <div style={{
        flex: 1,
        padding: '8px 12px',
        fontSize: `${obj.font_size || 14}px`,
        lineHeight: 1.5,
        color: '#1a1a1a',
        fontFamily: "'Space Grotesk', sans-serif",
        wordBreak: 'break-word',
        overflow: 'hidden',
      }}>
        {obj.text_content || (
          <span style={{ color: 'rgba(0,0,0,0.3)', fontStyle: 'italic' }}>
            Double-click to edit
          </span>
        )}
      </div>
    </div>
  );
}

function ShapeObject({
  obj, px, py, pw, ph, selected, attachHighlight,
}: {
  obj: CanvasObject;
  px: number; py: number; pw: number; ph: number;
  selected: boolean;
  attachHighlight: boolean;
}) {
  const svgW = pw + 4;
  const svgH = ph + 4;

  let shapeEl: React.ReactNode = null;
  const commonProps = {
    fill: obj.fill,
    stroke: obj.stroke === 'transparent' ? 'none' : obj.stroke,
    strokeWidth: obj.stroke_width,
  };

  switch (obj.type) {
    case 'rect':
      shapeEl = <rect x={2} y={2} width={pw} height={ph} rx={4} {...commonProps} />;
      break;
    case 'ellipse':
      shapeEl = <ellipse cx={pw / 2 + 2} cy={ph / 2 + 2} rx={pw / 2} ry={ph / 2} {...commonProps} />;
      break;
    case 'diamond':
      shapeEl = (
        <polygon
          points={`${pw / 2 + 2},2 ${pw + 2},${ph / 2 + 2} ${pw / 2 + 2},${ph + 2} 2,${ph / 2 + 2}`}
          {...commonProps}
        />
      );
      break;
    case 'line': {
      if (obj.points && obj.points.length >= 2) {
        const [start, end] = obj.points;
        const x1 = ((start.x - obj.x) / obj.width) * pw + 2;
        const y1 = ((start.y - obj.y) / obj.height) * ph + 2;
        const x2 = ((end.x - obj.x) / obj.width) * pw + 2;
        const y2 = ((end.y - obj.y) / obj.height) * ph + 2;
        shapeEl = (
          <line
            x1={x1} y1={y1}
            x2={x2} y2={y2}
            stroke={obj.fill}
            strokeWidth={obj.stroke_width}
            strokeLinecap="round"
          />
        );
      } else {
        shapeEl = (
          <line
            x1={2} y1={ph / 2 + 2}
            x2={pw + 2} y2={ph / 2 + 2}
            stroke={obj.fill}
            strokeWidth={obj.stroke_width}
            strokeLinecap="round"
          />
        );
      }
      break;
    }
    case 'arrow': {
      if (obj.points && obj.points.length >= 2) {
        const [start, end] = obj.points;
        const x1 = ((start.x - obj.x) / obj.width) * pw + 2;
        const y1 = ((start.y - obj.y) / obj.height) * ph + 2;
        const x2 = ((end.x - obj.x) / obj.width) * pw + 2;
        const y2 = ((end.y - obj.y) / obj.height) * ph + 2;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = 12;
        const hx1 = x2 - head * Math.cos(angle - Math.PI / 6);
        const hy1 = y2 - head * Math.sin(angle - Math.PI / 6);
        const hx2 = x2 - head * Math.cos(angle + Math.PI / 6);
        const hy2 = y2 - head * Math.sin(angle + Math.PI / 6);
        shapeEl = (
          <>
            <line
              x1={x1} y1={y1}
              x2={x2} y2={y2}
              stroke={obj.fill}
              strokeWidth={obj.stroke_width}
              strokeLinecap="round"
            />
            <polygon
              points={`${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}`}
              fill={obj.fill}
            />
          </>
        );
      } else {
        shapeEl = (
          <>
            <line
              x1={2} y1={ph / 2 + 2}
              x2={pw - 8} y2={ph / 2 + 2}
              stroke={obj.fill}
              strokeWidth={obj.stroke_width}
              strokeLinecap="round"
            />
            <polygon
              points={`${pw + 2},${ph / 2 + 2} ${pw - 10},${ph / 2 - 6} ${pw - 10},${ph / 2 + 10}`}
              fill={obj.fill}
            />
          </>
        );
      }
      break;
    }
    default:
      shapeEl = <rect x={2} y={2} width={pw} height={ph} rx={4} {...commonProps} />;
  }

  return (
    <svg
      data-canvas-item-id={obj.id}
      width={svgW}
      height={svgH}
      style={{
        position: 'absolute',
        left: px - 2,
        top: py - 2,
        transform: `rotate(${obj.rotation}deg)`,
        opacity: obj.opacity,
        cursor: 'move',
        outline: selected ? '2px solid var(--accent)' : attachHighlight ? '2px dashed var(--accent-border)' : 'none',
        outlineOffset: '2px',
        borderRadius: '4px',
        overflow: 'visible',
        willChange: selected ? 'transform' : 'auto',
        transformOrigin: 'top left',
        backfaceVisibility: 'hidden',
      }}
    >
      {shapeEl}
    </svg>
  );
}

function PenStroke({
  obj, canvasWidth, canvasHeight, selected, attachHighlight,
}: {
  obj: CanvasObject;
  canvasWidth: number;
  canvasHeight: number;
  selected: boolean;
  attachHighlight: boolean;
}) {
  const pts = obj.points || [];
  if (pts.length < 2) return null;

  const absPoints = pts.map(p => ({
    x: (p.x / 100) * canvasWidth,
    y: (p.y / 100) * canvasHeight,
  }));

  const minX = Math.min(...absPoints.map(p => p.x));
  const minY = Math.min(...absPoints.map(p => p.y));
  const maxX = Math.max(...absPoints.map(p => p.x));
  const maxY = Math.max(...absPoints.map(p => p.y));
  const pad = obj.stroke_width + 4;

  const pathD = absPoints.reduce((acc, p, i) => {
    const relX = p.x - minX + pad;
    const relY = p.y - minY + pad;
    return acc + (i === 0 ? `M${relX},${relY}` : `L${relX},${relY}`);
  }, '');

  return (
    <svg
      data-canvas-item-id={obj.id}
      width={maxX - minX + pad * 2}
      height={maxY - minY + pad * 2}
      style={{
        position: 'absolute',
        left: minX - pad,
        top: minY - pad,
        opacity: obj.opacity,
        cursor: 'move',
        outline: selected ? '2px solid var(--accent)' : attachHighlight ? '2px dashed var(--accent-border)' : 'none',
        outlineOffset: '2px',
        borderRadius: '4px',
        overflow: 'visible',
        pointerEvents: 'all',
        willChange: selected ? 'transform' : 'auto',
        transformOrigin: 'top left',
        backfaceVisibility: 'hidden',
      }}
    >
      <path
        d={pathD}
        fill="none"
        stroke={obj.fill}
        strokeWidth={obj.stroke_width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MediaObject({
  obj, px, py, pw, ph, selected, attachHighlight,
}: {
  obj: CanvasObject;
  px: number; py: number; pw: number; ph: number;
  selected: boolean;
  attachHighlight: boolean;
}) {
  return (
    <div
      data-canvas-item-id={obj.id}
      style={{
        position: 'absolute',
        left: px,
        top: py,
        width: pw,
        height: ph,
        transform: `rotate(${obj.rotation}deg)`,
        opacity: obj.opacity,
        cursor: 'move',
        outline: selected ? '2px solid var(--accent)' : attachHighlight ? '2px dashed var(--accent-border)' : 'none',
        outlineOffset: '2px',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--canvas-raised)',
        willChange: selected ? 'transform' : 'auto',
        transformOrigin: 'top left',
        backfaceVisibility: 'hidden',
      }}
    >
      {obj.type === 'image' ? (
        <img
          src={obj.src}
          alt={obj.file_name}
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : (
        <video
          src={obj.src}
          controls
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      )}
    </div>
  );
}

function FileObject({
  obj, px, py, pw, ph, selected, attachHighlight,
}: {
  obj: CanvasObject;
  px: number; py: number; pw: number; ph: number;
  selected: boolean;
  attachHighlight: boolean;
}) {
  const [preview, setPreview] = useState('');
  const [failed, setFailed] = useState(false);
  const isPreviewable = Boolean(obj.src) && isPreviewableName(obj.file_name, obj.text_content);

  useEffect(() => {
    let cancelled = false;
    setPreview('');
    setFailed(false);
    if (!isPreviewable) return;

    fetch(obj.src)
      .then(response => {
        if (!response.ok) throw new Error('Preview failed');
        return response.text();
      })
      .then(text => {
        if (!cancelled) setPreview(text.slice(0, 6000));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isPreviewable, obj.src]);

  return (
    <div
      data-canvas-item-id={obj.id}
      style={{
        position: 'absolute',
        left: px,
        top: py,
        width: pw,
        height: ph,
        transform: `rotate(${obj.rotation}deg)`,
        opacity: obj.opacity,
        cursor: 'move',
        outline: selected ? '2px solid var(--accent)' : attachHighlight ? '2px dashed var(--accent-border)' : 'none',
        outlineOffset: '2px',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--canvas-raised)',
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isPreviewable ? 'stretch' : 'center',
        justifyContent: isPreviewable ? 'flex-start' : 'center',
        gap: isPreviewable ? 0 : '6px',
        color: 'var(--text-muted)',
        fontSize: '12px',
        contain: 'layout paint style',
        userSelect: 'none',
        willChange: selected ? 'transform' : 'auto',
        transformOrigin: 'top left',
        backfaceVisibility: 'hidden',
      }}
    >
      {isPreviewable ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minHeight: 30,
              padding: '6px 8px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--canvas-overlay)',
              color: 'var(--text-primary)',
              fontWeight: 600,
            }}
          >
            <FileText style={{ width: 14, height: 14, flex: '0 0 auto' }} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {obj.file_name || 'File'}
            </span>
          </div>
          <pre
            style={{
              flex: 1,
              minHeight: 0,
              margin: 0,
              padding: '8px 10px',
              overflow: 'hidden',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: failed ? 'var(--text-muted)' : 'var(--text-secondary)',
              fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
              fontSize: Math.max(10, Math.min(13, ph / 16)),
              lineHeight: 1.45,
            }}
          >
            {failed ? 'Preview unavailable' : preview || 'Loading preview...'}
          </pre>
        </>
      ) : (
        <>
          <FileText style={{ width: 24, height: 24 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '90%' }}>
            {obj.file_name || 'File'}
          </span>
        </>
      )}
    </div>
  );
}

function isPreviewableName(fileName?: string, mimeHint?: string) {
  const name = fileName || '';
  const hint = mimeHint || '';
  return hint.startsWith('text/')
    || hint === 'application/json'
    || /\.(md|markdown|txt|json|csv|log|html|css|js|ts|tsx|jsx)$/i.test(name);
}
