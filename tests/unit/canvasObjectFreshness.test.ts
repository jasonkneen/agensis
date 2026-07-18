import { describe, expect, it } from 'vitest'
import { preferFresherCanvasObject, upsertCanvasObject } from '../../src/hooks/useCanvasObjects'
import type { CanvasObject } from '../../src/types'

function obj(partial: Partial<CanvasObject> & { id: string }): CanvasObject {
  return {
    id: partial.id,
    workspace_id: partial.workspace_id || 'ws-1',
    type: partial.type || 'rect',
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? 10,
    height: partial.height ?? 10,
    rotation: partial.rotation ?? 0,
    z_index: partial.z_index ?? 0,
    points: partial.points || [],
    fill: partial.fill || '',
    stroke: partial.stroke || '',
    text: partial.text || '',
    layer_id: partial.layer_id || 'base',
    updated_at: partial.updated_at,
    ...partial,
  } as CanvasObject
}

describe('preferFresherCanvasObject', () => {
  it('accepts incoming when local is missing', () => {
    const incoming = obj({ id: 'a', x: 5, updated_at: '2026-07-01T12:00:00.000Z' })
    expect(preferFresherCanvasObject(undefined, incoming)).toEqual(incoming)
  })

  it('keeps local when incoming updated_at is older', () => {
    const local = obj({ id: 'a', x: 10, updated_at: '2026-07-01T12:00:05.000Z' })
    const incoming = obj({ id: 'a', x: 1, updated_at: '2026-07-01T12:00:00.000Z' })
    expect(preferFresherCanvasObject(local, incoming).x).toBe(10)
  })

  it('applies incoming when it is newer', () => {
    const local = obj({ id: 'a', x: 10, updated_at: '2026-07-01T12:00:00.000Z' })
    const incoming = obj({ id: 'a', x: 99, updated_at: '2026-07-01T12:00:05.000Z' })
    expect(preferFresherCanvasObject(local, incoming).x).toBe(99)
  })

  it('applies incoming when either side lacks updated_at', () => {
    const local = obj({ id: 'a', x: 10, updated_at: undefined })
    const incoming = obj({ id: 'a', x: 3, updated_at: '2026-07-01T12:00:00.000Z' })
    expect(preferFresherCanvasObject(local, incoming).x).toBe(3)

    const localTs = obj({ id: 'a', x: 10, updated_at: '2026-07-01T12:00:00.000Z' })
    const incomingNoTs = obj({ id: 'a', x: 7, updated_at: undefined })
    expect(preferFresherCanvasObject(localTs, incomingNoTs).x).toBe(7)
  })
})

describe('upsertCanvasObject (realtime broadcast merge path)', () => {
  it('appends an object whose id is not yet present', () => {
    const list = [obj({ id: 'a', x: 1 })]
    const result = upsertCanvasObject(list, obj({ id: 'b', x: 2 }))
    expect(result).toHaveLength(2)
    expect(result[1].id).toBe('b')
  })

  it('does NOT revert a newer local object when an older broadcast echo arrives', () => {
    // Regression: two clients drag the same object; a delayed echo of an older
    // position must not clobber the newer local one. The broadcast handler used
    // to blind-merge (…prev[i], …incoming) and would revert here.
    const list = [obj({ id: 'a', x: 100, updated_at: '2026-07-01T12:00:05.000Z' })]
    const staleEcho = obj({ id: 'a', x: 3, updated_at: '2026-07-01T12:00:00.000Z' })
    const result = upsertCanvasObject(list, staleEcho)
    expect(result[0].x).toBe(100)
  })

  it('applies a newer incoming object over an older local one', () => {
    const list = [obj({ id: 'a', x: 5, updated_at: '2026-07-01T12:00:00.000Z' })]
    const fresh = obj({ id: 'a', x: 42, updated_at: '2026-07-01T12:00:05.000Z' })
    const result = upsertCanvasObject(list, fresh)
    expect(result[0].x).toBe(42)
  })

  it('preserves list length and order when merging an existing object', () => {
    const list = [obj({ id: 'a', x: 1 }), obj({ id: 'b', x: 2 }), obj({ id: 'c', x: 3 })]
    const result = upsertCanvasObject(list, obj({ id: 'b', x: 20, updated_at: '2026-07-01T12:00:05.000Z' }))
    expect(result.map(o => o.id)).toEqual(['a', 'b', 'c'])
    expect(result[1].x).toBe(20)
  })
})
