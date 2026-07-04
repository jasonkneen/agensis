// Buyer/user-friendly "what's new" entries, authored in public/release-notes.json
// and deployed WITH the build so the notes always match the running code. Never
// auto-derived from commit messages (that reads like a git log — the opposite of
// non-techie). Newest-first, as authored.

export interface ReleaseNote {
  version: string; // human label, e.g. "2026.07.04" or a commit short-sha
  date: string; // ISO date, for the dim footer line
  title: string; // short headline
  summary: string; // one plain-English sentence
  highlights?: string[]; // a few bullet points, optional
}

// Basic shape-guard so a malformed/truncated notes file degrades to "nothing to
// show" rather than throwing into the update dialog.
function isReleaseNote(v: unknown): v is ReleaseNote {
  if (!v || typeof v !== 'object') return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.version === 'string' &&
    typeof n.date === 'string' &&
    typeof n.title === 'string' &&
    typeof n.summary === 'string' &&
    (n.highlights === undefined ||
      (Array.isArray(n.highlights) && n.highlights.every((h) => typeof h === 'string')))
  );
}

export function parseReleaseNotes(body: unknown): ReleaseNote[] {
  if (!Array.isArray(body)) return [];
  return body.filter(isReleaseNote);
}

// Fetches the authored notes, cache bypassed (same reasoning as version.json).
// Returns [] on any failure so the dialog can still render its heading.
export async function fetchReleaseNotes(
  fetchImpl: typeof fetch = fetch,
): Promise<ReleaseNote[]> {
  try {
    const res = await fetchImpl('/release-notes.json', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return [];
    return parseReleaseNotes(await res.json());
  } catch {
    return [];
  }
}
