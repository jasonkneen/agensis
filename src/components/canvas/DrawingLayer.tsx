import { useState, useRef, useCallback, useEffect } from 'react';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasObjectRenderer } from './CanvasObjectRenderer';
import { Pencil, X, Trash2, Group, Ungroup, Link2, Unlink, ListTodo } from 'lucide-react';
import type { CanvasObject, CanvasTool, CanvasObjectType, CanvasGroup } from '../../types';

interface DrawingLayerProps {
  objects: CanvasObject[];
  groups: CanvasGroup[];
  drawingActive: boolean;
  onToggleDrawing: () => void;
  onAddObject: (type: CanvasObjectType, overrides?: Partial<CanvasObject>) => Promise<CanvasObject | null>;
  onUpdateObject: (id: string, updates: Partial<CanvasObject>) => void;
  onDeleteObject: (id: string) => void;
  onBringToFront: (id: string) => void;
  onCreateGroup: (name: string, objectIds: string[], color?: string) => Promise<CanvasGroup | null>;
  onDeleteGroup: (groupId: string) => void;
  onCreateTask?: (input: { title: string; sourceId: string }) => void;
}

const STICKY_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#fed7aa'];

export function DrawingLayer({
  objects,
  groups,
  drawingActive,
  onToggleDrawing,
  onAddObject,
  onUpdateObject,
  onDeleteObject,
  onBringToFront,
  onCreateGroup,
  onDeleteGroup,
  onCreateTask,
}: DrawingLayerProps) {
  const [tool, setTool] = useState<CanvasTool>('select');
  const [color, setColor] = useState('#3b82f6');
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [lastMousePos, setLastMousePos] = useState<{ x: number; y: number } | null>(null);
  const [activeStrokeId, setActiveStrokeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [dragAnchorId, setDragAnchorId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [resizeState, setResizeState] = useState<{
    id: string;
    handle: 'nw' | 'ne' | 'sw' | 'se';
    startMouse: { x: number; y: number };
    startRect: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [boxSelect, setBoxSelect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [boxSelectStart, setBoxSelectStart] = useState<{ x: number; y: number } | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [attachMode, setAttachMode] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const penPointsRef = useRef<Array<{ x: number; y: number }>>([]);

  const activeTool = drawingActive ? tool : 'select';

  const toPercent = useCallback((clientX: number, clientY: number) => {
    if (!layerRef.current) return { x: 0, y: 0 };
    const r = layerRef.current.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * 100,
      y: ((clientY - r.top) / r.height) * 100,
    };
  }, []);

  const getSize = useCallback(() => {
    if (!layerRef.current) return { w: 1, h: 1 };
    const r = layerRef.current.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }, []);

  const getObjectBounds = useCallback((obj: CanvasObject) => {
    if (obj.points && obj.points.length >= 2 && (obj.type === 'pen' || obj.type === 'line' || obj.type === 'arrow')) {
      const xs = obj.points.map(p => p.x);
      const ys = obj.points.map(p => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      return {
        x: minX,
        y: minY,
        width: Math.max(maxX - minX, 0.5),
        height: Math.max(maxY - minY, 0.5),
      };
    }

    return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
  }, []);

  const objectAtPoint = useCallback((pos: { x: number; y: number }): CanvasObject | null => {
    const sorted = [...objects].sort((a, b) => b.z_index - a.z_index);
    for (const obj of sorted) {
      if (obj.type === 'pen') {
        const pts = obj.points || [];
        if (pts.length < 2) continue;
        for (const p of pts) {
          const dx = p.x - pos.x;
          const dy = p.y - pos.y;
          if (Math.sqrt(dx * dx + dy * dy) < 2) return obj;
        }
        continue;
      }
      const bounds = getObjectBounds(obj);
      if (pos.x >= bounds.x && pos.x <= bounds.x + bounds.width &&
          pos.y >= bounds.y && pos.y <= bounds.y + bounds.height) {
        return obj;
      }
    }
    return null;
  }, [objects, getObjectBounds]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (editingTextId) return;
    const pos = toPercent(e.clientX, e.clientY);

    if (activeTool === 'select') {
      const hitObj = objectAtPoint(pos);
      if (!hitObj) {
        if (!e.shiftKey) setSelectedIds(new Set());
        setBoxSelectStart(pos);
        return;
      }
      return;
    }

    if (activeTool === 'eraser') return;

    if (activeTool === 'pen') {
      setIsDrawing(true);
      penPointsRef.current = [pos];
      return;
    }

    if (activeTool === 'text') {
      onAddObject('text', {
        x: pos.x, y: pos.y, width: 15, height: 4,
        fill: color, text_content: 'Double-click to edit',
        stroke: 'transparent', stroke_width: 0, font_size: 16,
      }).then(obj => {
        if (obj) {
          setSelectedIds(new Set([obj.id]));
          setEditingTextId(obj.id);
        }
      });
      setTool('select');
      return;
    }

    if (activeTool === 'sticky_note') {
      const stickyColor = STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)];
      onAddObject('sticky_note', {
        x: pos.x - 8, y: pos.y - 6, width: 16, height: 12,
        fill: stickyColor, stroke: 'transparent', stroke_width: 0,
        text_content: '', font_size: 14,
      }).then(obj => {
        if (obj) setSelectedIds(new Set([obj.id]));
      });
      setTool('select');
      return;
    }

    setIsDrawing(true);
    setDrawStart(pos);
  }, [activeTool, color, toPercent, onAddObject, objectAtPoint, editingTextId]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = toPercent(e.clientX, e.clientY);
    setLastMousePos(pos);

    if (boxSelectStart) {
      const x = Math.min(boxSelectStart.x, pos.x);
      const y = Math.min(boxSelectStart.y, pos.y);
      const w = Math.abs(pos.x - boxSelectStart.x);
      const h = Math.abs(pos.y - boxSelectStart.y);
      setBoxSelect({ x, y, w, h });
      return;
    }

    if (!isDrawing) {
      if (isDragging && selectedIds.size > 0 && dragOffset && dragAnchorId) {
        const primaryObj = objects.find(o => o.id === dragAnchorId);
        if (!primaryObj) return;
        const primaryBounds = getObjectBounds(primaryObj);
        const dx = pos.x - dragOffset.x - primaryBounds.x;
        const dy = pos.y - dragOffset.y - primaryBounds.y;
        selectedIds.forEach(id => {
          const obj = objects.find(o => o.id === id);
          if (obj) {
            const pointUpdates = obj.points && obj.points.length >= 2 && (obj.type === 'pen' || obj.type === 'line' || obj.type === 'arrow')
              ? { points: obj.points.map(p => ({ x: p.x + dx, y: p.y + dy })) }
              : {};
            onUpdateObject(id, { x: obj.x + dx, y: obj.y + dy, ...pointUpdates });
            const attached = objects.filter(o => o.attached_to === id);
            attached.forEach(a => {
              onUpdateObject(a.id, { x: a.x + dx, y: a.y + dy });
            });
          }
        });
      }
      return;
    }

    if (activeTool === 'pen') {
      penPointsRef.current.push(pos);
      if (!activeStrokeId && penPointsRef.current.length >= 2) {
        onAddObject('pen', {
          x: 0, y: 0, width: 100, height: 100,
          fill: color, stroke: color, stroke_width: strokeWidth,
          points: [...penPointsRef.current],
        }).then(obj => {
          if (obj) setActiveStrokeId(obj.id);
        });
      } else if (activeStrokeId && penPointsRef.current.length % 3 === 0) {
        onUpdateObject(activeStrokeId, { points: [...penPointsRef.current] });
      }
    }
  }, [isDrawing, isDragging, selectedIds, dragOffset, dragAnchorId, activeTool, color, strokeWidth,
      activeStrokeId, objects, toPercent, onAddObject, onUpdateObject, boxSelectStart, getObjectBounds]);

  const handleMouseUp = useCallback(() => {
    if (boxSelectStart && boxSelect) {
      const { x, y, w, h } = boxSelect;
      if (w > 1 || h > 1) {
        const hits = objects.filter(obj => {
          if (obj.type === 'pen') {
            return (obj.points || []).some(p =>
              p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h
            );
          }
          const objRight = obj.x + obj.width;
          const objBottom = obj.y + obj.height;
          return obj.x < x + w && objRight > x && obj.y < y + h && objBottom > y;
        });
        setSelectedIds(new Set(hits.map(o => o.id)));
      }
      setBoxSelect(null);
      setBoxSelectStart(null);
      return;
    }
    setBoxSelectStart(null);
    setBoxSelect(null);

    if (isDragging) {
      setIsDragging(false);
      setDragOffset(null);
      setDragAnchorId(null);
      return;
    }

    if (!isDrawing) return;
    setIsDrawing(false);

    if (activeTool === 'pen' && activeStrokeId) {
      onUpdateObject(activeStrokeId, { points: [...penPointsRef.current] });
      setSelectedIds(new Set([activeStrokeId]));
      setActiveStrokeId(null);
      penPointsRef.current = [];
      return;
    }

    if (drawStart && lastMousePos) {
      const minX = Math.min(drawStart.x, lastMousePos.x);
      const minY = Math.min(drawStart.y, lastMousePos.y);
      const shapeType = activeTool as CanvasObjectType;
      const isDirectional = shapeType === 'line' || shapeType === 'arrow';
      const w = isDirectional ? Math.max(Math.abs(lastMousePos.x - drawStart.x), 0.5) : Math.max(Math.abs(lastMousePos.x - drawStart.x), 4);
      const h = isDirectional ? Math.max(Math.abs(lastMousePos.y - drawStart.y), 0.5) : Math.max(Math.abs(lastMousePos.y - drawStart.y), 4);
      onAddObject(shapeType, {
        x: minX, y: minY, width: w, height: h,
        fill: color, stroke: color, stroke_width: strokeWidth,
        ...(isDirectional ? { points: [drawStart, lastMousePos] } : {}),
      }).then(obj => {
        if (obj) setSelectedIds(new Set([obj.id]));
      });
      setDrawStart(null);
      setTool('select');
    }
  }, [isDrawing, isDragging, activeTool, drawStart, lastMousePos, activeStrokeId,
      color, strokeWidth, onAddObject, onUpdateObject, boxSelect, boxSelectStart, objects]);

  const handleObjectSelect = useCallback((id: string, e: React.MouseEvent) => {
    if (editingTextId) return;

    if (activeTool === 'eraser') {
      onDeleteObject(id);
      return;
    }

    if (attachMode && selectedIds.size === 1) {
      const stickyId = Array.from(selectedIds)[0];
      const sticky = objects.find(o => o.id === stickyId);
      if (sticky && (sticky.type === 'sticky_note') && id !== stickyId) {
        onUpdateObject(stickyId, { attached_to: id });
        setAttachMode(false);
        setSelectedIds(new Set([stickyId]));
        return;
      }
    }

    const obj = objects.find(o => o.id === id);
    if (e.shiftKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (obj?.group_id) {
          objects.filter(o => o.group_id === obj.group_id).forEach(o => next.add(o.id));
        }
        return next;
      });
    } else {
      if (obj?.group_id) {
        const groupObjs = objects.filter(o => o.group_id === obj.group_id);
        setSelectedIds(new Set(groupObjs.map(o => o.id)));
      } else {
        setSelectedIds(new Set([id]));
      }
    }
    onBringToFront(id);
  }, [activeTool, objects, onDeleteObject, onBringToFront, attachMode, selectedIds, onUpdateObject, editingTextId]);

  const handleObjectDragStart = useCallback((id: string, e: React.MouseEvent) => {
    if (editingTextId) return;
    const pos = toPercent(e.clientX, e.clientY);
    const obj = objects.find(o => o.id === id);
    if (!obj) return;
    const bounds = getObjectBounds(obj);
    setDragOffset({ x: pos.x - bounds.x, y: pos.y - bounds.y });
    setDragAnchorId(id);
    setIsDragging(true);
  }, [objects, toPercent, editingTextId, getObjectBounds]);

  const handleDoubleClick = useCallback((id: string) => {
    const obj = objects.find(o => o.id === id);
    if (!obj) return;
    if (obj.type === 'text' || obj.type === 'sticky_note') {
      setEditingTextId(id);
      setSelectedIds(new Set([id]));
    }
  }, [objects]);

  const handleGroup = useCallback(async () => {
    if (selectedIds.size < 2) return;
    const name = `Group ${groups.length + 1}`;
    const grp = await onCreateGroup(name, Array.from(selectedIds), color);
    if (grp) setSelectedIds(new Set());
  }, [selectedIds, groups.length, color, onCreateGroup]);

  const handleUngroup = useCallback(() => {
    const groupIds = new Set<string>();
    selectedIds.forEach(id => {
      const obj = objects.find(o => o.id === id);
      if (obj?.group_id) groupIds.add(obj.group_id);
    });
    groupIds.forEach(gid => onDeleteGroup(gid));
    setSelectedIds(new Set());
  }, [selectedIds, objects, onDeleteGroup]);

  const handleDetach = useCallback(() => {
    selectedIds.forEach(id => {
      const obj = objects.find(o => o.id === id);
      if (obj?.attached_to) onUpdateObject(id, { attached_to: null });
    });
  }, [selectedIds, objects, onUpdateObject]);

  const hasGroupInSelection = Array.from(selectedIds).some(id => {
    const obj = objects.find(o => o.id === id);
    return obj?.group_id;
  });

  const hasAttachedInSelection = Array.from(selectedIds).some(id => {
    const obj = objects.find(o => o.id === id);
    return obj?.attached_to;
  });

  const hasStickyInSelection = Array.from(selectedIds).some(id => {
    const obj = objects.find(o => o.id === id);
    return obj?.type === 'sticky_note';
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (editingTextId) {
        if (e.key === 'Escape') setEditingTextId(null);
        return;
      }
      if (selectedIds.size === 0) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).contentEditable === 'true')) return;
        selectedIds.forEach(id => onDeleteObject(id));
        setSelectedIds(new Set());
      }
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
        setAttachMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, onDeleteObject, editingTextId]);

  const handleResizeStart = useCallback((id: string, handle: 'nw' | 'ne' | 'sw' | 'se', e: React.MouseEvent) => {
    e.stopPropagation();
    const obj = objects.find(o => o.id === id);
    if (!obj || obj.type === 'pen' || editingTextId) return;
    const pos = toPercent(e.clientX, e.clientY);
    setSelectedIds(new Set([id]));
    onBringToFront(id);
    setResizeState({
      id,
      handle,
      startMouse: pos,
      startRect: { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
    });
  }, [objects, editingTextId, toPercent, onBringToFront]);

  useEffect(() => {
    if (!isDragging) return;
    const handleDocMouseMove = (e: MouseEvent) => {
      if (!isDragging || selectedIds.size === 0 || !dragOffset || !dragAnchorId || !layerRef.current) return;
      const r = layerRef.current.getBoundingClientRect();
      const pos = {
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
      };
      const primaryObj = objects.find(o => o.id === dragAnchorId);
      if (!primaryObj) return;
      const primaryBounds = getObjectBounds(primaryObj);
      const dx = pos.x - dragOffset.x - primaryBounds.x;
      const dy = pos.y - dragOffset.y - primaryBounds.y;
      selectedIds.forEach(id => {
        const obj = objects.find(o => o.id === id);
        if (obj) {
          const pointUpdates = obj.points && obj.points.length >= 2 && (obj.type === 'pen' || obj.type === 'line' || obj.type === 'arrow')
            ? { points: obj.points.map(p => ({ x: p.x + dx, y: p.y + dy })) }
            : {};
          onUpdateObject(id, { x: obj.x + dx, y: obj.y + dy, ...pointUpdates });
          const attached = objects.filter(o => o.attached_to === id);
          attached.forEach(a => {
            onUpdateObject(a.id, { x: a.x + dx, y: a.y + dy });
          });
        }
      });
    };
    const handleDocMouseUp = () => {
      setIsDragging(false);
      setDragOffset(null);
      setDragAnchorId(null);
    };
    document.addEventListener('mousemove', handleDocMouseMove);
    document.addEventListener('mouseup', handleDocMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove);
      document.removeEventListener('mouseup', handleDocMouseUp);
    };
  }, [isDragging, selectedIds, dragOffset, dragAnchorId, objects, onUpdateObject, getObjectBounds]);

  useEffect(() => {
    if (!resizeState || !layerRef.current) return;

    const handleDocMouseMove = (e: MouseEvent) => {
      if (!resizeState || !layerRef.current) return;
      const r = layerRef.current.getBoundingClientRect();
      const pos = {
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
      };

      const { startMouse, startRect, handle, id } = resizeState;
      const minWidth = 4;
      const minHeight = 4;
      const dx = pos.x - startMouse.x;
      const dy = pos.y - startMouse.y;

      let nextX = startRect.x;
      let nextY = startRect.y;
      let nextWidth = startRect.width;
      let nextHeight = startRect.height;

      if (handle.includes('e')) {
        nextWidth = Math.max(minWidth, Math.min(100 - startRect.x, startRect.width + dx));
      }
      if (handle.includes('s')) {
        nextHeight = Math.max(minHeight, Math.min(100 - startRect.y, startRect.height + dy));
      }
      if (handle.includes('w')) {
        nextX = Math.max(0, Math.min(startRect.x + dx, startRect.x + startRect.width - minWidth));
        nextWidth = startRect.width + (startRect.x - nextX);
      }
      if (handle.includes('n')) {
        nextY = Math.max(0, Math.min(startRect.y + dy, startRect.y + startRect.height - minHeight));
        nextHeight = startRect.height + (startRect.y - nextY);
      }

      onUpdateObject(id, {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
      });
    };

    const handleDocMouseUp = () => {
      setResizeState(null);
    };

    document.addEventListener('mousemove', handleDocMouseMove);
    document.addEventListener('mouseup', handleDocMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove);
      document.removeEventListener('mouseup', handleDocMouseUp);
    };
  }, [resizeState, onUpdateObject]);

  const { w: canvasW, h: canvasH } = getSize();
  const sorted = [...objects].sort((a, b) => a.z_index - b.z_index);

  const anyInteraction = isDragging || isDrawing || !!boxSelectStart || !!resizeState;
  const previewBounds = drawStart && lastMousePos ? {
    x: Math.min(drawStart.x, lastMousePos.x),
    y: Math.min(drawStart.y, lastMousePos.y),
    w: Math.max(Math.abs(lastMousePos.x - drawStart.x), 4),
    h: Math.max(Math.abs(lastMousePos.y - drawStart.y), 4),
  } : null;
  const livePenPath = isDrawing && activeTool === 'pen' && penPointsRef.current.length >= 2
    ? penPointsRef.current.map((point, index) => {
        const x = (point.x / 100) * canvasW;
        const y = (point.y / 100) * canvasH;
        return `${index === 0 ? 'M' : 'L'}${x},${y}`;
      }).join(' ')
    : null;

  const singleSelectedObj = selectedIds.size === 1
    ? objects.find(o => o.id === Array.from(selectedIds)[0])
    : undefined;
  const taskFromObj = singleSelectedObj
    && (singleSelectedObj.type === 'sticky_note' || singleSelectedObj.type === 'text')
    && (singleSelectedObj.text_content || '').trim()
    ? singleSelectedObj
    : undefined;

  const selectionBar = selectedIds.size > 0 && !editingTextId ? (
    <SelectionActionBar
      count={selectedIds.size}
      hasGroup={hasGroupInSelection}
      hasAttached={hasAttachedInSelection}
      hasSticky={hasStickyInSelection}
      attachMode={attachMode}
      bottomOffset={drawingActive ? 84 : 16}
      canCreateTask={!!taskFromObj && !!onCreateTask}
      onGroup={handleGroup}
      onUngroup={handleUngroup}
      onAttach={() => setAttachMode(true)}
      onDetach={handleDetach}
      onCreateTask={() => {
        if (taskFromObj && onCreateTask) {
          onCreateTask({ title: (taskFromObj.text_content || '').trim(), sourceId: taskFromObj.id });
        }
      }}
      onDelete={() => {
        selectedIds.forEach(id => onDeleteObject(id));
        setSelectedIds(new Set());
      }}
    />
  ) : null;

  return (
    <>
      {/* Drawing layer - only captures full-surface events for non-select tools */}
      <div
        ref={layerRef}
        onMouseDown={drawingActive && activeTool !== 'select' ? handleMouseDown : undefined}
        onMouseMove={drawingActive && activeTool !== 'select' ? handleMouseMove : undefined}
        onMouseUp={drawingActive && activeTool !== 'select' ? handleMouseUp : undefined}
        onMouseLeave={drawingActive && activeTool !== 'select' ? handleMouseUp : undefined}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: drawingActive ? 500 : 0,
          cursor: drawingActive
            ? (activeTool === 'pen' || activeTool === 'eraser' ? 'crosshair'
              : activeTool === 'select' ? 'default' : 'crosshair')
            : 'default',
          userSelect: anyInteraction ? 'none' : 'auto',
          pointerEvents: drawingActive && activeTool !== 'select' ? 'auto' : 'none',
        }}
      >
        {drawingActive && activeTool !== 'select' && sorted.map(obj => (
          <CanvasItemWrapper
            key={obj.id}
            obj={obj}
            canvasW={canvasW}
            canvasH={canvasH}
            selected={selectedIds.has(obj.id)}
            editing={editingTextId === obj.id}
            attachMode={attachMode}
            parentObj={obj.attached_to ? objects.find(o => o.id === obj.attached_to) : undefined}
            onSelect={(e) => handleObjectSelect(obj.id, e)}
            onDragStart={(e) => handleObjectDragStart(obj.id, e)}
            onDoubleClick={() => handleDoubleClick(obj.id)}
            onTextChange={(text) => onUpdateObject(obj.id, { text_content: text })}
            onStopEditing={() => setEditingTextId(null)}
            onResizeStart={(handle, e) => handleResizeStart(obj.id, handle, e)}
            showResizeHandles={selectedIds.size === 1 && selectedIds.has(obj.id) && tool === 'select'}
          />
        ))}

        {drawingActive && previewBounds && activeTool !== 'pen' && activeTool !== 'text' && activeTool !== 'sticky_note' && activeTool !== 'eraser' && (
          <LiveShapePreview
            tool={activeTool}
            bounds={previewBounds}
            start={drawStart}
            end={lastMousePos}
            color={color}
            strokeWidth={strokeWidth}
          />
        )}

        {drawingActive && livePenPath && (
          <svg style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 9998,
            overflow: 'visible',
          }}>
            <path
              d={livePenPath}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.9}
            />
          </svg>
        )}

        {drawingActive && boxSelect && (
          <div style={{
            position: 'absolute',
            left: `${boxSelect.x}%`,
            top: `${boxSelect.y}%`,
            width: `${boxSelect.w}%`,
            height: `${boxSelect.h}%`,
            border: '1.5px dashed var(--accent)',
            background: 'rgba(79, 156, 249, 0.08)',
            borderRadius: '4px',
            pointerEvents: 'none',
            zIndex: 9999,
          }} />
        )}

        {drawingActive && activeTool !== 'select' && selectionBar}
      </div>

      {/* Object interaction layer - normal interactions when not drawing OR when pointer/select is active */}
      {(!drawingActive || activeTool === 'select') && sorted.map(obj => (
        <CanvasItemWrapper
          key={`interact-${obj.id}`}
          obj={obj}
          canvasW={canvasW}
          canvasH={canvasH}
          selected={selectedIds.has(obj.id)}
          editing={editingTextId === obj.id}
          attachMode={attachMode}
          parentObj={obj.attached_to ? objects.find(o => o.id === obj.attached_to) : undefined}
          onSelect={(e) => handleObjectSelect(obj.id, e)}
          onDragStart={(e) => handleObjectDragStart(obj.id, e)}
          onDoubleClick={() => handleDoubleClick(obj.id)}
          onTextChange={(text) => onUpdateObject(obj.id, { text_content: text })}
          onStopEditing={() => setEditingTextId(null)}
          onResizeStart={(handle, e) => handleResizeStart(obj.id, handle, e)}
          showResizeHandles={selectedIds.size === 1 && selectedIds.has(obj.id) && activeTool === 'select'}
          interactive
        />
      ))}

      {/* Box-select visual when normal interactions are active */}
      {(!drawingActive || activeTool === 'select') && boxSelect && (
        <div style={{
          position: 'absolute',
          left: `${boxSelect.x}%`,
          top: `${boxSelect.y}%`,
          width: `${boxSelect.w}%`,
          height: `${boxSelect.h}%`,
          border: '1.5px dashed var(--accent)',
          background: 'rgba(79, 156, 249, 0.08)',
          borderRadius: '4px',
          pointerEvents: 'none',
          zIndex: 9999,
        }} />
      )}

      {(!drawingActive || activeTool === 'select') && selectionBar}

      <DrawFAB active={drawingActive} onClick={onToggleDrawing} />

      {drawingActive && (
        <CanvasToolbar
          activeTool={tool}
          activeColor={color}
          strokeWidth={strokeWidth}
          onToolChange={setTool}
          onColorChange={setColor}
          onStrokeWidthChange={setStrokeWidth}
        />
      )}

      {/* Background box-select listener when normal interactions are active */}
      {(!drawingActive || activeTool === 'select') && (
        <BoxSelectListener
          layerRef={layerRef}
          objects={objects}
          onSelect={setSelectedIds}
          boxSelect={boxSelect}
          setBoxSelect={setBoxSelect}
          boxSelectStart={boxSelectStart}
          setBoxSelectStart={setBoxSelectStart}
        />
      )}
    </>
  );
}

function LiveShapePreview({
  tool,
  bounds,
  start,
  end,
  color,
  strokeWidth,
}: {
  tool: CanvasTool;
  bounds: { x: number; y: number; w: number; h: number };
  start: { x: number; y: number } | null;
  end: { x: number; y: number } | null;
  color: string;
  strokeWidth: number;
}) {
  const commonProps = {
    fill: `${color}22`,
    stroke: color,
    strokeWidth,
  };

  let shapeEl: React.ReactNode = null;

  switch (tool) {
    case 'rect':
      shapeEl = <rect x={2} y={2} width={96} height={96} rx={6} {...commonProps} />;
      break;
    case 'ellipse':
      shapeEl = <ellipse cx={50} cy={50} rx={48} ry={48} {...commonProps} />;
      break;
    case 'diamond':
      shapeEl = <polygon points="50,2 98,50 50,98 2,50" {...commonProps} />;
      break;
    case 'line': {
      if (!start || !end) return null;
      const x1 = bounds.w ? ((start.x - bounds.x) / bounds.w) * 100 : 2;
      const y1 = bounds.h ? ((start.y - bounds.y) / bounds.h) * 100 : 2;
      const x2 = bounds.w ? ((end.x - bounds.x) / bounds.w) * 100 : 98;
      const y2 = bounds.h ? ((end.y - bounds.y) / bounds.h) * 100 : 98;
      shapeEl = <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />;
      break;
    }
    case 'arrow': {
      if (!start || !end) return null;
      const x1 = bounds.w ? ((start.x - bounds.x) / bounds.w) * 100 : 2;
      const y1 = bounds.h ? ((start.y - bounds.y) / bounds.h) * 100 : 2;
      const x2 = bounds.w ? ((end.x - bounds.x) / bounds.w) * 100 : 98;
      const y2 = bounds.h ? ((end.y - bounds.y) / bounds.h) * 100 : 98;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = 10;
      const hx1 = x2 - head * Math.cos(angle - Math.PI / 6);
      const hy1 = y2 - head * Math.sin(angle - Math.PI / 6);
      const hx2 = x2 - head * Math.cos(angle + Math.PI / 6);
      const hy2 = y2 - head * Math.sin(angle + Math.PI / 6);
      shapeEl = (
        <>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
          <polygon points={`${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}`} fill={color} />
        </>
      );
      break;
    }
    default:
      return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: `${bounds.x}%`,
        top: `${bounds.y}%`,
        width: `${bounds.w}%`,
        height: `${bounds.h}%`,
        pointerEvents: 'none',
        zIndex: 9997,
        opacity: 0.95,
      }}
    >
      <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ overflow: 'visible' }}>
        {shapeEl}
      </svg>
    </div>
  );
}

function BoxSelectListener({
  layerRef,
  objects,
  onSelect,
  boxSelect,
  setBoxSelect,
  boxSelectStart,
  setBoxSelectStart,
}: {
  layerRef: React.RefObject<HTMLDivElement>;
  objects: CanvasObject[];
  onSelect: (ids: Set<string>) => void;
  boxSelect: { x: number; y: number; w: number; h: number } | null;
  setBoxSelect: (v: { x: number; y: number; w: number; h: number } | null) => void;
  boxSelectStart: { x: number; y: number } | null;
  setBoxSelectStart: (v: { x: number; y: number } | null) => void;
}) {
  const activeRef = useRef(false);

  const toPercent = useCallback((clientX: number, clientY: number) => {
    if (!layerRef.current) return { x: 0, y: 0 };
    const r = layerRef.current.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * 100,
      y: ((clientY - r.top) / r.height) * 100,
    };
  }, [layerRef]);

  useEffect(() => {
    const el = layerRef.current?.parentElement;
    if (!el) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-canvas-item]')) return;
      if (target.closest('button')) return;
      if (target.closest('textarea')) return;
      if (target.closest('input')) return;
      if (target.closest('[contenteditable]')) return;
      if (target.closest('[data-floating-window]')) return;

      const pos = toPercent(e.clientX, e.clientY);
      activeRef.current = true;
      setBoxSelectStart(pos);
      onSelect(new Set());
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!activeRef.current || !boxSelectStart) return;
      const pos = toPercent(e.clientX, e.clientY);
      const x = Math.min(boxSelectStart.x, pos.x);
      const y = Math.min(boxSelectStart.y, pos.y);
      const w = Math.abs(pos.x - boxSelectStart.x);
      const h = Math.abs(pos.y - boxSelectStart.y);
      if (w > 0.5 || h > 0.5) {
        setBoxSelect({ x, y, w, h });
      }
    };

    const handleMouseUp = () => {
      if (activeRef.current && boxSelect && (boxSelect.w > 1 || boxSelect.h > 1)) {
        const hits = objects.filter(obj => {
          if (obj.type === 'pen') {
            return (obj.points || []).some(p =>
              p.x >= boxSelect.x && p.x <= boxSelect.x + boxSelect.w &&
              p.y >= boxSelect.y && p.y <= boxSelect.y + boxSelect.h
            );
          }
          return obj.x < boxSelect.x + boxSelect.w && obj.x + obj.width > boxSelect.x &&
                 obj.y < boxSelect.y + boxSelect.h && obj.y + obj.height > boxSelect.y;
        });
        onSelect(new Set(hits.map(o => o.id)));
      }
      activeRef.current = false;
      setBoxSelect(null);
      setBoxSelectStart(null);
    };

    el.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      el.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [layerRef, toPercent, onSelect, boxSelect, boxSelectStart, setBoxSelect, setBoxSelectStart, objects]);

  return null;
}

function CanvasItemWrapper({
  obj,
  canvasW,
  canvasH,
  selected,
  editing,
  attachMode,
  parentObj,
  onSelect,
  onDragStart,
  onDoubleClick,
  onTextChange,
  onStopEditing,
  onResizeStart,
  showResizeHandles = false,
  interactive = false,
}: {
  obj: CanvasObject;
  canvasW: number;
  canvasH: number;
  selected: boolean;
  editing: boolean;
  attachMode: boolean;
  parentObj?: CanvasObject;
  onSelect: (e: React.MouseEvent) => void;
  onDragStart: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onTextChange: (text: string) => void;
  onStopEditing: () => void;
  onResizeStart: (handle: 'nw' | 'ne' | 'sw' | 'se', e: React.MouseEvent) => void;
  showResizeHandles?: boolean;
  interactive?: boolean;
}) {
  const showAttachLine = parentObj && !editing;
  const px = (obj.x / 100) * canvasW;
  const py = (obj.y / 100) * canvasH;
  const pw = (obj.width / 100) * canvasW;
  const ph = (obj.height / 100) * canvasH;

  let parentCenter: { x: number; y: number } | null = null;
  if (showAttachLine && parentObj) {
    parentCenter = {
      x: (parentObj.x / 100) * canvasW + (parentObj.width / 100) * canvasW / 2,
      y: (parentObj.y / 100) * canvasH + (parentObj.height / 100) * canvasH / 2,
    };
  }
  const myCenter = { x: px + pw / 2, y: py + ph / 2 };

  if (interactive) {
    return (
      <>
        {showAttachLine && parentCenter && (
          <svg style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            pointerEvents: 'none', zIndex: obj.z_index,
          }}>
            <line
              x1={myCenter.x} y1={myCenter.y}
              x2={parentCenter.x} y2={parentCenter.y}
              stroke="var(--text-muted)"
              strokeWidth="1"
              strokeDasharray="4 3"
              opacity={0.5}
            />
          </svg>
        )}
        <div
          data-canvas-item
          onMouseDown={e => {
            e.stopPropagation();
            onSelect(e);
            onDragStart(e);
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            onDoubleClick();
          }}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            overflow: 'visible',
            zIndex: obj.z_index,
            pointerEvents: 'none',
          }}
        >
          <div style={{ pointerEvents: 'auto', position: 'relative' }}>
            {(obj.type === 'sticky_note' && editing) ? (
              <StickyNoteEditor
                obj={obj}
                px={px} py={py} pw={pw} ph={ph}
                onTextChange={onTextChange}
                onStopEditing={onStopEditing}
              />
            ) : (obj.type === 'text' && editing) ? (
              <TextEditor
                obj={obj}
                px={px} py={py} pw={pw} ph={ph}
                onTextChange={onTextChange}
                onStopEditing={onStopEditing}
              />
            ) : (
              <CanvasObjectRenderer
                obj={obj}
                canvasWidth={canvasW}
                canvasHeight={canvasH}
                selected={selected}
                onSelect={() => {}}
                attachHighlight={attachMode && !selected}
              />
            )}
            {showResizeHandles && obj.type !== 'pen' && !editing && (
              <ResizeHandles px={px} py={py} pw={pw} ph={ph} onResizeStart={onResizeStart} />
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {showAttachLine && parentCenter && (
        <svg style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none', zIndex: 0,
        }}>
          <line
            x1={myCenter.x} y1={myCenter.y}
            x2={parentCenter.x} y2={parentCenter.y}
            stroke="var(--text-muted)"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity={0.5}
          />
        </svg>
      )}
      <div
        data-canvas-item
        onMouseDown={e => {
          e.stopPropagation();
          onSelect(e);
          onDragStart(e);
        }}
        onDoubleClick={e => {
          e.stopPropagation();
          onDoubleClick();
        }}
      >
        {(obj.type === 'sticky_note' && editing) ? (
          <StickyNoteEditor
            obj={obj}
            px={px} py={py} pw={pw} ph={ph}
            onTextChange={onTextChange}
            onStopEditing={onStopEditing}
          />
        ) : (obj.type === 'text' && editing) ? (
          <TextEditor
            obj={obj}
            px={px} py={py} pw={pw} ph={ph}
            onTextChange={onTextChange}
            onStopEditing={onStopEditing}
          />
        ) : (
          <>
            <CanvasObjectRenderer
              obj={obj}
              canvasWidth={canvasW}
              canvasHeight={canvasH}
              selected={selected}
              onSelect={() => {}}
              attachHighlight={attachMode && !selected}
            />
            {showResizeHandles && obj.type !== 'pen' && !editing && (
              <ResizeHandles px={px} py={py} pw={pw} ph={ph} onResizeStart={onResizeStart} />
            )}
          </>
        )}
      </div>
    </>
  );
}

function ResizeHandles({
  px,
  py,
  pw,
  ph,
  onResizeStart,
}: {
  px: number;
  py: number;
  pw: number;
  ph: number;
  onResizeStart: (handle: 'nw' | 'ne' | 'sw' | 'se', e: React.MouseEvent) => void;
}) {
  const handles: Array<{ key: 'nw' | 'ne' | 'sw' | 'se'; left: number; top: number; cursor: string }> = [
    { key: 'nw', left: px - 5, top: py - 5, cursor: 'nwse-resize' },
    { key: 'ne', left: px + pw - 5, top: py - 5, cursor: 'nesw-resize' },
    { key: 'sw', left: px - 5, top: py + ph - 5, cursor: 'nesw-resize' },
    { key: 'se', left: px + pw - 5, top: py + ph - 5, cursor: 'nwse-resize' },
  ];

  return (
    <>
      {handles.map(handle => (
        <div
          key={handle.key}
          onMouseDown={(e) => onResizeStart(handle.key, e)}
          style={{
            position: 'absolute',
            left: handle.left,
            top: handle.top,
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: 'white',
            border: '2px solid var(--accent)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
            cursor: handle.cursor,
            zIndex: 2,
          }}
        />
      ))}
    </>
  );
}

function StickyNoteEditor({
  obj, px, py, pw, ph, onTextChange, onStopEditing,
}: {
  obj: CanvasObject;
  px: number; py: number; pw: number; ph: number;
  onTextChange: (text: string) => void;
  onStopEditing: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div style={{
      position: 'absolute', left: px, top: py, width: pw, height: ph,
      background: obj.fill, borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1)',
      outline: '2px solid var(--accent)', outlineOffset: '2px',
      display: 'flex', flexDirection: 'column',
      transform: 'rotate(-1deg)',
    }}>
      <textarea
        ref={ref}
        defaultValue={obj.text_content}
        onBlur={(e) => { onTextChange(e.target.value); onStopEditing(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { onTextChange(e.currentTarget.value); onStopEditing(); } }}
        style={{
          flex: 1, resize: 'none', border: 'none', outline: 'none',
          background: 'transparent', padding: '12px',
          fontSize: `${obj.font_size || 14}px`, lineHeight: 1.5,
          fontFamily: "'Space Grotesk', sans-serif", color: '#1a1a1a',
        }}
      />
    </div>
  );
}

function TextEditor({
  obj, px, py, pw, ph, onTextChange, onStopEditing,
}: {
  obj: CanvasObject;
  px: number; py: number; pw: number; ph: number;
  onTextChange: (text: string) => void;
  onStopEditing: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, []);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => { onTextChange(e.currentTarget.textContent || ''); onStopEditing(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { onTextChange(e.currentTarget.textContent || ''); onStopEditing(); } }}
      style={{
        position: 'absolute', left: px, top: py, width: pw, minHeight: ph,
        padding: '8px 12px', color: obj.fill,
        fontSize: `${obj.font_size || Math.max(12, ph * 0.4)}px`,
        fontWeight: 500, lineHeight: 1.4, wordBreak: 'break-word',
        outline: '2px solid var(--accent)', outlineOffset: '2px',
        borderRadius: 'var(--radius-sm)', cursor: 'text',
      }}
    >
      {obj.text_content || ''}
    </div>
  );
}

function DrawFAB({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <div style={{
      position: 'absolute',
      bottom: '16px',
      right: '16px',
      zIndex: 600,
    }}>
      <button
        onClick={onClick}
        title={active ? 'Exit drawing' : 'Draw on canvas'}
        style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          background: active ? 'var(--error)' : 'var(--accent)',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          boxShadow: active
            ? '0 4px 20px rgba(239, 68, 68, 0.4)'
            : '0 4px 20px rgba(59, 130, 246, 0.4)',
          transition: 'transform 0.15s ease, box-shadow 0.15s ease, background 0.2s ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        {active ? <X size={20} /> : <Pencil size={20} />}
      </button>
    </div>
  );
}

function SelectionActionBar({
  count,
  hasGroup,
  hasAttached,
  hasSticky,
  attachMode,
  bottomOffset,
  canCreateTask,
  onGroup,
  onUngroup,
  onAttach,
  onDetach,
  onCreateTask,
  onDelete,
}: {
  count: number;
  hasGroup: boolean;
  hasAttached: boolean;
  hasSticky: boolean;
  attachMode: boolean;
  bottomOffset: number;
  canCreateTask: boolean;
  onGroup: () => void;
  onUngroup: () => void;
  onAttach: () => void;
  onDetach: () => void;
  onCreateTask: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{
      position: 'fixed',
      bottom: `${bottomOffset}px`,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 9999,
      display: 'flex',
      gap: '4px',
      background: 'var(--canvas-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '4px 6px',
      boxShadow: 'var(--shadow-lg)',
    }}>
      <span style={{
        fontSize: '11px', color: 'var(--text-secondary)',
        padding: '4px 8px', display: 'flex', alignItems: 'center',
      }}>
        {count} selected
      </span>

      {attachMode && (
        <span style={{
          fontSize: '10px', color: 'var(--accent)',
          padding: '4px 8px', display: 'flex', alignItems: 'center',
          background: 'var(--accent-subtle)', borderRadius: 'var(--radius-sm)',
        }}>
          Click an item to attach
        </span>
      )}

      {count >= 2 && !hasGroup && (
        <ActionButton icon={<Group size={13} />} label="Group" onClick={onGroup} />
      )}
      {hasGroup && (
        <ActionButton icon={<Ungroup size={13} />} label="Ungroup" onClick={onUngroup} />
      )}
      {hasSticky && count === 1 && !attachMode && (
        <ActionButton icon={<Link2 size={13} />} label="Stick to..." onClick={onAttach} />
      )}
      {hasAttached && (
        <ActionButton icon={<Unlink size={13} />} label="Detach" onClick={onDetach} />
      )}
      {canCreateTask && (
        <ActionButton icon={<ListTodo size={13} />} label="Create task" onClick={onCreateTask} />
      )}
      <ActionButton
        icon={<Trash2 size={13} />}
        label="Delete"
        danger
        onClick={onDelete}
      />
    </div>
  );
}

function ActionButton({
  icon, label, onClick, danger = false,
}: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: '5px',
        padding: '4px 10px',
        background: danger ? 'var(--error-subtle)' : 'var(--canvas-raised)',
        border: danger ? '1px solid rgba(248,113,113,0.3)' : '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', cursor: 'pointer',
        color: danger ? 'var(--error)' : 'var(--text-primary)',
        fontSize: '11px', fontWeight: 500, fontFamily: 'inherit',
        transition: 'background var(--transition-fast)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = danger ? 'rgba(248,113,113,0.15)' : 'var(--accent-subtle)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = danger ? 'var(--error-subtle)' : 'var(--canvas-raised)';
      }}
    >
      {icon}
      {label}
    </button>
  );
}
