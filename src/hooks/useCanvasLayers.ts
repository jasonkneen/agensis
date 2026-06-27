import { useCallback, useEffect, useMemo, useState } from 'react';

export interface CanvasLayer {
  id: string;
  name: string;
  minimized: boolean;
  description?: string;
  icon?: string;
  local_path?: string;
  project_kind?: string;
  git_root?: string;
  git_remote?: string;
  background_opacity?: number | null;
  version?: number;
}

const BASE_LAYER_ID = 'base';

function storageKey(workspaceId: string) {
  return `canvas_layers:${workspaceId}`;
}

function activeStorageKey(workspaceId: string) {
  return `canvas_layers_active:${workspaceId}`;
}

function defaultLayers(): CanvasLayer[] {
  return [{ id: BASE_LAYER_ID, name: 'Workspace 1', minimized: false, background_opacity: 0.42, version: 1 }];
}

function loadLayers(workspaceId: string | null): CanvasLayer[] {
  if (!workspaceId) return defaultLayers();
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return defaultLayers();
    const parsed = JSON.parse(raw) as CanvasLayer[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultLayers();
    if (!parsed.some(layer => layer.id === BASE_LAYER_ID)) {
      return [{ id: BASE_LAYER_ID, name: 'Workspace 1', minimized: true, background_opacity: 0.42, version: 1 }, ...parsed];
    }
    return parsed.map(layer => ({
      ...layer,
      background_opacity: layer.background_opacity ?? 0.42,
      version: layer.version ?? 1,
    }));
  } catch {
    return defaultLayers();
  }
}

function generateLayerId() {
  return `canvas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useCanvasLayers(workspaceId: string | null) {
  const [layers, setLayers] = useState<CanvasLayer[]>(() => loadLayers(workspaceId));
  const [activeLayerId, setActiveLayerId] = useState<string>(() => {
    if (!workspaceId) return BASE_LAYER_ID;
    return localStorage.getItem(activeStorageKey(workspaceId)) || BASE_LAYER_ID;
  });

  useEffect(() => {
    const nextLayers = loadLayers(workspaceId);
    setLayers(nextLayers);

    if (!workspaceId) {
      setActiveLayerId(BASE_LAYER_ID);
      return;
    }

    const savedActive = localStorage.getItem(activeStorageKey(workspaceId));
    const nextActive = nextLayers.find(layer => layer.id === savedActive && !layer.minimized)?.id
      || nextLayers.find(layer => !layer.minimized)?.id
      || nextLayers[0]?.id
      || BASE_LAYER_ID;
    setActiveLayerId(nextActive);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(layers));
  }, [workspaceId, layers]);

  useEffect(() => {
    if (!workspaceId) return;
    localStorage.setItem(activeStorageKey(workspaceId), activeLayerId);
  }, [workspaceId, activeLayerId]);

  useEffect(() => {
    if (!layers.some(layer => layer.id === activeLayerId && !layer.minimized)) {
      const fallback = layers.find(layer => !layer.minimized)?.id || layers[0]?.id || BASE_LAYER_ID;
      if (fallback !== activeLayerId) setActiveLayerId(fallback);
    }
  }, [layers, activeLayerId]);

  const activeLayer = useMemo(
    () => layers.find(layer => layer.id === activeLayerId) || layers[0] || defaultLayers()[0],
    [layers, activeLayerId]
  );

  const createLayer = useCallback((name?: string) => {
    const nextId = generateLayerId();
    setLayers(prev => {
      const nextNumber = prev.length + 1;
      return [
        ...prev.map(layer => layer.id === activeLayerId ? { ...layer, minimized: true } : layer),
        { id: nextId, name: name?.trim() || `Workspace ${nextNumber}`, minimized: false, background_opacity: 0.42, version: 1 },
      ];
    });
    setActiveLayerId(nextId);
    return nextId;
  }, [activeLayerId]);

  const activateLayer = useCallback((id: string) => {
    setLayers(prev => prev.map(layer => {
      if (layer.id === id) return { ...layer, minimized: false };
      if (layer.id === activeLayerId) return { ...layer, minimized: true };
      return layer;
    }));
    setActiveLayerId(id);
  }, [activeLayerId]);

  const minimizeActiveLayer = useCallback(() => {
    const otherLayers = layers.filter(layer => layer.id !== activeLayerId);
    if (otherLayers.length === 0) {
      createLayer();
      return;
    }

    const target = otherLayers[otherLayers.length - 1];
    setLayers(prev => prev.map(layer => {
      if (layer.id === activeLayerId) return { ...layer, minimized: true };
      if (layer.id === target.id) return { ...layer, minimized: false };
      return layer;
    }));
    setActiveLayerId(target.id);
  }, [layers, activeLayerId, createLayer]);

  const deleteLayer = useCallback((id: string) => {
    if (id === BASE_LAYER_ID) return;
    setLayers(prev => {
      const remaining = prev.filter(layer => layer.id !== id);
      if (remaining.length === 0) return defaultLayers();
      return remaining;
    });
    if (activeLayerId === id) {
      const fallback = layers.find(layer => layer.id !== id)?.id || BASE_LAYER_ID;
      setActiveLayerId(fallback);
    }
  }, [activeLayerId, layers]);

  const updateLayer = useCallback((id: string, updates: Partial<CanvasLayer>) => {
    setLayers(prev => prev.map(layer => layer.id === id ? {
      ...layer,
      ...updates,
      version: (layer.version ?? 1) + 1,
    } : layer));
  }, []);

  return {
    layers,
    activeLayer,
    activeLayerId,
    createLayer,
    activateLayer,
    minimizeActiveLayer,
    deleteLayer,
    updateLayer,
    baseLayerId: BASE_LAYER_ID,
  };
}
