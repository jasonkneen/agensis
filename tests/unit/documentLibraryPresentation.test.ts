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

  // The Default family's card-elevation catch-all went with Default (Expo is
  // the one style). The row controls keep their opt-out, and any catch-all
  // that lifts bordered raw buttons — in either stylesheet — must honour it.
  it('keeps its row controls out of any bordered-button card-elevation catch-all', () => {
    expect(component.match(/data-flat-control/g)?.length).toBe(2);
    const expo = readFileSync(resolve(process.cwd(), 'src/styles/expo.css'), 'utf8');
    const catchAlls = `${css}\n${expo}`.match(/button:not\(\[data-slot="button"\]\)[^{,]*\[class~="border"\]/g) ?? [];
    for (const selector of catchAlls) expect(selector).toContain(':not([data-flat-control])');
  });

  it('selects a provenance source directly instead of toggling the document off', () => {
    expect(component).toMatch(/onOpen=\{\(\) => \{\s*setSelectedKey\(entry\.key\);\s*setComparingId/);
  });
});
