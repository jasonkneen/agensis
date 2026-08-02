import { DEFAULT_BACKGROUND_OPACITY } from '../lib/wallpaperDefaults';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backendClient } from '../lib/backendClient';
import { defaultDesktopName, FIRST_DESKTOP_NAME } from '../lib/desktopOverlay';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';

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
  background_image?: string | null;
  sort_order?: number;
  version?: number;
}

// A `canvas_layers` row. `layer_id` — NOT `id` — is the layer identity that
// canvas_objects.layer_id stores; `id` is the row's own uuid primary key.
export interface CanvasLayerRow {
  id?: string;
  workspace_id?: string;
  layer_id: string;
  name?: string | null;
  sort_order?: number | null;
  description?: string | null;
  icon?: string | null;
  local_path?: string | null;
  project_kind?: string | null;
  git_root?: string | null;
  git_remote?: string | null;
  background_opacity?: number | null;
  background_image?: string | null;
  version?: number | null;
}

const BASE_LAYER_ID = 'base';

// Layer identity, name and ordering live in the workspace-scoped `canvas_layers`
// table so a canvas one member creates is visible to the rest of the workspace.
// This key now holds a per-browser MIRROR of that shared list, so the canvas
// paints instantly on load (and survives a backend hiccup) instead of flashing
// the default layer while the select is in flight. It is also the migration
// source for browsers that predate the table — see adoptedStorageKey.
function storageKey(workspaceId: string) {
  return `canvas_layers:${workspaceId}`;
}

// Which layer is open is genuinely per-browser, so it stays local.
function activeStorageKey(workspaceId: string) {
  return `canvas_layers_active:${workspaceId}`;
}

// Set once this browser's pre-table localStorage layers have been written into
// canvas_layers. Without it every mount would re-insert (and so resurrect) a
// layer that someone has since deleted.
function adoptedStorageKey(workspaceId: string) {
  return `canvas_layers_adopted:${workspaceId}`;
}

// "Main", not "Workspace 1": a canvas_layers row is one DESKTOP inside a
// workspace — a window/wallpaper configuration, not a place content lives — and
// calling every workspace's first one "Workspace 1" is most of why the two
// concepts were impossible to tell apart. Existing rows keep whatever name they
// were given; this is only the name a new one gets.
function defaultLayers(): CanvasLayer[] {
  return [{ id: BASE_LAYER_ID, name: FIRST_DESKTOP_NAME, minimized: false, background_opacity: DEFAULT_BACKGROUND_OPACITY, background_image: '', sort_order: 0, version: 1 }];
}

function loadLayers(workspaceId: string | null): CanvasLayer[] {
  if (!workspaceId) return defaultLayers();
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return defaultLayers();
    const parsed = JSON.parse(raw) as CanvasLayer[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultLayers();
    const known = parsed.map(layer => ({
      ...layer,
      background_opacity: layer.background_opacity ?? DEFAULT_BACKGROUND_OPACITY,
      background_image: layer.background_image ?? '',
      version: layer.version ?? 1,
    }));
    if (!known.some(layer => layer.id === BASE_LAYER_ID)) return [...defaultLayers(), ...known];
    return known;
  } catch {
    return defaultLayers();
  }
}

function generateLayerId() {
  return `canvas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Names for layers this client only learned about from canvas_objects.layer_id
// (a layer drawn on by a browser that predates canvas_layers). The same set of
// ids sorts the same way everywhere, so every client derives the same name until
// someone renames the layer.
function nextDerivedLayerName(used: Set<string>) {
  let index = 1;
  while (used.has(`Shared desktop ${index}`)) index += 1;
  const name = `Shared desktop ${index}`;
  used.add(name);
  return name;
}

export function rowToCanvasLayer(row: CanvasLayerRow): CanvasLayer {
  return {
    id: row.layer_id,
    name: row.name || 'Desktop',
    minimized: true,
    description: row.description ?? undefined,
    icon: row.icon ?? undefined,
    local_path: row.local_path ?? undefined,
    project_kind: row.project_kind ?? undefined,
    git_root: row.git_root ?? undefined,
    git_remote: row.git_remote ?? undefined,
    background_opacity: row.background_opacity ?? DEFAULT_BACKGROUND_OPACITY,
    background_image: row.background_image ?? '',
    sort_order: typeof row.sort_order === 'number' ? row.sort_order : 0,
    version: row.version ?? 1,
  };
}

// The base layer is always first; the rest follow the shared sort_order, with
// the id as a tiebreak so every client lists them in the same order.
export function sortCanvasLayers(layers: CanvasLayer[]): CanvasLayer[] {
  return [...layers].sort((a, b) => {
    if (a.id === BASE_LAYER_ID || b.id === BASE_LAYER_ID) {
      return a.id === b.id ? 0 : a.id === BASE_LAYER_ID ? -1 : 1;
    }
    const orderA = a.sort_order ?? 0;
    const orderB = b.sort_order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Layers that exist somewhere but have no `canvas_layers` row yet:
 *  - `cached` — this browser's pre-table localStorage layers (once only, see
 *    adoptedStorageKey), so nobody's canvases vanish on upgrade;
 *  - `objectLayerIds` — every layer id that actually has objects in the shared
 *    DB (checked on every load), so work drawn by a client that has not migrated
 *    yet stays reachable rather than being stranded on an unknown layer.
 * Returns them ready to insert, with a sort_order after the known ones.
 */
export function layersToAdopt(
  known: CanvasLayer[],
  cached: CanvasLayer[],
  objectLayerIds: string[],
  includeCached: boolean,
): CanvasLayer[] {
  const knownIds = new Set(known.map(layer => layer.id));
  const adopt: CanvasLayer[] = [];
  if (includeCached) {
    for (const layer of cached) {
      if (!layer.id || knownIds.has(layer.id)) continue;
      knownIds.add(layer.id);
      adopt.push(layer);
    }
  }
  const usedNames = new Set([...known, ...adopt].map(layer => layer.name));
  const orphans = [...new Set(objectLayerIds)].filter(id => id && !knownIds.has(id)).sort();
  for (const id of orphans) {
    knownIds.add(id);
    adopt.push({ id, name: nextDerivedLayerName(usedNames), minimized: true, background_opacity: DEFAULT_BACKGROUND_OPACITY, background_image: '', version: 1 });
  }
  const maxOrder = known.reduce((max, layer) => Math.max(max, layer.sort_order ?? 0), 0);
  return adopt.map((layer, index) => ({
    ...layer,
    sort_order: layer.id === BASE_LAYER_ID ? 0 : maxOrder + index + 1,
  }));
}

// Columns a layer edit may write. `minimized` is per-browser and `version` is
// bumped by the backend, so neither is ever sent.
const LAYER_ROW_COLUMNS = [
  'name',
  'sort_order',
  'description',
  'icon',
  'local_path',
  'project_kind',
  'git_root',
  'git_remote',
  'background_opacity',
  'background_image',
] as const;

export function layerRowValues(updates: Partial<CanvasLayer>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const column of LAYER_ROW_COLUMNS) {
    const value = updates[column];
    if (value !== undefined) values[column] = value;
  }
  return values;
}

function layerInsertValues(workspaceId: string, layer: CanvasLayer): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    layer_id: layer.id,
    name: layer.name,
    sort_order: layer.sort_order ?? 0,
    description: layer.description ?? '',
    icon: layer.icon ?? '',
    local_path: layer.local_path ?? '',
    project_kind: layer.project_kind ?? '',
    git_root: layer.git_root ?? '',
    git_remote: layer.git_remote ?? '',
    background_opacity: layer.background_opacity ?? DEFAULT_BACKGROUND_OPACITY,
    background_image: layer.background_image ?? '',
  };
}

function upsertLayer(layers: CanvasLayer[], layer: CanvasLayer): CanvasLayer[] {
  const index = layers.findIndex(item => item.id === layer.id);
  if (index === -1) return sortCanvasLayers([...layers, layer]);
  const next = [...layers];
  next[index] = { ...next[index], ...layer };
  return sortCanvasLayers(next);
}

export function useCanvasLayers(workspaceId: string | null) {
  const workspaceIdentityRef = useRef({ workspaceId, generation: 0 });
  if (workspaceIdentityRef.current.workspaceId !== workspaceId) {
    workspaceIdentityRef.current = {
      workspaceId,
      generation: workspaceIdentityRef.current.generation + 1,
    };
  }
  const workspaceIdentity = workspaceIdentityRef.current;
  // Shared layer definitions. `minimized` on these is meaningless — the rendered
  // list below derives it from activeLayerId, which is the single source of
  // truth for which layer this browser has open.
  const [definitions, setDefinitions] = useState<CanvasLayer[]>(() => loadLayers(workspaceId));
  const [activeLayerId, setActiveLayerId] = useState<string>(() => {
    if (!workspaceId) return BASE_LAYER_ID;
    return localStorage.getItem(activeStorageKey(workspaceId)) || BASE_LAYER_ID;
  });
  const [loaded, setLoaded] = useState(false);
  // Which workspace `definitions` actually came from.
  //
  // `workspaceId` is the caller's PROP: it changes on the render that switches
  // workspace, while `definitions` still holds the previous workspace's layers
  // until the effect below runs. Anything that pairs a layer list with a
  // workspace name (the canvas overlay) must key off this, not off the prop, or
  // it paints workspace A's desktops under workspace B's heading for a frame.
  const [layersWorkspaceId, setLayersWorkspaceId] = useState<string | null>(workspaceId);

  const layers = useMemo(
    () => definitions.map(layer => ({ ...layer, minimized: layer.id !== activeLayerId })),
    [definitions, activeLayerId]
  );
  const layersRef = useRef(layers);
  useEffect(() => { layersRef.current = layers; }, [layers]);

  useEffect(() => {
    setDefinitions(loadLayers(workspaceId));
    setLayersWorkspaceId(workspaceId);
    setLoaded(false);

    if (!workspaceId) {
      setActiveLayerId(BASE_LAYER_ID);
      return;
    }

    // Keep the saved active layer even when the mirror has never heard of it —
    // it may be a layer a teammate created, which the load below will bring in.
    setActiveLayerId(localStorage.getItem(activeStorageKey(workspaceId)) || BASE_LAYER_ID);
  }, [workspaceId]);

  // Load the shared layer list, adopting anything that predates the table (see
  // layersToAdopt). The canvas_objects read is layer_id-only — strictly smaller
  // than the object fetch useCanvasObjects runs right after this hook.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const [layerResult, objectResult] = await Promise.all([
        backendClient
          .from('canvas_layers')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('sort_order', { ascending: true }),
        backendClient
          .from('canvas_objects')
          .select('layer_id')
          .eq('workspace_id', workspaceId),
      ]);
      if (cancelled) return;
      // Backend unreachable (or the table not deployed yet) — keep the mirror.
      if (!Array.isArray(layerResult.data)) return;

      const known = (layerResult.data as CanvasLayerRow[]).map(rowToCanvasLayer);
      const objectLayerIds = Array.isArray(objectResult.data)
        ? (objectResult.data as { layer_id?: string | null }[]).map(row => row.layer_id || BASE_LAYER_ID)
        : [];
      const includeCached = localStorage.getItem(adoptedStorageKey(workspaceId)) !== '1';
      const adopt = layersToAdopt(known, loadLayers(workspaceId), objectLayerIds, includeCached);

      // Show the adopted layers whether or not the write below lands: a
      // read-only member can't insert, and their teammates' work must still be
      // reachable in that browser.
      setDefinitions(sortCanvasLayers([...known, ...adopt]));
      setLoaded(true);

      if (adopt.length === 0) {
        if (includeCached) localStorage.setItem(adoptedStorageKey(workspaceId), '1');
        return;
      }
      // Best effort: UNIQUE (workspace_id, layer_id) makes a race between two
      // clients a no-op rather than a duplicate. Only mark the migration done
      // once it actually succeeded, so a denied/failed write is retried.
      const { error } = await backendClient
        .from('canvas_layers')
        .insert(adopt.map(layer => layerInsertValues(workspaceId, layer)))
        .select('layer_id');
      if (!cancelled && includeCached && !error) {
        localStorage.setItem(adoptedStorageKey(workspaceId), '1');
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<CanvasLayerRow>(
    {
      enabled: !!workspaceId,
      channelName: `canvas_layers:${workspaceId}`,
      table: 'canvas_layers',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (workspaceIdentityRef.current !== workspaceIdentity) return;
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.layer_id) return;
        setDefinitions(prev => prev.filter(layer => layer.id !== row.layer_id));
        return;
      }
      const row = payload.new;
      if (!row?.layer_id) return;
      setDefinitions(prev => upsertLayer(prev, rowToCanvasLayer(row)));
    },
  );

  useEffect(() => {
    if (!workspaceId || layersWorkspaceId !== workspaceId) return;
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(layers));
  }, [workspaceId, layers, layersWorkspaceId]);

  useEffect(() => {
    if (!workspaceId || layersWorkspaceId !== workspaceId) return;
    localStorage.setItem(activeStorageKey(workspaceId), activeLayerId);
  }, [workspaceId, activeLayerId, layersWorkspaceId]);

  // Only once the shared list has loaded — before that the saved active layer
  // may simply not be in the mirror yet.
  useEffect(() => {
    if (!loaded) return;
    if (layers.some(layer => layer.id === activeLayerId)) return;
    const fallback = layers[0]?.id || BASE_LAYER_ID;
    if (fallback !== activeLayerId) setActiveLayerId(fallback);
  }, [loaded, layers, activeLayerId]);

  const activeLayer = useMemo(
    () => layers.find(layer => layer.id === activeLayerId) || layers[0] || defaultLayers()[0],
    [layers, activeLayerId]
  );

  const createLayer = useCallback((name?: string) => {
    const current = layersRef.current;
    const nextId = generateLayerId();
    const layer: CanvasLayer = {
      id: nextId,
      name: name?.trim() || defaultDesktopName(current),
      minimized: false,
      background_opacity: DEFAULT_BACKGROUND_OPACITY,
      background_image: '',
      sort_order: current.reduce((max, item) => Math.max(max, item.sort_order ?? 0), 0) + 1,
      version: 1,
    };
    setDefinitions(prev => upsertLayer(prev, layer));
    setActiveLayerId(nextId);
    if (workspaceId) {
      void backendClient
        .from('canvas_layers')
        .insert(layerInsertValues(workspaceId, layer))
        .select('layer_id');
    }
    return nextId;
  }, [workspaceId]);

  const activateLayer = useCallback((id: string) => {
    setActiveLayerId(id);
  }, []);

  const minimizeActiveLayer = useCallback(() => {
    const otherLayers = layers.filter(layer => layer.id !== activeLayerId);
    if (otherLayers.length === 0) {
      createLayer();
      return;
    }
    setActiveLayerId(otherLayers[otherLayers.length - 1].id);
  }, [layers, activeLayerId, createLayer]);

  const deleteLayer = useCallback((id: string) => {
    if (id === BASE_LAYER_ID) return;
    setDefinitions(prev => {
      const remaining = prev.filter(layer => layer.id !== id);
      if (remaining.length === 0) return defaultLayers();
      return remaining;
    });
    if (activeLayerId === id) {
      const fallback = layers.find(layer => layer.id !== id)?.id || BASE_LAYER_ID;
      setActiveLayerId(fallback);
    }
    if (workspaceId) {
      void backendClient
        .from('canvas_layers')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('layer_id', id);
    }
  }, [workspaceId, activeLayerId, layers]);

  const updateLayer = useCallback((id: string, updates: Partial<CanvasLayer>) => {
    const existing = layersRef.current.find(layer => layer.id === id) || defaultLayers()[0];
    setDefinitions(prev => prev.map(layer => layer.id === id ? {
      ...layer,
      ...updates,
      version: (layer.version ?? 1) + 1,
    } : layer));

    const values = layerRowValues(updates);
    if (!workspaceId || Object.keys(values).length === 0) return;
    void (async () => {
      const { data, error } = await backendClient
        .from('canvas_layers')
        .update(values)
        .eq('workspace_id', workspaceId)
        .eq('layer_id', id)
        .select('layer_id');
      if (
        workspaceIdentityRef.current !== workspaceIdentity
        || error
        || (Array.isArray(data) && data.length > 0)
      ) return;
      // Nothing to update: the layer has no row yet (the default `base` layer of
      // a workspace nobody has edited since canvas_layers shipped). Create it
      // with the merged definition so the edit is shared, not lost.
      await backendClient
        .from('canvas_layers')
        .insert(layerInsertValues(workspaceId, { ...existing, ...updates, id }))
        .select('layer_id');
    })();
  }, [workspaceId, workspaceIdentity]);

  return {
    layers,
    layersWorkspaceId,
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
