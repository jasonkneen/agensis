import { useId, useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  WIREFRAME_ANIMATION_SECONDS,
  WIREFRAME_VIEWBOX,
  isValidScene,
  sceneDurationSeconds,
  type WireframeKind,
  type WireframeMotion,
  type WireframeScene,
  type WireframeShape,
  type WireframeTone,
} from '@/lib/wireframeScenes';

// ---------------------------------------------------------------------------
// Renders a WireframeScene: a looping, theme-coloured animated diagram of a
// feature. Format and reasoning in src/lib/wireframeScenes.ts; authoring guide
// in .claude/skills/wireframe-demos/SKILL.md.
//
// THE DELAY IS BAKED INTO THE KEYFRAMES, not expressed with animation-delay.
// `animation-delay` applies to the FIRST iteration only, so a staggered scene
// built that way plays correctly once and then collapses — every shape arriving
// together on loop two. Instead each shape gets its own keyframes whose motion
// occupies the slice of the loop it is due, which makes the stagger survive
// every repeat.
//
// Keyframes live in a <style> inside this component rather than index.css:
// it is a self-contained reusable component, index.css is a heavily-shared
// file, and the rules are namespaced by a generated id so two demos rendered
// at once (a gallery mid-transition shows two slides) cannot collide.
//
// Colour is theme tokens only — currentColor and --primary via Tailwind
// opacity utilities — so a wireframe stays legible in every theme, including
// the brutal ones, with no per-theme branch.
// ---------------------------------------------------------------------------

export interface WireframeDemoProps {
  scene: WireframeScene;
  className?: string;
}

/** Corner rounding per kind — with size, the only thing distinguishing them,
 *  which is what keeps the vocabulary abstract rather than app-specific. */
const RADIUS: Record<WireframeKind, number> = {
  panel: 4,
  row: 2.5,
  bar: 2,
  chip: 6,
  button: 3,
  cursor: 1.5,
};

const TONE_CLASS: Record<WireframeTone, string> = {
  base: 'fill-foreground/25',
  muted: 'fill-foreground/10',
  accent: 'fill-primary/55',
};

/** The hidden state a motion starts from. `none` has no hidden state. */
const FROM: Record<Exclude<WireframeMotion, 'none'>, string> = {
  fade: 'opacity:0',
  'slide-left': 'opacity:0;transform:translateX(14px)',
  'slide-right': 'opacity:0;transform:translateX(-14px)',
  'slide-up': 'opacity:0;transform:translateY(12px)',
  pop: 'opacity:0;transform:scale(.6)',
  pulse: 'opacity:0;transform:scale(.85)',
};

const SETTLED = 'opacity:1;transform:none';

/**
 * Keyframes for one shape, with its delay expressed as a percentage of the
 * shared loop so the stagger repeats correctly.
 */
function keyframesFor(name: string, shape: WireframeShape, loop: number): string {
  const motion = shape.motion ?? 'fade';
  if (motion === 'none') return '';
  const start = ((shape.delay ?? 0) / loop) * 100;
  const end = Math.min(100, (((shape.delay ?? 0) + WIREFRAME_ANIMATION_SECONDS) / loop) * 100);
  const from = FROM[motion];
  const pct = (n: number) => `${n.toFixed(3)}%`;

  // pulse keeps breathing after it lands, so a scene can say "this is the
  // point" without another shape competing for attention.
  if (motion === 'pulse') {
    const mid = Math.min(100, end + (100 - end) * 0.45);
    return `@keyframes ${name}{0%{${from}}${pct(start)}{${from}}${pct(end)}{${SETTLED}}` +
      `${pct(mid)}{opacity:.7;transform:none}100%{${SETTLED}}}`;
  }
  return `@keyframes ${name}{0%{${from}}${pct(start)}{${from}}${pct(end)}{${SETTLED}}100%{${SETTLED}}}`;
}

export function WireframeDemo({ scene, className }: WireframeDemoProps) {
  const rawId = useId();
  const ns = useMemo(() => `wf${rawId.replace(/[^a-zA-Z0-9]/g, '')}`, [rawId]);

  const valid = isValidScene(scene);
  const loop = valid ? sceneDurationSeconds(scene) : 0;

  const css = useMemo(() => {
    if (!valid) return '';
    const rules = scene.shapes
      .map((shape, i) => keyframesFor(`${ns}-k${i}`, shape, loop))
      .filter(Boolean)
      .join('');
    // Reduced motion is an accessibility setting, not a preference to talk out
    // of: the scene renders in its FINAL state, so it still illustrates the
    // feature with nothing moving.
    return `${rules}
      .${ns}-shape{transform-box:fill-box;transform-origin:center;animation-iteration-count:infinite;animation-timing-function:cubic-bezier(.2,.7,.3,1);animation-duration:${loop}s}
      @media (prefers-reduced-motion:reduce){.${ns}-shape{animation:none!important;opacity:1!important;transform:none!important}}`;
  }, [valid, scene, ns, loop]);

  // A malformed scene renders nothing rather than a broken diagram. Authoring
  // data is validated in tests; this is the runtime floor.
  if (!valid) return null;

  return (
    <div className={cn('relative w-full overflow-hidden rounded-lg bg-muted/40', className)}>
      <style>{css}</style>
      <svg
        viewBox={`0 0 ${WIREFRAME_VIEWBOX.width} ${WIREFRAME_VIEWBOX.height}`}
        className="block h-full w-full"
        role="img"
        aria-label={scene.alt}
        data-testid={`wireframe-${scene.id}`}
      >
        {scene.shapes.map((shape, i) => {
          const motion = shape.motion ?? 'fade';
          return (
            <rect
              key={`${shape.kind}-${i}`}
              className={cn(`${ns}-shape`, TONE_CLASS[shape.tone ?? 'base'])}
              x={shape.x}
              y={shape.y}
              width={shape.w}
              height={shape.h}
              rx={RADIUS[shape.kind]}
              style={
                motion === 'none'
                  ? { opacity: 1 }
                  : { animationName: `${ns}-k${i}` }
              }
            />
          );
        })}
      </svg>
    </div>
  );
}
