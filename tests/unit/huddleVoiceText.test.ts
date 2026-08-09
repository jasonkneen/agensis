import { describe, expect, it } from 'vitest'
import {
  acceptHuddleVoiceSentence,
  huddleVoiceChannel,
  HUDDLE_VOICE_CHANNEL_PREFIX,
  HUDDLE_VOICE_EVENT,
} from '../../src/lib/huddleVoiceText'

describe('huddleVoiceChannel', () => {
  it('builds the workspace-scoped channel name', () => {
    expect(huddleVoiceChannel('ws-1')).toBe(`${HUDDLE_VOICE_CHANNEL_PREFIX}:ws-1`)
    expect(huddleVoiceChannel('')).toBe('')
    expect(huddleVoiceChannel(null)).toBe('')
  })
})

describe('acceptHuddleVoiceSentence', () => {
  const base = {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentId: 'ag-1',
    agentName: 'Ada',
    sentence: 'Hello there.',
    offset: 0,
    spokenAfter: 'Hello there.',
    seq: 0,
  }

  it('accepts a first sentence for the live session', () => {
    const accepted = acceptHuddleVoiceSentence(base, 'sess-1', '')
    expect(accepted?.sentence).toBe('Hello there.')
    expect(accepted?.spokenAfter).toBe('Hello there.')
  })

  it('rejects frames for another session', () => {
    expect(acceptHuddleVoiceSentence(base, 'sess-other', '')).toBeNull()
  })

  it('rejects already-spoken offsets (durable catch-up)', () => {
    expect(
      acceptHuddleVoiceSentence(
        { ...base, offset: 0, spokenAfter: 'Hello there.' },
        'sess-1',
        'Hello there.',
      ),
    ).toBeNull()
  })

  it('accepts the next sentence after a prefix', () => {
    const accepted = acceptHuddleVoiceSentence(
      {
        ...base,
        sentence: 'More.',
        offset: 13,
        spokenAfter: 'Hello there. More.',
      },
      'sess-1',
      'Hello there. ',
    )
    // offset 13 vs spoken length 13 — continue
    // actually 'Hello there. '.length is 13
    expect(accepted?.sentence).toBe('More.')
  })

  it('rejects empty or incomplete payloads', () => {
    expect(acceptHuddleVoiceSentence({}, 'sess-1', '')).toBeNull()
    expect(acceptHuddleVoiceSentence({ ...base, sentence: '' }, 'sess-1', '')).toBeNull()
    expect(HUDDLE_VOICE_EVENT).toBe('sentence')
  })
})
