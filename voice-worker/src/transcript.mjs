// Mirror what is said in the huddle into the channel it belongs to.
//
// A huddle and its channel are ONE conversation held two ways, not two records
// of the same meeting. If the spoken half only exists as LiveKit transcription,
// it dies with the room: nobody who missed the call can read it, no agent can
// search it later, and the written thread has a hole in it where the decision
// was actually made.
//
// Deliberately fire-and-forget. A transcript write that fails must never break
// the call — the person is still talking, and dropping the audio because a POST
// 500'd would be a far worse failure than a missing line.

import { AgentSessionEventTypes } from '@livekit/agents';

/** Never let a runaway model turn into an unbounded row. */
const MAX_CHARS = 8000;

function textOf(item) {
  if (!item) return '';
  const content = item.content ?? item.textContent ?? item.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).filter(Boolean).join(' ');
  }
  return '';
}

/**
 * @param {{ session: object, meta: object, log?: Console, fetchImpl?: typeof fetch }} opts
 * @returns {{ stop: () => void }}
 */
export function mirrorTranscript({ session, meta, log = console, fetchImpl = fetch } = {}) {
  const url = String(meta?.transcript?.url || '').trim();
  const token = String(meta?.transcript?.token || '').trim();
  const sessionId = String(meta?.sessionId || '').trim();
  // With nowhere to write, do nothing rather than half-doing it — and say so once.
  if (!url || !sessionId) {
    log.log?.('[voice] transcript mirroring disabled (no session/url in job metadata)');
    return { stop: () => {} };
  }

  let stopped = false;
  // One in-flight write at a time, chained, so lines land in the order spoken
  // rather than in whatever order the network settles them.
  let chain = Promise.resolve();

  const post = (role, text) => {
    const body = String(text || '').trim().slice(0, MAX_CHARS);
    if (!body || stopped) return;
    chain = chain.then(async () => {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            sessionId,
            huddleId: meta.huddleId || null,
            agentId: meta.agentId || null,
            handle: meta.handle || null,
            name: meta.name || null,
            role,
            content: body,
            source: 'huddle',
          }),
        });
        if (!response.ok) {
          log.error?.(`[voice] transcript write failed: HTTP ${response.status}`);
        }
      } catch (error) {
        log.error?.(`[voice] transcript write failed: ${error?.message || error}`);
      }
    });
  };

  // What the human said, once the turn is final. Interim hypotheses are noise in
  // a written channel — they rewrite themselves mid-sentence.
  const onUser = (event) => {
    if (event?.isFinal === false) return;
    post('user', event?.transcript ?? event?.text);
  };

  // What the agent said. ConversationItemAdded fires for both sides, so the role
  // is filtered here rather than assumed.
  const onItem = (event) => {
    const item = event?.item ?? event;
    const role = String(item?.role || '');
    if (role !== 'assistant') return;
    post('assistant', textOf(item));
  };

  session.on(AgentSessionEventTypes.UserInputTranscribed, onUser);
  session.on(AgentSessionEventTypes.ConversationItemAdded, onItem);

  return {
    stop() {
      stopped = true;
      try {
        session.off?.(AgentSessionEventTypes.UserInputTranscribed, onUser);
        session.off?.(AgentSessionEventTypes.ConversationItemAdded, onItem);
      } catch { /* session already closed */ }
    },
  };
}
