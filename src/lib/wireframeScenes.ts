// ---------------------------------------------------------------------------
// WIREFRAME DEMOS — tiny animated illustrations of a feature, as DATA.
//
// A feature demo is a handful of grey boxes that move. Not a screenshot: a
// screenshot of this app goes stale the moment the UI changes, has to be
// recaptured per theme, and drags a binary into the bundle. A wireframe says
// "a panel slides in from the left and a row lights up" — which stays true
// through a restyle, weighs nothing, and inherits the current theme's colours
// because it is drawn from theme tokens rather than baked pixels.
//
// The format is deliberately small. A scene is a list of shapes on a fixed
// viewBox, each with a delay and one named motion. Authoring a new demo is
// adding data to this file, never writing CSS — which is the whole point of it
// being a format rather than a component per demo.
//
// Rendered by src/components/wireframe/WireframeDemo.tsx.
// Authoring guide: .claude/skills/wireframe-demos/SKILL.md
// ---------------------------------------------------------------------------

/** The drawing surface every scene is authored against. */
export const WIREFRAME_VIEWBOX = { width: 160, height: 100 } as const;

/**
 * What a shape represents. This is presentational vocabulary, not app
 * concepts — `row` is "a line of content", not `ChatMessage`. Keeping it
 * abstract is what stops a demo needing an update when a real component moves.
 */
export type WireframeKind =
  | 'panel' // a surface: window, dialog, sidebar
  | 'row' // a line of content inside a surface
  | 'bar' // a short text-ish run
  | 'chip' // a pill: a tag, a badge, an avatar
  | 'button' // an affordance
  | 'cursor'; // the pointer, for demos that show an interaction

/** How a shape arrives, and whether it keeps moving. */
export type WireframeMotion =
  | 'none' // present from the first frame
  | 'fade'
  | 'slide-left' // enters from the right, settles
  | 'slide-right' // enters from the left, settles
  | 'slide-up'
  | 'pop' // scales up from nothing — good for "this appeared"
  | 'pulse'; // arrives, then breathes — good for "this is the point"

/** Emphasis. Tones map to theme tokens, never to literal colours. */
export type WireframeTone = 'base' | 'muted' | 'accent';

export interface WireframeShape {
  kind: WireframeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Seconds before this shape animates in. */
  delay?: number;
  motion?: WireframeMotion;
  tone?: WireframeTone;
}

export interface WireframeScene {
  /** Stable id — also the animation namespace, so it must be unique. */
  id: string;
  /** Read by screen readers in place of the animation. Required: a decorative
   *  <svg> with no text is invisible to anyone not looking at it. */
  alt: string;
  shapes: WireframeShape[];
}

/**
 * One slide of the gallery: a demo on the left, words on the right.
 *
 * A slide is IDENTIFIED BY THE RELEASE NOTE IT ILLUSTRATES rather than by a
 * name of its own. The slides live here in TypeScript and the notes live in
 * public/release-notes.json, so the two drift apart the moment someone ships a
 * feature and writes only the note — which is exactly how this gallery came to
 * be advertising six features nobody had shipped recently. Naming the note
 * makes that drift checkable: `tests/unit/wireframeScenes.test.ts` reads the
 * notes file and fails when a slide points at a note nobody wrote, or when the
 * newest release has no slide at all.
 */
export interface GallerySlide {
  /** The `version` slug of the release note this illustrates. Also the key. */
  note: string;
  title: string;
  body: string;
  scene: WireframeScene;
}

// --- validation ------------------------------------------------------------

const KINDS: readonly WireframeKind[] = ['panel', 'row', 'bar', 'chip', 'button', 'cursor'];
const MOTIONS: readonly WireframeMotion[] = [
  'none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'pop', 'pulse',
];
const TONES: readonly WireframeTone[] = ['base', 'muted', 'accent'];

/**
 * Whether a shape is drawable. A shape outside the viewBox or with no area is
 * not a rendering bug to hunt later — it is authoring data that is wrong now,
 * and this is where that gets caught.
 */
export function isValidShape(value: unknown): value is WireframeShape {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (!KINDS.includes(s.kind as WireframeKind)) return false;
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    const n = s[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  const { x, y, w, h } = s as unknown as WireframeShape;
  if (w <= 0 || h <= 0) return false;
  if (x < 0 || y < 0) return false;
  if (x + w > WIREFRAME_VIEWBOX.width || y + h > WIREFRAME_VIEWBOX.height) return false;
  if (s.delay !== undefined && (typeof s.delay !== 'number' || s.delay < 0)) return false;
  if (s.motion !== undefined && !MOTIONS.includes(s.motion as WireframeMotion)) return false;
  if (s.tone !== undefined && !TONES.includes(s.tone as WireframeTone)) return false;
  return true;
}

/** A scene is drawable if it is identified, described, and every shape is valid. */
export function isValidScene(value: unknown): value is WireframeScene {
  if (!value || typeof value !== 'object') return false;
  const scene = value as Record<string, unknown>;
  if (typeof scene.id !== 'string' || scene.id.trim() === '') return false;
  if (typeof scene.alt !== 'string' || scene.alt.trim() === '') return false;
  if (!Array.isArray(scene.shapes) || scene.shapes.length === 0) return false;
  return scene.shapes.every(isValidShape);
}

/**
 * How long one loop of a scene lasts, in seconds — the longest shape delay plus
 * the shared animation duration, floored so a single instant shape still holds
 * on screen long enough to be seen.
 */
export const WIREFRAME_ANIMATION_SECONDS = 0.55;
export const WIREFRAME_MIN_LOOP_SECONDS = 2.4;

export function sceneDurationSeconds(scene: WireframeScene): number {
  const last = scene.shapes.reduce((max, s) => Math.max(max, s.delay ?? 0), 0);
  return Math.max(WIREFRAME_MIN_LOOP_SECONDS, last + WIREFRAME_ANIMATION_SECONDS);
}

// --- the built-in scenes ---------------------------------------------------
//
// One per feature worth illustrating. Authored against a 160x100 box: a rough
// 16:10, which is why the slide puts the demo left and the prose right.
//
// A shape can only ARRIVE — there is no exit motion, and reduced-motion renders
// the settled frame. So a scene has to be composed as "these things appear",
// and the final still has to say the feature on its own.

/** A side panel arriving beside a list — used for split-view style features. */
const splitView: WireframeScene = {
  id: 'split-view',
  alt: 'A list on the left; a detail panel slides in beside it and its heading highlights.',
  shapes: [
    { kind: 'panel', x: 6, y: 8, w: 70, h: 84, tone: 'muted', motion: 'none' },
    { kind: 'row', x: 12, y: 16, w: 56, h: 7, tone: 'base', motion: 'fade', delay: 0.1 },
    { kind: 'row', x: 12, y: 28, w: 56, h: 7, tone: 'accent', motion: 'fade', delay: 0.2 },
    { kind: 'row', x: 12, y: 40, w: 56, h: 7, tone: 'base', motion: 'fade', delay: 0.3 },
    { kind: 'row', x: 12, y: 52, w: 56, h: 7, tone: 'base', motion: 'fade', delay: 0.4 },
    { kind: 'panel', x: 84, y: 8, w: 70, h: 84, tone: 'base', motion: 'slide-left', delay: 0.55 },
    { kind: 'bar', x: 92, y: 18, w: 40, h: 8, tone: 'accent', motion: 'pulse', delay: 0.9 },
    { kind: 'bar', x: 92, y: 34, w: 54, h: 5, tone: 'muted', motion: 'fade', delay: 1.05 },
    { kind: 'bar', x: 92, y: 44, w: 46, h: 5, tone: 'muted', motion: 'fade', delay: 1.15 },
  ],
};

/** Chips appearing in a field — token/skill inputs, participant chips. */
const chips: WireframeScene = {
  id: 'chips',
  alt: 'A text field where typed words become removable chips, one after another.',
  shapes: [
    { kind: 'panel', x: 10, y: 26, w: 140, h: 48, tone: 'muted', motion: 'none' },
    { kind: 'chip', x: 18, y: 38, w: 30, h: 12, tone: 'accent', motion: 'pop', delay: 0.15 },
    { kind: 'chip', x: 52, y: 38, w: 38, h: 12, tone: 'accent', motion: 'pop', delay: 0.5 },
    { kind: 'chip', x: 94, y: 38, w: 26, h: 12, tone: 'accent', motion: 'pop', delay: 0.85 },
    { kind: 'bar', x: 124, y: 42, w: 16, h: 4, tone: 'muted', motion: 'pulse', delay: 1.1 },
    { kind: 'cursor', x: 120, y: 52, w: 8, h: 10, tone: 'base', motion: 'fade', delay: 1.2 },
  ],
};

/** Rows pacing in one at a time — reply cadence, staggered arrival. */
const cadence: WireframeScene = {
  id: 'cadence',
  alt: 'Replies arriving one at a time, spaced apart, rather than all at once.',
  shapes: [
    { kind: 'panel', x: 8, y: 8, w: 144, h: 84, tone: 'muted', motion: 'none' },
    { kind: 'row', x: 16, y: 16, w: 60, h: 9, tone: 'base', motion: 'slide-right', delay: 0.1 },
    { kind: 'row', x: 84, y: 32, w: 56, h: 9, tone: 'accent', motion: 'slide-left', delay: 0.7 },
    { kind: 'row', x: 84, y: 48, w: 48, h: 9, tone: 'accent', motion: 'slide-left', delay: 1.3 },
    { kind: 'row', x: 84, y: 64, w: 52, h: 9, tone: 'accent', motion: 'slide-left', delay: 1.9 },
  ],
};

/** A tool being called and a result coming back — the agent tool loop. */
const toolLoop: WireframeScene = {
  id: 'tool-loop',
  alt: 'An agent calls a tool, a result returns, and the answer is written.',
  shapes: [
    { kind: 'panel', x: 8, y: 10, w: 64, h: 80, tone: 'muted', motion: 'none' },
    { kind: 'panel', x: 88, y: 10, w: 64, h: 80, tone: 'muted', motion: 'none' },
    { kind: 'bar', x: 16, y: 20, w: 44, h: 6, tone: 'base', motion: 'fade', delay: 0.1 },
    { kind: 'button', x: 16, y: 34, w: 34, h: 12, tone: 'accent', motion: 'pop', delay: 0.4 },
    { kind: 'row', x: 96, y: 34, w: 48, h: 12, tone: 'accent', motion: 'slide-left', delay: 0.9 },
    { kind: 'bar', x: 96, y: 54, w: 40, h: 5, tone: 'muted', motion: 'fade', delay: 1.2 },
    { kind: 'bar', x: 16, y: 60, w: 48, h: 5, tone: 'base', motion: 'fade', delay: 1.5 },
    { kind: 'bar', x: 16, y: 70, w: 36, h: 5, tone: 'base', motion: 'fade', delay: 1.65 },
  ],
};

/** A card unfurling under a line of text — link previews. */
const preview: WireframeScene = {
  id: 'preview',
  alt: 'A pasted link expands into a preview card with a thumbnail and title.',
  shapes: [
    { kind: 'bar', x: 16, y: 16, w: 90, h: 6, tone: 'base', motion: 'fade', delay: 0.1 },
    { kind: 'panel', x: 16, y: 30, w: 128, h: 54, tone: 'base', motion: 'slide-up', delay: 0.45 },
    { kind: 'panel', x: 24, y: 38, w: 38, h: 38, tone: 'accent', motion: 'fade', delay: 0.8 },
    { kind: 'bar', x: 70, y: 42, w: 60, h: 7, tone: 'base', motion: 'fade', delay: 0.95 },
    { kind: 'bar', x: 70, y: 54, w: 66, h: 4, tone: 'muted', motion: 'fade', delay: 1.05 },
    { kind: 'bar', x: 70, y: 62, w: 50, h: 4, tone: 'muted', motion: 'fade', delay: 1.15 },
  ],
};

/** Windows dropping away to reveal the desktop. */
const showDesktop: WireframeScene = {
  id: 'show-desktop',
  alt: 'Open windows drop away to the dock, leaving the desktop and its input.',
  shapes: [
    { kind: 'panel', x: 14, y: 12, w: 60, h: 44, tone: 'base', motion: 'fade', delay: 0 },
    { kind: 'panel', x: 50, y: 26, w: 60, h: 44, tone: 'base', motion: 'fade', delay: 0.15 },
    { kind: 'panel', x: 86, y: 16, w: 58, h: 44, tone: 'base', motion: 'fade', delay: 0.3 },
    { kind: 'panel', x: 34, y: 76, w: 92, h: 14, tone: 'accent', motion: 'slide-up', delay: 1.1 },
    { kind: 'chip', x: 60, y: 79, w: 8, h: 8, tone: 'muted', motion: 'pop', delay: 1.4 },
    { kind: 'chip', x: 74, y: 79, w: 8, h: 8, tone: 'muted', motion: 'pop', delay: 1.5 },
    { kind: 'chip', x: 88, y: 79, w: 8, h: 8, tone: 'muted', motion: 'pop', delay: 1.6 },
  ],
};

/** A conversation that belongs to the two people in it — private DMs. */
const dmPrivacy: WireframeScene = {
  id: 'dm-privacy',
  alt: 'The rest of the workspace waits outside while a conversation opens holding only its two people and their messages.',
  shapes: [
    // The rest of the workspace, pushed to the margin: present, but outside.
    // Held at x>=16: the carousel's previous-slide arrow floats over the demo's
    // left edge, and it lands squarely on anything nearer the border.
    { kind: 'chip', x: 16, y: 18, w: 12, h: 12, tone: 'base', motion: 'fade', delay: 0.1 },
    { kind: 'chip', x: 16, y: 40, w: 12, h: 12, tone: 'base', motion: 'fade', delay: 0.2 },
    { kind: 'chip', x: 16, y: 62, w: 12, h: 12, tone: 'base', motion: 'fade', delay: 0.3 },
    { kind: 'panel', x: 38, y: 10, w: 116, h: 80, tone: 'base', motion: 'slide-left', delay: 0.6 },
    // Exactly two people inside it — the whole point, so they land last and loud.
    { kind: 'chip', x: 48, y: 20, w: 14, h: 14, tone: 'accent', motion: 'pop', delay: 0.95 },
    { kind: 'chip', x: 68, y: 20, w: 14, h: 14, tone: 'accent', motion: 'pop', delay: 1.05 },
    { kind: 'bar', x: 48, y: 50, w: 82, h: 6, tone: 'muted', motion: 'fade', delay: 1.3 },
    { kind: 'bar', x: 48, y: 64, w: 62, h: 6, tone: 'muted', motion: 'fade', delay: 1.45 },
  ],
};

/** A rule assembled from parts, then firing into a channel — automations. */
const automationRule: WireframeScene = {
  id: 'automation-rule',
  alt: 'A rule is assembled from a trigger, a filter and a destination, then posts its message into a channel.',
  shapes: [
    { kind: 'panel', x: 6, y: 8, w: 66, h: 84, tone: 'muted', motion: 'none' },
    { kind: 'chip', x: 14, y: 18, w: 30, h: 12, tone: 'accent', motion: 'pop', delay: 0.2 },
    { kind: 'chip', x: 14, y: 36, w: 40, h: 12, tone: 'base', motion: 'pop', delay: 0.5 },
    { kind: 'chip', x: 14, y: 54, w: 34, h: 12, tone: 'base', motion: 'pop', delay: 0.8 },
    { kind: 'button', x: 14, y: 72, w: 26, h: 12, tone: 'base', motion: 'pop', delay: 1.05 },
    { kind: 'panel', x: 84, y: 8, w: 70, h: 84, tone: 'muted', motion: 'none' },
    { kind: 'row', x: 92, y: 22, w: 48, h: 10, tone: 'muted', motion: 'fade', delay: 0.15 },
    // The posted message: the only thing a rule can actually do. It travels
    // rightward, out of the rule and into the channel — a shape that merely
    // appeared here would leave two unrelated lists side by side.
    { kind: 'row', x: 92, y: 44, w: 54, h: 12, tone: 'accent', motion: 'slide-right', delay: 1.45 },
  ],
};

/** An agent saved into a gallery of starting points — agent templates. */
const savedTemplate: WireframeScene = {
  id: 'saved-template',
  alt: 'A tuned agent is saved with a button and joins the gallery of templates as its new first tile.',
  shapes: [
    { kind: 'panel', x: 6, y: 10, w: 58, h: 80, tone: 'muted', motion: 'none' },
    // The agent you tuned: two lines of wording above the button.
    { kind: 'bar', x: 14, y: 22, w: 42, h: 6, tone: 'base', motion: 'fade', delay: 0.15 },
    { kind: 'bar', x: 14, y: 34, w: 32, h: 6, tone: 'base', motion: 'fade', delay: 0.25 },
    { kind: 'panel', x: 78, y: 10, w: 76, h: 80, tone: 'muted', motion: 'none' },
    // The gallery that already existed, filling in first.
    { kind: 'panel', x: 120, y: 20, w: 26, h: 26, tone: 'base', motion: 'fade', delay: 0.35 },
    { kind: 'panel', x: 86, y: 54, w: 28, h: 26, tone: 'base', motion: 'fade', delay: 0.45 },
    { kind: 'panel', x: 120, y: 54, w: 26, h: 26, tone: 'base', motion: 'fade', delay: 0.55 },
    { kind: 'button', x: 14, y: 70, w: 40, h: 12, tone: 'accent', motion: 'pop', delay: 0.8 },
    { kind: 'panel', x: 86, y: 20, w: 28, h: 26, tone: 'accent', motion: 'pulse', delay: 1.25 },
  ],
};

/** One invite resolves to a human, an agent, or a workspace resource. */
const connectionResources: WireframeScene = {
  id: 'connection-resources',
  alt: 'A single invite link is redeemed into a human connection, an agent connection, or a resource steward inside the workspace.',
  shapes: [
    { kind: 'panel', x: 6, y: 10, w: 54, h: 80, tone: 'muted', motion: 'none' },
    { kind: 'chip', x: 14, y: 22, w: 34, h: 12, tone: 'accent', motion: 'pop', delay: 0.2 },
    { kind: 'row', x: 14, y: 42, w: 36, h: 9, tone: 'base', motion: 'fade', delay: 0.45 },
    { kind: 'row', x: 14, y: 56, w: 30, h: 9, tone: 'base', motion: 'fade', delay: 0.65 },
    { kind: 'panel', x: 72, y: 10, w: 82, h: 80, tone: 'muted', motion: 'none' },
    { kind: 'row', x: 82, y: 22, w: 54, h: 10, tone: 'base', motion: 'fade', delay: 0.3 },
    { kind: 'chip', x: 82, y: 42, w: 22, h: 12, tone: 'accent', motion: 'pulse', delay: 0.9 },
    { kind: 'chip', x: 110, y: 42, w: 22, h: 12, tone: 'base', motion: 'pop', delay: 1.05 },
    { kind: 'chip', x: 82, y: 62, w: 50, h: 12, tone: 'base', motion: 'pop', delay: 1.2 },
  ],
};

/** Lines appended to a ledger, each naming who — the audit log. */
const auditLog: WireframeScene = {
  id: 'audit-log',
  alt: 'Each change is written as a line naming who made it, and a new line is appended below the last.',
  shapes: [
    { kind: 'panel', x: 8, y: 8, w: 144, h: 84, tone: 'muted', motion: 'none' },
    { kind: 'chip', x: 16, y: 20, w: 12, h: 12, tone: 'base', motion: 'fade', delay: 0.15 },
    { kind: 'row', x: 34, y: 20, w: 104, h: 12, tone: 'base', motion: 'fade', delay: 0.2 },
    { kind: 'chip', x: 16, y: 42, w: 12, h: 12, tone: 'base', motion: 'fade', delay: 0.5 },
    { kind: 'row', x: 34, y: 42, w: 104, h: 12, tone: 'base', motion: 'fade', delay: 0.55 },
    // Appended, never rewritten: the newest entry lands under the others.
    { kind: 'chip', x: 16, y: 64, w: 12, h: 12, tone: 'accent', motion: 'pop', delay: 1.0 },
    { kind: 'row', x: 34, y: 64, w: 104, h: 12, tone: 'accent', motion: 'pulse', delay: 1.05 },
  ],
};

/** Three dots filling in below a conversation — typing indicators. */
const typingDots: WireframeScene = {
  id: 'typing-dots',
  alt: 'Below the conversation an avatar appears with three dots filling in one after another.',
  shapes: [
    { kind: 'panel', x: 8, y: 10, w: 144, h: 80, tone: 'muted', motion: 'none' },
    { kind: 'row', x: 16, y: 20, w: 76, h: 10, tone: 'base', motion: 'fade', delay: 0.1 },
    { kind: 'row', x: 16, y: 36, w: 58, h: 10, tone: 'base', motion: 'fade', delay: 0.25 },
    { kind: 'chip', x: 16, y: 58, w: 14, h: 14, tone: 'base', motion: 'fade', delay: 0.75 },
    { kind: 'chip', x: 38, y: 63, w: 7, h: 7, tone: 'accent', motion: 'pop', delay: 1.0 },
    { kind: 'chip', x: 50, y: 63, w: 7, h: 7, tone: 'accent', motion: 'pop', delay: 1.15 },
    { kind: 'chip', x: 62, y: 63, w: 7, h: 7, tone: 'accent', motion: 'pop', delay: 1.3 },
  ],
};

/** A run that ends early, with the reason attached — agent stop reasons. */
const stopReason: WireframeScene = {
  id: 'stop-reason',
  alt: 'A run of replies ends part-way through, and a labelled badge with a line of explanation appears beneath it.',
  shapes: [
    { kind: 'panel', x: 8, y: 10, w: 144, h: 80, tone: 'muted', motion: 'none' },
    { kind: 'row', x: 16, y: 20, w: 64, h: 9, tone: 'base', motion: 'fade', delay: 0.1 },
    { kind: 'row', x: 16, y: 33, w: 76, h: 9, tone: 'base', motion: 'fade', delay: 0.3 },
    // Cut short: the run that did not finish.
    { kind: 'row', x: 16, y: 46, w: 34, h: 9, tone: 'base', motion: 'fade', delay: 0.5 },
    { kind: 'chip', x: 16, y: 64, w: 36, h: 13, tone: 'accent', motion: 'pulse', delay: 1.0 },
    { kind: 'bar', x: 58, y: 67, w: 76, h: 7, tone: 'base', motion: 'fade', delay: 1.25 },
  ],
};

/** A self-hosted account form with only its available local sign-in path. */
const socialSignInGuard: WireframeScene = {
  id: 'social-sign-in-guard',
  alt: 'A self-hosted account form shows email and password without unavailable social sign-in buttons.',
  shapes: [
    { kind: 'panel', x: 30, y: 6, w: 100, h: 88, tone: 'muted', motion: 'none' },
    { kind: 'bar', x: 47, y: 17, w: 66, h: 8, tone: 'accent', motion: 'fade', delay: 0.1 },
    { kind: 'bar', x: 40, y: 35, w: 80, h: 12, tone: 'base', motion: 'slide-up', delay: 0.35 },
    { kind: 'bar', x: 40, y: 54, w: 80, h: 12, tone: 'base', motion: 'slide-up', delay: 0.5 },
    { kind: 'button', x: 40, y: 74, w: 80, h: 12, tone: 'accent', motion: 'pop', delay: 0.7 }
 ]
}
/** A selected local CLI becoming the explicit runtime in its connect command. */
const codexRuntime: WireframeScene = {
  id: 'codex-runtime',
  alt: 'Codex is selected from two local CLI choices, then appears as the highlighted runtime in the generated connection command.',
  shapes: [
    { kind: 'panel', x: 6, y: 10, w: 66, h: 80, tone: 'muted', motion: 'none' },
    { kind: 'row', x: 14, y: 22, w: 48, h: 12, tone: 'base', motion: 'fade', delay: 0.15 },
    { kind: 'row', x: 14, y: 42, w: 48, h: 12, tone: 'accent', motion: 'pulse', delay: 0.45 },
    { kind: 'button', x: 14, y: 66, w: 30, h: 12, tone: 'accent', motion: 'pop', delay: 0.75 },
    { kind: 'panel', x: 82, y: 10, w: 72, h: 80, tone: 'base', motion: 'slide-left', delay: 1.0 },
    { kind: 'bar', x: 90, y: 26, w: 54, h: 6, tone: 'muted', motion: 'fade', delay: 1.2 },
    { kind: 'chip', x: 90, y: 44, w: 46, h: 13, tone: 'accent', motion: 'pulse', delay: 1.4 },
    { kind: 'bar', x: 90, y: 68, w: 38, h: 5, tone: 'muted', motion: 'fade', delay: 1.55 },
  ]
};

export const WIREFRAME_SCENES = {
  // In the gallery today.
  socialSignInGuard, dmPrivacy, automationRule, codexRuntime, savedTemplate, connectionResources, auditLog, typingDots, stopReason,
  // Retired from the gallery when their feature stopped being news. Kept as
  // authored vocabulary — a scene costs nothing and is the reference for how
  // this format is meant to read.
  splitView, chips, cadence, toolLoop, preview, showDesktop
} as const;

export type WireframeSceneName = keyof typeof WIREFRAME_SCENES;

// --- the gallery -----------------------------------------------------------

/**
 * The slides shown above the notes. Curated, not derived: a gallery is "here
 * is what is worth knowing", and every entry needs a demo that genuinely
 * illustrates it — most notes have no such demo and stay bullets below.
 *
 * But curated is not the same as free-floating. Each slide names the release
 * note it illustrates, so a slide can be checked against what actually shipped
 * instead of quietly outliving it. Retiring a slide is deleting it from here;
 * its scene stays in WIREFRAME_SCENES.
 */
export const GALLERY_SLIDES: GallerySlide[] = [
  {
    note: 'workspace-connections-and-agent-resources',
    title: 'One link, clear roles',
    body: 'Invite a person, an agent, or a resource steward with one short-lived link; the workspace keeps authority and capability separate.',
    scene: connectionResources,
  },
  {
    note: 'self-hosted-social-sign-in',
    title: 'Local sign-in shows the local path',
    body: 'A self-hosted account page now leaves unavailable Google and GitHub buttons out and presents email and password directly.',
    scene: socialSignInGuard
  },
  {
    note: 'onboarding-codex-runtime',
    title: 'Choosing Codex now connects Codex',
    body: 'The setup choice is saved before the command is made, so a Codex agent uses the Codex CLI and your logged-in OpenAI account.',
    scene: codexRuntime,
  },
  {
    note: 'private-direct-messages',
    title: 'Direct messages are private',
    body: 'A DM is readable only by the people in it. An admin can grant access to one conversation, and every grant is recorded.',
    scene: dmPrivacy,
  },
  {
    note: 'agent-templates',
    title: 'Save an agent as a template',
    body: 'Tune an agent once, save it, and start the next one from it. Your own templates sit alongside the built-in ones.',
    scene: savedTemplate,
  },
  {
    note: 'audit-log',
    title: 'A record of who changed what',
    body: 'Sensitive changes are written to a log you can read back: who did it, what changed, and when.',
    scene: auditLog,
  },
];

/**
 * The slides in release order — newest note first — so the gallery leads with
 * the latest thing without anyone remembering to re-sort this file. Slides
 * whose note is not in the list (a notes file that failed to load, or a slide
 * added ahead of its note) keep their authored order at the end rather than
 * disappearing: a gallery is better slightly stale than empty.
 *
 * `notes` is taken structurally rather than as a ReleaseNote[] so this file
 * stays what it is — authoring data with no dependencies.
 */
export function orderGallerySlides(
  slides: readonly GallerySlide[],
  notes: readonly { version: string }[],
): GallerySlide[] {
  const rank = new Map(notes.map((n, i) => [n.version, i]));
  const place = (s: GallerySlide) => rank.get(s.note) ?? Number.POSITIVE_INFINITY;
  return slides
    .map((slide, i) => ({ slide, i }))
    // Index as the tiebreaker keeps this a stable sort on every engine, which
    // matters because unplaced slides all share one rank.
    .sort((a, b) => place(a.slide) - place(b.slide) || a.i - b.i)
    .map(({ slide }) => slide);
}

/**
 * Which slide to show for a given index, wrapping. Extracted so the carousel's
 * dots and the keyboard handler share one definition of "next" — two of those
 * disagreeing is how a gallery ends up skipping a slide at the wrap.
 */
export function nextSlideIndex(current: number, total: number, step = 1): number {
  if (total <= 0) return 0;
  return ((current + step) % total + total) % total;
}
