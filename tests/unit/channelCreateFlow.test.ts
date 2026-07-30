import { describe, expect, it } from 'vitest';
import {
  CHORUS_THRESHOLD,
  MAX_CHANNEL_TITLE_CHARS,
  applyTemplateName,
  canAdvanceToMembers,
  chorusNote,
  composeChannelDraft,
  duplicateChannelName,
  normalizeChannelTitle,
  toDraftParticipants,
} from '../../src/lib/channelCreateFlow';
import { CHANNEL_TEMPLATES } from '../../src/lib/channelTemplates';
import { CHANNEL_ICONS, MAX_DESCRIPTION_CHARS, MAX_INTENT_CHARS } from '../../src/lib/channelProfile';
import type { ChannelParticipant, ChatSession } from '../../src/types';

const custom = CHANNEL_TEMPLATES.find(t => t.id === 'custom')!;
const project = CHANNEL_TEMPLATES.find(t => t.id === 'project')!;
const standup = CHANNEL_TEMPLATES.find(t => t.id === 'standup')!;

function channel(id: string, title: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id, workspace_id: 'ws', title, model: 'auto',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as ChatSession;
}

const agentPick = (id: string, name: string): Partial<ChannelParticipant> & Pick<ChannelParticipant, 'id' | 'name' | 'kind'> =>
  ({ id: `agent:${id}`, name, kind: 'agent', agent_id: id, handle: name.toLowerCase() });

describe('step 1 gates step 2 on a real name', () => {
  it('a blank or whitespace-only name cannot advance', () => {
    // MUTATION: gate on `name.length` instead of `normalizeChannelTitle(name).length`.
    // A channel called "   " is unreachable in the sidebar and indistinguishable
    // from the "New Channel" fallback this whole flow exists to remove.
    expect(canAdvanceToMembers('')).toBe(false);
    expect(canAdvanceToMembers('   ')).toBe(false);
    expect(canAdvanceToMembers('\t\n ')).toBe(false);
    expect(canAdvanceToMembers('incidents')).toBe(true);
    expect(canAdvanceToMembers('  incidents  ')).toBe(true);
  });

  it('clamps the title to what the channel editor accepts back', () => {
    // Otherwise creation produces a channel whose own edit form silently
    // shortens it on the first save. Same clamp as channelProfileDiff.
    const long = 'x'.repeat(MAX_CHANNEL_TITLE_CHARS + 50);
    expect(normalizeChannelTitle(long)).toHaveLength(MAX_CHANNEL_TITLE_CHARS);
    expect(normalizeChannelTitle('  incidents  ')).toBe('incidents');
  });
});

describe('a template is a modifier, not a gate', () => {
  it('fills an empty name but never overwrites one the user typed', () => {
    // MUTATION: make template selection assign unconditionally. Typing
    // "outages" and then clicking "Project" to set the tone would silently
    // rename the channel to "New project".
    expect(applyTemplateName('', project)).toBe(project.title);
    expect(applyTemplateName('   ', project)).toBe(project.title);
    expect(applyTemplateName('outages', project)).toBe('outages');
  });

  it('the custom template leaves the field alone — it has no name to give', () => {
    expect(custom.title).toBe('');
    expect(applyTemplateName('', custom)).toBe('');
  });
});

describe('the duplicate-name warning', () => {
  const sessions = [
    channel('a', 'Incidents'),
    channel('b', 'Standup'),
    channel('c', 'Archived', { deleted_at: '2026-01-02T00:00:00Z' }),
    channel('d', 'Ada', { folder: 'Direct messages' }),
    channel('e', 'Sub', { parent_message_id: 'm1' }),
  ];

  it('matches case-insensitively and returns the existing spelling', () => {
    expect(duplicateChannelName(sessions, 'incidents')).toBe('Incidents');
    expect(duplicateChannelName(sessions, '  INCIDENTS ')).toBe('Incidents');
  });

  it('is silent for a name nobody is using', () => {
    expect(duplicateChannelName(sessions, 'outages')).toBeNull();
    expect(duplicateChannelName(sessions, '   ')).toBeNull();
  });

  it('does not warn about DMs, sub-threads or deleted channels', () => {
    // Those are not names a person is choosing between in the sidebar. Warning
    // about a DM with someone called Ada when naming #ada would be noise.
    expect(duplicateChannelName(sessions, 'Archived')).toBeNull();
    expect(duplicateChannelName(sessions, 'Ada')).toBeNull();
    expect(duplicateChannelName(sessions, 'Sub')).toBeNull();
  });
});

describe('the chorus note', () => {
  it('fires only past the threshold, and only on auto', () => {
    // The roster decides who is a CANDIDATE to answer, so this is about
    // behaviour, not decoration. `social` paces replies and caps a broadcast;
    // `mention` waits to be asked — neither needs the warning.
    expect(chorusNote(CHORUS_THRESHOLD, 'auto')).toBeNull();
    expect(chorusNote(CHORUS_THRESHOLD + 1, 'auto')).toContain('candidates to answer');
    expect(chorusNote(9, 'social')).toBeNull();
    expect(chorusNote(9, 'mention')).toBeNull();
  });

  it('names the count so the warning is about this room, not rooms in general', () => {
    expect(chorusNote(6, 'auto')).toContain('6 agents');
  });

  it('carries no emoji — house rule, and this string is user-facing', () => {
    expect(chorusNote(6, 'auto')!).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('the participant rows creation writes', () => {
  it('dedupes the same agent arriving under both historical key shapes', () => {
    // `agent:<uuid>` from one writer, bare `<uuid>` from another. A duplicate is
    // not cosmetic: continueConversation iterates agent participants, so the
    // agent is dispatched twice per turn and a huddle reads both replies aloud.
    // MUTATION: skip dedupeSessionParticipants in toDraftParticipants.
    const rows = toDraftParticipants([
      { id: 'agent:abc', name: 'Ada', kind: 'agent', agent_id: 'abc' },
      { id: 'abc', name: 'Ada', kind: 'agent', agent_id: 'abc', handle: 'ada' },
    ]);
    expect(rows).toHaveLength(1);
    // The surviving row keeps the handle only the second copy carried — dropping
    // the later row wholesale would lose the only copy of it.
    expect(rows[0].handle).toBe('ada');
  });

  it('keeps distinct agents and people apart', () => {
    const rows = toDraftParticipants([
      agentPick('a1', 'Ada'),
      agentPick('a2', 'Bo'),
      { id: 'user:u1', name: 'Sam', kind: 'user', user_id: 'u1' },
    ]);
    expect(rows).toHaveLength(3);
  });

  it('writes every field explicitly, nulls included', () => {
    // An omitted key and an explicit null are not the same to the dedupe merge.
    const [row] = toDraftParticipants([agentPick('a1', 'Ada')]);
    expect(Object.keys(row).sort()).toEqual(
      ['added_at', 'agent_id', 'handle', 'id', 'kind', 'name', 'status', 'user_id'],
    );
    expect(row.user_id).toBeNull();
  });
});

describe('composeChannelDraft — what actually reaches the insert', () => {
  it('carries the typed name, not the template title', () => {
    const draft = composeChannelDraft(project, '  outages  ', []);
    expect(draft.title).toBe('outages');
  });

  it('participants is a real ARRAY, never JSON text', () => {
    // This is the exact bug that left 51 of 70 live sessions with empty-looking
    // rosters: a stringified array bound into a `$n::jsonb` placeholder stores a
    // jsonb STRING SCALAR, and every `Array.isArray` consumer reads it as
    // nobody. Silent — the UI just shows an empty channel.
    // MUTATION: wrap the participants value in JSON.stringify.
    const draft = composeChannelDraft(project, 'outages', [agentPick('a1', 'Ada')]);
    expect(Array.isArray(draft.participants)).toBe(true);
    expect(typeof draft.participants).not.toBe('string');
    expect(draft.participants[0].agent_id).toBe('a1');
  });

  it('NEVER carries a visibility key', () => {
    // The one thing on this screen that can lose access to data.
    //
    // `visibility` IS client-settable on a new top-level channel: chat_sessions
    // has no entry in PRIVILEGED_DB_COLUMNS_BY_TABLE, and the server's override
    // only fires for sessions that INHERIT privacy (those carrying
    // parent_message_id or split_parent_id), which a new channel has neither of.
    // Meanwhile chat_session_members is deliberately NOT allowlisted for generic
    // writes, because that table is a self-grant primitive.
    //
    // So setting visibility:'private' here would create a channel with ZERO
    // members — unreadable by everyone including whoever just made it,
    // unfixable from the client, and reported as no error at all. Not corrupt;
    // invisible, which is worse.
    //
    // A member picker is exactly the screen that invites a "Private channel"
    // checkbox, so this is asserted rather than left to a comment.
    // MUTATION: add `visibility: 'private'` to the returned object.
    const draft = composeChannelDraft(project, 'outages', [agentPick('a1', 'Ada')]) as Record<string, unknown>;
    expect(Object.hasOwn(draft, 'visibility')).toBe(false);
    expect(Object.keys(draft).sort()).toEqual(
      ['conversation_mode', 'description', 'icon', 'intent', 'participants', 'title'],
    );
  });

  it('never records the template id — a channel from a template is an ordinary channel', () => {
    for (const tpl of CHANNEL_TEMPLATES) {
      const draft = composeChannelDraft(tpl, 'name', []) as Record<string, unknown>;
      expect(Object.keys(draft), tpl.id).not.toContain('template_id');
      expect(Object.keys(draft), tpl.id).not.toContain('id');
    }
  });

  it('normalizes every field to what the channel editor would accept back', () => {
    // Deliberately fed an ABUSIVE template rather than the shipped ones. Every
    // real template already fits the limits — tests/unit/channelTemplates.test.ts
    // is what keeps them that way — so looping over CHANNEL_TEMPLATES here would
    // pass with the normalizers removed entirely. It would be testing the
    // fixture. This tests the composer.
    // MUTATION: pass any of these template fields through raw.
    const abusive = {
      ...project,
      intent: 'i'.repeat(MAX_INTENT_CHARS + 100),
      channelDescription: 'd'.repeat(MAX_DESCRIPTION_CHARS + 100),
      channelIcon: 'not-a-real-icon-key',
    };
    const draft = composeChannelDraft(abusive, 'a name', []);
    expect(draft.intent).toHaveLength(MAX_INTENT_CHARS);
    expect(draft.description).toHaveLength(MAX_DESCRIPTION_CHARS);
    // An icon key the column will not accept normalizes to '' (the default
    // hash) rather than being stored and silently lost on the first save.
    expect(draft.icon).toBe('');
  });

  it('every shipped template composes to storable values', () => {
    for (const tpl of CHANNEL_TEMPLATES) {
      const draft = composeChannelDraft(tpl, 'a name', []);
      expect([...CHANNEL_ICONS, ''], tpl.id).toContain(draft.icon);
      expect(['auto', 'social', 'mention'], tpl.id).toContain(draft.conversation_mode);
    }
  });

  it('keeps the mode the template chose, and honours an explicit override', () => {
    expect(composeChannelDraft(standup, 'standup', []).conversation_mode).toBe('mention');
    expect(composeChannelDraft(standup, 'standup', [], 'auto').conversation_mode).toBe('auto');
  });

  it('an unrecognised mode falls back rather than reaching the column', () => {
    // conversation_mode is read by the server to decide dispatch; a value it
    // does not know would be a channel whose reply behaviour is undefined.
    const draft = composeChannelDraft(project, 'x', [], 'nonsense' as never);
    expect(draft.conversation_mode).toBe('auto');
  });

  it('an empty selection produces an empty array, not undefined', () => {
    // App.tsx only sends the key when the array is non-empty; the draft still
    // has to be uniform so callers never branch on its shape.
    expect(composeChannelDraft(custom, 'plain', []).participants).toEqual([]);
  });
});
