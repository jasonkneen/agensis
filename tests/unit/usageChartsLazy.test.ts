import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// recharts is ~300KB minified and the Usage tab is the only shipped surface
// that draws a chart. If it ever stops being lazily imported it joins the index
// chunk, and every user downloads it on first load to open a settings tab most
// never visit. Nothing about that failure is visible in the UI — the charts
// render exactly the same either way — so it needs a test that reads the wiring.

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

describe('usage charts stay out of the main bundle', () => {
  it('is imported with React.lazy, never statically', () => {
    const dialog = read('src/components/settings/SettingsDialog.tsx');
    expect(dialog).toMatch(/lazy\(\(\) => import\(['"]\.\/UsageCharts['"]\)\)/);
    // A static import of the same module would defeat the split entirely.
    expect(dialog).not.toMatch(/^import .*from ['"]\.\/UsageCharts['"]/m);
  });

  it('keeps recharts confined to that one module', () => {
    // Any other component importing recharts directly pulls it back into
    // whatever chunk that component lands in.
    const offenders: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full);
        // The showcase is dev-only (gated on import.meta.env.DEV in main.tsx),
        // so Rollup drops it from the production build entirely.
        if (rel.startsWith('src/showcase/')) continue;
        if (rel === 'src/components/settings/UsageCharts.tsx') continue;
        if (/from ['"]recharts['"]/.test(read(rel))) offenders.push(rel);
      }
    })(path.resolve(process.cwd(), 'src'));

    expect(offenders).toEqual([]);
  });

  it('renders numbers the panel already computed, not its own maths', () => {
    // The cards and the chart must never disagree. The component takes
    // pre-formatted values and a formatter rather than converting bytes itself.
    const charts = read('src/components/settings/UsageCharts.tsx');
    expect(charts).toMatch(/formatBytes:\s*\(bytes: number\) => string/);
    expect(charts).not.toMatch(/1024|\/ 1e6|Math\.pow/);
  });
});
