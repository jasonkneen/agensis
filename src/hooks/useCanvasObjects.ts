import { useState, useEffect, useCallback, useRef } from 'react';
import { backendClient } from '../lib/backendClient';
import type { CanvasObject, CanvasObjectType, CanvasGroup } from '../types';
import type { RealtimeChannel, BroadcastPayload, DbChangePayload } from '../types/realtime';

interface BroadcastCanvasObjectPayload {
  senderId?: string;
  object: CanvasObject;
}

interface BroadcastCanvasDeletePayload {
  senderId?: string;
  id: string;
}

// Canvas objects enter React state from four places: the initial fetch, the
// realtime broadcast upsert, and the DB INSERT/UPDATE change feeds. Every one
// of them must produce a well-formed object, because `points` is a JSONB column
// and legacy/corrupt rows can return it as a JSON string or a non-array value.
// A non-array `points` reaching PenStroke (`points.map(...)`) or the hit-testing
// destructure throws "map is not a function" during render and — with no error
// boundary above the canvas — blanks the entire app on load. Coerce here at the
// single ingestion boundary so every downstream consumer sees a real array.
export function normalizeCanvasObject(raw: CanvasObject): CanvasObject {
  const next = { ...raw, layer_id: raw.layer_id || 'base' } as CanvasObject;
  if (!Array.isArray(next.points)) {
    let coerced: unknown = next.points;
    if (typeof coerced === 'string') {
      try { coerced = JSON.parse(coerced); } catch { coerced = null; }
    }
    next.points = Array.isArray(coerced) ? (coerced as CanvasObject['points']) : [];
  }
  return next;
}

/**
 * Prefer the fresher of two canvas object snapshots by `updated_at`.
 * Missing timestamps on either side → accept incoming (safe default under
 * out-of-order delivery only hurts when we can prove local is newer).
 */
export function preferFresherCanvasObject(
  local: CanvasObject | undefined,
  incoming: CanvasObject,
): CanvasObject {
  if (!local) return incoming;
  const localTs = local.updated_at ? Date.parse(String(local.updated_at)) : NaN;
  const incomingTs = incoming.updated_at ? Date.parse(String(incoming.updated_at)) : NaN;
  if (Number.isFinite(localTs) && Number.isFinite(incomingTs) && incomingTs < localTs) {
    return local;
  }
  return { ...local, ...incoming };
}

export function useCanvasObjects(workspaceId: string | null, userId?: string, activeLayerId = 'base') {
  const [objects, setObjects] = useState<CanvasObject[]>([]);
  const [groups, setGroups] = useState<CanvasGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const nextZRef = useRef(0);
  const objectsRef = useRef<CanvasObject[]>([]);
  const pendingSaveTimersRef = useRef<Record<string, number>>({});

  const fetchObjects = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    const [objRes, grpRes] = await Promise.all([
      backendClient
        .from('canvas_objects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('z_index', { ascending: true }),
      backendClient
        .from('canvas_groups')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true }),
    ]);
    if (objRes.data) {
      const normalized = (objRes.data as CanvasObject[]).map(normalizeCanvasObject);
      setObjects(normalized);
      const maxZ = normalized.reduce((m: number, o: { z_index: number }) => Math.max(m, o.z_index), 0);
      nextZRef.current = maxZ + 1;
    }
    if (grpRes.data) setGroups(grpRes.data as CanvasGroup[]);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchObjects();
  }, [fetchObjects]);

  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  // Allocate the next stacking index from the *live* object set, not just the
  // local counter. In a multi-client workspace another participant's
  // bringToFront bumps a z_index that syncs into objectsRef via realtime while
  // our nextZRef stays stale-low — without this, a freshly created object could
  // open *behind* a remotely-raised one. Math.max keeps the counter monotonic.
  const nextZ = useCallback(() => {
    const maxZ = objectsRef.current.reduce((m, o) => Math.max(m, o.z_index), 0);
    const z = Math.max(nextZRef.current, maxZ + 1);
    nextZRef.current = z + 1;
    return z;
  }, []);

  useEffect(() => {
    if (!workspaceId) return;

    const channel = backendClient
      .channel(`canvas:${workspaceId}`)
      .on(
        'broadcast',
        { event: 'object_upsert' },
        ({ payload }: BroadcastPayload<BroadcastCanvasObjectPayload>) => {
          const { senderId, object } = payload;
          if (senderId && userId && senderId === userId) return;
          const normalized = normalizeCanvasObject(object);
          setObjects(prev => {
            const index = prev.findIndex(o => o.id === normalized.id);
            if (index === -1) return [...prev, normalized];
            const next = [...prev];
            next[index] = { ...next[index], ...normalized };
            return next;
          });
        }
      )
      .on(
        'broadcast',
        { event: 'object_delete' },
        ({ payload }: BroadcastPayload<BroadcastCanvasDeletePayload>) => {
          const { senderId, id } = payload;
          if (senderId && userId && senderId === userId) return;
          setObjects(prev => prev.filter(o => o.id !== id));
        }
      )
      .on(
        'db_changes',
        { event: 'INSERT', schema: 'public', table: 'canvas_objects', filter: `workspace_id=eq.${workspaceId}` },
        (payload: DbChangePayload<CanvasObject>) => {
          if (!payload.new) return;
          const obj = normalizeCanvasObject(payload.new);
          setObjects(prev => {
            if (prev.find(o => o.id === obj.id)) return prev;
            return [...prev, obj];
          });
        }
      )
      .on(
        'db_changes',
        { event: 'UPDATE', schema: 'public', table: 'canvas_objects', filter: `workspace_id=eq.${workspaceId}` },
        (payload: DbChangePayload<CanvasObject>) => {
          if (!payload.new) return;
          const obj = normalizeCanvasObject(payload.new);
          setObjects(prev => prev.map(o => (o.id === obj.id ? preferFresherCanvasObject(o, obj) : o)));
        }
      )
      .on(
        'db_changes',
        { event: 'DELETE', schema: 'public', table: 'canvas_objects', filter: `workspace_id=eq.${workspaceId}` },
        (payload: DbChangePayload<CanvasObject>) => {
          const old = payload.old as { id?: string } | undefined;
          if (!old?.id) return;
          setObjects(prev => prev.filter(o => o.id !== old.id));
        }
      )
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: 'canvas_groups', filter: `workspace_id=eq.${workspaceId}` },
        () => {
          backendClient
            .from('canvas_groups')
            .select('*')
            .eq('workspace_id', workspaceId)
            .order('created_at', { ascending: true })
            .then(({ data }: { data: CanvasGroup[] | null }) => {
              if (data) setGroups(data as CanvasGroup[]);
            });
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      Object.values(pendingSaveTimersRef.current).forEach(timer => window.clearTimeout(timer));
      pendingSaveTimersRef.current = {};
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [workspaceId, userId]);

  const addObject = useCallback(async (
    type: CanvasObjectType,
    overrides: Partial<CanvasObject> = {}
  ): Promise<CanvasObject | null> => {
    if (!workspaceId) return null;
    const z = nextZ();
    let data: CanvasObject | null = null;

    const insertPayload = {
      workspace_id: workspaceId,
      user_id: userId || null,
      type,
      z_index: z,
      layer_id: activeLayerId,
      ...overrides,
    };

    const firstAttempt = await backendClient
      .from('canvas_objects')
      .insert(insertPayload)
      .select()
      .maybeSingle();

    if (firstAttempt.data) {
      data = { ...(firstAttempt.data as CanvasObject), layer_id: (firstAttempt.data as CanvasObject).layer_id || activeLayerId } as CanvasObject;
    } else if (firstAttempt.error && String(firstAttempt.error.message || '').toLowerCase().includes('layer_id')) {
      const fallbackPayload = Object.fromEntries(
        Object.entries(insertPayload).filter(([key]) => key !== 'layer_id')
      );
      const retry = await backendClient
        .from('canvas_objects')
        .insert(fallbackPayload)
        .select()
        .maybeSingle();
      if (retry.data) {
        data = { ...(retry.data as CanvasObject), layer_id: activeLayerId } as CanvasObject;
      }
    }

    if (data) {
      const obj = data as CanvasObject;
      setObjects(prev => {
        if (prev.find(o => o.id === obj.id)) return prev;
        return [...prev, obj];
      });
      channelRef.current?.send({
        type: 'broadcast',
        event: 'object_upsert',
        payload: {
          senderId: userId,
          object: obj,
        } satisfies BroadcastCanvasObjectPayload,
      });
      return obj;
    }
    return null;
  }, [workspaceId, userId, activeLayerId, nextZ]);

  const updateObject = useCallback(async (id: string, updates: Partial<CanvasObject>) => {
    const existing = objectsRef.current.find(o => o.id === id);
    if (!existing) return;

    const nextObject = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    } as CanvasObject;

    setObjects(prev => {
      const next = prev.map(o => o.id === id ? nextObject : o);
      objectsRef.current = next;
      return next;
    });

    channelRef.current?.send({
      type: 'broadcast',
      event: 'object_upsert',
      payload: {
        senderId: userId,
        object: nextObject,
      } satisfies BroadcastCanvasObjectPayload,
    });

    if (pendingSaveTimersRef.current[id]) {
      window.clearTimeout(pendingSaveTimersRef.current[id]);
    }

    pendingSaveTimersRef.current[id] = window.setTimeout(async () => {
      await backendClient
        .from('canvas_objects')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id);
      delete pendingSaveTimersRef.current[id];
    }, 180);
  }, [userId]);

  const deleteObject = useCallback(async (id: string) => {
    if (pendingSaveTimersRef.current[id]) {
      window.clearTimeout(pendingSaveTimersRef.current[id]);
      delete pendingSaveTimersRef.current[id];
    }
    setObjects(prev => prev.filter(o => o.id !== id));
    channelRef.current?.send({
      type: 'broadcast',
      event: 'object_delete',
      payload: {
        senderId: userId,
        id,
      } satisfies BroadcastCanvasDeletePayload,
    });
    await backendClient
      .from('canvas_objects')
      .delete()
      .eq('id', id);
  }, [userId]);

  const deleteObjectsInLayer = useCallback(async (layerId: string) => {
    setObjects(prev => prev.filter(o => (o.layer_id || 'base') !== layerId));
    await backendClient
      .from('canvas_objects')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('layer_id', layerId);
  }, [workspaceId]);

  const bringToFront = useCallback(async (id: string) => {
    const z = nextZ();
    updateObject(id, { z_index: z });
  }, [updateObject, nextZ]);

  const createGroup = useCallback(async (name: string, objectIds: string[], color?: string): Promise<CanvasGroup | null> => {
    if (!workspaceId) return null;
    const { data } = await backendClient
      .from('canvas_groups')
      .insert({
        workspace_id: workspaceId,
        name,
        color: color || '#3b82f6',
        created_by: userId || null,
      })
      .select()
      .maybeSingle();
    if (!data) return null;
    const group = data as CanvasGroup;
    setGroups(prev => [...prev, group]);

    for (const objId of objectIds) {
      await updateObject(objId, { group_id: group.id });
    }
    return group;
  }, [workspaceId, userId, updateObject]);

  const deleteGroup = useCallback(async (groupId: string) => {
    setObjects(prev => prev.map(o => o.group_id === groupId ? { ...o, group_id: null } : o));
    setGroups(prev => prev.filter(g => g.id !== groupId));
    await backendClient.from('canvas_objects').update({ group_id: null }).eq('group_id', groupId);
    await backendClient.from('canvas_groups').delete().eq('id', groupId);
  }, []);

  const renameGroup = useCallback(async (groupId: string, name: string) => {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, name } : g));
    await backendClient.from('canvas_groups').update({ name }).eq('id', groupId);
  }, []);

  return {
    objects, groups, loading,
    addObject, updateObject, deleteObject, deleteObjectsInLayer, bringToFront,
    createGroup, deleteGroup, renameGroup,
  };
}
