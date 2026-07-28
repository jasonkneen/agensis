/**
 * A `BareTransport` that relays through OUR backend instead of wisp/epoxy.
 *
 * Scramjet's own transport stack (`wisp-js`, `epoxy-transport`, `epoxy-tls`) is
 * AGPL-3.0-only, which is a poor fit for hosted SaaS. But `BareTransport` is only
 * a four-method interface, and wisp is just one implementation of it — so this
 * replaces the lot and keeps the shipped stack MIT (scramjet + bare-mux).
 *
 * It also puts egress where the web build wants it: the browser talks only to our
 * own backend, and the backend is the only thing that dials the open internet
 * (server/browser-proxy.cjs, which is SSRF-guarded).
 *
 * bare-mux instantiates the DEFAULT EXPORT as a class, spreading the option array
 * from `setTransport(path, options)` as constructor arguments.
 *
 * Runs inside bare-mux's SharedWorker — no app state, no React, no imports.
 */

// Headers must be Latin-1. Percent-encoding keeps arbitrary UTF-8 inside that
// without the chunking that base64 would need for large header sets.
const packHeaders = (value) => encodeURIComponent(JSON.stringify(value ?? {}));
const unpackHeaders = (raw) => {
  if (!raw) return {};
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return {};
  }
};

// bare-mux hands headers as a plain object. epoxy 3.x assumed an iterable and
// broke on every request, so accept both rather than inherit that bug.
function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return { ...headers };
}

export default class AgensisRelayTransport {
  /**
   * @param {{ base: string, headers?: Record<string,string> }} options
   *   base    backend origin (apiBaseUrl())
   *   headers auth headers, captured when the panel mounted — see the note on
   *           token expiry in BrowserPanel.
   */
  constructor(options = {}) {
    this.base = String(options.base || '').replace(/\/+$/, '');
    this.authHeaders = options.headers || {};
    this.ready = false;
  }

  async init() {
    this.ready = true;
  }

  meta() {
    return {};
  }

  async request(remote, method, body, headers, signal) {
    // GET/HEAD must not carry a body, and a stream body would need duplex:'half'
    // plus HTTP/2 — buffer instead, which is fine at the sizes pages actually post.
    let payload = body ?? null;
    if (method === 'GET' || method === 'HEAD') payload = null;
    else if (payload instanceof ReadableStream) payload = await new Response(payload).arrayBuffer();

    const response = await fetch(`${this.base}/backend/browser/fetch`, {
      method: 'POST',
      headers: {
        ...this.authHeaders,
        'x-relay-url': encodeURIComponent(remote.href),
        'x-relay-method': method,
        'x-relay-headers': packHeaders(normalizeHeaders(headers)),
      },
      body: payload,
      signal,
    });

    const relayError = response.headers.get('x-relay-error');
    if (relayError) throw new Error(decodeURIComponent(relayError));

    return {
      body: await response.arrayBuffer(),
      headers: unpackHeaders(response.headers.get('x-relay-headers')),
      status: Number(response.headers.get('x-relay-status') || response.status),
      statusText: decodeURIComponent(response.headers.get('x-relay-statustext') || ''),
    };
  }

  /**
   * Not supported yet, and it fails LOUDLY rather than hanging.
   *
   * Proxying websockets means a second upgrade path on the Fly server, next to
   * the daemon socket at /backend/ws — the one piece of infrastructure in this
   * repo with a history of subtle liveness bugs. Deliberately out of scope for
   * the first cut: pages that use websockets for live updates lose those updates
   * and render fine otherwise. A transport that resolved and then never
   * delivered would look like a hung page instead.
   */
  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    queueMicrotask(() => {
      onerror('websockets are not proxied in the web browser panel yet');
      onclose(1011, 'websocket relay unavailable');
    });
    return [() => {}, () => {}];
  }
}
