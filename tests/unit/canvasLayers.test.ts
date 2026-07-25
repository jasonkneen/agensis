import { describe, expect, it } from 'vitest'
import {
  layerRowValues,
  layersToAdopt,
  rowToCanvasLayer,
  sortCanvasLayers,
} from '../../src/hooks/useCanvasLayers'
import type { CanvasLayer } from '../../src/hooks/useCanvasLayers'

function layer(partial: Partial<CanvasLayer> & { id: string }): CanvasLayer {
  return {
    name: partial.name || partial.id,
    minimized: true,
    background_opacity: 0.42,
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
    expect(result.name).toBe('Workspace')
    expect(result.background_opacity).toBe(0.42)
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
    expect(adopt[0].name).toBe('Shared workspace 1')
  })

  it('adopts nothing when every layer already has a row', () => {
    const known = [layer({ id: 'base' }), layer({ id: 'canvas_1' })]
    expect(layersToAdopt(known, known, ['base', 'canvas_1'], true)).toEqual([])
  })

  it('names derived layers deterministically and past the names already taken', () => {
    const adopt = layersToAdopt([layer({ id: 'base', name: 'Shared workspace 1' })], [], ['b_two', 'a_one'], false)
    expect(adopt.map(l => l.name)).toEqual(['Shared workspace 2', 'Shared workspace 3'])
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
