import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// One monospace face, and it must be one the app actually ships.
//
// Before --font-mono existed there were four competing stacks. The two most
// visible named a font nobody installs: `.chat-markdown code` and the code
// block both asked for 'JetBrains Mono', which is not a dependency and is not
// imported, so inline code rendered in whatever the OS fell back to — SFMono on
// a Mac, Consolas on Windows, Fira if the user happened to have it — while the
// neo theme rendered IBM Plex and Tailwind's own `font-mono` utility resolved to
// the framework's system stack. Three different monospace faces could appear on
// one screen, and nothing failed, so nobody saw it.
//
// The trap is that a font-family naming an absent face is SILENT. Only a test
// that cross-checks the names against what is imported can catch it.

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
const settings = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/settings.ts'), 'utf8');

/** Font families @import-ed from a bundled @fontsource package. */
function bundledFamilies(): string[] {
  return [...css.matchAll(/@import ["']@fontsource(?:-variable)?\/([a-z0-9-]+)/g)]
    .map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);
}

/** Strip comments so prose about a font is never mistaken for a declaration. */
function cssWithoutComments(): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the default UI face', () => {
  it('is bundled, not fetched from a third party at runtime', () => {
    // Every font choice except this one was a bundled @fontsource package;
    // 'bricolage' — the DEFAULT — was fetched from fonts.googleapis.com by
    // ensureUiFontLoaded. So the app's own default look depended on Google
    // answering, and a cold load, an offline session or the installed PWA
    // rendered the next face in the stack instead.
    expect(css).toMatch(/@import ["']@fontsource-variable\/bricolage-grotesque/);

    // It must NOT also sit in the on-demand Google map, or it would still be
    // requested over the network despite being bundled.
    const map = /const UI_FONT_GOOGLE_FAMILY[\s\S]*?\n\};/.exec(settings);
    expect(map, 'settings.ts must still declare the on-demand font map').toBeTruthy();
    expect(map![0]).not.toMatch(/\bbricolage:/);
  });

  it('names the family the bundled file actually registers', () => {
    // The variable build registers as 'Bricolage Grotesque Variable'. A stack
    // asking only for 'Bricolage Grotesque' matches nothing and silently falls
    // through to Geist — which is exactly the failure bundling it was meant to
    // fix, so the bundle alone would have been a no-op.
    const stacks = [...css.matchAll(/'Bricolage Grotesque[^']*'/g)].map(m => m[0]);
    expect(stacks.length).toBeGreaterThan(0);
    for (const [i, name] of stacks.entries()) {
      if (name !== "'Bricolage Grotesque Variable'") {
        // Every plain mention must be preceded by the Variable name as a
        // higher-priority candidate in the same stack.
        expect(stacks[i - 1], `bare ${name} with no Variable name before it`).toBe("'Bricolage Grotesque Variable'");
      }
    }
  });
});

describe('the --text-* namespace', () => {
  it('holds only font SIZES, never colours', () => {
    // Tailwind v4 generates utilities from `--text-*` in the theme block, so
    // that prefix means font-size. Four text COLOURS used to live one keystroke
    // away as --text-primary/-secondary/-muted/-inverse, safe only because they
    // sat at :root rather than in @theme — one accidental move and
    // `.text-primary` would set font-size to a hex string. They are `--ink*`
    // now, which collides with no Tailwind namespace.
    const declarations = [...css.matchAll(/^\s*(--text-[a-z0-9-]+):\s*([^;]+);/gm)];
    expect(declarations.length).toBeGreaterThan(0);
    for (const [, name, value] of declarations) {
      expect(value.trim(), `${name} looks like a colour, not a size`).toMatch(/^[0-9.]+(rem|em|px)$/);
    }
  });

  it('keeps the ink colours off that prefix', () => {
    expect(css).toMatch(/--ink:/);
    expect(css).not.toMatch(/--text-(primary|secondary|muted|inverse)\b/);
  });
});

describe('mono typography', () => {
  it('defines a single --font-mono token', () => {
    expect(cssWithoutComments()).toMatch(/--font-mono:\s*'IBM Plex Mono'/);
  });

  it('routes every mono surface through that token, not a literal stack', () => {
    const live = cssWithoutComments();
    // Inline code, code blocks and the neo theme each used to carry their own
    // stack. Each must now defer.
    const monoDeclarations = [...live.matchAll(/font-family:\s*([^;]+);/g)]
      .map(m => m[1].trim())
      .filter(value => /mono/i.test(value));

    const literalStacks = monoDeclarations.filter(
      value => !value.includes('var(--font-mono)') && !value.includes('var(--neo-mono)'),
    );
    // 'Press Start 2P' is the retro pixel DISPLAY face, not a code face, and is
    // deliberately exempt.
    const unexpected = literalStacks.filter(value => !value.includes('Press Start 2P'));
    expect(unexpected).toEqual([]);
  });

  it('never names a font that is not bundled or fetched on demand', () => {
    const bundled = bundledFamilies();
    // JetBrains Mono is fetched ONLY when the user picks the 'jetbrains-mono'
    // UI font (UI_FONT_GOOGLE_FAMILY loads it then). Any OTHER reference to it —
    // in a stylesheet rule, or in a font stack that is not that choice — names a
    // face the browser does not have.
    expect(bundled).toContain('ibm-plex-mono');
    expect(cssWithoutComments()).not.toContain('JetBrains Mono');

    // The 'mono' settings choice must not promise JetBrains either: it does not
    // trigger the on-demand load, so the name was decorative.
    const monoCase = /case 'mono':[\s\S]*?return "([^"]+)"/.exec(settings);
    expect(monoCase, 'settings.ts must still have a mono font choice').toBeTruthy();
    expect(monoCase![1]).not.toContain('JetBrains Mono');
    expect(monoCase![1]).toContain('IBM Plex Mono');
  });
});
