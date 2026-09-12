import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The element picker's title-bar trigger must be present in BOTH window-shell
// implementations, or it silently disappears on one class of window: grouped
// (tiled) windows have no per-pane title bar — WindowGroupFrame owns the only
// header — while ungrouped windows use FloatingWindowShell.
//
// Rendering either shell here would need the full window-manager + UI provider
// stack (and this suite has no React Testing Library), so this is a deliberate
// source-level guard against accidental removal of the wiring, not a render
// test. It fails loudly the moment either shell drops the import or the element.

// vitest runs with the repo root as cwd (see vitest.config.ts).
function readSrc(rel: string): string {
  return readFileSync(join(process.cwd(), 'src', rel), 'utf8');
}

const SHELLS = [
  'components/windows/FloatingWindowShell.tsx',
  'components/windows/WindowGroupFrame.tsx',
];

describe('global element-picker trigger wiring', () => {
  for (const file of SHELLS) {
    it(`${file} imports GlobalPickerTitlebarControl`, () => {
      const code = readSrc(file);
      expect(code).toMatch(/import\s*\{[^}]*\bGlobalPickerTitlebarControl\b[^}]*\}\s*from\s*['"][^'"]*providers\/PickerProvider['"]/);
    });

    it(`${file} renders <GlobalPickerTitlebarControl>`, () => {
      const code = readSrc(file);
      expect(code).toMatch(/<GlobalPickerTitlebarControl\b/);
    });
  }
});
