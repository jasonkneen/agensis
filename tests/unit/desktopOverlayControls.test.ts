import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

describe('desktop chooser controls', () => {
  it('does not let nested settings/delete buttons trigger the card launcher', () => {
    const card = appSource.slice(
      appSource.indexOf('data-overlay-desktop={tile.id}'),
      appSource.indexOf('data-overlay-desktop={tile.id}') + 1600,
    );
    expect(card).toContain('if (e.target !== e.currentTarget) return;');
    expect(card).toContain('e.preventDefault();');
  });
});
