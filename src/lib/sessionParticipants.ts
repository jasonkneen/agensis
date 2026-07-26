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
