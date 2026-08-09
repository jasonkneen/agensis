// Durable huddle transcript mirroring with bounded, at-least-once writes.

import { createHash, randomUUID } from 'node:crypto';
import { AgentSessionEventTypes } from '@livekit/agents';
import { capText, VOICE_RESULT_UNAVAILABLE_MARKER, MAX_VOICE_RESULT_CHARS } from './voiceBounds.mjs';

export const MAX_TRANSCRIPT_CHARS = MAX_VOICE_RESULT_CHARS;
export const MAX_TRANSCRIPT_QUEUE = 32;
export const MAX_TRANSCRIPT_QUEUE_AGE_MS = 30_000;

function textOf(item) {
  if (!item) return '';
  const content = item.content ?? item.textContent ?? item.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).filter(Boolean).join(' ');
  return '';
}

export function transcriptEventId({ huddleId, itemId, speakerId, role, content, agentId } = {}) {
  const provided = String(itemId || '').trim();
  const prefix = role === 'assistant' || role === 'user' ? `${role}:` : '';
  // Provider item ids can be local to a worker and user ids can repeat across
  // speakers. Hash the complete huddle/role/attribution tuple rather than
  // trusting the id or truncating identity fields; the server's unique key then
  // remains stable across retries without cross-speaker collisions.
  if (provided && /^[A-Za-z0-9._:-]{1,256}$/.test(provided)) {
    const material = [huddleId, role, role === 'assistant' ? agentId : speakerId, provided];
    return `${prefix}sha256:${createHash('sha256').update(material.map((value) => {
      const text = String(value ?? '');
      return `${text.length}:\u0000${text}`;
    }).join('')).digest('hex')}`;
  }
  // STT events commonly omit itemId. Do not include a wall-clock value: a
  // retry/finalization of the same utterance must hash to the same row. Include
  // full, length-prefixed fields so delimiter characters cannot alias.
  const material = [huddleId, speakerId, role, role === 'assistant' ? agentId : '', content];
  return `sha256:${createHash('sha256').update(material.map((value) => {
    const text = String(value ?? '');
    return `${text.length}:\u0000${text}`;
  }).join('')).digest('hex')}`;
}

/**
 * @param {{ session: object, meta: object, log?: Console, fetchImpl?: typeof fetch }} opts
 * @returns {{ stop: () => void }}
 */
export function mirrorTranscript({ session, meta, log = console, fetchImpl = fetch, shouldMirror = () => true } = {}) {
  const url = String(meta?.transcript?.url || '').trim();
  const token = String(meta?.transcript?.token || '').trim();
  const sessionId = String(meta?.transcriptSessionId || meta?.sessionId || '').trim();
  const agentId = String(meta?.agentId || '').trim();
  if (!url || !sessionId) {
    if (!url || !sessionId) log.log?.('[voice] transcript mirroring disabled (no session/url in job metadata)');
    return { stop: () => {} };
  }

  let stopped = false;
  let draining = false;
  let currentAbort = null;
  const queue = [];
  const seen = new Set();
  const ephemeralEventIds = new WeakMap();
  const mirrorInstanceId = randomUUID();
  let ephemeralEventSequence = 0;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && queue.length) {
        const item = queue.shift();
        if (Date.now() - item.createdAt > MAX_TRANSCRIPT_QUEUE_AGE_MS) {
          seen.delete(item.eventId);
          continue;
        }
        currentAbort = new AbortController();
        const body = JSON.stringify({
          sessionId,
          huddleId: meta.huddleId || null,
          eventId: item.eventId,
          speakerId: item.speakerId || null,
          role: item.role,
          content: item.content,
          source: 'huddle',
        });
        let delivered = false;
        try {
          let response;
          for (let attempt = 0; attempt < 2 && !stopped; attempt += 1) {
            response = await fetchImpl(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
              body,
              signal: currentAbort.signal,
            });
            if (response.ok) { delivered = true; break; }
          }
          if (!delivered && !stopped) throw new Error(`HTTP ${response?.status || 'unknown'}`);
        } catch (error) {
          if (!stopped) {
            log.error?.(`[voice] transcript write failed: ${error?.message || error}`);
            if (item.attempts < 3 && Date.now() - item.createdAt <= MAX_TRANSCRIPT_QUEUE_AGE_MS) {
              item.attempts += 1;
              queue.push(item);
              await new Promise((resolve) => setTimeout(resolve, item.attempts * 100));
            } else {
              seen.delete(item.eventId);
            }
          }
        } finally {
          currentAbort = null;
        }
      }
    } finally {
      draining = false;
      if (!stopped && queue.length) void drain();
    }
  };

  const post = ({ role, text, itemId = '', speakerId = '', createdAt = Date.now(), sourceEvent = null }) => {
    const body = capText(String(text || '').trim(), MAX_TRANSCRIPT_CHARS);
    if (!body || stopped) return;
    let stableItemId = itemId;
    if (!stableItemId && sourceEvent && typeof sourceEvent === 'object') {
      stableItemId = ephemeralEventIds.get(sourceEvent);
      if (!stableItemId) {
        ephemeralEventSequence += 1;
        stableItemId = `nonce:${mirrorInstanceId}:${ephemeralEventSequence}`;
        ephemeralEventIds.set(sourceEvent, stableItemId);
      }
    }
    const eventId = transcriptEventId({
      huddleId: meta.huddleId,
      itemId: stableItemId,
      speakerId,
      role,
      content: body,
      agentId,
    });
    if (seen.has(eventId)) return;
    seen.add(eventId);
    if (seen.size > 128) seen.delete(seen.values().next().value);
    if (queue.length >= MAX_TRANSCRIPT_QUEUE) {
      const dropped = queue.shift();
      if (dropped) seen.delete(dropped.eventId);
      log.error?.(`[voice] transcript queue full; dropped oldest event${VOICE_RESULT_UNAVAILABLE_MARKER}`);
    }
    queue.push({ role, content: body, eventId, speakerId, createdAt: Date.now(), attempts: 0 });
    void drain();
  };

  const onUser = (event) => {
    if (event?.isFinal === false || !shouldMirror()) return;
    post({
      role: 'user',
      text: event?.transcript ?? event?.text,
      itemId: event?.itemId || event?.eventId || event?.sequence,
      speakerId: event?.speakerId || event?.participantIdentity || session?._roomIO?.linkedParticipant?.identity,
      createdAt: event?.createdAt,
      sourceEvent: event,
    });
  };

  const onItem = (event) => {
    if (!shouldMirror()) return;
    const item = event?.item ?? event;
    if (String(item?.role || '') !== 'assistant') return;
    // Interrupting a target can still emit the partial assistant item that was
    // on the wire. It was not an audible completed turn, so never make it a
    // durable transcript row.
    if (event?.interrupted === true || event?.isInterrupted === true
      || item?.interrupted === true || item?.isInterrupted === true
      || event?.status === 'interrupted' || item?.status === 'interrupted') return;
    post({
      role: 'assistant',
      text: textOf(item),
      itemId: item?.id || event?.eventId || event?.sequence,
      createdAt: event?.createdAt || item?.createdAt,
      sourceEvent: event,
    });
  };

  session.on(AgentSessionEventTypes.UserInputTranscribed, onUser);
  session.on(AgentSessionEventTypes.ConversationItemAdded, onItem);

  return {
    stop() {
      stopped = true;
      queue.length = 0;
      currentAbort?.abort();
      try {
        session.off?.(AgentSessionEventTypes.UserInputTranscribed, onUser);
        session.off?.(AgentSessionEventTypes.ConversationItemAdded, onItem);
      } catch { /* session already closed */ }
    },
  };
}
