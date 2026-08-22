# Live huddle latency

## Current pipeline

The live huddle voice path is streamed, with three deliberate boundaries:

1. Microphone PCM is sent continuously to Deepgram Flux. Interim transcripts
   update the live caption, but only `EndOfTurn` commits an utterance and
   dispatches an agent. This avoids answering an incomplete or resumed turn.
2. Agent text updates stream into the durable message row. Completed sentences
   are released to speech immediately; an unterminated tail is held until the
   message settles. Long sentence-free text may break at a safe clause boundary.
3. Cartesia returns raw PCM chunks over a warm websocket. The browser schedules
   each chunk as it arrives, maintaining one continuous playback timeline across
   chunks and sentences.

LiveKit carries the human call audio. Deepgram transcription uses the existing
authenticated realtime connection as a server relay, while Cartesia playback
uses a short-lived, TTS-only browser token and a direct provider websocket.

## What is already optimized

- Microphone frames are small enough to avoid holding the last word for a large
  capture buffer.
- Flux decides end of turn in roughly a tenth of a second in the recorded live
  measurements. Lowering its threshold did not materially improve this.
- A live-huddle prompt asks agents to emit a short, punctuated first sentence
  before doing longer work.
- A completed sentence bypasses the normal 250 ms streamed-write throttle.
- Cartesia is prewarmed when the huddle opens. Recorded warm time to first audio
  chunk is about 107-120 ms, versus hundreds of milliseconds for a cold start.
- Cartesia audio plays as chunks arrive; playback does not wait for the sentence
  or response to finish generating.

These facts make model time-to-first-sentence and the durable message round trip
the most plausible remaining sources of perceived silence. That is a hypothesis
until an end-to-end turn is measured.

## Measure before changing behavior

Record monotonic timestamps, joined by huddle, job, message, and speech context:

1. Deepgram `EndOfTurn` received.
2. Human transcript message committed.
3. Agent job dispatched and claimed.
4. Model request started and first text received.
5. First speakable sentence detected.
6. Sentence update committed and delivered to the listening browser.
7. Cartesia request sent and first PCM chunk received.
8. First audio sample scheduled and played.

Report stage durations rather than only total latency. Logs should contain IDs
and elapsed times, never transcript text, provider credentials, or audio.

## Recommended optimization order

### Phase 1: observability

Add the timing markers above and measure several short spoken turns on a warm
huddle. Compare built-in and daemon-backed agents separately. This is low risk
and identifies whether dispatch, model startup, persistence, delivery, or TTS is
actually dominant.

### Phase 2: remove the durable sentence round trip from speech

If message persistence and subscription delivery are material, add an ephemeral,
session-scoped voice-text event for newly completed agent sentences. Deliver it
to the authorized live huddle audience immediately while the existing message
write continues as the durable transcript.

The browser must deduplicate by message ID plus spoken character offset, preserve
sentence order, and fall back to the durable message stream whenever the
ephemeral event is absent. The event must use the same fail-closed private-session
audience resolution as other session-derived realtime data. It must carry only
the sentence needed for speech, not tools, hidden reasoning, or unrelated row
fields.

This removes a database commit and subscription round trip from the spoken path
without changing transcription turn-taking or transcript durability.

### Phase 3: tune first-sentence production

If model startup or sentence formation dominates, keep the existing immediate
acknowledgement contract and measure compliance. Consider a lower safe clause
limit for live voice only if agents routinely produce long unpunctuated openings.
Do not speak arbitrary token fragments: unstable fragments, abbreviations, and
rewrites can create repeated or malformed audio.

### Deferred: speculative generation

Do not initially dispatch from `EagerEndOfTurn` or an interim transcript. A
`TurnResumed` event can follow, but a posted agent job cannot be un-posted without
visible duplication and cancellation races. Speculative generation is only worth
revisiting if measurement proves end-of-turn latency is dominant and the design
can keep speculative work invisible, cancellable, and free of durable side
effects until the final turn is confirmed.

## Acceptance criteria

- Warm-huddle latency is reported per stage from final human speech to first
  played agent sample.
- Existing interim captions and final-turn dispatch semantics remain unchanged.
- Spoken sentences remain ordered, exactly once, and use the posting agent's
  configured voice.
- A dropped ephemeral event still produces correct speech through the durable
  fallback.
- Private-session sentences never reach a listener outside the live session
  audience.
- Transcript writes remain durable and unchanged in meaning.
- Focused voice streaming, latency, ordering, reconnection, and authorization
  tests pass.
