import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GALLERY_SLIDES,
  WIREFRAME_MIN_LOOP_SECONDS,
  WIREFRAME_SCENES,
  WIREFRAME_VIEWBOX,
  isValidScene,
  isValidShape,
  nextSlideIndex,
  orderGallerySlides,
  sceneDurationSeconds,
  type GallerySlide,
  type WireframeScene,
} from '../../src/lib/wireframeScenes';
import { parseReleaseNotes } from '../../src/lib/releaseNotes';

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

  it('no two slides illustrate the same note', () => {
    const notes = GALLERY_SLIDES.map(s => s.note);
    expect(new Set(notes).size).toBe(notes.length);
  });

  it('no two slides share a scene — a repeated animation says nothing', () => {
    const ids = GALLERY_SLIDES.map(s => s.scene.id);
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

  it('stays a highlight reel rather than a changelog', () => {
    expect(GALLERY_SLIDES.length).toBeGreaterThanOrEqual(3);
    expect(GALLERY_SLIDES.length).toBeLessThanOrEqual(6);
  });
});

// --- the drift guard -------------------------------------------------------
//
// The slides are authored in TypeScript and the release notes in JSON, so
// nothing in the type system stops the gallery advertising features nobody
// shipped — which is precisely what happened: six slides about tool loops and
// link previews sat above notes about private DMs and the audit log. These
// tests are the join between the two files, and they are the reason a slide
// names its note at all.

// Read from disk rather than imported: the notes are a public/ asset served at
// runtime, not a module, and importing them would let a bundler decide this
// test passes. cwd is the repo root under vitest.
const notesPath = resolve(process.cwd(), 'public/release-notes.json');
const RELEASE_NOTES = parseReleaseNotes(JSON.parse(readFileSync(notesPath, 'utf8')));

describe('the gallery against the release notes', () => {
  it('the notes file itself parses — everything below depends on it', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
  });

  it('every slide illustrates a note that was actually written', () => {
    const versions = new Set(RELEASE_NOTES.map(n => n.version));
    for (const slide of GALLERY_SLIDES) {
      // Fails when a slide outlives its note, or names one that never landed:
      // an animation for a feature no user was told about.
      expect(versions.has(slide.note), `no release note with version "${slide.note}"`).toBe(true);
    }
  });

  it('the newest release has a slide', () => {
    // Not every note deserves an animation — but shipping a whole release
    // without one means the gallery is showing the previous release as news.
    // Notes are authored newest-first.
    const newestDate = RELEASE_NOTES[0]?.date;
    const newest = new Set(RELEASE_NOTES.filter(n => n.date === newestDate).map(n => n.version));
    const covered = GALLERY_SLIDES.filter(s => newest.has(s.note)).map(s => s.note);
    expect(covered.length, `no slide for any note dated ${newestDate}`).toBeGreaterThan(0);
  });
});

describe('orderGallerySlides', () => {
  const slide = (note: string) => ({ note, title: note, body: note, scene: {} }) as GallerySlide;

  it('leads with the slide for the newest note', () => {
    const ordered = orderGallerySlides(
      [slide('old'), slide('new')],
      [{ version: 'new' }, { version: 'old' }],
    );
    expect(ordered.map(s => s.note)).toEqual(['new', 'old']);
  });

  it('keeps a slide whose note is missing, at the end and in authored order', () => {
    // A slide added ahead of its note, or a notes file that failed to load,
    // must not make the slide vanish — a stale gallery beats an empty one.
    const ordered = orderGallerySlides(
      [slide('ghost'), slide('known'), slide('other-ghost')],
      [{ version: 'known' }],
    );
    expect(ordered.map(s => s.note)).toEqual(['known', 'ghost', 'other-ghost']);
  });

  it('falls back to the authored order when there are no notes at all', () => {
    const authored = [slide('a'), slide('b'), slide('c')];
    expect(orderGallerySlides(authored, []).map(s => s.note)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the authored list', () => {
    const authored = [slide('a'), slide('b')];
    orderGallerySlides(authored, [{ version: 'b' }]);
    expect(authored.map(s => s.note)).toEqual(['a', 'b']);
  });

  it('orders the real gallery by the real notes', () => {
    const ordered = orderGallerySlides(GALLERY_SLIDES, RELEASE_NOTES);
    const rank = (note: string) => RELEASE_NOTES.findIndex(n => n.version === note);
    const ranks = ordered.map(s => rank(s.note));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
