export const VOICE_TARGET_TOPIC = 'agensis.voice.target';
export const VOICE_TARGET_VERSION = 1;
export const VOICE_TARGET_REQUEST_TYPE = 'voice_target_request';
export const MAX_TARGET_REVISION = 0x7fffffff;

const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function assertTargetHuddleId(value: string): string {
  if (typeof value !== 'string' || !TARGET_ID_RE.test(value)) throw new RangeError('huddleId is invalid');
  return value;
}

function assertTargetRevision(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TARGET_REVISION) {
    throw new RangeError('voice target revision is invalid');
  }
  return value;
}
export type VoiceTargetRequest = {
  type: 'voice_target_request';
  version: 1;
  huddleId: string;
};

export type VoiceTargetPacket = {
  type: 'voice_target';
  version: 1;
  huddleId: string;
  targetAgentId: string | null;
  revision: number;
};

export function makeVoiceTarget({
  huddleId, targetAgentId = null, revision,
}: { huddleId: string; targetAgentId?: string | null; revision: number }): VoiceTargetPacket {
  assertTargetHuddleId(huddleId);
  assertTargetRevision(revision);
  if (targetAgentId !== null && (typeof targetAgentId !== 'string' || !TARGET_ID_RE.test(targetAgentId))) throw new RangeError('targetAgentId is invalid');
  return { type: 'voice_target', version: VOICE_TARGET_VERSION, huddleId, targetAgentId, revision };
}

export function makeVoiceTargetRequest(huddleId: string): VoiceTargetRequest {
  assertTargetHuddleId(huddleId);
  return { type: VOICE_TARGET_REQUEST_TYPE, version: VOICE_TARGET_VERSION, huddleId };
}

export function decodeVoiceTargetRequest(data: Uint8Array | string, huddleId: string): VoiceTargetRequest | null {
  try {
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const packet = JSON.parse(raw);
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
    const keys = Object.keys(packet);
    if (keys.length !== 3 || keys.some((key) => !['type', 'version', 'huddleId'].includes(key))) return null;
    if (packet.type !== VOICE_TARGET_REQUEST_TYPE || packet.version !== VOICE_TARGET_VERSION
      || packet.huddleId !== huddleId || !TARGET_ID_RE.test(packet.huddleId)) return null;
    return packet as VoiceTargetRequest;
  } catch {
    return null;
  }
}

export function decodeVoiceTarget(
  data: Uint8Array | string,
  huddleId: string,
  rosterAgentIds: string[],
  options: { allowUnknownTarget?: boolean } = {},
): VoiceTargetPacket | null {
  try {
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const packet = JSON.parse(raw);
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
    const keys = Object.keys(packet);
    if (keys.length !== 5 || keys.some((key) => !['type', 'version', 'huddleId', 'targetAgentId', 'revision'].includes(key))) return null;
    if (packet.type !== 'voice_target' || packet.version !== VOICE_TARGET_VERSION
      || packet.huddleId !== huddleId || !TARGET_ID_RE.test(packet.huddleId)) return null;
    if (!Number.isInteger(packet.revision) || packet.revision < 0 || packet.revision > MAX_TARGET_REVISION
      || packet.targetAgentId !== null && (typeof packet.targetAgentId !== 'string' || !TARGET_ID_RE.test(packet.targetAgentId))
      || packet.targetAgentId !== null && !options.allowUnknownTarget && !rosterAgentIds.includes(packet.targetAgentId)) return null;
    return packet as VoiceTargetPacket;
  } catch {
    return null;
  }
}
