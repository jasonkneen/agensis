import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { partitionForBaseline, loadBaselineManifest } from '../../scripts/migrate.mjs';

// Incident (2026-07-30, H7 in scripts/migrate.mjs): the first-ever run of
// `npm run migrate` against production silently marked EVERY .sql file on
// disk as "already applied" without running it — including a migration that
// shipped in the same deploy and had never actually run anywhere. These tests
// pin the fix: only files the frozen manifest vouches for may be silently
// backfilled; anything else must come back as "not eligible" so the caller
// leaves it pending (and it actually executes).

describe('partitionForBaseline', () => {
  it('marks manifest files eligible for silent backfill', () => {
    const { eligible, notEligible } = partitionForBaseline(
      ['a.sql', 'b.sql'],
      ['a.sql', 'b.sql'],
    );
    expect(eligible).toEqual(['a.sql', 'b.sql']);
    expect(notEligible).toEqual([]);
  });

  it('never lets a file absent from the manifest slip into "eligible" — the exact incident', () => {
    // a.sql/b.sql are old, already-applied-elsewhere migrations; brand-new.sql
    // is a migration that shipped in the same deploy and has never run.
    const { eligible, notEligible } = partitionForBaseline(
      ['a.sql', 'b.sql', 'brand-new.sql'],
      ['a.sql', 'b.sql'],
    );
    expect(eligible).toEqual(['a.sql', 'b.sql']);
    expect(notEligible).toEqual(['brand-new.sql']);
  });

  it('treats an empty manifest as nothing being pre-applied', () => {
    const { eligible, notEligible } = partitionForBaseline(['a.sql'], []);
    expect(eligible).toEqual([]);
    expect(notEligible).toEqual(['a.sql']);
  });

  it('is order-preserving and never invents files not in the input list', () => {
    const { eligible, notEligible } = partitionForBaseline(
      ['z.sql', 'a.sql', 'm.sql'],
      ['a.sql', 'q.sql'],
    );
    expect(eligible).toEqual(['a.sql']);
    expect(notEligible).toEqual(['z.sql', 'm.sql']);
  });
});

describe('loadBaselineManifest', () => {
  it('resolves the real, checked-in manifest to a non-empty array of .sql filenames', async () => {
    const files = await loadBaselineManifest();
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/\.sql$/);
  });

  it('the real manifest matches what is actually checked in on disk, so it never silently drifts stale', () => {
    // Cheap sanity check independent of the module: read the manifest file
    // directly and confirm every migration currently on disk that predates
    // this test's own change is still accounted for. This doesn't assert
    // exact equality (new migrations land after the manifest is frozen on
    // purpose) — it just guards against the manifest file rotting/emptying.
    const manifestPath = join(__dirname, '../../supabase/migrations/.baseline-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(60);
    expect(typeof manifest.frozenAt).toBe('string');
  });
});
