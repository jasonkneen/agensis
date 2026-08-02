import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BACKGROUND_OPACITY } from '../../src/lib/wallpaperDefaults';
import {
  layerRowValues,
  layersToAdopt,
  rowToCanvasLayer,
  sortCanvasLayers,
  useCanvasLayers,
} from '../../src/hooks/useCanvasLayers'
import type { CanvasLayer } from '../../src/hooks/useCanvasLayers'

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const moduleMocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../src/lib/backendClient', () => ({ backendClient: { from: moduleMocks.from } }));
vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: vi.fn(),
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
}));

function layer(partial: Partial<CanvasLayer> & { id: string }): CanvasLayer {
  return {
    name: partial.name || partial.id,
    minimized: true,
    background_opacity: DEFAULT_BACKGROUND_OPACITY,
    background_image: '',
    version: 1,
    ...partial,
  }
}

describe('rowToCanvasLayer', () => {
  it('uses layer_id (not the row uuid) as the layer identity', () => {
    // canvas_objects.layer_id stores layer_id; the uuid id is only the row key.
    const result = rowToCanvasLayer({ id: '0f1c…-uuid', layer_id: 'canvas_1', name: 'Design' })
    expect(result.id).toBe('canvas_1')
    expect(result.name).toBe('Design')
  })

  it('fills the defaults the canvas renders against', () => {
    const result = rowToCanvasLayer({ layer_id: 'base', name: null, background_opacity: null, background_image: null })
    expect(result.name).toBe('Desktop')
    expect(result.background_opacity).toBe(DEFAULT_BACKGROUND_OPACITY)
    expect(result.background_image).toBe('')
    expect(result.sort_order).toBe(0)
    expect(result.version).toBe(1)
  })
})

describe('sortCanvasLayers', () => {
  it('keeps base first and orders the rest by sort_order', () => {
    const result = sortCanvasLayers([
      layer({ id: 'c', sort_order: 3 }),
      layer({ id: 'base', sort_order: 9 }),
      layer({ id: 'a', sort_order: 1 }),
    ])
    expect(result.map(l => l.id)).toEqual(['base', 'a', 'c'])
  })

  it('breaks sort_order ties on id so every client lists the same order', () => {
    const result = sortCanvasLayers([
      layer({ id: 'zeta', sort_order: 1 }),
      layer({ id: 'alpha', sort_order: 1 }),
    ])
    expect(result.map(l => l.id)).toEqual(['alpha', 'zeta'])
  })
})

describe('layersToAdopt', () => {
  it('adopts this browser localStorage layers on the first pass', () => {
    const adopt = layersToAdopt([], [layer({ id: 'base', name: 'Workspace 1' }), layer({ id: 'canvas_1', name: 'Design' })], [], true)
    expect(adopt.map(l => l.id)).toEqual(['base', 'canvas_1'])
    expect(adopt.find(l => l.id === 'base')?.sort_order).toBe(0)
  })

  it('never re-adopts localStorage layers once the migration is marked done', () => {
    // Otherwise every mount would resurrect a layer a teammate has deleted.
    const adopt = layersToAdopt([], [layer({ id: 'canvas_1' })], [], false)
    expect(adopt).toEqual([])
  })

  it('adopts a layer that only exists as canvas_objects.layer_id, even after migration', () => {
    // The whole point of the table: a layer someone else drew on must not be
    // stranded just because this browser never heard of it.
    const adopt = layersToAdopt([layer({ id: 'base' })], [], ['base', 'canvas_x', 'canvas_x'], false)
    expect(adopt.map(l => l.id)).toEqual(['canvas_x'])
    expect(adopt[0].name).toBe('Shared desktop 1')
  })

  it('adopts nothing when every layer already has a row', () => {
    const known = [layer({ id: 'base' }), layer({ id: 'canvas_1' })]
    expect(layersToAdopt(known, known, ['base', 'canvas_1'], true)).toEqual([])
  })

  it('names derived layers deterministically and past the names already taken', () => {
    const adopt = layersToAdopt([layer({ id: 'base', name: 'Shared desktop 1' })], [], ['b_two', 'a_one'], false)
    expect(adopt.map(l => l.name)).toEqual(['Shared desktop 2', 'Shared desktop 3'])
    // Sorted by id, so two clients derive the same name for the same layer.
    expect(adopt.map(l => l.id)).toEqual(['a_one', 'b_two'])
  })

  it('places adopted layers after the highest known sort_order', () => {
    const adopt = layersToAdopt([layer({ id: 'base', sort_order: 4 })], [layer({ id: 'canvas_1' })], [], true)
    expect(adopt[0].sort_order).toBe(5)
  })
})

describe('layerRowValues', () => {
  it('sends only the shared columns that actually changed', () => {
    expect(layerRowValues({ name: 'Renamed' })).toEqual({ name: 'Renamed' })
  })

  it('never writes per-browser or server-owned fields', () => {
    // minimized is derived from the active layer (per browser) and version is
    // bumped by the backend's VERSIONED_TABLES path.
    const values = layerRowValues({ name: 'X', minimized: false, version: 7, id: 'canvas_1' } as Partial<CanvasLayer>)
    expect(values).toEqual({ name: 'X' })
  })

  it('passes an explicit empty string through (clearing a background)', () => {
    expect(layerRowValues({ background_image: '' })).toEqual({ background_image: '' })
  })
})

describe('useCanvasLayers persistence identity', () => {
  afterEach(() => {
    moduleMocks.from.mockReset();
    localStorage.clear();
  });

  it('does not insert a fallback row when an existing layer update succeeds', async () => {
    const inserts: unknown[] = [];
    moduleMocks.from.mockImplementation((table: string) => {
      let operation: 'read' | 'update' | 'insert' = 'read';
      let workspaceId = '';
      let selectedUpdate = false;
      const query = {
        select: () => {
          if (operation === 'update') selectedUpdate = true;
          return query;
        },
        update: () => { operation = 'update'; return query; },
        insert: (value: { workspace_id?: string }) => {
          operation = 'insert';
          workspaceId = String(value.workspace_id || '');
          inserts.push(value);
          return query;
        },
        eq: (column: string, value: string) => {
          if (column === 'workspace_id') workspaceId = value;
          return query;
        },
        order: () => Promise.resolve({
          data: [{ layer_id: 'base', workspace_id: workspaceId, name: `${workspaceId} Main` }],
        }),
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
          const result = operation === 'update'
            ? { data: selectedUpdate ? [{ layer_id: 'base' }] : null }
            : operation === 'insert'
              ? { data: [{ layer_id: 'base' }] }
              : { data: table === 'canvas_objects' ? [] : [{ layer_id: 'base', workspace_id: workspaceId, name: `${workspaceId} Main` }] };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    });

    let latest!: ReturnType<typeof useCanvasLayers>;
    function Probe() { latest = useCanvasLayers('A'); return null; }
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(createElement(Probe)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => latest.updateLayer('base', { name: 'Renamed' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(inserts).toEqual([]);
    act(() => root.unmount());
  });

  it('does not finish workspace A fallback persistence after switching to B', async () => {
    let resolveUpdate!: (value: { data: unknown[] }) => void;
    const update = new Promise<{ data: unknown[] }>(resolve => { resolveUpdate = resolve; });
    const inserts: Array<{ workspace_id?: string; name?: string }> = [];
    moduleMocks.from.mockImplementation((table: string) => {
      let operation: 'read' | 'update' | 'insert' = 'read';
      let workspaceId = '';
      const query = {
        select: () => query,
        update: () => { operation = 'update'; return query; },
        insert: (value: { workspace_id?: string; name?: string }) => {
          operation = 'insert';
          workspaceId = String(value.workspace_id || '');
          inserts.push(value);
          return query;
        },
        eq: (column: string, value: string) => {
          if (column === 'workspace_id') workspaceId = value;
          return query;
        },
        order: () => Promise.resolve({
          data: [{ layer_id: 'base', workspace_id: workspaceId, name: `${workspaceId} Main` }],
        }),
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
          const result = operation === 'update' && workspaceId === 'A'
            ? update
            : Promise.resolve(operation === 'read' && table === 'canvas_objects'
              ? { data: [] }
              : { data: [{ layer_id: 'base' }] });
          return result.then(resolve, reject);
        },
      };
      return query;
    });

    let latest!: ReturnType<typeof useCanvasLayers>;
    function Probe({ workspaceId }: { workspaceId: string }) {
      latest = useCanvasLayers(workspaceId);
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(createElement(Probe, { workspaceId: 'A' })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => latest.updateLayer('base', { description: 'A description' }));
    act(() => root.render(createElement(Probe, { workspaceId: 'B' })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { resolveUpdate({ data: [] }); await update; });

    expect(inserts).toEqual([]);
    act(() => root.unmount());
  });

  it('never writes workspace A layer definitions into workspace B local storage', async () => {
    moduleMocks.from.mockImplementation((table: string) => {
      let workspaceId = '';
      const query = {
        select: () => query,
        eq: (column: string, value: string) => {
          if (column === 'workspace_id') workspaceId = value;
          return query;
        },
        order: () => Promise.resolve({
          data: [{ layer_id: 'base', workspace_id: workspaceId, name: `${workspaceId} Main` }],
        }),
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => Promise.resolve(
          table === 'canvas_objects'
            ? { data: [] }
            : { data: [{ layer_id: 'base', workspace_id: workspaceId, name: `${workspaceId} Main` }] },
        ).then(resolve, reject),
      };
      return query;
    });
    localStorage.setItem('canvas_layers:A', JSON.stringify([layer({ id: 'base', name: 'A Main' })]));
    localStorage.setItem('canvas_layers:B', JSON.stringify([layer({ id: 'base', name: 'B Main' })]));
    localStorage.setItem('canvas_layers_adopted:A', '1');
    localStorage.setItem('canvas_layers_adopted:B', '1');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    function Probe({ workspaceId }: { workspaceId: string }) {
      useCanvasLayers(workspaceId);
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(createElement(Probe, { workspaceId: 'A' })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    setItem.mockClear();
    act(() => root.render(createElement(Probe, { workspaceId: 'B' })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const crossWorkspaceWrites = setItem.mock.calls.filter(([key, value]) =>
      key === 'canvas_layers:B' && String(value).includes('A Main'));
    expect(crossWorkspaceWrites).toEqual([]);
    act(() => root.unmount());
  });
})
