import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasObjectRenderer } from './CanvasObjectRenderer';
import { Trash2, Group, Ungroup, Link2, Unlink, ListTodo } from 'lucide-react';
import type { CanvasObject, CanvasTool, CanvasObjectType, CanvasGroup, Task, WorkspaceAgent, PresenceVisibilityMode } from '../../types';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

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
  tasks?: Task[];
  agents?: WorkspaceAgent[];
  getPresenceMode?: (id?: string | null) => PresenceVisibilityMode;
  canEditObject?: (obj: CanvasObject) => boolean;
  onCreateAppletTask?: (input: CreateTaskInput) => void;
  onUpdateAppletTask?: (id: string, updates: Partial<Task>) => void;
}

const STICKY_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#fed7aa'];

type DragSnapshotObject = {
  x: number;
  y: number;
  type: CanvasObjectType;
  points?: Array<{ x: number; y: number }>;
};

type DragSnapshot = {
  anchorBounds: { x: number; y: number; width: number; height: number };
  offset: { x: number; y: number };
  moveIds: Set<string>;
  objects: Map<string, DragSnapshotObject>;
  canvasRect: { left: number; top: number; width: number; height: number };
  latestDelta: { x: number; y: number };
};

type ResizeSnapshot = {
  id: string;
  handle: 'nw' | 'ne' | 'sw' | 'se';
  startMouse: { x: number; y: number };
  startRect: { x: number; y: number; width: number; height: number };
  canvasRect: { left: number; top: number; width: number; height: number };
  latestRect: { x: number; y: number; width: number; height: number };
};

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
  tasks = [],
  agents = [],
  getPresenceMode = () => 'visible',
  canEditObject = () => true,
  onCreateAppletTask,
  onUpdateAppletTask,
}: DrawingLayerProps) {
  const [tool, setTool] = useState<CanvasTool>('select');
  const [color, setColor] = useState('#3b82f6');
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [lastMousePos, setLastMousePos] = useState<{ x: number; y: number } | null>(null);
  const [activeStrokeId, setActiveStrokeId] = useState<string | null>(null);
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
  const dragSnapshotRef = useRef<DragSnapshot | null>(null);
  const resizeSnapshotRef = useRef<ResizeSnapshot | null>(null);

  const activeTool = drawingActive ? tool : 'select';

  const setHostInteractionLocked = useCallback((locked: boolean) => {
    if (typeof document === 'undefined') return;
    document.documentElement.toggleAttribute('data-canvas-host-interaction', locked);
  }, []);

  const getCanvasItemElements = useCallback((id: string) => {
    const root = layerRef.current?.parentElement;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(`[data-canvas-item-id="${id}"]`));
  }, []);

  const setCanvasItemTransform = useCallback((id: string, transform: string) => {
    getCanvasItemElements(id).forEach(element => {
      if (element.dataset.baseTransform === undefined) {
        element.dataset.baseTransform = element.style.transform || 'none';
      }
      const baseTransform = element.dataset.baseTransform === 'none' ? '' : element.dataset.baseTransform;
      element.dataset.transforming = 'true';
      element.style.transform = `${transform} ${baseTransform}`.trim();
    });
  }, [getCanvasItemElements]);

  const clearCanvasItemTransform = useCallback((id: string) => {
    getCanvasItemElements(id).forEach(element => {
      const baseTransform = element.dataset.baseTransform;
      delete element.dataset.transforming;
      delete element.dataset.baseTransform;
      element.style.transform = baseTransform && baseTransform !== 'none' ? baseTransform : '';
      element.style.transformOrigin = '';
    });
  }, [getCanvasItemElements]);

  const clearCanvasItemTransforms = useCallback((ids: Iterable<string>) => {
    Array.from(ids).forEach(clearCanvasItemTransform);
  }, [clearCanvasItemTransform]);

  const previewDragToPosition = useCallback((pos: { x: number; y: number }) => {
    const snapshot = dragSnapshotRef.current;
    if (!snapshot) return;

    const dx = pos.x - snapshot.offset.x - snapshot.anchorBounds.x;
    const dy = pos.y - snapshot.offset.y - snapshot.anchorBounds.y;
    snapshot.latestDelta = { x: dx, y: dy };

    const tx = (dx / 100) * snapshot.canvasRect.width;
    const ty = (dy / 100) * snapshot.canvasRect.height;
    snapshot.moveIds.forEach(id => setCanvasItemTransform(id, `translate3d(${tx}px, ${ty}px, 0)`));
  }, [setCanvasItemTransform]);

  const commitDrag = useCallback(() => {
    const snapshot = dragSnapshotRef.current;
    if (!snapshot) return;

    const { x: dx, y: dy } = snapshot.latestDelta;
    snapshot.moveIds.forEach(id => {
      const start = snapshot.objects.get(id);
      if (!start) return;
      const pointUpdates = start.points && start.points.length >= 2 && (start.type === 'pen' || start.type === 'line' || start.type === 'arrow')
        ? { points: start.points.map(point => ({ x: point.x + dx, y: point.y + dy })) }
        : {};
      onUpdateObject(id, { x: start.x + dx, y: start.y + dy, ...pointUpdates });
    });
    clearCanvasItemTransforms(snapshot.moveIds);
    dragSnapshotRef.current = null;
  }, [clearCanvasItemTransforms, onUpdateObject]);

  const endDrag = useCallback((commit = true) => {
    const snapshot = dragSnapshotRef.current;
    if (snapshot) {
      if (commit) commitDrag();
      else {
        clearCanvasItemTransforms(snapshot.moveIds);
        dragSnapshotRef.current = null;
      }
    }
    setIsDragging(false);
    setHostInteractionLocked(false);
  }, [clearCanvasItemTransforms, commitDrag, setHostInteractionLocked]);

  const computeResizeRect = useCallback((snapshot: ResizeSnapshot, pos: { x: number; y: number }) => {
    const { startMouse, startRect, handle } = snapshot;
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

    return { x: nextX, y: nextY, width: nextWidth, height: nextHeight };
  }, []);

  const previewResizeToPosition = useCallback((pos: { x: number; y: number }) => {
    const snapshot = resizeSnapshotRef.current;
    if (!snapshot) return;
    const next = computeResizeRect(snapshot, pos);
    snapshot.latestRect = next;

    const tx = ((next.x - snapshot.startRect.x) / 100) * snapshot.canvasRect.width;
    const ty = ((next.y - snapshot.startRect.y) / 100) * snapshot.canvasRect.height;
    const scaleX = next.width / snapshot.startRect.width;
    const scaleY = next.height / snapshot.startRect.height;
    getCanvasItemElements(snapshot.id).forEach(element => {
      if (element.dataset.baseTransform === undefined) {
        element.dataset.baseTransform = element.style.transform || 'none';
      }
      const baseTransform = element.dataset.baseTransform === 'none' ? '' : element.dataset.baseTransform;
      element.dataset.transforming = 'true';
      element.style.transformOrigin = 'top left';
      element.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scaleX}, ${scaleY}) ${baseTransform}`.trim();
    });
  }, [computeResizeRect, getCanvasItemElements]);

  const endResize = useCallback((commit = true) => {
    const snapshot = resizeSnapshotRef.current;
    if (snapshot) {
      if (commit) {
        onUpdateObject(snapshot.id, snapshot.latestRect);
      }
      clearCanvasItemTransform(snapshot.id);
      resizeSnapshotRef.current = null;
    }
    setResizeState(null);
    setHostInteractionLocked(false);
  }, [clearCanvasItemTransform, onUpdateObject, setHostInteractionLocked]);

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

  const expandSelection = useCallback((seedIds: Iterable<string>) => {
    const next = new Set<string>();
    for (const seedId of seedIds) {
      const obj = objects.find(o => o.id === seedId);
      if (!obj) continue;
      if (obj.group_id) {
        objects.filter(item => item.group_id === obj.group_id).forEach(item => next.add(item.id));
      } else {
        next.add(seedId);
      }
    }
    return next;
  }, [objects]);

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
      if (isDragging) previewDragToPosition(pos);
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
  }, [isDrawing, isDragging, activeTool, color, strokeWidth,
      activeStrokeId, toPercent, onAddObject, onUpdateObject, boxSelectStart, previewDragToPosition]);

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
      endDrag();
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
      color, strokeWidth, onAddObject, onUpdateObject, boxSelect, boxSelectStart, objects, endDrag]);

  const handleObjectSelect = useCallback((id: string, e: React.MouseEvent) => {
    if (editingTextId) return;
    const obj = objects.find(o => o.id === id);
    const editable = obj ? canEditObject(obj) : false;

    if (activeTool === 'eraser') {
      if (editable) onDeleteObject(id);
      return;
    }

    if (attachMode && selectedIds.size === 1) {
      const stickyId = Array.from(selectedIds)[0];
      const sticky = objects.find(o => o.id === stickyId);
      if (sticky && canEditObject(sticky) && (sticky.type === 'sticky_note') && id !== stickyId) {
        onUpdateObject(stickyId, { attached_to: id });
        onBringToFront(stickyId);
        setAttachMode(false);
        setSelectedIds(new Set([stickyId]));
        return;
      }
    }

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
    if (editable) onBringToFront(id);
  }, [activeTool, objects, canEditObject, onDeleteObject, onBringToFront, attachMode, selectedIds, onUpdateObject, editingTextId]);

  const handleObjectDragStart = useCallback((id: string, e: React.MouseEvent) => {
    if (editingTextId) return;
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pos = toPercent(e.clientX, e.clientY);
    const obj = objects.find(o => o.id === id);
    if (!obj) return;
    if (!canEditObject(obj)) return;
    const baseSelection = selectedIds.has(id) ? selectedIds : new Set([id]);
    const primaryIds = expandSelection(baseSelection);
    primaryIds.add(id);
    const primaryObjects = Array.from(primaryIds)
      .map(moveId => objects.find(o => o.id === moveId))
      .filter(Boolean) as CanvasObject[];
    if (primaryObjects.some(item => !canEditObject(item))) return;

    const moveIds = new Set(primaryIds);
    objects.forEach(item => {
      if (item.attached_to && primaryIds.has(item.attached_to) && canEditObject(item)) {
        moveIds.add(item.id);
      }
    });

    const bounds = getObjectBounds(obj);
    const snapshotObjects = new Map<string, DragSnapshotObject>();
    moveIds.forEach(moveId => {
      const item = objects.find(o => o.id === moveId);
      if (!item) return;
      snapshotObjects.set(moveId, {
        x: item.x,
        y: item.y,
        type: item.type,
        points: item.points?.map(point => ({ ...point })),
      });
    });

    setSelectedIds(new Set(primaryIds));
    dragSnapshotRef.current = {
      anchorBounds: bounds,
      offset: { x: pos.x - bounds.x, y: pos.y - bounds.y },
      moveIds,
      objects: snapshotObjects,
      canvasRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      latestDelta: { x: 0, y: 0 },
    };
    setHostInteractionLocked(true);
    setIsDragging(true);
  }, [objects, selectedIds, expandSelection, toPercent, editingTextId, getObjectBounds, setHostInteractionLocked, canEditObject]);

  const handleDoubleClick = useCallback((id: string) => {
    const obj = objects.find(o => o.id === id);
    if (!obj) return;
    if (!canEditObject(obj)) return;
    if (obj.type === 'text' || obj.type === 'sticky_note') {
      setEditingTextId(id);
      setSelectedIds(new Set([id]));
    }
  }, [objects, canEditObject]);

  const handleGroup = useCallback(async () => {
    if (selectedIds.size < 2) return;
    const selection = Array.from(selectedIds)
      .map(id => objects.find(o => o.id === id))
      .filter(Boolean) as CanvasObject[];
    if (selection.some(obj => !canEditObject(obj))) return;
    const name = `Group ${groups.length + 1}`;
    const grp = await onCreateGroup(name, Array.from(selectedIds), color);
    if (grp) setSelectedIds(new Set());
  }, [selectedIds, objects, canEditObject, groups.length, color, onCreateGroup]);

  const handleUngroup = useCallback(() => {
    const groupIds = new Set<string>();
    selectedIds.forEach(id => {
      const obj = objects.find(o => o.id === id);
      if (obj?.group_id && canEditObject(obj)) groupIds.add(obj.group_id);
    });
    groupIds.forEach(gid => onDeleteGroup(gid));
    setSelectedIds(new Set());
  }, [selectedIds, objects, canEditObject, onDeleteGroup]);

  const handleDetach = useCallback(() => {
    selectedIds.forEach(id => {
      const obj = objects.find(o => o.id === id);
      if (obj?.attached_to && canEditObject(obj)) onUpdateObject(id, { attached_to: null });
    });
  }, [selectedIds, objects, canEditObject, onUpdateObject]);

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
        selectedIds.forEach(id => {
          const obj = objects.find(o => o.id === id);
          if (obj && canEditObject(obj)) onDeleteObject(id);
        });
        setSelectedIds(new Set());
      }
      if (e.key === 'Escape') {
        endDrag(false);
        endResize(false);
        setSelectedIds(new Set());
        setAttachMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, objects, canEditObject, onDeleteObject, editingTextId, endDrag, endResize]);

  const handleResizeStart = useCallback((id: string, handle: 'nw' | 'ne' | 'sw' | 'se', e: React.MouseEvent) => {
    e.stopPropagation();
    const obj = objects.find(o => o.id === id);
    if (!obj || obj.type === 'pen' || editingTextId) return;
    if (!canEditObject(obj)) return;
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pos = toPercent(e.clientX, e.clientY);
    const snapshot: ResizeSnapshot = {
      id,
      handle,
      startMouse: pos,
      startRect: { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
      canvasRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      latestRect: { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
    };
    resizeSnapshotRef.current = snapshot;
    setSelectedIds(new Set([id]));
    onBringToFront(id);
    setHostInteractionLocked(true);
    setResizeState({
      id,
      handle,
      startMouse: pos,
      startRect: { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
    });
  }, [objects, editingTextId, canEditObject, toPercent, onBringToFront, setHostInteractionLocked]);

  useEffect(() => {
    if (!isDragging) return;
    const handleDocMouseMove = (e: MouseEvent) => {
      const snapshot = dragSnapshotRef.current;
      if (!isDragging || !snapshot) return;
      const r = snapshot.canvasRect;
      const pos = {
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
      };
      previewDragToPosition(pos);
    };
    const handleDocMouseUp = () => endDrag();
    const handlePointerCancel = () => endDrag();
    const handleWindowBlur = () => endDrag();
    const handleDragEnd = () => endDrag();
    document.addEventListener('mousemove', handleDocMouseMove);
    document.addEventListener('mouseup', handleDocMouseUp);
    window.addEventListener('mouseup', handleDocMouseUp);
    window.addEventListener('pointerup', handleDocMouseUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('dragend', handleDragEnd);
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove);
      document.removeEventListener('mouseup', handleDocMouseUp);
      window.removeEventListener('mouseup', handleDocMouseUp);
      window.removeEventListener('pointerup', handleDocMouseUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('dragend', handleDragEnd);
      setHostInteractionLocked(false);
    };
  }, [isDragging, previewDragToPosition, endDrag, setHostInteractionLocked]);

  useEffect(() => {
    if (!resizeState || !layerRef.current) return;

    const handleDocMouseMove = (e: MouseEvent) => {
      const snapshot = resizeSnapshotRef.current;
      if (!resizeState || !snapshot) return;
      const r = snapshot.canvasRect;
      const pos = {
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
      };
      previewResizeToPosition(pos);
    };

    const handleDocMouseUp = () => endResize();

    document.addEventListener('mousemove', handleDocMouseMove);
    document.addEventListener('mouseup', handleDocMouseUp);
    window.addEventListener('mouseup', handleDocMouseUp);
    window.addEventListener('pointerup', handleDocMouseUp);
    window.addEventListener('pointercancel', handleDocMouseUp);
    window.addEventListener('blur', handleDocMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove);
      document.removeEventListener('mouseup', handleDocMouseUp);
      window.removeEventListener('mouseup', handleDocMouseUp);
      window.removeEventListener('pointerup', handleDocMouseUp);
      window.removeEventListener('pointercancel', handleDocMouseUp);
      window.removeEventListener('blur', handleDocMouseUp);
      if (resizeSnapshotRef.current) endResize(false);
    };
  }, [resizeState, previewResizeToPosition, endResize]);

  useEffect(() => {
    return () => setHostInteractionLocked(false);
  }, [setHostInteractionLocked]);

  const { w: canvasW, h: canvasH } = getSize();
  const objectById = new Map(objects.map(obj => [obj.id, obj]));
  const displayZIndexOf = (obj: CanvasObject) => {
    const parent = obj.attached_to ? objectById.get(obj.attached_to) : null;
    return parent ? Math.max(obj.z_index, parent.z_index + 1) : obj.z_index;
  };
  const sorted = [...objects].sort((a, b) => displayZIndexOf(a) - displayZIndexOf(b));

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
    && canEditObject(singleSelectedObj)
    && (singleSelectedObj.text_content || '').trim()
    ? singleSelectedObj
    : undefined;
  const canMutateSelection = Array.from(selectedIds).every(id => {
    const obj = objects.find(o => o.id === id);
    return !!obj && canEditObject(obj);
  });

  const selectionBar = selectedIds.size > 0 && !editingTextId ? (
    <SelectionActionBar
      count={selectedIds.size}
      canMutateSelection={canMutateSelection}
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
        selectedIds.forEach(id => {
          const obj = objects.find(o => o.id === id);
          if (obj && canEditObject(obj)) onDeleteObject(id);
        });
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
            onTextChange={(text) => {
              if (canEditObject(obj)) onUpdateObject(obj.id, { text_content: text });
            }}
            onStopEditing={() => setEditingTextId(null)}
            onResizeStart={(handle, e) => handleResizeStart(obj.id, handle, e)}
            showResizeHandles={canEditObject(obj) && selectedIds.size === 1 && selectedIds.has(obj.id) && tool === 'select'}
            tasks={tasks}
            agents={agents}
            presenceMode={getPresenceMode(obj.user_id)}
            hostInteractionActive={anyInteraction}
            onAppletStateChange={canEditObject(obj) ? (stateText) => onUpdateObject(obj.id, { text_content: stateText }) : undefined}
            onAppletCreateTask={onCreateAppletTask}
            onAppletUpdateTask={onUpdateAppletTask}
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
          onTextChange={(text) => {
            if (canEditObject(obj)) onUpdateObject(obj.id, { text_content: text });
          }}
          onStopEditing={() => setEditingTextId(null)}
          onResizeStart={(handle, e) => handleResizeStart(obj.id, handle, e)}
          showResizeHandles={canEditObject(obj) && selectedIds.size === 1 && selectedIds.has(obj.id) && activeTool === 'select'}
          tasks={tasks}
          agents={agents}
          presenceMode={getPresenceMode(obj.user_id)}
          hostInteractionActive={anyInteraction}
          onAppletStateChange={canEditObject(obj) ? (stateText) => onUpdateObject(obj.id, { text_content: stateText }) : undefined}
          onAppletCreateTask={onCreateAppletTask}
          onAppletUpdateTask={onUpdateAppletTask}
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

      {drawingActive && (
        <CanvasToolbar
          activeTool={tool}
          activeColor={color}
          strokeWidth={strokeWidth}
          onToolChange={setTool}
          onColorChange={setColor}
          onStrokeWidthChange={setStrokeWidth}
          onExitDrawing={onToggleDrawing}
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
  layerRef: React.RefObject<HTMLDivElement | null>;
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
  tasks = [],
  agents = [],
  presenceMode = 'visible',
  onAppletStateChange,
  onAppletCreateTask,
  onAppletUpdateTask,
  hostInteractionActive = false,
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
  tasks?: Task[];
  agents?: WorkspaceAgent[];
  presenceMode?: PresenceVisibilityMode;
  onAppletStateChange?: (stateText: string) => void;
  onAppletCreateTask?: (input: CreateTaskInput) => void;
  onAppletUpdateTask?: (id: string, updates: Partial<Task>) => void;
  hostInteractionActive?: boolean;
  interactive?: boolean;
}) {
  const showAttachLine = parentObj && !editing;
  const displayZIndex = parentObj ? Math.max(obj.z_index, parentObj.z_index + 1) : obj.z_index;
  const px = (obj.x / 100) * canvasW;
  const py = (obj.y / 100) * canvasH;
  const pw = (obj.width / 100) * canvasW;
  const ph = (obj.height / 100) * canvasH;
  const dimmedByPresence = (presenceMode === 'dimmed' || presenceMode === 'hidden') && !editing;
  const presenceStyle = dimmedByPresence
    ? {
        opacity: presenceMode === 'hidden' ? 0.22 : 0.35,
        filter: 'saturate(0.55)',
      }
    : undefined;

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
            pointerEvents: 'none', zIndex: displayZIndex - 1,
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
            zIndex: displayZIndex,
            pointerEvents: 'none',
            opacity: presenceStyle?.opacity,
            filter: presenceStyle?.filter,
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
                hostInteractionActive={hostInteractionActive}
                tasks={tasks}
                agents={agents}
                onAppletStateChange={onAppletStateChange}
                onAppletCreateTask={onAppletCreateTask}
                onAppletUpdateTask={onAppletUpdateTask}
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
          pointerEvents: 'none', zIndex: displayZIndex - 1,
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
        style={presenceStyle}
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
              hostInteractionActive={hostInteractionActive}
              tasks={tasks}
              agents={agents}
              onAppletStateChange={onAppletStateChange}
              onAppletCreateTask={onAppletCreateTask}
              onAppletUpdateTask={onAppletUpdateTask}
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
          data-resize-handle
          onMouseDown={(e) => {
            e.preventDefault();
            onResizeStart(handle.key, e);
          }}
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
      <Textarea
        ref={ref}
        defaultValue={obj.text_content}
        onBlur={(e) => { onTextChange(e.target.value); onStopEditing(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { onTextChange(e.currentTarget.value); onStopEditing(); } }}
        className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 text-sm leading-relaxed text-neutral-950 shadow-none focus-visible:ring-0"
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

function SelectionActionBar({
  count,
  canMutateSelection,
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
  canMutateSelection: boolean;
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
    <div
      className="fixed left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-popover px-1.5 py-1 shadow-lg"
      style={{ bottom: `${bottomOffset}px` }}
    >
      <Badge variant="outline" className="text-[11px]">
        {count} selected
      </Badge>

      {attachMode && (
        <Badge variant="secondary" className="text-[10px]">
          Click an item to attach
        </Badge>
      )}

      {!canMutateSelection && (
        <Badge variant="secondary" className="text-[10px]">
          Read only
        </Badge>
      )}

      {canMutateSelection && count >= 2 && !hasGroup && (
        <ActionButton icon={<Group data-icon="inline-start" className="size-3.5" />} label="Group" onClick={onGroup} />
      )}
      {canMutateSelection && hasGroup && (
        <ActionButton icon={<Ungroup data-icon="inline-start" className="size-3.5" />} label="Ungroup" onClick={onUngroup} />
      )}
      {canMutateSelection && hasSticky && count === 1 && !attachMode && (
        <ActionButton icon={<Link2 data-icon="inline-start" className="size-3.5" />} label="Stick to..." onClick={onAttach} />
      )}
      {canMutateSelection && hasAttached && (
        <ActionButton icon={<Unlink data-icon="inline-start" className="size-3.5" />} label="Detach" onClick={onDetach} />
      )}
      {canMutateSelection && canCreateTask && (
        <ActionButton icon={<ListTodo data-icon="inline-start" className="size-3.5" />} label="Create task" onClick={onCreateTask} />
      )}
      {canMutateSelection && (
        <ActionButton
          icon={<Trash2 data-icon="inline-start" className="size-3.5" />}
          label="Delete"
          danger
          onClick={onDelete}
        />
      )}
    </div>
  );
}

function ActionButton({
  icon, label, onClick, danger = false,
}: {
  icon: ReactNode; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={danger ? 'destructive' : 'outline'}
      size="xs"
      onClick={onClick}
      title={label}
      className={cn('text-[11px]', danger && 'border-destructive/30')}
    >
      {icon}
      {label}
    </Button>
  );
}
