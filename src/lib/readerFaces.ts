import { agentAccentColor } from './agentAccent';
import type { WorkspaceAgent } from '../types';

// Who did it — turned into something a chip can draw.
//
// Three surfaces (the channel, the reply thread, the sub-thread) each had their
// own copy of "resolve a reader id to a name", and each one was a uuid lookup
// that ended in a string. A chip that shows WHO needs more than a string, and
// three more copies of the lookup is how they drift. So the resolution lives
// here, once, with no React in it — `tests/unit/**/*.test.ts` is the only glob
// the frontend runner sees, so logic left in a component cannot be tested in
// this repo at all.
//
// A READER ID IS NOT ALWAYS A PERSON. Read markers and reactions both cover
// agents now, and an agent has a row in `workspace_agents`, not `app_users`. So
// every lookup tries members first and then the agent roster, and the caller
// never has to know which kind of id it is holding.
//
// AN UNRESOLVED ID IS "Someone", NEVER THE UUID. A raw uuid tells the reader
// nothing and leaks an identifier into any screenshot of the tooltip. The face
// still draws — a reader who has genuinely read your message does not stop
// existing because the roster has not loaded yet.

export interface ReaderFace {
  id: string;
  /** null when the id resolves to nobody we know; render as "Someone". */
  name: string | null;
  /** Avatar token — an image url, a pet spritesheet id, or '' for none. */
  avatar: string;
  /** Fallback glyph when there is no avatar. Never empty. */
  initials: string;
  isAgent: boolean;
  /** The agent's accent colour, so its face carries the same colour as its name. '' for people. */
  accent: string;
}

export interface ReaderDirectoryMember {
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
}

export interface ReaderDirectory {
  members?: readonly ReaderDirectoryMember[];
  agents?: readonly WorkspaceAgent[];
}

/**
 * "Coder" -> "C", "ada lovelace" -> "AL", "" -> "?".
 *
 * Two letters at most: the face is 16px and a third letter turns it into a
 * smear. Word-initials rather than the first two characters, because "AL" says
 * which person and "AD" says nothing.
 */
export function readerInitials(name: string | null | undefined): string {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0].slice(0, 1) + words[words.length - 1].slice(0, 1)).toUpperCase();
}

/** The display name for a member row — the local part of the email, never the domain. */
function memberName(member: ReaderDirectoryMember): string | null {
  if (member.name && String(member.name).trim()) return String(member.name).trim();
  const email = String(member.email || '').trim();
  return email ? email.split('@')[0] : null;
}

/**
 * Build the id -> face lookup for a surface.
 *
 * Returns a function rather than a Map so a caller can hold it in a `useMemo`
 * and pass it down as one prop. Members are checked before agents because a
 * human id and an agent id are drawn from different tables and cannot collide;
 * the order is only about doing the cheaper, commoner lookup first.
 */
export function buildReaderFaces(directory: ReaderDirectory): (readerId: string) => ReaderFace {
  const members = directory.members || [];
  const agents = directory.agents || [];
  return (readerId: string): ReaderFace => {
    const id = String(readerId);
    const member = members.find(row => String(row.user_id ?? '') === id);
    if (member) {
      const name = memberName(member);
      return { id, name, avatar: '', initials: readerInitials(name), isAgent: false, accent: '' };
    }
    const agent = agents.find(row => String(row.id) === id);
    if (agent) {
      const name = agent.name || null;
      return {
        id,
        name,
        avatar: String(agent.avatar || ''),
        initials: readerInitials(name),
        isAgent: true,
        accent: agentAccentColor(agent),
      };
    }
    return { id, name: null, avatar: '', initials: '?', isAgent: false, accent: '' };
  };
}

/** The name-only view, for the surfaces that still want a plain string. */
export function readerNameResolver(
  resolveFace: (readerId: string) => ReaderFace,
): (readerId: string) => string | null {
  return readerId => resolveFace(readerId).name;
}

export interface FaceStackModel {
  /** The faces actually drawn, in the order given. */
  shown: ReaderFace[];
  /** How many more there are. 0 when everybody fits. */
  overflow: number;
}

/**
 * How many faces a chip draws, and how many it admits to hiding.
 *
 * THREE IS THE CAP, and it is not arbitrary. The chip sits inline in a row of
 * reaction pills; past three 16px faces at -4px overlap the chip is wider than
 * the pills beside it and the row wraps on a normal-width message column. Over
 * the cap the count comes back as "+4" — which is the one case where a numeral
 * beats a face, because four unreadable slivers say less than the number does.
 *
 * Duplicate ids are collapsed. The same reader appearing twice in a marker set
 * is a bug upstream, but drawing them twice makes it look like two people.
 */
export function faceStack(
  readerIds: readonly string[],
  resolveFace: (readerId: string) => ReaderFace,
  max = 3,
): FaceStackModel {
  const seen = new Set<string>();
  const faces: ReaderFace[] = [];
  for (const readerId of readerIds) {
    const id = String(readerId);
    if (seen.has(id)) continue;
    seen.add(id);
    faces.push(resolveFace(id));
  }
  const limit = Math.max(1, max);
  return { shown: faces.slice(0, limit), overflow: Math.max(0, faces.length - limit) };
}

/** "Coder", "Coder and Grok", "Coder, Grok and 2 others" — for a tooltip or a label. */
export function describeFaces(faces: readonly ReaderFace[], overflow = 0): string {
  const names = faces.map(face => face.name || 'Someone');
  if (names.length === 0) return overflow > 0 ? `${overflow} others` : '';
  const all = overflow > 0 ? [...names, `${overflow} other${overflow === 1 ? '' : 's'}`] : names;
  if (all.length === 1) return all[0];
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}
