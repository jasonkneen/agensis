import { describe, it, expect } from 'vitest';
import { normalizeCanvasObject } from '../../src/hooks/useCanvasObjects';
import type { CanvasObject } from '../../src/types';

// Regression for the production crash `i.map is not a function` (PenStroke →
// blank app on load). A `pen` canvas_objects row whose JSONB `points` came back
// as a non-array (JSON string, object, or null) must be coerced to a real array
// at ingestion so no downstream renderer/hit-test throws.
function penRow(points: unknown): CanvasObject {
  return {
    id: 'o1', workspace_id: 'w1', user_id: 'u1', type: 'pen',
    x: 0, y: 0, width: 0, height: 0, rotation: 0,
    fill: '#000', stroke: '#000', stroke_width: 2, opacity: 1,
    // deliberately wrong runtime shape — the DB layer is not type-safe
    points: points as CanvasObject['points'],
    text_content: '', src: '', file_name: '', z_index: 0, locked: false,
    group_id: null, attached_to: null, font_size: 14, layer_id: null,
    created_at: '', updated_at: '',
  };
}

describe('normalizeCanvasObject points coercion', () => {
  it('keeps a valid point array intact', () => {
    const pts = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    expect(normalizeCanvasObject(penRow(pts)).points).toEqual(pts);
  });

  it('parses a JSON-string points column back into an array', () => {
    const out = normalizeCanvasObject(penRow('[{"x":1,"y":2},{"x":3,"y":4}]'));
    expect(Array.isArray(out.points)).toBe(true);
    expect(out.points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it.each([null, undefined, {}, 42, 'not-json', '{"x":1}'])(
    'coerces non-array points (%o) to [] instead of crashing consumers',
    (bad) => {
      const out = normalizeCanvasObject(penRow(bad));
      expect(Array.isArray(out.points)).toBe(true);
      expect(out.points).toEqual([]);
      // the exact op that used to throw in PenStroke
      expect(() => out.points.map(p => p.x)).not.toThrow();
    },
  );

  it('defaults layer_id to base', () => {
    expect(normalizeCanvasObject(penRow([])).layer_id).toBe('base');
  });
});
