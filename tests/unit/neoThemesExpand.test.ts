import { describe, expect, it } from 'vitest'
import { expand, NEO_MANAGED_KEYS, type NeoSeed } from '../../src/showcase/neoThemes'

const seed: NeoSeed = {
  paper: '#fff9df',
  ink: '#0a0a0a',
  primary: '#ff5c00',
  onPrimary: '#ffffff',
}

describe('neoThemes expand()', () => {
  it('passes the required seed colours straight through', () => {
    const v = expand(seed, 'light')
    expect(v['--background']).toBe('#fff9df')
    expect(v['--canvas-base']).toBe('#fff9df')
    expect(v['--foreground']).toBe('#0a0a0a')
    expect(v['--neo-ink']).toBe('#0a0a0a')
    expect(v['--primary']).toBe('#ff5c00')
    expect(v['--primary-foreground']).toBe('#ffffff')
    expect(v['--sh-accent-foreground']).toBe('#ffffff')
  })

  it('defaults the hard-shadow ink to the seed ink in light mode', () => {
    // light: shadowTone = ink, shadow = shadowTone (no alpha mix)
    expect(expand(seed, 'light')['--neo-shadow-ink']).toBe('#0a0a0a')
  })

  it('derives a translucent, ink-tinted shadow in dark mode (not flat ink)', () => {
    const shadow = expand(seed, 'dark')['--neo-shadow-ink']
    // dark shadow renders at 30% over transparent — must be a color-mix, not raw ink
    expect(shadow).toContain('color-mix')
    expect(shadow).toContain('30%')
    expect(shadow).not.toBe('#0a0a0a')
  })

  it('derives different elevated surfaces for light vs dark', () => {
    const light = expand(seed, 'light')
    const dark = expand(seed, 'dark')
    expect(light['--card']).not.toBe(dark['--card'])
    expect(light['--muted']).not.toBe(dark['--muted'])
  })

  it('every derived color-mix sums to 100% (no accidental translucency)', () => {
    // The module comment is explicit: color-mix percentages must sum to 100% or
    // surfaces bleed through. Verify for both schemes across all values.
    for (const scheme of ['light', 'dark'] as const) {
      const v = expand(seed, scheme)
      for (const value of Object.values(v)) {
        const m = /color-mix\(in srgb,[^)]*\)/.exec(value)
        if (!m) continue
        const pcts = [...m[0].matchAll(/(\d+(?:\.\d+)?)%/g)].map(x => Number(x[1]))
        // Values that intentionally composite over `transparent` (shadow/dot)
        // carry a single alpha percentage — skip those; only two-colour mixes
        // must sum to 100.
        if (/transparent/.test(m[0]) && pcts.length === 1) continue
        if (pcts.length >= 2) {
          expect(pcts.reduce((a, b) => a + b, 0)).toBe(100)
        }
      }
    }
  })

  it('lets a seed override win over the derived surface', () => {
    const withCard = expand({ ...seed, card: '#123456', muted: '#654321' }, 'light')
    expect(withCard['--card']).toBe('#123456')
    expect(withCard['--popover']).toBe('#123456')
    expect(withCard['--canvas-elevated']).toBe('#123456')
    expect(withCard['--muted']).toBe('#654321')
  })

  it('defaults the status colours per scheme and lets seeds override them', () => {
    expect(expand(seed, 'light')['--error']).toBe('#ff3b30')
    expect(expand(seed, 'dark')['--error']).toBe('#ff5f63')
    expect(expand({ ...seed, error: '#abcdef' }, 'light')['--error']).toBe('#abcdef')
  })

  it('only emits keys it declares as managed', () => {
    const managed = new Set<string>(NEO_MANAGED_KEYS)
    for (const key of Object.keys(expand(seed, 'light'))) {
      expect(managed.has(key)).toBe(true)
    }
  })
})
