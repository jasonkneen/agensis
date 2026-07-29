'use strict';

// The Cartesia layer: the voice catalogue, and rendering one line for preview.
//
// This is NOT the huddle playback pipeline — that is owned separately. What is
// here is the part with the sharp edges:
//
//   1. THE API KEY MUST NOT REACH THE BROWSER. A Cartesia voice id is a public
//      identifier and is safe to hand out; CARTESIA_API_KEY mints billable
//      audio. So the catalogue is proxied and the render happens server-side.
//   2. THE PREVIEW TRANSCRIPT IS NOT CLIENT INPUT. /tts/bytes bills per
//      character. Accepting `transcript` from the request body would turn an
//      authenticated preview button into a metered TTS endpoint for anyone with
//      a login.
//   3. THE CATALOGUE IS PAGINATED AND UNORDERED. ~836 voices behind a cursor,
//      and a default voice derived from "the Nth English voice" drifts unless
//      the list is sorted first.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

process.env.CARTESIA_API_KEY = process.env.CARTESIA_API_KEY || 'testkey_car_test_key';
const { __test } = require('../server/index.cjs');

const voice = (id, name, language) => ({
  id, name, language, gender: 'feminine', description: 'x', country: 'GB',
  is_pro: true, is_owner: false, embedding: [1, 2, 3],
});

function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

test('publicCartesiaVoice keeps only the fields the picker needs', () => {
  const trimmed = __test.publicCartesiaVoice(voice('abc', 'Brooke', 'en-GB'));
  assert.deepEqual(Object.keys(trimmed).sort(), [
    'country', 'description', 'gender', 'id', 'is_pro', 'language', 'name',
  ]);
  // A voice embedding is large and useless to the browser; it must not be
  // relayed just because Cartesia sent it.
  assert.equal('embedding' in trimmed, false);
});

test('the catalogue pages through every voice and returns English ids sorted', async () => {
  const page1 = {
    data: [voice('ccc-11111111', 'C', 'en-US'), voice('aaa-11111111', 'A', 'fr-FR')],
    has_more: true,
    next_page: 'aaa-11111111',
  };
  const page2 = {
    data: [voice('bbb-11111111', 'B', 'en-GB')],
    has_more: false,
    next_page: null,
  };
  let call = 0;
  const stub = stubFetch(async () => jsonResponse(call++ === 0 ? page1 : page2));
  try {
    const ids = await __test.cartesiaEnglishVoiceIds();
    // French dropped, English sorted by id — NOT in the order the pages arrived.
    assert.deepEqual(ids, ['bbb-11111111', 'ccc-11111111']);
    assert.equal(stub.calls.length, 2, 'should follow the has_more cursor');
    assert.match(stub.calls[0].url, /\/voices\?limit=100$/);
    assert.match(stub.calls[1].url, /starting_after=aaa-11111111/);
    // These header assertions pin a LIVE-VERIFIED contract, not the code's own
    // echo: on 2026-07-26, GET /voices with exactly these headers returned 200
    // against api.cartesia.ai (as did Authorization: Bearer — the API accepts
    // both, so keeping X-API-Key is a verified choice, not an oversight).
    assert.equal(stub.calls[0].init.headers['X-API-Key'], process.env.CARTESIA_API_KEY);
    assert.equal(stub.calls[0].init.headers['Cartesia-Version'], '2026-03-01');
  } finally {
    stub.restore();
  }
});

test('the catalogue is cached, so opening the panel does not re-page 800 voices', async () => {
  const stub = stubFetch(async () => jsonResponse({ data: [voice('ddd-11111111', 'D', 'en')], has_more: false }));
  try {
    await __test.cartesiaEnglishVoiceIds();
    assert.equal(stub.calls.length, 0, 'the previous test already warmed the cache');
  } finally {
    stub.restore();
  }
});

test('cartesiaSpeak sends the live-verified sonic-3.5 request', async () => {
  const stub = stubFetch(async () => ({
    ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  }));
  try {
    const audio = await __test.cartesiaSpeak({
      voiceId: 'f9fc912e-e650-4766-a20c-5a93a43aa6e3',
      speed: 1.2,
      emotion: 'contemplative',
    });
    assert.ok(Buffer.isBuffer(audio));

    const [call] = stub.calls;
    assert.match(call.url, /\/tts\/bytes$/);
    assert.equal(call.init.method, 'POST');
    const body = JSON.parse(call.init.body);
    assert.equal(body.model_id, 'sonic-3.5');
    assert.deepEqual(body.voice, { mode: 'id', id: 'f9fc912e-e650-4766-a20c-5a93a43aa6e3' });
    // generation_config is the supported surface on sonic-3 and newer; the old
    // top-level `speed: "fast"` is deprecated and must not be used.
    assert.deepEqual(body.generation_config, { speed: 1.2, emotion: 'contemplative' });
    assert.equal(body.speed, undefined);
    // The full shape, deep-equal, because it is a LIVE-VERIFIED contract: on
    // 2026-07-26 POST /tts/bytes with exactly this output_format returned 200
    // audio/mpeg (an ID3-tagged MP3) against api.cartesia.ai. The documented
    // form ({ container:'mp3', sample_rate:44100, bit_rate:128000 }, no
    // `encoding`) was accepted too — Cartesia tolerates both, so a mismatch
    // with the docs here is not a bug. Re-verify live before changing this.
    assert.deepEqual(body.output_format, { container: 'mp3', encoding: 'mp3', sample_rate: 24000 });
    assert.ok(body.transcript.length > 0);
  } finally {
    stub.restore();
  }
});

test('a Cartesia that stops answering becomes a 504 with a sentence, not a hung request', async () => {
  // Both outbound calls ride cartesiaFetch, whose AbortSignal timeout fires as
  // a TimeoutError. That must reach the route as a clean, client-safe error —
  // the preview button and the voice picker both block on these.
  const timeoutError = () => Object.assign(
    new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' },
  );
  const stub = stubFetch(async () => { throw timeoutError(); });
  try {
    await assert.rejects(
      () => __test.cartesiaSpeak({ voiceId: 'f9fc912e-e650-4766-a20c-5a93a43aa6e3' }),
      (error) => error.status === 504 && /did not respond/.test(error.message),
    );
    // fetchCartesiaVoices directly — cartesiaEnglishVoiceIds would serve the
    // catalogue this file already cached.
    await assert.rejects(
      () => __test.fetchCartesiaVoices(),
      (error) => error.status === 504 && /did not respond/.test(error.message),
    );
  } finally {
    stub.restore();
  }
});

test('cartesiaSpeak refuses a voice id that is not one', async () => {
  const stub = stubFetch(async () => { throw new Error('must not be called'); });
  try {
    await assert.rejects(
      () => __test.cartesiaSpeak({ voiceId: 'Microsoft Aria Online (Natural)' }),
      /voice id is required/,
    );
    assert.equal(stub.calls.length, 0, 'a bad id must never reach the API');
  } finally {
    stub.restore();
  }
});

test('a failed render is surfaced as a 502, not a silent empty buffer', async () => {
  const stub = stubFetch(async () => ({ ok: false, status: 400, text: async () => 'bad voice' }));
  try {
    await assert.rejects(
      () => __test.cartesiaSpeak({ voiceId: 'f9fc912e-e650-4766-a20c-5a93a43aa6e3' }),
      (error) => error.status === 502 && /400/.test(error.message),
    );
  } finally {
    stub.restore();
  }
});

test('the preview route never takes its transcript from the request body', async () => {
  // The one property that stops an authenticated button being a free metered
  // TTS endpoint. Asserted against the source because the guarantee is the
  // ABSENCE of a read, which no runtime call can demonstrate.
  const src = require('./helpers/fly-lane.cjs').flyLaneSource();
  const route = src.slice(src.indexOf("app.post('/backend/tts/preview'"));
  const handler = route.slice(0, route.indexOf('app.post(', 10));
  assert.doesNotMatch(handler, /\btranscript\b/, 'the preview must not accept caller-supplied text');
  assert.match(handler, /normalizeVoicePreference\(req\.body/, 'voice settings must be validated, not trusted');
  assert.match(handler, /ttsPreviewRateLimiter/, 'a route that spends money must be rate limited');
});

test('the voice routes require auth and report a missing key as configuration', async () => {
  const src = require('./helpers/fly-lane.cjs').flyLaneSource();
  assert.match(src, /app\.get\('\/backend\/tts\/voices', requireAuth/);
  assert.match(src, /app\.post\('\/backend\/tts\/preview', requireAuth/);
  // An unconfigured backend must render an explanatory panel, not an error.
  assert.match(src, /configured: false/);
});

test('the API key is never sent to the browser', async () => {
  const src = require('./helpers/fly-lane.cjs').flyLaneSource();
  // The env var may be READ in exactly one place (comments do not count), and
  // the only thing that value is ever put into is the outbound header.
  const reads = src.match(/process\.env\.CARTESIA_API_KEY/g) || [];
  assert.equal(reads.length, 1, 'CARTESIA_API_KEY should be read in exactly one place');
  assert.match(src, /'X-API-Key': cartesiaApiKey\(\)/);
  // Routes may only ask WHETHER a key exists, never send the value on.
  assert.doesNotMatch(src, /res\.json\([^)]*cartesiaApiKey\(\)/);
});
