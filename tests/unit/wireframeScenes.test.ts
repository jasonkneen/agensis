import { describe, expect, it } from 'vitest';
import {
  GALLERY_SLIDES,
  WIREFRAME_MIN_LOOP_SECONDS,
  WIREFRAME_SCENES,
  WIREFRAME_VIEWBOX,
  isValidScene,
  isValidShape,
  nextSlideIndex,
  sceneDurationSeconds,
  type WireframeScene,
} from '../../src/lib/wireframeScenes';

// A wireframe demo is authoring DATA. Everything here is a mistake that would
// otherwise render as a silently blank or clipped diagram that nobody notices
// until it ships in the What's New dialog.

const shape = (over: Record<string, unknown> = {}) => ({
  kind: 'row', x: 10, y: 10, w: 20, h: 10, ...over,
});

describe('isValidShape', () => {
  it('accepts a well-formed shape', () => {
    expect(isValidShape(shape())).toBe(true);
  });

  it('rejects a shape that falls outside the canvas', () => {
    // Authored past the edge, this renders clipped or invisible — the exact
    // failure that is invisible in review and obvious in production.
    expect(isValidShape(shape({ x: WIREFRAME_VIEWBOX.width - 5, w: 40 }))).toBe(false);
    expect(isValidShape(shape({ y: WIREFRAME_VIEWBOX.height - 4, h: 20 }))).toBe(false);
    expect(isValidShape(shape({ x: -1 }))).toBe(false);
  });

  it('rejects a shape with no area', () => {
    expect(isValidShape(shape({ w: 0 }))).toBe(false);
    expect(isValidShape(shape({ h: -3 }))).toBe(false);
  });

  it('rejects unknown vocabulary rather than silently drawing a default', () => {
    expect(isValidShape(shape({ kind: 'sparkle' }))).toBe(false);
    expect(isValidShape(shape({ motion: 'explode' }))).toBe(false);
    expect(isValidShape(shape({ tone: 'hotpink' }))).toBe(false);
  });

  it('rejects a negative delay and a non-finite coordinate', () => {
    expect(isValidShape(shape({ delay: -1 }))).toBe(false);
    expect(isValidShape(shape({ x: Number.NaN }))).toBe(false);
  });
});

describe('isValidScene', () => {
  it('requires an id, an alt sentence, and at least one shape', () => {
    expect(isValidScene({ id: '', alt: 'a', shapes: [shape()] })).toBe(false);
    expect(isValidScene({ id: 'x', alt: '', shapes: [shape()] })).toBe(false);
    expect(isValidScene({ id: 'x', alt: 'a', shapes: [] })).toBe(false);
  });

  it('rejects a scene where any one shape is bad', () => {
    expect(isValidScene({ id: 'x', alt: 'a', shapes: [shape(), shape({ w: 0 })] })).toBe(false);
  });
});

describe('the built-in scenes', () => {
  const scenes = Object.entries(WIREFRAME_SCENES);

  it.each(scenes)('%s is valid', (_name, scene) => {
    expect(isValidScene(scene)).toBe(true);
  });

  it('every scene has a unique id — ids namespace the animations', () => {
    // Two scenes sharing an id would have their keyframes collide on any page
    // rendering both, which a gallery does mid-transition.
    const ids = scenes.map(([, s]) => (s as WireframeScene).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every alt text is a real description, not a placeholder', () => {
    for (const [, s] of scenes) {
      const scene = s as WireframeScene;
      expect(scene.alt.trim().length).toBeGreaterThan(20);
      expect(scene.alt).toMatch(/\s/); // more than one word
    }
  });

  it('no scene is so busy it cannot be read at this size', () => {
    for (const [, s] of scenes) {
      expect((s as WireframeScene).shapes.length).toBeLessThanOrEqual(9);
      expect((s as WireframeScene).shapes.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('sceneDurationSeconds', () => {
  it('never returns a loop too short to see', () => {
    const instant: WireframeScene = { id: 'i', alt: 'one instant shape', shapes: [shape() as never] };
    expect(sceneDurationSeconds(instant)).toBe(WIREFRAME_MIN_LOOP_SECONDS);
  });

  it('covers the last shape to arrive', () => {
    const late: WireframeScene = {
      id: 'l',
      alt: 'a shape that arrives late',
      shapes: [shape({ delay: 4 }) as never],
    };
    expect(sceneDurationSeconds(late)).toBeGreaterThan(4);
  });
});

describe('nextSlideIndex', () => {
  it('advances and wraps', () => {
    expect(nextSlideIndex(0, 3)).toBe(1);
    expect(nextSlideIndex(2, 3)).toBe(0);
  });

  it('wraps backwards without going negative', () => {
    // A raw % in JS yields -1 here, which indexes nothing and blanks the slide.
    expect(nextSlideIndex(0, 3, -1)).toBe(2);
  });

  it('survives an empty gallery', () => {
    expect(nextSlideIndex(0, 0)).toBe(0);
  });
});

describe('GALLERY_SLIDES', () => {
  it('every slide carries a valid scene', () => {
    for (const slide of GALLERY_SLIDES) {
      expect(isValidScene(slide.scene)).toBe(true);
    }
  });

  it('slide ids are unique', () => {
    const ids = GALLERY_SLIDES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every slide says something, and says it briefly', () => {
    for (const slide of GALLERY_SLIDES) {
      expect(slide.title.trim()).not.toBe('');
      expect(slide.body.trim().length).toBeGreaterThan(20);
      // A gallery slide is a headline, not a paragraph; longer than this and
      // it overflows the panel beside the demo.
      expect(slide.body.length).toBeLessThanOrEqual(160);
    }
  });
});
