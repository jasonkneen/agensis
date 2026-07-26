import { describe, expect, it } from 'vitest';
import {
  huddleAgentOptions,
  huddleShortcutIndex,
  isTextEntryTarget,
  matchLeadingAgentName,
  withAgentMention,
  type HuddleAgentOption,
} from '../../src/lib/huddleAgents';
import type { ChannelParticipant, WorkspaceAgent } from '../../src/types';

// The switching decisions, without a microphone.
//
// The leading-name parser is the risky one: it runs on speech-to-text output,
// it changes where your next sentence goes, and getting it wrong is silent —
// the sentence lands on the wrong agent and nothing says so. So the cases that
// matter here are the ones where it must REFUSE: a name in the middle of a
// sentence, and a leading word that two agents answer to.

function option(overrides: Partial<HuddleAgentOption> & { id: string }): HuddleAgentOption {
  return {
    name: overrides.id,
    handle: overrides.id,
    avatar: '',
    accent: '#00a95c',
    ...overrides,
  };
}

const CODER = option({ id: 'a1', name: 'Coder', handle: 'coder' });
const ADA = option({ id: 'a2', name: 'Ada', handle: 'ada' });
const REVIEWER = option({ id: 'a3', name: 'Code Reviewer', handle: 'code-reviewer' });

function agent(overrides: Partial<WorkspaceAgent> & { id: string }): WorkspaceAgent {
  return {
    workspace_id: 'ws1',
    name: overrides.id,
    avatar: '',
    description: '',
    system_prompt: '',
    model: 'auto',
    created_by: null,
    created_at: '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

function participant(overrides: Partial<ChannelParticipant> & { id: string }): ChannelParticipant {
  return { name: overrides.id, kind: 'agent', ...overrides };
}

describe('matchLeadingAgentName', () => {
  it('switches and keeps the rest of the sentence', () => {
    const match = matchLeadingAgentName("Coder, what's the status", [CODER, ADA]);
    expect(match?.agent.id).toBe('a1');
    expect(match?.remainder).toBe("what's the status");
  });

  it('does not need the comma speech-to-text usually drops', () => {
    const match = matchLeadingAgentName('coder what is the status', [CODER, ADA]);
    expect(match?.agent.id).toBe('a1');
    expect(match?.remainder).toBe('what is the status');
  });

  it('is case-insensitive and tolerates a leading @', () => {
    expect(matchLeadingAgentName('CODER hello', [CODER])?.agent.id).toBe('a1');
    expect(matchLeadingAgentName('@coder hello', [CODER])?.agent.id).toBe('a1');
  });

  it('matches the handle as well as the name', () => {
    const match = matchLeadingAgentName('code-reviewer take a look', [CODER, REVIEWER]);
    expect(match?.agent.id).toBe('a3');
    expect(match?.remainder).toBe('take a look');
  });

  it('matches a multi-word name spoken as separate words', () => {
    const match = matchLeadingAgentName('code reviewer take a look', [CODER, REVIEWER]);
    expect(match?.agent.id).toBe('a3');
    expect(match?.remainder).toBe('take a look');
  });

  it('prefers the longest name when one is a prefix of another', () => {
    // "Code Reviewer" must win over a hypothetical "Code", not the other way up.
    const code = option({ id: 'a4', name: 'Code', handle: 'code' });
    const match = matchLeadingAgentName('code reviewer ship it', [code, REVIEWER]);
    expect(match?.agent.id).toBe('a3');
    expect(match?.remainder).toBe('ship it');
  });

  it('stops the name at punctuation', () => {
    const code = option({ id: 'a4', name: 'Code', handle: 'code' });
    const match = matchLeadingAgentName('Code, reviewer said no', [code, REVIEWER]);
    expect(match?.agent.id).toBe('a4');
    expect(match?.remainder).toBe('reviewer said no');
  });

  it('refuses when two agents answer to the same leading word', () => {
    const twin = option({ id: 'a9', name: 'Coder', handle: 'coder-two' });
    expect(matchLeadingAgentName('coder what is the status', [CODER, twin])).toBeNull();
  });

  it('ignores a name that is not at the start', () => {
    expect(matchLeadingAgentName('ask coder about the build', [CODER, ADA])).toBeNull();
    expect(matchLeadingAgentName('I think ada is right', [CODER, ADA])).toBeNull();
  });

  it('switches with nothing to say when only the name was spoken', () => {
    const match = matchLeadingAgentName('Ada.', [CODER, ADA]);
    expect(match?.agent.id).toBe('a2');
    expect(match?.remainder).toBe('');
  });

  it('returns null for an unknown name, empty speech, or no agents', () => {
    expect(matchLeadingAgentName('someone else entirely', [CODER])).toBeNull();
    expect(matchLeadingAgentName('   ', [CODER])).toBeNull();
    expect(matchLeadingAgentName('coder hello', [])).toBeNull();
  });

  it('never matches a one-character alias', () => {
    // "I", "a" and "the" arrive constantly; a one-letter agent does not exist.
    const tiny = option({ id: 'a5', name: 'I', handle: 'i' });
    expect(matchLeadingAgentName('I think we should ship', [tiny])).toBeNull();
  });
});

describe('withAgentMention', () => {
  it('prefixes the handle so a channel message dispatches', () => {
    expect(withAgentMention('what is the status', 'coder')).toBe('@coder what is the status');
  });

  it('does not double up a mention that is already there', () => {
    expect(withAgentMention('@coder what is the status', 'coder')).toBe('@coder what is the status');
    expect(withAgentMention('hey @Coder look', 'coder')).toBe('hey @Coder look');
  });

  it('treats a handle with regex characters literally', () => {
    expect(withAgentMention('ping', 'code-reviewer')).toBe('@code-reviewer ping');
    expect(withAgentMention('@code-reviewer ping', 'code-reviewer')).toBe('@code-reviewer ping');
    // "code.reviewer" must not match "codeXreviewer" through an unescaped dot.
    expect(withAgentMention('@codeXreviewer ping', 'code.reviewer')).toBe('@code.reviewer @codeXreviewer ping');
  });

  it('is a no-op without a handle or without text', () => {
    expect(withAgentMention('hello', '')).toBe('hello');
    expect(withAgentMention('   ', 'coder')).toBe('');
  });
});

describe('huddleShortcutIndex', () => {
  it('accepts meta on macOS and ctrl elsewhere', () => {
    expect(huddleShortcutIndex({ key: '1', code: 'Digit1', metaKey: true })).toBe(0);
    expect(huddleShortcutIndex({ key: '9', code: 'Digit9', ctrlKey: true })).toBe(8);
  });

  it('reads the physical key so shifted digit rows still work', () => {
    // AZERTY: Cmd+Shift+1 produces key '&' on Digit1.
    expect(huddleShortcutIndex({ key: '&', code: 'Digit1', metaKey: true })).toBe(0);
  });

  it('ignores a bare digit, alt chords, 0, and non-digits', () => {
    expect(huddleShortcutIndex({ key: '1', code: 'Digit1' })).toBeNull();
    expect(huddleShortcutIndex({ key: '1', code: 'Digit1', metaKey: true, altKey: true })).toBeNull();
    expect(huddleShortcutIndex({ key: '0', code: 'Digit0', metaKey: true })).toBeNull();
    expect(huddleShortcutIndex({ key: 'k', code: 'KeyK', metaKey: true })).toBeNull();
    expect(huddleShortcutIndex(null)).toBeNull();
  });
});

describe('isTextEntryTarget', () => {
  it('recognises the places a human types', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('lets everything else through', () => {
    expect(isTextEntryTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'BUTTON', isContentEditable: false })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget('input')).toBe(false);
  });
});

describe('huddleAgentOptions', () => {
  const coder = agent({ id: 'ag1', name: 'Coder', handle: 'coder', avatar: 'icon:bot', accent_color: '#38bdf8' });
  const ada = agent({ id: 'ag2', name: 'Ada Lovelace', handle: null });

  it('lists the channel roster in order, resolved against the workspace agents', () => {
    const options = huddleAgentOptions(
      [ada, coder],
      [
        participant({ id: 'user:1', name: 'Jason', kind: 'user' }),
        participant({ id: 'agent:ag1', name: 'Coder', agent_id: 'ag1' }),
        participant({ id: 'agent:ag2', name: 'Ada Lovelace', agent_id: 'ag2' }),
      ],
    );
    expect(options.map(item => item.id)).toEqual(['ag1', 'ag2']);
    expect(options[0]).toMatchObject({ name: 'Coder', handle: 'coder', avatar: 'icon:bot', accent: '#38bdf8' });
    // No handle on the row: the name is slugged the same way the composer does.
    expect(options[1].handle).toBe('ada-lovelace');
  });

  it('matches a participant by handle when it carries no agent_id', () => {
    const options = huddleAgentOptions([coder], [participant({ id: 'p1', name: 'Coder', handle: 'coder' })]);
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe('ag1');
  });

  it('keeps an unresolved agent participant so the numbering has no hole', () => {
    const options = huddleAgentOptions([], [participant({ id: 'p9', name: 'Ghost', handle: 'ghost' })]);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ handle: 'ghost', name: 'Ghost' });
    expect(options[0].accent).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('drops users, nameless rows and duplicates', () => {
    const options = huddleAgentOptions(
      [coder],
      [
        participant({ id: 'user:1', name: 'Jason', kind: 'user' }),
        participant({ id: 'blank', name: '', handle: '' }),
        participant({ id: 'agent:ag1', name: 'Coder', agent_id: 'ag1' }),
        participant({ id: 'dupe', name: 'Coder', handle: 'coder' }),
      ],
    );
    expect(options.map(item => item.id)).toEqual(['ag1']);
  });

  it('survives missing input', () => {
    expect(huddleAgentOptions([], [])).toEqual([]);
  });
});
