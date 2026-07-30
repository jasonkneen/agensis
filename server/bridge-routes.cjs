'use strict';

// The hub lane: the two providers that push to a public URL.
//
// Telegram and Slack are here because they are the only two that can be: both
// deliver by POSTing to an address on the internet, and both authenticate with
// a token the user pastes in. WhatsApp, Signal and OpenClaw cannot work this way
// at any price — they need to BE a linked device — so they live in the daemon.
//
// Each provider gets its own verification, and neither is optional:
//   Telegram  a secret token we generate per bridge and hand to setWebhook,
//             returned on every delivery in X-Telegram-Bot-Api-Secret-Token.
//   Slack     an HMAC over the RAW body with the app's signing secret, plus a
//             timestamp window so a captured delivery cannot be replayed.
//
// Both endpoints are UNAUTHENTICATED in the requireAuth sense — they have to be,
// the caller is Telegram or Slack — so the per-provider check IS the auth.

const crypto = require('crypto');

const TELEGRAM_API = 'https://api.telegram.org';
// Slack rejects its own deliveries older than five minutes; matching that is
// what stops a captured request being replayed at us later.
const SLACK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function telegramAdapter({ fetchImpl = fetch } = {}) {
 return {
  provider: 'telegram',
  async send(bridge, text, meta) {
   const token = bridge.config?.botToken;
   if (!token) throw new Error('Telegram bridge has no bot token');
   // Who said it has to survive the hop: everyone in the Telegram group sees one
   // bot account, so without a prefix every agent and teammate reads as "the
   // bot". Telegram has no per-message author override for bots.
   const body = meta.authorName ? `${meta.authorName}: ${text}` : text;
   const res = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: bridge.external_id, text: body }),
   });
   const json = await res.json().catch(() => ({}));
   if (!res.ok || json.ok === false) {
    throw new Error(`Telegram sendMessage failed: ${json.description || res.status}`);
   }
   const id = json.result?.message_id;
   return id ? String(id) : null;
  },
 };
}

// Point Telegram at us. Called when a bridge is created or its token changes.
// The secret token is what makes the public URL safe to publish: a delivery that
// does not carry it is not from Telegram.
async function telegramSetWebhook({ botToken, url, secretToken, fetchImpl = fetch }) {
 const res = await fetchImpl(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
   url,
   secret_token: secretToken,
   // Everything else is noise for a chat mirror.
   allowed_updates: ['message', 'edited_message'],
  }),
 });
 const json = await res.json().catch(() => ({}));
 if (!res.ok || json.ok === false) {
  throw new Error(`Telegram setWebhook failed: ${json.description || res.status}`);
 }
 return json.result;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

function slackAdapter({ fetchImpl = fetch } = {}) {
 return {
  provider: 'slack',
  async send(bridge, text, meta) {
   const token = bridge.config?.botToken;
   if (!token) throw new Error('Slack bridge has no bot token');
   const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
     'content-type': 'application/json; charset=utf-8',
     authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
     channel: bridge.external_id,
     text,
     // Slack DOES let a bot post under a per-message identity, so unlike
     // Telegram the author survives properly rather than being inlined.
     username: meta.authorName || undefined,
    }),
   });
   const json = await res.json().catch(() => ({}));
   if (!json.ok) throw new Error(`Slack chat.postMessage failed: ${json.error || res.status}`);
   return json.ts ? String(json.ts) : null;
  },
 };
}

// Slack's v0 scheme, verbatim: sha256 HMAC over `v0:<timestamp>:<raw body>`.
// The RAW body matters — re-serializing the parsed JSON changes key order and
// whitespace and the signature stops matching, which is the classic way this
// gets "mysteriously" broken.
function verifySlackSignature({ signingSecret, timestamp, rawBody, signature, now = Date.now() }) {
 if (!signingSecret || !timestamp || !signature) return false;
 const ts = Number(timestamp);
 if (!Number.isFinite(ts)) return false;
 if (Math.abs(now - ts * 1000) > SLACK_REPLAY_WINDOW_MS) return false;
 const expected = `v0=${crypto
  .createHmac('sha256', signingSecret)
  .update(`v0:${timestamp}:${rawBody}`)
  .digest('hex')}`;
 const a = Buffer.from(expected);
 const b = Buffer.from(String(signature));
 // Length check first: timingSafeEqual THROWS on a length mismatch rather than
 // returning false, which would turn a bad signature into a 500.
 if (a.length !== b.length) return false;
 return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function mountBridgeRoutes(app, deps) {
 const { bridges, jsonError, rateLimitBlocked, bridgeRateLimiter, clientIpFromReq } = deps;

 // Telegram delivery. Answer 200 fast and unconditionally once the secret checks
 // out: Telegram retries anything it considers failed, and a retry storm against
 // a slow agent turn is how a chat ends up with the same message five times.
 app.post('/backend/bridges/telegram/:bridgeId', async (req, res) => {
  try {
   if (rateLimitBlocked(res, bridgeRateLimiter, clientIpFromReq(req))) return;
   const bridge = await bridges.bridgeById(req.params.bridgeId);
   if (!bridge || bridge.provider !== 'telegram') return jsonError(res, 404, new Error('Bridge not found'));

   const presented = String(req.get('x-telegram-bot-api-secret-token') || '');
   const expected = String(bridge.config?.secretToken || '');
   if (!expected || presented !== expected) return jsonError(res, 401, new Error('Bad secret token'));

   const update = req.body || {};
   const msg = update.message || update.edited_message;
   // Answer 200 for anything we do not handle. A 4xx makes Telegram retry it
   // forever, and a join notice is not an error.
   if (!msg || !msg.text) return res.json({ ok: true });
   if (String(msg.chat?.id ?? '') !== String(bridge.external_id)) return res.json({ ok: true });
   // A bot's own posts come back down the same socket.
   if (msg.from?.is_bot) return res.json({ ok: true });

   const from = msg.from || {};
   const authorName = [from.first_name, from.last_name].filter(Boolean).join(' ')
     || from.username || 'Telegram user';

   await bridges.ingestBridgeMessage({
    bridgeId: bridge.id,
    externalMessageId: `${msg.chat.id}:${msg.message_id}`,
    authorName,
    authorHandle: from.username || '',
    text: msg.text,
   });
   res.json({ ok: true });
  } catch (error) {
   console.error('telegram bridge delivery failed', error);
   // Still 200: the message is lost either way, and a non-200 buys a retry
   // storm on top of the loss.
   res.json({ ok: true });
  }
 });

 // Slack Events API. The signature is computed over the bytes Slack actually
 // sent — `req.rawBody`, captured by the express.json verify hook — never over a
 // re-serialization of the parsed object.
 app.post('/backend/bridges/slack/:bridgeId', async (req, res) => {
  try {
   if (rateLimitBlocked(res, bridgeRateLimiter, clientIpFromReq(req))) return;
   const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody || '');
   if (!rawBody) return jsonError(res, 400, new Error('Missing body'));
   const payload = req.body || {};

   const bridge = await bridges.bridgeById(req.params.bridgeId);
   if (!bridge || bridge.provider !== 'slack') return jsonError(res, 404, new Error('Bridge not found'));

   const ok = verifySlackSignature({
    signingSecret: bridge.config?.signingSecret,
    timestamp: req.get('x-slack-request-timestamp'),
    rawBody,
    signature: req.get('x-slack-signature'),
   });
   if (!ok) return jsonError(res, 401, new Error('Bad Slack signature'));

   // The one-time handshake Slack runs when the Event URL is saved. Verified
   // FIRST so an unsigned challenge cannot enrol a URL.
   if (payload.type === 'url_verification') return res.json({ challenge: payload.challenge });

   const event = payload.event || {};
   if (event.type !== 'message') return res.json({ ok: true });
   // bot_message covers our own posts; the subtype guard drops joins, edits and
   // channel-topic noise that would otherwise read as somebody talking.
   if (event.bot_id || event.subtype) return res.json({ ok: true });
   if (String(event.channel || '') !== String(bridge.external_id)) return res.json({ ok: true });

   await bridges.ingestBridgeMessage({
    bridgeId: bridge.id,
    // event_ts is unique per channel event and stable across Slack's retries.
    externalMessageId: String(event.event_ts || event.ts || ''),
    authorName: event.user_profile?.real_name || event.username || `Slack ${event.user || 'user'}`,
    authorHandle: event.user || '',
    text: String(event.text || ''),
   });
   res.json({ ok: true });
  } catch (error) {
   console.error('slack bridge delivery failed', error);
   res.json({ ok: true });
  }
 });
}

module.exports = {
 telegramAdapter,
 telegramSetWebhook,
 slackAdapter,
 verifySlackSignature,
 mountBridgeRoutes,
 SLACK_REPLAY_WINDOW_MS,
};
