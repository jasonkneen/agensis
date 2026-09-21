// Runs only in the independent helper's sandboxed, unthrottled renderer.
'use strict';
(() => {
  const api = window.broadcastCapture;
  let current;
  function stop() {
    const capture = current;
    if (!capture) return;
    current = null;
    if (capture.recorder?.state === 'recording') capture.recorder.stop();
    capture.tracks.forEach(track => track.stop());
  }
  function fail(capture, code) {
    if (current !== capture) return;
    api.failure(capture.id, code); stop();
  }
  function accept(capture, stream) {
    if (current !== capture) { stream.getTracks().forEach(track => track.stop()); throw new Error('Cancelled'); }
    capture.tracks.push(...stream.getTracks());
    stream.getTracks().forEach(track => track.addEventListener('ended', () => fail(capture, 'ended'), { once: true }));
    return stream;
  }
  api.onStop(stop);
  api.onStart(async config => {
    stop();
    const capture = { id: config.id, tracks: [], pending: 0, queue: Promise.resolve() };
    current = capture;
    try {
      const video = accept(capture, await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: config.sourceId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 },
      } }));
      const audio = config.audio ? accept(capture, await navigator.mediaDevices.getUserMedia({ audio: true, video: false })) : null;
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) { fail(capture, 'recording'); return; }
      capture.recorder = new MediaRecorder(new MediaStream([...video.getVideoTracks(), ...(audio?.getAudioTracks() || [])]), {
        mimeType, videoBitsPerSecond: 4500000, audioBitsPerSecond: 128000,
      });
      capture.recorder.onerror = () => fail(capture, 'recording');
      capture.recorder.ondataavailable = event => {
        if (current !== capture || !event.data.size) return;
        capture.pending += event.data.size;
        if (capture.pending > 4 * 1024 * 1024 || event.data.size > 2 * 1024 * 1024) { fail(capture, 'queue'); return; }
        capture.queue = capture.queue.then(async () => {
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          if (current !== capture) return;
          const status = await api.write(capture.id, bytes);
          if (current === capture && ['error', 'stopped'].includes(status.state)) stop();
        }).catch(() => fail(capture, 'delivery')).finally(() => { capture.pending -= event.data.size; });
      };
      capture.recorder.start(250);
    } catch { fail(capture, 'permission'); }
  });
})();
