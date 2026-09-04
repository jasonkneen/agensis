import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(
  resolve(process.cwd(), 'src/components/windows/DocumentLibraryWindowContent.tsx'),
  'utf8',
);
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('document library presentation', () => {
  it('uses contiguous information rows instead of one elevated card per document', () => {
    expect(component).toContain('document-library-list-row border-b');
    expect(component).toContain('document-library-source-row flex w-full items-center gap-2 border-b');
    expect(component).not.toMatch(/document-library-list-row[^`]*rounded-lg border/);
    expect(css).toContain('.document-library-list-row[data-selected="true"]');
  });

  it('opts its row controls out of the Default theme card-elevation catch-all', () => {
    expect(component.match(/data-flat-control/g)?.length).toBe(2);
    expect(css).toMatch(/button:not\(\[data-slot="button"\]\):not\(\[data-flat-control\]\)\[class~="border"\]/);
  });

  it('selects a provenance source directly instead of toggling the document off', () => {
    expect(component).toMatch(/onOpen=\{\(\) => \{\s*setSelectedKey\(entry\.key\);\s*setComparingId/);
  });
});
