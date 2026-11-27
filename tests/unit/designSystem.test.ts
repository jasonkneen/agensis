import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The design system, enforced.
//
// This app already had the right shape — oklch tokens, a type ramp including
// --text-2xs/--text-3xs, semantic state colours — and it was being eroded one
// bracket at a time: 106 arbitrary font sizes, 73 raw Tailwind palette colours,
// and a tile radius spelled as 7px, 9px and 11px in different files. None of
// that failed a test, so nothing stopped it, and the result is an interface that
// is *nearly* consistent and therefore reads as sloppy rather than deliberate.
//
// These are the rules that keep it deliberate. Each one names the alternative
// in its failure message, so the fix is obvious at the point of failure.

const SRC = path.resolve(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      walk(p, out);
    } else if (/\.(tsx|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const read = (f: string) => fs.readFileSync(f, 'utf8');
const rel = (f: string) => path.relative(process.cwd(), f);

/**
 * Strip BLOCK comments so prose about a class is never mistaken for the class.
 *
 * Line comments are deliberately NOT stripped. Every JSX attribute in this
 * codebase is documented with a `//` comment directly above it, so removing
 * comment lines also removes the very attributes these rules look for — and a
 * rule that then reports correct, accessible code as broken is worse than no
 * rule at all. Prose in a `//` comment cannot match these patterns anyway,
 * because they all require a `class=`-shaped or `<tag ...onClick=` construct.
 */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the type scale', () => {
  it('is the only way font sizes are expressed', () => {
    // text-[0.6875rem] WAS --text-2xs; text-[0.8125rem] became --text-xs-plus;
    // 7-8px avatar monograms became --text-avatar; the pixel feed --text-pixel.
    // An arbitrary size means someone needed a step the ramp does not have —
    // name it in index.css rather than burying a magic number in a component.
    const offenders: string[] = [];
    for (const file of files) {
      const text = code(read(file));
      for (const m of text.matchAll(/\btext-\[[0-9.]+(?:px|rem)\]/g)) {
        offenders.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(offenders, 'use a scale step (text-4xs/3xs/2xs/xs/xs-plus/sm) or add one to index.css').toEqual([]);
  });

  it('exposes every step it declares', () => {
    const css = read(path.join(SRC, 'index.css'));
    // Each named step must have a real rem value, so a typo in a token name
    // cannot silently render at the browser's default size.
    for (const token of ['--text-2xs', '--text-3xs', '--text-4xs', '--text-xs-plus', '--text-avatar', '--text-pixel']) {
      const m = new RegExp(`${token}:\\s*([^;]+);`).exec(css);
      expect(m, `${token} must be declared in index.css`).toBeTruthy();
      expect(m![1].trim(), `${token} must be a rem value so the UI font-size setting scales it`).toMatch(/^[0-9.]+rem$/);
    }
  });
});

describe('colour', () => {
  // Decorative and identity colours that are legitimately literal: the canvas
  // colour picker offers these exact swatches to the user, and the onboarding
  // tour assigns one accent per step.
  const ALLOWED_LITERAL_HUES = new Set([
    'src/components/canvas/CanvasToolbar.tsx',
    'src/components/onboarding/OnboardingTour.tsx',
    'src/components/editor/DocumentComments.tsx',
    'src/components/windows/TasksWindowContent.tsx',
    'src/components/canvas/DrawingLayer.tsx',
  ]);

  it('routes state meaning through semantic tokens, not raw palette utilities', () => {
    const palette = /(?:text|bg|border|ring|from|to|via)-(?:red|green|blue|amber|violet|purple|orange|yellow|pink|rose|cyan|teal|emerald|indigo|sky|lime|fuchsia)-\d{3}\b/g;
    const offenders: string[] = [];
    for (const file of files) {
      const relative = rel(file);
      if (ALLOWED_LITERAL_HUES.has(relative)) continue;
      // The agent hue and the info hue are tokens precisely because they were
      // spelled as violet-500 / sky-500 here; catching them keeps them tokens.
      for (const m of code(read(file)).matchAll(palette)) {
        offenders.push(`${relative}: ${m[0]}`);
      }
    }
    expect(offenders, 'use --agent / --info / --success / --warning / --destructive tokens').toEqual([]);
  });

  it('defines every state colour in EVERY theme family', () => {
    // A theme family that overrides some state colours but not others is the
    // subtlest kind of inconsistency: the Expo family redefined success/warning/
    // error, so an agent chip or info dot inside it silently fell back to the
    // default palette and read as a different product. If a family sets one
    // state colour it must set them all.
    const files = {
      default: read(path.join(SRC, 'index.css')),
      expo: read(path.join(SRC, 'styles', 'expo.css')),
    };
    const STATE = ['--success', '--warning', '--error', '--agent', '--info', '--knowledge'];
    for (const [family, css] of Object.entries(files)) {
      for (const token of STATE) {
        const n = (css.match(new RegExp(`${token}:`, 'g')) || []).length;
        expect(n, `${family} must define ${token}`).toBeGreaterThan(0);
      }
    }
  });

  it('defines the agent and info colours in BOTH themes', () => {
    const css = read(path.join(SRC, 'index.css'));
    // A token defined only in the dark block leaves light mode unstyled, which
    // is exactly how the violet/sky literals happened in the first place.
    for (const token of ['--agent', '--info']) {
      const count = (css.match(new RegExp(`${token}:`, 'g')) || []).length;
      expect(count, `${token} must be defined for dark AND light`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('shape', () => {
  it('does not spell radii as arbitrary pixels', () => {
    // rounded-[7px]/[9px]/[11px] were three spellings of the same tile.
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of code(read(file)).matchAll(/\brounded-\[[0-9]+px\]/g)) {
        // Sub-4px decorative marks (a dock dot, a picker outline) sit below the
        // scale on purpose and are not worth a token.
        const px = Number(/\[(\d+)px\]/.exec(m[0])![1]);
        if (px < 4) continue;
        offenders.push(`${rel(file)}: ${m[0]}`);
      }
    }
    expect(offenders, 'use rounded-sm/md/lg/xl/tile/tile-tight, or add a token').toEqual([]);
  });

  it('declares the tile radius for the shapes it names', () => {
    const css = read(path.join(SRC, 'index.css'));
    expect(css).toMatch(/--radius-tile:\s*[0-9]+px/);
    expect(css).toMatch(/--radius-tile-tight:\s*[0-9]+px/);
  });
});

describe('motion', () => {
  it('never animates every property with transition-all', () => {
    // transition-all animates layout properties too, which is both slower and
    // the cause of the "everything jiggles" feel. Name what moves.
    const offenders: string[] = [];
    for (const file of files) {
      const text = code(read(file));
      for (const m of text.matchAll(/transition-all\b/g)) offenders.push(rel(file));
    }
    expect([...new Set(offenders)], 'list the properties that animate, e.g. transition-[transform,box-shadow]').toEqual([]);
  });
});

describe('interaction surfaces', () => {
  it('does not put ACTIONS on non-interactive elements', () => {
    // A div with onClick is unreachable by keyboard and invisible to assistive
    // tech, so a real control must be a <button>.
    //
    // Click-away scrims are the exception, and they are not controls: a
    // full-bleed backdrop that dismisses a dialog is a convenience for pointer
    // users, the dialog itself owns the keyboard (Escape, and its own buttons),
    // and an `aria-hidden` scrim must not be focusable. Those are recognised by
    // being inside a dialog/drawer or marked aria-hidden — anything else is a
    // control hiding in a div and is reported.
    const offenders: string[] = [];
    for (const file of files) {
      const text = code(read(file));
      for (const m of text.matchAll(/<(div|span)\b([^>]*)onClick=/g)) {
        const attrs = m[2] ?? '';
        const elementStart = m.index ?? 0;
        // Grab a little context around the element to spot its own attributes
        // (aria-hidden/role) wherever they were written.
        // The element's own opening tag, plus a little after it. 900 chars
        // because these tags carry comment blocks and conditional class lists;
        // too small a window reports correct code as broken.
        // From the tag's `<` to its closing `>`, plus a little after it. Anchoring
        // on the tag boundary (not a fixed character count) means documented
        // attributes and long conditional class lists cannot push the attributes
        // these rules look for out of the window.
        const tagEnd = text.indexOf('>', elementStart);
        const context = text.slice(elementStart, Math.max(elementStart + 900, tagEnd + 200));
        // Acceptable, in order of preference:
        //  - a pointer-only dismiss scrim inside a dialog, or marked aria-hidden;
        //  - an element that reconstructed the control contract by hand:
        //    role="button" + tabIndex + an Enter/Space key handler. That is not
        //    the ideal (<button> is), but it IS keyboard reachable and announced,
        //    so it is not an accessibility defect and this rule must not cry
        //    wolf about it (a gate that cries wolf gets deleted).
        const isScrim =
          /aria-hidden/.test(context) ||
          /role="dialog"/.test(context) ||
          /role="presentation"/.test(context);
        if (isScrim) continue;
        // The role may be a literal (`role="button"`) or conditional
        // (`role={isHeader ? undefined : 'button'}`), which is how a row band
        // that is only sometimes a control has to be written.
        const hasButtonRole = /role="button"/.test(context) || /role=\{[^}]*'button'/.test(context);
        const reconstructed =
          hasButtonRole &&
          /tabIndex=\{/.test(context) &&
          /onKeyDown=/.test(context);
        if (reconstructed) continue;
        const line = text.slice(0, elementStart).split('\n').length;
        offenders.push(`${rel(file)}:${line} <${m[1]} ... onClick>`);
      }
    }
    expect(offenders, 'use <button>, or mark a pointer-only scrim with aria-hidden').toEqual([]);
  });
});
