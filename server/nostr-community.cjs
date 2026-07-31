'use strict';

// Nostr protocol adapter.
//
// Nostr communities are Nostr relays selected by URL. An invite code is an
// opaque credential for that exact host; it is never decoded or translated.
// This module owns the protocol details and deliberately exposes normalized
// communities, channels, members and messages to the rest of agensis.

const crypto = require('node:crypto');
const nostr = require('nostr-tools');

const NOSTR_MESSAGE_KINDS = Object.freeze([9, 40002, 40008, 45001, 45003]);
const NIP98_KIND = 27235;
const NIP42_AUTH_KIND = 22242;
const REQUEST_TIMEOUT_MS = 15_000;
const SMALL_RESPONSE_MAX_BYTES = 256 * 1024;
const QUERY_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const INBOUND_MESSAGE_MAX_BYTES = 8 * 1024;
const REMOTE_CHANNEL_NAME_MAX_CHARS = 200;
const REMOTE_DESCRIPTION_MAX_CHARS = 500;

function parseNostrInviteUrl(rawUrl) {
 let url;
 try { url = new URL(String(rawUrl || '').trim()); } catch { throw inputError('Nostr invite URL must be a valid absolute URL'); }
 if (url.protocol !== 'https:') throw inputError('Nostr invite URL must use HTTPS');
 if (url.username || url.password) throw inputError('Nostr invite URL must not embed credentials');
 if (url.search || url.hash) throw inputError('Nostr invite URL must not contain a query or fragment');

 const match = /^\/invite\/([^/]+)$/.exec(url.pathname);
 if (!match) throw inputError('Nostr invite URL must have the form https://host/invite/code');
 let code;
 try { code = decodeURIComponent(match[1]); } catch { throw inputError('Nostr invite code is malformed'); }
 if (!code || code.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(code)) throw inputError('Nostr invite code is malformed');

 const httpUrl = url.origin;
 const wsUrl = new URL(httpUrl);
 wsUrl.protocol = 'wss:';
 return {
  inviteUrl: `${httpUrl}/invite/${encodeURIComponent(code)}`,
  code,
  host: url.host,
  httpUrl,
  wsUrl: wsUrl.origin,
 };
}

function inputError(message, status = 400) {
 const error = new Error(message);
 error.status = status;
 return error;
}

function secretBytes(secretKeyHex) {
 const value = String(secretKeyHex || '').trim().toLowerCase();
 if (!/^[0-9a-f]{64}$/.test(value)) throw inputError('Nostr identity key is unavailable', 500);
 return Uint8Array.from(Buffer.from(value, 'hex'));
}

function sha256Hex(value) {
 return crypto.createHash('sha256').update(value).digest('hex');
}

function buildNip98Header({ method, url, body = null, secretKeyHex, now = () => Math.floor(Date.now() / 1000) }) {
 const tags = [
  ['u', String(url)],
  ['method', String(method).toUpperCase()],
  ['nonce', crypto.randomUUID()],
 ];
 if (body != null) tags.push(['payload', sha256Hex(Buffer.from(String(body)))]);
 const event = nostr.finalizeEvent({
  kind: NIP98_KIND,
  created_at: now(),
  tags,
  content: '',
 }, secretBytes(secretKeyHex));
 return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

function buildNip42AuthEvent({ challenge, relayUrl, secretKeyHex, now = () => Math.floor(Date.now() / 1000) }) {
 if (!challenge || String(challenge).length > 1024) throw inputError('Nostr relay sent an invalid authentication challenge', 502);
 return nostr.finalizeEvent({
  kind: NIP42_AUTH_KIND,
  created_at: now(),
  tags: [['relay', String(relayUrl)], ['challenge', String(challenge)]],
  content: '',
 }, secretBytes(secretKeyHex));
}

async function readResponseJson(response, label, maxBytes = SMALL_RESPONSE_MAX_BYTES) {
 const declared = Number(response?.headers?.get?.('content-length') || 0);
 if (declared > maxBytes) throw inputError(`${label}: response is too large`, 502);
 let raw = '';
 try {
  if (response?.body?.getReader) {
   const reader = response.body.getReader();
   const decoder = new TextDecoder();
   let received = 0;
   while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
     await reader.cancel().catch(() => {});
     throw inputError(`${label}: response is too large`, 502);
    }
    raw += decoder.decode(value, { stream: true });
   }
   raw += decoder.decode();
  } else if (typeof response?.text === 'function') {
   raw = await response.text();
   if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw inputError(`${label}: response is too large`, 502);
  }
 } catch (error) {
  if (error?.status) throw error;
  throw inputError(`${label}: could not read response`, 502);
 }
 let value;
 try {
  value = raw ? JSON.parse(raw) : await response.json();
 } catch {
  value = {};
 }
 if (!response.ok) {
  const detail = typeof value?.error === 'string'
   ? value.error
   : typeof value?.message === 'string'
    ? value.message
    : `HTTP ${response.status}`;
  const status = response.status >= 400 && response.status < 500 ? response.status : 502;
  throw inputError(`${label}: ${detail}`, status);
 }
 return value;
}

function normalizedPolicy(raw) {
 if (!raw || typeof raw !== 'object') return null;
 return {
  termsMarkdown: typeof raw.terms_markdown === 'string' ? raw.terms_markdown : '',
  privacyMarkdown: typeof raw.privacy_markdown === 'string' ? raw.privacy_markdown : '',
  ageAttestationRequired: raw.age_attestation_required === true,
  version: String(raw.version || ''),
 };
}

function createNostrProtocol({ fetchImpl = globalThis.fetch, assertSafeOutboundUrl = async url => url } = {}) {
 if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

 async function request(url, init, label, maxBytes = SMALL_RESPONSE_MAX_BYTES) {
  let response;
  try {
   response = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: init?.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
   });
  } catch (error) {
   throw inputError(`${label}: ${error?.message || error}`, 502);
  }
  return readResponseJson(response, label, maxBytes);
 }

 async function previewInvite(inviteUrl) {
  const parsed = parseNostrInviteUrl(inviteUrl);
  const normalizedOrigin = await assertSafeOutboundUrl(parsed.httpUrl, 'Nostr community URL');
  if (new URL(normalizedOrigin).origin !== parsed.httpUrl) throw inputError('Nostr community URL changed during validation');

  const relay = await request(parsed.httpUrl, {
   method: 'GET',
   headers: { Accept: 'application/nostr+json' },
  }, 'Could not read Nostr relay metadata');
  const supportedNips = Array.isArray(relay?.supported_nips)
   ? relay.supported_nips.map(Number).filter(Number.isFinite)
   : [];
  for (const required of [29, 42]) {
   if (!supportedNips.includes(required)) throw inputError(`Nostr relay does not advertise required NIP-${required} support`);
  }
  const relayPubkey = /^[0-9a-f]{64}$/i.test(String(relay?.self || ''))
   ? String(relay.self).toLowerCase()
   : '';
  if (!relayPubkey) throw inputError('Nostr relay does not publish its NIP-29 signing identity');

  let policy = null;
  try {
   const policyResponse = await request(`${parsed.httpUrl}/api/join-policy`, { method: 'GET' }, 'Could not read Nostr join policy');
   policy = normalizedPolicy(policyResponse?.policy);
  } catch (error) {
   if (error?.status !== 404) throw error;
  }
  return {
   ...parsed,
   name: normalizeRemoteText(relay?.name, REMOTE_CHANNEL_NAME_MAX_CHARS, parsed.host),
   description: normalizeRemoteText(relay?.description, REMOTE_DESCRIPTION_MAX_CHARS),
   relayPubkey,
   supportedNips,
   policy,
  };
 }

 async function signedPost(url, bodyValue, secretKeyHex, label) {
  const guarded = await assertSafeOutboundUrl(url, 'Nostr relay URL');
  const requested = new URL(url);
  const safe = new URL(guarded);
  if (safe.origin !== requested.origin || safe.pathname !== requested.pathname || safe.search !== requested.search) {
   throw inputError('Nostr relay URL changed during validation');
  }
  const body = JSON.stringify(bodyValue);
  return request(url, {
   method: 'POST',
   headers: {
    Authorization: buildNip98Header({ method: 'POST', url, body, secretKeyHex }),
    'Content-Type': 'application/json',
   },
   body,
  }, label, url.endsWith('/query') ? QUERY_RESPONSE_MAX_BYTES : SMALL_RESPONSE_MAX_BYTES);
 }

 async function claimInvite({
  inviteUrl, secretKeyHex, policyVersion = '', ageConfirmed = false,
  termsAccepted = false, privacyAccepted = false,
 }) {
  const preview = await previewInvite(inviteUrl);
  let policyReceipt = null;
  if (preview.policy) {
   if (!preview.policy.version || policyVersion !== preview.policy.version) throw inputError('Nostr join policy changed; review it again');
   if (preview.policy.ageAttestationRequired && ageConfirmed !== true) throw inputError('Confirm the Nostr community age requirement');
   if (preview.policy.termsMarkdown && termsAccepted !== true) throw inputError('Accept the Nostr community terms');
   if (preview.policy.privacyMarkdown && privacyAccepted !== true) throw inputError('Accept the Nostr community privacy policy');
   const accepted = await request(`${preview.httpUrl}/api/invites/accept-policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
     code: preview.code,
     policy_version: preview.policy.version,
     age_confirmed: ageConfirmed === true,
    }),
   }, 'Nostr policy acceptance failed');
   policyReceipt = String(accepted?.receipt || '');
   if (!policyReceipt) throw inputError('Nostr policy acceptance returned no receipt', 502);
  }

  const raw = await signedPost(`${preview.httpUrl}/api/invites/claim`, {
   code: preview.code,
   ...(policyReceipt ? { policy_receipt: policyReceipt } : {}),
  }, secretKeyHex, 'Nostr invite claim failed');
  if (raw?.status !== 'joined' && raw?.status !== 'already_member') throw inputError('Nostr invite claim returned an unknown result', 502);
  return {
   preview,
   status: raw.status,
   communityId: String(raw.community_id || ''),
   host: String(raw.host || preview.host),
   role: String(raw.role || 'member'),
  };
 }

 async function query({ httpUrl, secretKeyHex, filters }) {
  return signedPost(`${httpUrl}/query`, filters, secretKeyHex, 'Nostr query failed');
 }

 async function publish({ httpUrl, secretKeyHex, event }) {
  return signedPost(`${httpUrl}/events`, event, secretKeyHex, 'Nostr publish failed');
 }

 return { previewInvite, claimInvite, query, publish };
}

function tagValue(event, name) {
 const found = Array.isArray(event?.tags)
  ? event.tags.find(value => Array.isArray(value) && value[0] === name && typeof value[1] === 'string')
  : null;
 return found?.[1] || '';
}

function hasTag(event, name, expectedValue = null) {
 return Array.isArray(event?.tags) && event.tags.some(value => (
  Array.isArray(value)
  && value[0] === name
  && (expectedValue == null ? value.length === 1 : value[1] === expectedValue)
 ));
}

function normalizeRemoteText(value, maxChars, fallback = '') {
 const normalized = String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/[<>]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxChars);
 return normalized || fallback;
}

function truncateUtf8(value, maxBytes) {
 const text = String(value || '');
 if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
 const marker = '\n\n[... remote message truncated ...]';
 const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
 const codepoints = [...text];
 let low = 0;
 let high = codepoints.length;
 while (low < high) {
  const keep = Math.ceil((low + high) / 2);
  if (Buffer.byteLength(codepoints.slice(0, keep).join(''), 'utf8') <= budget) low = keep;
  else high = keep - 1;
 }
 return codepoints.slice(0, low).join('') + marker;
}

function extractNostrChannels(events) {
 const values = Array.isArray(events) ? events : [];
 const joined = new Set(values.filter(event => Number(event?.kind) === 39002).map(event => tagValue(event, 'd')).filter(Boolean));
 const latest = new Map();
 for (const event of values) {
  if (Number(event?.kind) !== 39000) continue;
  const id = tagValue(event, 'd');
  if (!id || Number(latest.get(id)?.created_at || 0) > Number(event.created_at || 0)) continue;
  latest.set(id, event);
 }
 return [...latest.entries()].map(([id, event]) => ({
   id,
   name: normalizeRemoteText(tagValue(event, 'name'), REMOTE_CHANNEL_NAME_MAX_CHARS, id),
   description: normalizeRemoteText(tagValue(event, 'about'), REMOTE_DESCRIPTION_MAX_CHARS),
   type: normalizeRemoteText(tagValue(event, 't'), 32, 'stream'),
   visibility: hasTag(event, 'private') ? 'private' : 'public',
   archived: hasTag(event, 'archived') || hasTag(event, 'archived', 'true'),
   joined: joined.has(id),
  }));
}

function slugHandle(value) {
 return String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^@+/, '')
  .replace(/[^a-z0-9_.-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64);
}

function extractNostrMembers(membershipEvent, profileEvents) {
 const roles = new Map();
 for (const value of Array.isArray(membershipEvent?.tags) ? membershipEvent.tags : []) {
  if (!Array.isArray(value) || value[0] !== 'p' || !/^[0-9a-f]{64}$/i.test(String(value[1] || ''))) continue;
  roles.set(String(value[1]).toLowerCase(), String(value[3] || value[2] || 'member').toLowerCase());
 }
 const pubkeys = new Set(roles.keys());
 const profiles = new Map();
 for (const event of Array.isArray(profileEvents) ? profileEvents : []) {
  const pubkey = String(event?.pubkey || '').toLowerCase();
  if (!pubkeys.has(pubkey) || Number(event?.kind) !== 0) continue;
  if (Number(profiles.get(pubkey)?.createdAt || 0) > Number(event.created_at || 0)) continue;
  let profile;
  try { profile = JSON.parse(String(event.content || '{}')); } catch { profile = {}; }
  const displayName = normalizeRemoteText(profile?.display_name || profile?.name, 200);
  const rawName = normalizeRemoteText(profile?.name || displayName, 200);
  const name = displayName || `${pubkey.slice(0, 8)}…`;
  const handle = slugHandle(rawName) || pubkey.slice(0, 12);
  const aliases = [...new Set([name, rawName, handle].map(value => String(value || '').trim()).filter(Boolean))];
  profiles.set(pubkey, {
   pubkey,
   name,
   handle,
   picture: typeof profile?.picture === 'string' ? profile.picture.slice(0, 2048) : '',
   isAgent: profile?.is_agent === true || roles.get(pubkey) === 'bot',
   aliases,
   createdAt: Number(event.created_at || 0),
  });
 }
 return [...pubkeys].map(pubkey => {
  const profile = profiles.get(pubkey);
  if (profile) {
   const { createdAt: _createdAt, ...member } = profile;
   return member;
  }
  return {
   pubkey,
   name: `${pubkey.slice(0, 8)}…`,
   handle: pubkey.slice(0, 12),
   picture: '',
   isAgent: roles.get(pubkey) === 'bot',
   aliases: [pubkey.slice(0, 12)],
  };
 });
}

function mentionPresent(content, alias) {
 const haystack = String(content || '').toLocaleLowerCase();
 const needle = `@${String(alias || '').trim().toLocaleLowerCase()}`;
 if (needle === '@') return false;
 let from = 0;
 while (from < haystack.length) {
  const index = haystack.indexOf(needle, from);
  if (index < 0) return false;
  const before = index === 0 ? '' : haystack[index - 1];
  const after = haystack[index + needle.length] || '';
  if ((!before || /\s|[([{,:;]/.test(before)) && (!after || /\s|[\])},.!?:;]/.test(after))) return true;
  from = index + needle.length;
 }
 return false;
}

function resolveNostrMentions(content, members) {
 const found = [];
 const seen = new Set();
 for (const member of Array.isArray(members) ? members : []) {
  const pubkey = String(member?.pubkey || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey) || seen.has(pubkey)) continue;
  const aliases = Array.isArray(member.aliases) ? member.aliases : [member.name, member.handle];
  if (!aliases.some(alias => mentionPresent(content, alias))) continue;
  seen.add(pubkey);
  found.push(pubkey);
 }
 return found;
}

function buildOutboundMessageEvent({
 secretKeyHex, channelId, content, authorName = '', members = [], parentEventId = null,
 channelType = 'stream',
 createdAt = Math.floor(Date.now() / 1000),
}) {
 const channel = String(channelId || '').trim();
 const body = String(content || '').trim();
 if (!channel) throw inputError('Nostr channel id is required');
 if (!body) throw inputError('Nostr message is empty');
 const tags = [['h', channel]];
 for (const pubkey of resolveNostrMentions(body, members)) tags.push(['p', pubkey]);
 if (/^[0-9a-f]{64}$/i.test(String(parentEventId || ''))) tags.push(['e', String(parentEventId).toLowerCase(), '', 'reply']);
 const who = String(authorName || '').trim();
 const isForum = String(channelType || '').toLowerCase() === 'forum';
 return nostr.finalizeEvent({
  kind: isForum ? (parentEventId ? 45003 : 45001) : 9,
  created_at: Number(createdAt) || Math.floor(Date.now() / 1000),
  tags,
  content: who ? `${who} via Agensis: ${body}` : body,
 }, secretBytes(secretKeyHex));
}

function mapInboundNostrEvent(event, mappedChannelIds) {
 if (!event || !NOSTR_MESSAGE_KINDS.includes(Number(event.kind))) return null;
 // nostr-tools memoizes verification on the object. Relay frames are untrusted,
 // so copy only the signed fields into a fresh object before verifying; a caller
 // must never be able to mutate a previously verified object and inherit its
 // cached result.
 const candidate = {
  id: String(event.id || ''),
  pubkey: String(event.pubkey || ''),
  created_at: Number(event.created_at),
  kind: Number(event.kind),
  tags: Array.isArray(event.tags) ? event.tags : [],
  content: String(event.content || ''),
  sig: String(event.sig || ''),
 };
 if (!nostr.verifyEvent(candidate)) return null;
 const channelId = tagValue(candidate, 'h');
 if (!channelId || !mappedChannelIds?.has(channelId)) return null;
 const content = truncateUtf8(candidate.content.trim(), INBOUND_MESSAGE_MAX_BYTES);
 if (!content) return null;
 const reply = candidate.tags.find(value => (
  Array.isArray(value) && value[0] === 'e' && /^[0-9a-f]{64}$/i.test(String(value[1] || '')) && value[3] === 'reply'
 )) || candidate.tags.find(value => (
  Array.isArray(value) && value[0] === 'e' && /^[0-9a-f]{64}$/i.test(String(value[1] || ''))
 ));
 return {
  channelId,
  eventId: candidate.id,
  pubkey: candidate.pubkey.toLowerCase(),
  content,
  parentEventId: reply ? String(reply[1]).toLowerCase() : null,
  createdAt: candidate.created_at || 0,
 };
}

function verifiedNostrEvents(events, { authors = null, kinds = null } = {}) {
 const authorSet = authors ? new Set([...authors].map(value => String(value).toLowerCase())) : null;
 const kindSet = kinds ? new Set([...kinds].map(Number)) : null;
 const verified = [];
 for (const event of Array.isArray(events) ? events : []) {
  const candidate = {
   id: String(event?.id || ''),
   pubkey: String(event?.pubkey || ''),
   created_at: Number(event?.created_at),
   kind: Number(event?.kind),
   tags: Array.isArray(event?.tags) ? event.tags : [],
   content: String(event?.content || ''),
   sig: String(event?.sig || ''),
  };
  if (authorSet && !authorSet.has(candidate.pubkey.toLowerCase())) continue;
  if (kindSet && !kindSet.has(candidate.kind)) continue;
  if (nostr.verifyEvent(candidate)) verified.push(candidate);
 }
 return verified;
}

module.exports = {
 NOSTR_MESSAGE_KINDS,
 NIP42_AUTH_KIND,
 REQUEST_TIMEOUT_MS,
 INBOUND_MESSAGE_MAX_BYTES,
 QUERY_RESPONSE_MAX_BYTES,
 SMALL_RESPONSE_MAX_BYTES,
 buildNip42AuthEvent,
 buildNip98Header,
 buildOutboundMessageEvent,
 createNostrProtocol,
 extractNostrChannels,
 extractNostrMembers,
 inputError,
 mapInboundNostrEvent,
 parseNostrInviteUrl,
 resolveNostrMentions,
 slugHandle,
 truncateUtf8,
 verifiedNostrEvents,
};
