// LiveKit Agents 1.6.1 starts ParticipantAudioOutput only after RoomIO has
// resolved its initial input participant. Agensis deliberately parks an
// unselected worker on a sentinel participant, then selects the real human by
// data packet. RoomIO replaces its participant Future during that switch while
// init() is still awaiting the old Future, so the input changes successfully
// but the output track is never published.
//
// Start the already-created room audio output directly. The WeakMap makes this
// idempotent while publishTrack()/waitForSubscription() is still in flight.

const outputStarts = new WeakMap();

export function roomParticipantAudioOutput(session) {
  return session?._roomIO?.participantAudioOutput || null;
}

export function ensureRoomAudioOutputStarted({ session, signal, log = console } = {}) {
  const output = roomParticipantAudioOutput(session);
  if (!output || typeof output.start !== 'function') {
    return Promise.reject(new Error('LiveKit room participant audio output was not created'));
  }
  if (output.subscribed) return Promise.resolve(output);

  const existing = outputStarts.get(output);
  if (existing) return existing;

  const pending = Promise.resolve()
    .then(() => output.start(signal))
    .then(() => {
      log.log?.('[voice] LiveKit room audio track published and subscribed');
      return output;
    })
    .catch((error) => {
      outputStarts.delete(output);
      throw error;
    });
  outputStarts.set(output, pending);
  return pending;
}
