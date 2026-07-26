// Reading `chat_sessions.participants` without trusting its shape.
//
// The column is jsonb, but two server write sites bound `JSON.stringify(...)`
// into a `$n::jsonb` placeholder, which stores a jsonb STRING SCALAR rather than
// an array. 51 of 70 live sessions were written that way. Postgres reports
// `jsonb_typeof = 'string'`, the row arrives at the browser as a JSON *string*,
// and every consumer doing `Array.isArray(session.participants)` silently sees
// nobody — no participants in the sidebar, no agent in a session, and the agent
// mesh reporting "nothing here yet" for an agent with a dozen live threads.
//
// The writes are fixed and the rows repaired, but this stays: the column has
// held both shapes, older clients and caches still carry the string form, and a
// participant list that silently reads as empty is indistinguishable from a real
// empty one. Parsing is cheap; being wrong about who is in a conversation is not.

/** Anything array-shaped, whether it arrived as jsonb or as JSON text. */
export function parseParticipants(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Not JSON at all. An unreadable value is an empty list, never a throw —
    // one malformed row must not take down the surface rendering it.
    return [];
  }
}

/**
 * The one true key for an agent participant, whatever shape wrote it.
 *
 * Two writers produced two shapes for the SAME agent — `agent:<uuid>` from the
 * add-people dialog and the mention path, bare `<uuid>` from the sub-thread
 * creation path — and nothing deduped across them. The same agent twice in a
 * roster is not cosmetic: continueConversation iterates agent participants, so
 * a duplicated agent was dispatched twice per turn and a huddle read BOTH
 * replies aloud. That was the double voice.
 */
export function participantAgentKey(participant: unknown): string {
  if (!participant || typeof participant !== 'object') return '';
  const source = participant as Record<string, unknown>;
  if (source.kind !== 'agent') return '';
  const raw = String(source.agent_id ?? source.id ?? '').trim();
  const bare = raw.replace(/^agent:/, '');
  if (bare) return bare;
  return String(source.handle ?? '').trim().toLowerCase();
}

/**
 * Collapse duplicate agents, keeping the FIRST row seen for each agent but
 * upgrading it with any fields a later duplicate carries that it lacks —
 * the two shapes disagree about which fields they populate, and dropping the
 * later row wholesale would sometimes drop the only copy of `handle`.
 * Non-agent rows pass through untouched, order preserved.
 */
export function dedupeSessionParticipants<T>(participants: readonly T[]): T[] {
  const out: T[] = [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const participant of participants) {
    const key = participantAgentKey(participant);
    if (!key) { out.push(participant); continue; }
    const existing = byKey.get(key);
    if (!existing) {
      const copy = { ...(participant as Record<string, unknown>) };
      byKey.set(key, copy);
      out.push(copy as T);
      continue;
    }
    for (const [field, value] of Object.entries(participant as Record<string, unknown>)) {
      if ((existing[field] === null || existing[field] === undefined || existing[field] === '') && value != null && value !== '') {
        existing[field] = value;
      }
    }
  }
  return out;
}
