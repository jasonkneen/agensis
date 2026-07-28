'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Cartesia voices: the catalogue, and a one-line preview.
//
// Both are thin proxies for one reason — CARTESIA_API_KEY must never reach the
// browser. The catalogue is fetched server-side and the preview is rendered
// server-side; the only thing the client ever gets is audio.
//
// NOT the huddle playback pipeline. This is "which voices exist" and "let me
// hear this one".

function mountTtsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, rateLimitBlocked, clientIpFromReq, cartesiaApiKey,
  cartesiaSpeak, cartesiaVoices, normalizeVoicePreference,
  ttsPreviewRateLimiter,
 } = deps;

 app.get('/backend/tts/voices', requireAuth, async (req, res) => {
  try {
   if (!cartesiaApiKey()) {
    // A missing key is a configuration state, not a failure: the panel shows
    // "voices unavailable" and every agent keeps its stored id.
    return res.json({ data: [], error: null, configured: false });
   }
   const voices = await cartesiaVoices();
   res.json({ data: voices, error: null, configured: true });
  } catch (error) {
   jsonError(res, error.status || 502, error);
  }
 });

 app.post('/backend/tts/preview', requireAuth, async (req, res) => {
  try {
   if (rateLimitBlocked(res, ttsPreviewRateLimiter, req.userId || clientIpFromReq(req))) return;
   if (!cartesiaApiKey()) return jsonError(res, 503, new Error('Cartesia is not configured'));

   // Only the voice settings come from the client. The TRANSCRIPT does not:
   // this route bills per character, and accepting arbitrary text would turn an
   // authenticated preview button into a metered text-to-speech endpoint for
   // anyone with an account.
   const settings = normalizeVoicePreference(req.body || {});
   if (!settings.cartesia_voice_id) return jsonError(res, 400, new Error('A Cartesia voice id is required'));

   const audio = await cartesiaSpeak({
    voiceId: settings.cartesia_voice_id,
    speed: settings.speed ?? 1,
    emotion: settings.emotion || 'neutral',
   });
   res.setHeader('Content-Type', 'audio/mpeg');
   res.setHeader('Cache-Control', 'no-store');
   res.send(audio);
  } catch (error) {
   jsonError(res, error.status || 502, error);
  }
 });
}

module.exports = { mountTtsRoutes };
