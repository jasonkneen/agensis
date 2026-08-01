import { describe, expect, it } from 'vitest'
import { applyDocumentRealtimeToContentCache } from '../../src/hooks/useDocuments'

describe('applyDocumentRealtimeToContentCache', () => {
  it('invalidates cache on UPDATE when content is stripped (heavy-field fanout)', () => {
    const cache = new Map<string, string>([['doc-1', '<p>old body</p>']])
    applyDocumentRealtimeToContentCache(cache, 'UPDATE', {
      id: 'doc-1',
      // content absent — matches REALTIME_HEAVY_FIELDS strip
    })
    expect(cache.has('doc-1')).toBe(false)
  })

  it('refreshes cache when content is present', () => {
    const cache = new Map<string, string>([['doc-1', 'old']])
    applyDocumentRealtimeToContentCache(cache, 'UPDATE', {
      id: 'doc-1',
      content: 'new body',
    })
    expect(cache.get('doc-1')).toBe('new body')
  })

  it('invalidates on INSERT without content and deletes on DELETE', () => {
    const cache = new Map<string, string>([['doc-1', 'x'], ['doc-2', 'y']])
    applyDocumentRealtimeToContentCache(cache, 'INSERT', { id: 'doc-1' })
    expect(cache.has('doc-1')).toBe(false)
    applyDocumentRealtimeToContentCache(cache, 'DELETE', null, { id: 'doc-2' })
    expect(cache.has('doc-2')).toBe(false)
  })
})
