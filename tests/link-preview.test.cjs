'use strict';

// ============================================================================
// tests/link-preview.test.cjs
// ----------------------------------------------------------------------------
// Link preview cards mean this server fetches a URL a stranger typed into a
// chat message, from inside Fly's network, with no egress restrictions. That is
// the same primitive as the inference-gateway `base_url` hole (see
// tests/gateway-ssrf.test.cjs) with a wider door: anyone who can post a message
// can pick the URL, not just a workspace `manage` role.
//
// So these are not "does the parser work" tests. The load-bearing ones are:
//
//   * every hop of a redirect chain is re-validated, and the request to a
//     private address is NEVER MADE (asserted on the call log, not on the
//     returned status — a function can return the right answer having already
//     leaked the request);
//   * the byte cap is enforced by CANCELLING the stream, not by reading 2GB and
//     then slicing;
//   * a hostile Content-Length, an hostile content-type, and an endless
//     redirect loop each terminate;
//   * everything that reaches the UI has been stripped of the characters that
//     let text render as something other than what it says.
//
// Network and DNS are both injected, so all of the above is provable with no
// live host — which is the reason the fetcher takes `lookup`/`fetchImpl` at all.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BLOCKED_IPV4_RANGES,
  LINK_PREVIEW_FAILURE_TTL_MS,
  LINK_PREVIEW_MAX_PER_MESSAGE,
  LINK_PREVIEW_MAX_TITLE_CHARS,
  LINK_PREVIEW_TTL_MS,
  LINK_PREVIEW_USER_AGENT,
  clampPreviewText,
  decodeHtmlEntities,
  extractLinkUrls,
  fetchLinkPreview,
  fetchPreviewImage,
  isBlockedAddress,
  linkPreviewCacheKey,
  linkPreviewTtlMs,
  normalizeUnfurlUrl,
  parseHtmlMetadata,
  resolvePreviewImageUrl,
  resolveUnfurlTarget,
} = require('../server/link-preview.cjs');

// --- fakes -----------------------------------------------------------------

/** A lookup that answers from a table; anything unlisted is NXDOMAIN. */
function fakeLookup(table) {
  return async (host) => {
    if (!Object.prototype.hasOwnProperty.call(table, host)) {
      const error = new Error(`ENOTFOUND ${host}`);
      error.code = 'ENOTFOUND';
      throw error;
    }
    return table[host];
  };
}

// A body that records what was done to it. ReadableStream calls `pull` eagerly at
// construction to fill its queue, so a pull count cannot prove "nothing was read" —
// only `readers` can, hence the wrapper. readCappedBody needs nothing but getReader.
function bodyStream(chunks, state = {}) {
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++];
      state.pulled = (state.pulled || 0) + 1;
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    getReader() {
      state.readers = (state.readers || 0) + 1;
      return stream.getReader();
    },
  };
}

function htmlResponse(html, { status = 200, contentType = 'text/html; charset=utf-8', headers = {}, state } = {}) {
  return {
    status,
    headers: new Headers({ 'content-type': contentType, ...headers }),
    body: bodyStream(Array.isArray(html) ? html : [html], state),
  };
}

function redirectResponse(location, status = 302) {
  return { status, headers: new Headers(location ? { location } : {}), body: null };
}

/** Records every URL fetched, and replies from a scripted map or list. */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const reply = typeof script === 'function' ? script(url, calls.length) : script[url];
    if (!reply) throw new Error(`unscripted fetch: ${url}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  impl.calls = calls;
  return impl;
}

const PUBLIC_DNS = { 'example.com': ['93.184.216.34'], 'redirector.test': ['93.184.216.34'], 'evil.test': ['93.184.216.34'] };

// --- the address gate ------------------------------------------------------

test('blocks the addresses that make SSRF worth doing', () => {
  const blocked = [
    '169.254.169.254', // cloud metadata — the whole reason this exists
    '127.0.0.1', '127.1.2.3', '0.0.0.0',
    '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', // CGNAT
    '198.18.0.1', // benchmarking
    '192.0.0.1', // IETF protocol assignments
    '224.0.0.1', // multicast
    '240.0.0.1', // reserved
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:169.254.169.254', // IPv4-mapped metadata address
    '::ffff:127.0.0.1',
    'not-an-ip', '', null, undefined, '999.999.999.999',
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }
});

test('allows ordinary public addresses', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '192.167.255.255', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
  }
});

test('172.16.0.0/12 boundaries are exact', () => {
  assert.equal(isBlockedAddress('172.15.255.255'), false, 'just below the range is public');
  assert.equal(isBlockedAddress('172.16.0.0'), true);
  assert.equal(isBlockedAddress('172.31.255.255'), true);
  assert.equal(isBlockedAddress('172.32.0.0'), false, 'just above the range is public');
});

test('the range table agrees with the gateway guard in server/index.cjs', () => {
  // Two copies of an SSRF range table is how one of them silently goes stale.
  // Compared by BEHAVIOUR over the union of both suites' fixtures rather than by
  // deep-equalling the literals, so a table that is reordered or re-expressed
  // still passes and a table that is missing a range still fails.
  const { __test } = require('../server/index.cjs');
  const sample = [
    '169.254.169.254', '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '198.18.0.1', '192.0.0.1', '224.0.0.1', '240.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:169.254.169.254',
    '::ffff:127.0.0.1', 'not-an-ip', '1.1.1.1', '8.8.8.8', '172.32.0.1', '192.167.255.255',
    '2606:4700::1111', '172.15.255.255', '172.16.0.0', '172.32.0.0',
  ];
  for (const address of sample) {
    assert.equal(
      isBlockedAddress(address),
      __test.isBlockedAddress(address),
      `${address}: the link-preview gate and the gateway gate disagree`,
    );
  }
  assert.ok(BLOCKED_IPV4_RANGES.length >= 11, 'the v4 range table lost entries');
});

// --- URL shape -------------------------------------------------------------

test('normalizeUnfurlUrl accepts http and https and nothing else', () => {
  assert.equal(normalizeUnfurlUrl('https://example.com/a').ok, true);
  // http is deliberately allowed here, unlike the gateway guard: there is no API
  // key on this request, so refusing plaintext would only mean no card for an
  // http-only site.
  assert.equal(normalizeUnfurlUrl('http://example.com/a').ok, true);
  for (const bad of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/', 'data:text/html,<b>x', 'javascript:alert(1)']) {
    assert.equal(normalizeUnfurlUrl(bad).reason, 'scheme_not_allowed', `${bad} should be refused`);
  }
});

test('normalizeUnfurlUrl refuses credentials, split-horizon names and junk', () => {
  assert.equal(normalizeUnfurlUrl('https://user:pass@example.com/').reason, 'credentials_in_url');
  assert.equal(normalizeUnfurlUrl('https://user@example.com/').reason, 'credentials_in_url');
  for (const host of ['localhost', 'foo.localhost', 'printer.local', 'metadata.internal', 'wiki.intranet', 'nas.lan', 'box.home.arpa']) {
    assert.equal(normalizeUnfurlUrl(`http://${host}/x`).reason, 'private_host', `${host} should be refused by name`);
  }
  assert.equal(normalizeUnfurlUrl('').reason, 'empty');
  assert.equal(normalizeUnfurlUrl('example.com/v1').reason, 'not_a_url');
  assert.equal(normalizeUnfurlUrl('/relative/path').reason, 'not_a_url');
  assert.equal(normalizeUnfurlUrl(`https://example.com/${'a'.repeat(3000)}`).reason, 'url_too_long');
});

test('the fragment is dropped so two spellings of one page share a cache entry', () => {
  const a = normalizeUnfurlUrl('https://example.com/post?s=20#reply');
  const b = normalizeUnfurlUrl('https://example.com/post?s=20');
  assert.equal(a.url, b.url);
  assert.equal(a.url, 'https://example.com/post?s=20');
  // Query params are KEPT — stripping them guesses at which ones matter.
  assert.notEqual(normalizeUnfurlUrl('https://example.com/post').url, a.url);
  assert.equal(linkPreviewCacheKey(a.url), linkPreviewCacheKey(b.url));
  assert.match(linkPreviewCacheKey(a.url), /^[a-f0-9]{64}$/);
});

test('resolveUnfurlTarget requires EVERY resolved address to be public', async () => {
  const lookup = fakeLookup({
    'good.test': ['93.184.216.34'],
    // One public answer and one private one is a rebinding attempt, not a
    // misconfiguration. Picking the public one and proceeding is the bug.
    'mixed.test': ['93.184.216.34', '169.254.169.254'],
    'private.test': ['10.0.0.5'],
    'empty.test': [],
  });
  assert.equal((await resolveUnfurlTarget('https://good.test/a', { lookup })).ok, true);
  assert.equal((await resolveUnfurlTarget('https://mixed.test/a', { lookup })).reason, 'blocked_address');
  assert.equal((await resolveUnfurlTarget('https://private.test/a', { lookup })).reason, 'blocked_address');
  assert.equal((await resolveUnfurlTarget('https://empty.test/a', { lookup })).reason, 'dns_failed');
  assert.equal((await resolveUnfurlTarget('https://nx.test/a', { lookup })).reason, 'dns_failed');
  // An IP literal skips DNS entirely and is judged directly.
  assert.equal((await resolveUnfurlTarget('http://169.254.169.254/latest/meta-data/', { lookup })).reason, 'blocked_address');
  assert.equal((await resolveUnfurlTarget('http://[::1]:9000/', { lookup })).reason, 'blocked_address');
  assert.equal((await resolveUnfurlTarget('https://1.1.1.1/', { lookup })).ok, true);
});

// --- the redirect chain: the actual bypass ---------------------------------

test('a redirect to the metadata endpoint is refused AND never requested', async () => {
  const fetchImpl = fakeFetch({
    'https://redirector.test/go': redirectResponse('http://169.254.169.254/latest/meta-data/'),
  });
  const result = await fetchLinkPreview('https://redirector.test/go', {
    lookup: fakeLookup(PUBLIC_DNS),
    fetchImpl,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail, 'blocked_address');
  // The assertion that matters: exactly ONE request left the machine, and it was
  // to the public host. Returning "blocked" after having already fetched the
  // metadata endpoint would be a pass on status and a total failure in fact.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://redirector.test/go');
});

test('a redirect chain that ends privately is refused at the hop it turns private', async () => {
  const fetchImpl = fakeFetch({
    'https://redirector.test/a': redirectResponse('https://redirector.test/b'),
    'https://redirector.test/b': redirectResponse('https://internal.test/c'),
  });
  const result = await fetchLinkPreview('https://redirector.test/a', {
    lookup: fakeLookup({ ...PUBLIC_DNS, 'internal.test': ['10.4.5.6'] }),
    fetchImpl,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail, 'blocked_address');
  assert.deepEqual(fetchImpl.calls.map(call => call.url), [
    'https://redirector.test/a',
    'https://redirector.test/b',
  ]);
});

test('every redirect status is walked by hand, not by undici', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const fetchImpl = fakeFetch({
      'https://redirector.test/go': redirectResponse('http://127.0.0.1:9000/admin', status),
    });
    const result = await fetchLinkPreview('https://redirector.test/go', {
      lookup: fakeLookup(PUBLIC_DNS), fetchImpl,
    });
    assert.equal(result.status, 'blocked', `${status} should not be followed to loopback`);
    assert.equal(fetchImpl.calls.length, 1, `${status} leaked a request`);
    // `redirect: 'manual'` is what makes the hand-walk possible at all.
    assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
  }
});

test('the redirect count is capped', async () => {
  // A host that redirects to itself forever.
  const fetchImpl = fakeFetch(url => redirectResponse(`${url}x`));
  const result = await fetchLinkPreview('https://example.com/a', {
    lookup: fakeLookup(PUBLIC_DNS), fetchImpl, maxRedirects: 3,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail, 'too_many_redirects');
  assert.equal(fetchImpl.calls.length, 4, 'the initial request plus three hops, then stop');
});

test('a relative Location is resolved against the hop it came from', async () => {
  const fetchImpl = fakeFetch({
    'https://example.com/a/b': redirectResponse('../c'),
    'https://example.com/c': htmlResponse('<meta property="og:title" content="Landed">'),
  });
  const result = await fetchLinkPreview('https://example.com/a/b', {
    lookup: fakeLookup(PUBLIC_DNS), fetchImpl,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.title, 'Landed');
  assert.equal(result.finalUrl, 'https://example.com/c');
});

test('a redirect with no Location, and an unparseable one, both terminate', async () => {
  const noLocation = fakeFetch({ 'https://example.com/a': redirectResponse('') });
  assert.equal(
    (await fetchLinkPreview('https://example.com/a', { lookup: fakeLookup(PUBLIC_DNS), fetchImpl: noLocation })).detail,
    'redirect_without_location',
  );
  const badScheme = fakeFetch({ 'https://example.com/a': redirectResponse('file:///etc/passwd') });
  const result = await fetchLinkPreview('https://example.com/a', { lookup: fakeLookup(PUBLIC_DNS), fetchImpl: badScheme });
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail, 'scheme_not_allowed');
});

// --- the budget ------------------------------------------------------------

test('the byte cap CANCELS the stream instead of reading it all', async () => {
  const state = {};
  // 40 chunks of 1KB behind a 4KB cap: a real cap stops pulling.
  const chunks = Array.from({ length: 40 }, () => 'x'.repeat(1024));
  const fetchImpl = fakeFetch({ 'https://example.com/big': htmlResponse(chunks, { state }) });
  const result = await fetchLinkPreview('https://example.com/big', {
    lookup: fakeLookup(PUBLIC_DNS), fetchImpl, maxBytes: 4096,
  });
  assert.equal(state.cancelled, true, 'the response stream must be cancelled, not drained');
  assert.ok(state.pulled <= 6, `stopped after ${state.pulled} chunks, expected ~4`);
  // 4KB of 'x' has no metadata, which is the honest answer.
  assert.equal(result.status, 'empty');
  assert.equal(result.detail, 'truncated');
});

test('a hostile Content-Length is refused before the body is read', async () => {
  const state = {};
  const fetchImpl = fakeFetch({
    'https://example.com/huge': htmlResponse('<title>x</title>', {
      headers: { 'content-length': String(2 * 1024 * 1024 * 1024) },
      state,
    }),
  });
  const result = await fetchLinkPreview('https://example.com/huge', {
    lookup: fakeLookup(PUBLIC_DNS), fetchImpl, maxBytes: 4096,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail, 'too_large');
  assert.equal(state.readers, undefined, 'the body must not be read at all');
});

test('only text/html is parsed', async () => {
  for (const contentType of ['application/json', 'application/pdf', 'image/png', 'text/plain', 'application/zip']) {
    const fetchImpl = fakeFetch({ 'https://example.com/f': htmlResponse('{}', { contentType }) });
    const result = await fetchLinkPreview('https://example.com/f', { lookup: fakeLookup(PUBLIC_DNS), fetchImpl });
    assert.equal(result.status, 'blocked', `${contentType} should not be parsed`);
    assert.match(result.detail, /^content_type_/);
  }
  for (const contentType of ['text/html', 'text/html;charset=iso-8859-1', 'application/xhtml+xml']) {
    const fetchImpl = fakeFetch({ 'https://example.com/f': htmlResponse('<title>Fine</title>', { contentType }) });
    const result = await fetchLinkPreview('https://example.com/f', { lookup: fakeLookup(PUBLIC_DNS), fetchImpl });
    assert.equal(result.status, 'ok', `${contentType} should be parsed`);
  }
});

test('a timeout and a network error are failures, not crashes', async () => {
  const hang = fakeFetch(async () => {
    await new Promise(() => {}); // never settles; the deadline must fire
  });
  const timedOut = await fetchLinkPreview('https://example.com/slow', {
    lookup: fakeLookup(PUBLIC_DNS),
    fetchImpl: async (url, init) => {
      void hang;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
    timeoutMs: 20,
  });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.detail, 'timeout');

  const refused = await fetchLinkPreview('https://example.com/down', {
    lookup: fakeLookup(PUBLIC_DNS),
    fetchImpl: fakeFetch({ 'https://example.com/down': new Error('ECONNREFUSED') }),
  });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.detail, 'network_error');
});

test('an HTTP error status is a failure with the code in the detail', async () => {
  for (const status of [404, 403, 500, 503]) {
    const fetchImpl = fakeFetch({ 'https://example.com/x': htmlResponse('<title>nope</title>', { status }) });
    const result = await fetchLinkPreview('https://example.com/x', { lookup: fakeLookup(PUBLIC_DNS), fetchImpl });
    assert.equal(result.status, 'failed');
    assert.equal(result.detail, `http_${status}`);
  }
});

test('fetchLinkPreview never throws, whatever it is handed', async () => {
  for (const input of ['', null, undefined, 'not a url', 'file:///etc/passwd', 'http://169.254.169.254/']) {
    const result = await fetchLinkPreview(input, { lookup: fakeLookup(PUBLIC_DNS), fetchImpl: fakeFetch({}) });
    assert.equal(result.status, 'blocked', `${input} should be a blocked row, not an exception`);
    assert.ok(result.detail, 'a blocked row must say why');
  }
});

test('the request identifies itself honestly', async () => {
  const fetchImpl = fakeFetch({ 'https://example.com/a': htmlResponse('<title>x</title>') });
  await fetchLinkPreview('https://example.com/a', { lookup: fakeLookup(PUBLIC_DNS), fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers['user-agent'], LINK_PREVIEW_USER_AGENT);
  assert.match(LINK_PREVIEW_USER_AGENT, /^agensis-linkpreview/);
});

// --- metadata parsing ------------------------------------------------------

test('og: beats twitter: beats the plain HTML equivalent', () => {
  const meta = parseHtmlMetadata(`
    <html><head>
      <title>Document title</title>
      <meta name="description" content="Plain description">
      <meta name="twitter:title" content="Twitter title">
      <meta name="twitter:description" content="Twitter description">
      <meta property="og:title" content="OG title">
      <meta property="og:description" content="OG description">
      <meta property="og:site_name" content="Example">
    </head></html>`, 'https://www.example.com/post');
  assert.equal(meta.title, 'OG title');
  assert.equal(meta.description, 'OG description');
  assert.equal(meta.siteName, 'Example');

  const twitterOnly = parseHtmlMetadata(`
    <title>Document title</title>
    <meta name="twitter:title" content="Twitter title">`, 'https://www.example.com/post');
  assert.equal(twitterOnly.title, 'Twitter title');
  // No og:site_name — fall back to the hostname with www. stripped, which is
  // what every other unfurler shows.
  assert.equal(twitterOnly.siteName, 'example.com');

  const titleOnly = parseHtmlMetadata('<title>Document title</title>', 'https://example.com/post');
  assert.equal(titleOnly.title, 'Document title');
});

test('a duplicated tag keeps the first, and unquoted attributes still parse', () => {
  const meta = parseHtmlMetadata(`
    <meta property="og:title" content="First">
    <meta property="og:title" content="Second">
    <meta property=og:site_name content=Unquoted>`);
  assert.equal(meta.title, 'First');
  assert.equal(meta.siteName, 'Unquoted');
});

test('entities are decoded once, and only into text', () => {
  const meta = parseHtmlMetadata('<meta property="og:title" content="Tom &amp; Jerry &lt;3 &quot;quotes&quot; &#39;n &#x27;things">');
  assert.equal(meta.title, `Tom & Jerry <3 "quotes" 'n 'things`);
  // The decoded result is handed to React as a text child, so a decoded `<b>`
  // is five characters of title and not a tag. Nothing here builds HTML.
  const injected = parseHtmlMetadata('<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;">');
  assert.equal(injected.title, '<img src=x onerror=alert(1)>');
  assert.equal(decodeHtmlEntities('&notanentity; &amp;'), '&notanentity; &');
});

test('metadata inside a script body or a comment is ignored', () => {
  const meta = parseHtmlMetadata(`
    <meta property="og:title" content="Real">
    <script>var s = '<meta property="og:title" content="Injected">';</script>
    <!-- <meta property="og:description" content="Commented"> -->`);
  assert.equal(meta.title, 'Real');
  assert.equal(meta.description, '');
});

test('a page with nothing to show reports nothing, and does not invent a title', () => {
  const meta = parseHtmlMetadata('<html><body><p>hello</p></body></html>', 'https://example.com/x');
  assert.equal(meta.title, '');
  assert.equal(meta.description, '');
  assert.equal(meta.imageUrl, '');
  // siteName alone is not "metadata found" — see the 'empty' status below.
  assert.equal(meta.siteName, 'example.com');
});

test('og:image is made absolute, and anything not http(s) is dropped', () => {
  assert.equal(
    parseHtmlMetadata('<meta property="og:image" content="/img/card.png">', 'https://example.com/a/b').imageUrl,
    'https://example.com/img/card.png',
  );
  assert.equal(
    parseHtmlMetadata('<meta property="og:image" content="//cdn.example.com/c.png">', 'https://example.com/a').imageUrl,
    'https://cdn.example.com/c.png',
  );
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'http://localhost/x.png', '']) {
    assert.equal(
      parseHtmlMetadata(`<meta property="og:image" content="${bad}">`, 'https://example.com/a').imageUrl,
      '',
      `${bad} should not survive as an image URL`,
    );
  }
  // og:image:secure_url wins over og:image when both are present.
  assert.equal(
    parseHtmlMetadata(`
      <meta property="og:image" content="http://example.com/plain.png">
      <meta property="og:image:secure_url" content="https://example.com/secure.png">`).imageUrl,
    'https://example.com/secure.png',
  );
  assert.equal(resolvePreviewImageUrl('  ', 'https://example.com/'), '');
});

// --- the untrusted-text clamp ---------------------------------------------

test('clampPreviewText removes what makes text lie about itself', () => {
  // Every fixture below is \u-escaped on purpose. A literal bidi override in a
  // test file is invisible in review, so the test would assert something nobody
  // reading it can see.
  const RLO = '\u202e';        // right-to-left override: renders the rest reversed
  const ZWSP = '\u200b';       // zero-width space
  const ZWNJ = '\u200c';
  const ZWJ = '\u200d';
  const BOM = '\ufeff';
  const LINE_SEP = '\u2028';   // a newline that most \\n handling misses
  const PARA_SEP = '\u2029';
  const NUL = '\u0000';
  const BELL = '\u0007';

  assert.equal(clampPreviewText(`safe${RLO}gnp.exe`, 100), 'safegnp.exe');
  assert.equal(clampPreviewText(`a${ZWSP}b${ZWNJ}${ZWJ}c${BOM}`, 100), 'abc');
  assert.equal(clampPreviewText(`a${NUL}${BELL}b`, 100), 'a b');
  // Newlines collapse: a card title is one line by construction, so a title with
  // forty of them cannot push the message below it off the screen.
  assert.equal(clampPreviewText('one\ntwo\r\n\nthree', 100), 'one two three');
  // U+2028/U+2029 ARE whitespace to the regex engine, so they collapse to a space
  // like a newline rather than being deleted — deleting them would silently fuse
  // two sentences into one word.
  assert.equal(clampPreviewText(`line${LINE_SEP}sep${PARA_SEP}par`, 100), 'line sep par');
  assert.equal(clampPreviewText('  padded  ', 100), 'padded');
  assert.equal(clampPreviewText(null, 100), '');
  assert.equal(clampPreviewText('abcdef', 3), 'abc');
  assert.equal(clampPreviewText('abcdef', 0), '');

  // And the same clamp is what a card title actually goes through.
  const meta = parseHtmlMetadata(`<meta property="og:title" content="ship${RLO}gnp.exe">`);
  assert.equal(meta.title, 'shipgnp.exe');
});

test('an absurdly long title is cut to the cap', () => {
  const meta = parseHtmlMetadata(`<meta property="og:title" content="${'t'.repeat(5000)}">`);
  assert.equal(meta.title.length, LINK_PREVIEW_MAX_TITLE_CHARS);
  const description = parseHtmlMetadata(`<meta property="og:description" content="${'d'.repeat(5000)}">`);
  assert.ok(description.description.length <= 400);
});

// --- end-to-end shape -----------------------------------------------------

test('a well-formed page produces an ok row with every field', async () => {
  const fetchImpl = fakeFetch({
    'https://example.com/post?s=20': htmlResponse(`
      <html><head>
        <meta property="og:title" content="Crazy how good these models are">
        <meta property="og:description" content="A thread about it.">
        <meta property="og:site_name" content="Example">
        <meta property="og:image" content="/card.png">
      </head></html>`),
  });
  const result = await fetchLinkPreview('https://example.com/post?s=20#x', {
    lookup: fakeLookup(PUBLIC_DNS), fetchImpl,
  });
  assert.deepEqual(result, {
    url: 'https://example.com/post?s=20',
    finalUrl: 'https://example.com/post?s=20',
    status: 'ok',
    detail: '',
    title: 'Crazy how good these models are',
    description: 'A thread about it.',
    siteName: 'Example',
    imageUrl: 'https://example.com/card.png',
  });
});

test('a page that publishes nothing is `empty`, which is not a failure', async () => {
  const fetchImpl = fakeFetch({
    'https://example.com/bare': htmlResponse('<html><body>just words</body></html>'),
  });
  const result = await fetchLinkPreview('https://example.com/bare', { lookup: fakeLookup(PUBLIC_DNS), fetchImpl });
  assert.equal(result.status, 'empty');
  assert.equal(result.title, '');
  // The host is still known, so the card can say which site declined to say
  // anything rather than showing a blank rectangle.
  assert.equal(result.siteName, 'example.com');
});

test('a failed unfurl is cached for an hour, a successful one for a week', () => {
  assert.equal(linkPreviewTtlMs('ok'), LINK_PREVIEW_TTL_MS);
  assert.equal(linkPreviewTtlMs('empty'), LINK_PREVIEW_TTL_MS);
  // Short, so a host that was down for one minute is not un-previewable until
  // next Tuesday.
  assert.equal(linkPreviewTtlMs('failed'), LINK_PREVIEW_FAILURE_TTL_MS);
  assert.equal(linkPreviewTtlMs('blocked'), LINK_PREVIEW_FAILURE_TTL_MS);
  assert.ok(LINK_PREVIEW_FAILURE_TTL_MS < LINK_PREVIEW_TTL_MS);
});

// --- the image proxy's fetcher --------------------------------------------

test('the image fetcher takes the same SSRF gate, per hop', async () => {
  const fetchImpl = fakeFetch({
    'https://cdn.example.com/a.png': redirectResponse('http://169.254.169.254/latest/meta-data/'),
  });
  const result = await fetchPreviewImage('https://cdn.example.com/a.png', {
    lookup: fakeLookup({ 'cdn.example.com': ['93.184.216.34'] }), fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked_address');
  assert.equal(fetchImpl.calls.length, 1);

  const direct = await fetchPreviewImage('http://10.0.0.5/a.png', { lookup: fakeLookup({}), fetchImpl: fakeFetch({}) });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'blocked_address');
});

test('only raster image types are served, and SVG is not one of them', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
    const fetchImpl = fakeFetch({
      'https://cdn.example.com/a': { status: 200, headers: new Headers({ 'content-type': contentType }), body: bodyStream([bytes]) },
    });
    const result = await fetchPreviewImage('https://cdn.example.com/a', {
      lookup: fakeLookup({ 'cdn.example.com': ['93.184.216.34'] }), fetchImpl,
    });
    assert.equal(result.ok, true, `${contentType} should be served`);
    assert.equal(result.contentType, contentType);
    assert.equal(result.bytes.length, 8);
  }
  // An SVG is an image that runs script when navigated to directly. Not worth
  // the caveat for a thumbnail.
  for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf', '']) {
    const fetchImpl = fakeFetch({
      'https://cdn.example.com/a': { status: 200, headers: new Headers(contentType ? { 'content-type': contentType } : {}), body: bodyStream([bytes]) },
    });
    const result = await fetchPreviewImage('https://cdn.example.com/a', {
      lookup: fakeLookup({ 'cdn.example.com': ['93.184.216.34'] }), fetchImpl,
    });
    assert.equal(result.ok, false, `${contentType || '(none)'} should be refused`);
    assert.match(result.reason, /^content_type_/);
  }
});

test('an oversized image is refused rather than served half-drawn', async () => {
  const state = {};
  const chunks = Array.from({ length: 20 }, () => new Uint8Array(1024));
  const fetchImpl = fakeFetch({
    'https://cdn.example.com/a.png': { status: 200, headers: new Headers({ 'content-type': 'image/png' }), body: bodyStream(chunks, state) },
  });
  const result = await fetchPreviewImage('https://cdn.example.com/a.png', {
    lookup: fakeLookup({ 'cdn.example.com': ['93.184.216.34'] }), fetchImpl, maxBytes: 2048,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_large');
  assert.equal(state.cancelled, true);
  assert.equal(result.bytes.length, 0);
});

// --- extraction ------------------------------------------------------------

test('extractLinkUrls finds bare URLs in ordinary prose', () => {
  assert.deepEqual(
    extractLinkUrls('Crazy how good these models are https://x.com/runzhuotao/status/2080746699988115897?s=20'),
    ['https://x.com/runzhuotao/status/2080746699988115897?s=20'],
  );
  assert.deepEqual(extractLinkUrls('see http://example.com and https://example.org'), [
    'http://example.com/', 'https://example.org/',
  ]);
});

test('sentence punctuation is not part of the URL', () => {
  assert.deepEqual(extractLinkUrls('Look at https://example.com/post.'), ['https://example.com/post']);
  assert.deepEqual(extractLinkUrls('(see https://example.com/post)'), ['https://example.com/post']);
  assert.deepEqual(extractLinkUrls('"https://example.com/post",'), ['https://example.com/post']);
  assert.deepEqual(extractLinkUrls('https://example.com/post!?'), ['https://example.com/post']);
  assert.deepEqual(extractLinkUrls('(see https://example.com/post).'), ['https://example.com/post']);
});

test('a URL that contains its own parentheses keeps them', () => {
  // The obvious regex (excluding `)`) cuts this at `Sonic_(` and unfurls the
  // wrong page. Balanced pairs belong to the URL; a lone closer belongs to the
  // sentence around it.
  assert.deepEqual(
    extractLinkUrls('https://en.wikipedia.org/wiki/Sonic_(hedgehog)'),
    ['https://en.wikipedia.org/wiki/Sonic_(hedgehog)'],
  );
  assert.deepEqual(
    extractLinkUrls('(from https://en.wikipedia.org/wiki/Sonic_(hedgehog))'),
    ['https://en.wikipedia.org/wiki/Sonic_(hedgehog)'],
  );
  assert.deepEqual(
    extractLinkUrls('read https://en.wikipedia.org/wiki/Sonic_(hedgehog), then'),
    ['https://en.wikipedia.org/wiki/Sonic_(hedgehog)'],
  );
});

test('a URL inside code is being shown, not shared', () => {
  assert.deepEqual(extractLinkUrls('run `curl https://example.com/api`'), []);
  assert.deepEqual(extractLinkUrls('```\nfetch("https://example.com/api")\n```'), []);
  // An unterminated fence still swallows to the end — a half-typed code block is
  // the streaming case, and unfurling out of it mid-keystroke looks broken.
  assert.deepEqual(extractLinkUrls('```\nhttps://example.com/api'), []);
  assert.deepEqual(extractLinkUrls('before ```\nhttps://in-code.example.com\n``` https://after.example.com/x'), [
    'https://after.example.com/x',
  ]);
});

test('extraction dedupes and caps', () => {
  assert.deepEqual(extractLinkUrls('https://example.com/a https://example.com/a#frag'), ['https://example.com/a']);
  const many = 'https://a.example.com/1 https://b.example.com/2 https://c.example.com/3 https://d.example.com/4';
  assert.equal(extractLinkUrls(many).length, LINK_PREVIEW_MAX_PER_MESSAGE);
  assert.equal(extractLinkUrls(many, 3).length, 3);
  assert.deepEqual(extractLinkUrls(many, 0), []);
});

test('extraction refuses what the fetcher would refuse anyway', () => {
  assert.deepEqual(extractLinkUrls('ftp://example.com/x mailto:a@b.com file:///etc/passwd'), []);
  assert.deepEqual(extractLinkUrls('http://localhost:3000/admin http://169.254.169.254/'), []);
  assert.deepEqual(extractLinkUrls(''), []);
  assert.deepEqual(extractLinkUrls(null), []);
  assert.deepEqual(extractLinkUrls('no links here'), []);
});

test('a markdown link target is still a link', () => {
  assert.deepEqual(extractLinkUrls('[the thread](https://example.com/post)'), ['https://example.com/post']);
});
