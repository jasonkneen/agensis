'use strict';

// --- Outbound SSRF guard for operator-supplied URLs ------------------------
//
// Moved verbatim out of server/index.cjs (Wave 1 of the index.cjs reduction).
// A pure leaf: `net` and `dns`, nothing else.
//
// `base_url` is attacker-controlled in the sense that matters: any workspace
// member with the `manage` role can set it, and the server then fetches it from
// inside Fly's network with no egress restrictions. Unvalidated, that turns a
// normal product feature into a request forgery primitive against the cloud
// metadata endpoint (169.254.169.254), localhost admin ports, and anything else
// reachable from the machine — with the response body streamed back to the
// caller through the SSE relay.
//
// LIMITS — what this does NOT catch:
//   * DNS rebinding. We re-resolve immediately before the fetch, but Node's
//     global fetch gives no hook to pin the resolved address for the actual
//     connection, so a hostname whose TTL expires between our lookup and
//     undici's can still move. Closing that needs a custom dispatcher; the
//     remaining window is small and every direct-address attack is blocked.
//   * Open redirects at the upstream. We do not follow redirects to a private
//     address because we do not follow redirects at all (see `redirect: 'error'`
//     at the call site).
//   * Operator-supplied `headers`, which are still passed through verbatim.
//
// ONE PREDICATE. tests/sandbox-agent-wiring.test.cjs counts the declarations of
// the blocked-address predicate in THIS file and requires exactly one, and
// separately requires that callProviderOperation does not re-derive it — a
// second implementation is a second thing to get wrong, and this repo has
// already had an SSRF finding from an unvalidated base URL.
//
// (That test counts by regex over this file's source, so do not spell the
// declaration out again in a comment here — a mention would be counted as a
// second one. It is why this paragraph describes it instead of quoting it.)
//
// NOTE: server/link-preview.cjs still carries its own v4-only copy for its own
// redirect chain, and tests/link-preview.test.cjs asserts the two agree.
// Converging them is a behaviour change, not a move, so it is deliberately NOT
// part of this commit.

const dns = require('dns').promises;
const net = require('net');

const BLOCKED_IPV4_RANGES = [
 ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
 ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
 ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4ToInt(address) {
 return address.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

// Expand an IPv6 literal into its eight 16-bit groups, or null if it will not
// parse. `net.isIPv6` has already vetted the syntax, so this only has to fill in
// the `::` elision — which is the whole point: the string tests below used to be
// applied to the TEXT of an address, and text has more than one spelling.
function ipv6Groups(address) {
 const lower = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
 if (!net.isIPv6(lower) || lower.includes('.')) return null;
 const halves = lower.split('::');
 if (halves.length > 2) return null;
 const head = halves[0] ? halves[0].split(':') : [];
 const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
 const parts = halves.length === 2
  ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
  : head;
 if (parts.length !== 8) return null;
 const groups = parts.map((part) => Number.parseInt(part || '0', 16));
 return groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff) ? null : groups;
}

function isBlockedAddress(address) {
 if (net.isIPv4(address)) {
  const value = ipv4ToInt(address);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
   const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
   return (value & mask) === (ipv4ToInt(base) & mask);
  });
 }
 if (!net.isIPv6(address)) return true; // unparseable — refuse rather than guess
 const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
 // IPv4-mapped (::ffff:a.b.c.d) must be judged on the embedded v4 address.
 const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
 if (mapped) return isBlockedAddress(mapped[1]);
 // Everything below used to be a prefix test on the TEXT, which let two spellings
 // of a blocked address through: `::ffff:a9fe:a9fe` is 169.254.169.254 in hex form
 // and matched none of the string tests, and `0:0:0:0:0:0:0:1` is loopback spelled
 // out and is not the string '::1'. Both reached a fetch. Compare the NUMBERS.
 const groups = ipv6Groups(lower);
 if (!groups) return true;                                       // fail closed
 if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
  return isBlockedAddress(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
 }
 // ::/96 — unspecified, loopback, and the deprecated v4-compatible range. None of
 // them is ever a legitimate outbound destination.
 if (groups.slice(0, 6).every((g) => g === 0)) return true;
 if ((groups[0] & 0xfe00) === 0xfc00) return true;               // fc00::/7  unique-local
 if ((groups[0] & 0xffc0) === 0xfe80) return true;               // fe80::/10 link-local
 if ((groups[0] & 0xffc0) === 0xfec0) return true;               // fec0::/10 deprecated site-local
 if ((groups[0] & 0xff00) === 0xff00) return true;               // ff00::/8  multicast
 if (groups[0] === 0x0064 && groups[1] === 0xff9b) return true;   // 64:ff9b::/96 NAT64 — reaches v4 space
 if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;   // 2001:db8::/32 documentation
 return false;
}

// Throws a 400-shaped Error when the URL must not be fetched server-side.
// Returns the normalized origin+path with any trailing slashes removed.
async function assertSafeOutboundUrl(rawUrl, label = 'base_url') {
 const reject = (message) => {
  const error = new Error(`${label} ${message}`);
  error.status = 400;
  throw error;
 };
 let url;
 try { url = new URL(String(rawUrl || '').trim()); } catch { return reject('must be a valid absolute URL'); }
 if (url.protocol !== 'https:' && url.protocol !== 'http:') reject('must use http or https');
 // Preserved from the superseded assertSafeGatewayBaseUrl: plaintext http would
 // put the workspace's decrypted API key on the wire, and .local/.internal are
 // split-horizon names that can resolve differently on the server than here.
 if (url.protocol !== 'https:') reject('must use HTTPS');
 const lowerHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
 if (lowerHost.endsWith('.local') || lowerHost.endsWith('.internal')) reject('must use a public hostname');
 if (url.username || url.password) reject('must not embed credentials');

 const host = url.hostname.replace(/^\[|\]$/g, '');
 let addresses;
 if (net.isIP(host)) {
  addresses = [host];
 } else {
  try {
   addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(entry => entry.address);
  } catch {
   return reject('host could not be resolved');
  }
 }
 if (!addresses.length) reject('host could not be resolved');
 // ALL resolved addresses must be public — a host that returns one public and
 // one private address is a rebinding attempt, not a misconfiguration.
 if (addresses.some(isBlockedAddress)) reject('must not resolve to a private, loopback, link-local or reserved address');

 return url.toString().replace(/\/+$/, '');
}

module.exports = {
 BLOCKED_IPV4_RANGES,
 ipv4ToInt,
 ipv6Groups,
 isBlockedAddress,
 assertSafeOutboundUrl,
};
