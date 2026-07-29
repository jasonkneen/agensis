---
name: wireframe-demos
description: Author a small animated wireframe demo for an agensis feature — the abstract grey-box animations shown in the What's New gallery and anywhere a feature needs illustrating. Use this when adding a slide to the release gallery, when a feature needs a visual that is not a screenshot, when asked for "a demo of X", or when tempted to record a GIF or capture a screenshot of the app to show how something works. Covers the scene format, the shape and motion vocabulary, the viewBox, validation rules, and why screenshots are the wrong tool here.
---

# Wireframe demos

A wireframe demo is a handful of grey boxes that move, drawn from theme tokens,
describing a feature abstractly. `src/lib/wireframeScenes.ts` holds the format
and the scenes; `src/components/wireframe/WireframeDemo.tsx` renders them.

## Why not a screenshot

Reach for a wireframe rather than a capture:

- A screenshot **goes stale** the moment the UI it shows is restyled, and
  nobody notices until it is embarrassing.
- It has to be **recaptured per theme** — this app has six theme scopes across
  light and dark, and a light-theme PNG on a brutal-dark background looks broken.
- It is a **binary in the bundle**. The whole gallery costs nothing today.
- A wireframe states the *idea* ("a panel slides in and a row lights up"),
  which stays true through a redesign.

Use a real screenshot only when the actual pixels are the point (a bug report,
a visual regression). For "here is what this feature does", use a wireframe.

## The format

A scene is data, not code. Authoring a new demo means adding an object to
`WIREFRAME_SCENES` — you should never write CSS.

```ts
const myScene: WireframeScene = {
  id: 'my-scene',                    // unique; namespaces the animation
  alt: 'A plain sentence describing what happens.',  // REQUIRED
  shapes: [
    { kind: 'panel', x: 6, y: 8, w: 70, h: 84, tone: 'muted', motion: 'none' },
    { kind: 'row',   x: 12, y: 16, w: 56, h: 7, tone: 'accent', motion: 'fade', delay: 0.2 },
  ],
};
```

**Canvas is 160 x 100** (`WIREFRAME_VIEWBOX`). Everything is authored in those
units. A shape outside the box, or with zero area, fails validation.

### Vocabulary

`kind` — presentational, never app concepts. `row` means "a line of content",
not `ChatMessage`. Keeping it abstract is what stops a demo needing an update
when a real component moves.

| kind | use for |
|---|---|
| `panel` | a surface: window, dialog, sidebar |
| `row` | a line of content inside a surface |
| `bar` | a short text-ish run |
| `chip` | a pill: tag, badge, avatar |
| `button` | an affordance |
| `cursor` | the pointer, for interaction demos |

`motion` — `none`, `fade`, `slide-left` (enters from the right),
`slide-right`, `slide-up`, `pop` (scales up — "this appeared"), `pulse`
(arrives then breathes — "this is the point"; use once per scene at most).

`tone` — `base`, `muted`, `accent`. These map to theme tokens. **Never use a
literal colour**: a hex in a wireframe is invisible in some theme.

`delay` — seconds. The scene loops on the longest delay plus the animation
duration, floored at `WIREFRAME_MIN_LOOP_SECONDS`.

## Rules that matter

1. **`alt` is required and must be a real sentence.** An `<svg role="img">`
   with no label is invisible to anyone not looking at it. Describe what
   happens, not what it looks like: "Replies arriving one at a time, spaced
   apart" beats "grey boxes appear".
2. **Stagger with `delay`, never with `animation-delay`.** The renderer bakes
   the delay into per-shape keyframe percentages precisely because
   `animation-delay` applies to the first iteration only — a scene built that
   way plays correctly once, then collapses with every shape arriving together
   on loop two.
3. **Three to nine shapes.** Fewer says nothing; more is a diagram nobody
   parses at 160x100.
4. **Reduced motion is handled for you** — the renderer shows the final state
   when `prefers-reduced-motion: reduce`. Which means: the *settled* state must
   itself communicate the feature. A scene that only makes sense while moving
   is a scene that fails for those users.
5. **Validate.** `isValidScene` runs at render time and returns nothing for a
   malformed scene, so a typo is a blank box, not a crash. Add your scene to
   `tests/unit/wireframeScenes.test.ts` so it is caught at build instead.

## Adding a gallery slide

`GALLERY_SLIDES` in the same file pairs a scene with a title and a sentence.
It is hand-curated, deliberately: a slide needs a demo that genuinely
illustrates it, and most release notes do not have one. Notes without a scene
still appear as bullets below the gallery — they simply do not get a slide.

Keep `body` to one sentence about *what the user can now do*. Not the
implementation. Four to six slides; it is a highlight reel, not a changelog.

**A slide names the release note it illustrates** — `note` is the `version`
slug from `public/release-notes.json`, and it is the slide's identity. Slides
are TypeScript and notes are JSON, so nothing else stops the gallery quietly
outliving what shipped (it once advertised six features that were months old).
`tests/unit/wireframeScenes.test.ts` reads the notes file and fails when a
slide names a note nobody wrote, or when the newest release date has no slide
at all. `orderGallerySlides` then sorts by note recency at render time, so the
newest feature leads without anyone re-ordering the array.

Retiring a slide is deleting it from `GALLERY_SLIDES`; leave its scene in
`WIREFRAME_SCENES`.

## Two things that bite when authoring

- **Shapes only ever arrive.** There is no exit motion, and reduced motion
  renders the settled frame. "The other windows drop away" is unauthorable —
  compose it as what appears, and make sure the final still says the feature.
- **Keep small shapes out of the outer ~16 units.** The carousel's arrows float
  over the demo — the left one always, the right one once the slide stacks on a
  narrow dialog. A panel running to the edge under an arrow is fine; an avatar
  or a badge under one is a shape nobody can see.
