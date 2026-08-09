// Versioned, pure routing contract shared by the voice worker and browser tests.

export const VOICE_TARGET_TOPIC = 'agensis.voice.target';
export const VOICE_TARGET_VERSION = 1;
export const VOICE_TARGET_TYPE = 'voice_target';
export const VOICE_TARGET_REQUEST_TYPE = 'voice_target_request';
export const INACTIVE_PARTICIPANT_IDENTITY = '__agensis_voice_inactive__';
export const MAX_TARGET_REVISION = 0x7fffffff;

const PACKET_KEYS = new Set(['type', 'version', 'huddleId', 'targetAgentId', 'revision']);
const REQUEST_KEYS = new Set(['type', 'version', 'huddleId']);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function text(value) {
  return typeof value === 'string' ? value : '';
}

export function encodeVoiceTarget(packet) {
  return new TextEncoder().encode(JSON.stringify(packet));
}

export function decodeVoiceTarget(data) {
  try {
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const packet = JSON.parse(raw);
    return packet && typeof packet === 'object' && !Array.isArray(packet) ? packet : null;
  } catch {
    return null;
  }
}

export function validateVoiceTarget(packet, { huddleId, rosterAgentIds = [] } = {}) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return { ok: false, reason: 'packet' };
  const keys = Object.keys(packet);
  if (keys.length !== PACKET_KEYS.size || keys.some((key) => !PACKET_KEYS.has(key))) {
    return { ok: false, reason: 'keys' };
  }
  if (packet.type !== VOICE_TARGET_TYPE || packet.version !== VOICE_TARGET_VERSION) return { ok: false, reason: 'version' };
  if (text(packet.huddleId) !== text(huddleId) || !ID_RE.test(packet.huddleId)) return { ok: false, reason: 'huddle' };
  if (!Number.isInteger(packet.revision) || packet.revision < 0 || packet.revision > MAX_TARGET_REVISION) {
    return { ok: false, reason: 'revision' };
  }
  if (packet.targetAgentId !== null && (!text(packet.targetAgentId) || !ID_RE.test(packet.targetAgentId))) {
    return { ok: false, reason: 'target' };
  }
  const roster = new Set((Array.isArray(rosterAgentIds) ? rosterAgentIds : []).map(String));
  if (packet.targetAgentId !== null && !roster.has(packet.targetAgentId)) return { ok: false, reason: 'unknown-target' };
  return { ok: true };
}

function participantKind(participant) {
  return participant?.kind ?? participant?.info?.kind ?? participant?.participantKind ?? '';
}

export function isAgentParticipant(participant) {
  if (!participant) return true;
  if (participant.isAgent === true) return true;
  if (participant.attributes?.['agensis.kind'] === 'agent') return true;
  const kind = participantKind(participant);
  // rtc-node exposes ParticipantKind.AGENT as protobuf enum value 4, while
  // older SDKs exposed the string. Treat every non-standard/unknown kind as
  // non-human; only the server-issued user:<uuid> identity below can opt back
  // into the human path. This prevents an enum number from being mistaken for
  // a controller when agent attributes have not propagated yet.
  if (kind === 4 || (typeof kind === 'string' && kind.toLowerCase() === 'agent')) return true;
  return !String(participant.identity || '').startsWith('user:');
}

export function acceptsTargetPacket({ packet, sender, huddleId, rosterAgentIds, controllerIdentity = '', currentRevision = -1 } = {}) {
  const checked = validateVoiceTarget(packet, { huddleId, rosterAgentIds });
  if (!checked.ok) return { accepted: false, ...checked };
  if (!sender?.identity || isAgentParticipant(sender)) return { accepted: false, reason: 'sender' };
  if (controllerIdentity && String(sender.identity) !== String(controllerIdentity)) return { accepted: false, reason: 'controller' };
  if (packet.revision <= currentRevision) return { accepted: false, reason: 'stale' };
  return { accepted: true, targetAgentId: packet.targetAgentId, revision: packet.revision };
}

export function makeVoiceTarget({ huddleId, targetAgentId = null, revision = 1 } = {}) {
  return { type: VOICE_TARGET_TYPE, version: VOICE_TARGET_VERSION, huddleId, targetAgentId, revision };
}

export function isTargetAgent({ targetAgentId, agentId } = {}) {
  return targetAgentId !== null && String(targetAgentId || '') === String(agentId || '');
}


export function encodeVoiceTargetRequest(huddleId) {
  return new TextEncoder().encode(JSON.stringify({
    type: VOICE_TARGET_REQUEST_TYPE, version: VOICE_TARGET_VERSION, huddleId,
  }));
}

export function isVoiceTargetRequest(packet, huddleId) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false;
  const keys = Object.keys(packet);
  return keys.length === REQUEST_KEYS.size
    && keys.every((key) => REQUEST_KEYS.has(key))
    && packet.type === VOICE_TARGET_REQUEST_TYPE
    && packet.version === VOICE_TARGET_VERSION
    && text(packet.huddleId) === text(huddleId)
    && ID_RE.test(packet.huddleId);
}
