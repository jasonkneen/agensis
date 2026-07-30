'use strict';

const crypto = require('node:crypto');

const FARM_SCOPES = Object.freeze([
  'workspace:read',
  'agents:read',
  'agents:enroll',
  'agents:dispatch',
  'models:read',
  'models:invoke',
]);

function codedError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function randomUserCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  const value = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `FARM-${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizeScopes(scopes) {
  const requested = Array.isArray(scopes) ? scopes : FARM_SCOPES;
  return FARM_SCOPES.filter((scope) => requested.includes(scope));
}

function createFarmIntegrationCore({
  store,
  now = Date.now,
  secret = randomSecret,
  userCode = randomUserCode,
  ttlMs = 10 * 60_000,
  deviceRetentionMs = 24 * 60 * 60_000,
  verificationUri = '/integrations/farm',
} = {}) {
  if (!store) throw new Error('A Farm integration store is required.');

  async function start({ name = 'Agent Farm' } = {}) {
    const createdAt = now();
    await store.pruneDevices?.(createdAt - deviceRetentionMs);
    const deviceCode = secret('agd');
    const record = {
      id: crypto.randomUUID(),
      deviceCodeHash: hashSecret(deviceCode),
      userCode: userCode(),
      name: String(name || 'Agent Farm').trim().slice(0, 120) || 'Agent Farm',
      status: 'pending',
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    await store.insertDevice(record);
    return {
      deviceCode,
      userCode: record.userCode,
      verificationUri,
      expiresIn: Math.ceil(ttlMs / 1000),
      interval: 5,
      status: 'pending',
    };
  }

  async function approve({ userCode: code, workspaceId, approvedBy, scopes } = {}) {
    const record = await store.findDeviceByUserCode(String(code || '').trim().toUpperCase());
    if (!record || record.status !== 'pending') throw codedError('invalid_request', 'Device request was not found.', 404);
    if (now() > record.expiresAt) throw codedError('expired_token', 'Device request expired.');
    if (!workspaceId || !approvedBy) throw codedError('invalid_request', 'workspaceId and approvedBy are required.');
    return store.updateDevice(record.id, {
      status: 'approved',
      workspaceId: String(workspaceId),
      approvedBy: String(approvedBy),
      scopes: normalizeScopes(scopes),
      approvedAt: now(),
    });
  }

  async function deny({ userCode: code, deniedBy } = {}) {
    const record = await store.findDeviceByUserCode(String(code || '').trim().toUpperCase());
    if (!record || record.status !== 'pending') throw codedError('invalid_request', 'Device request was not found.', 404);
    return store.updateDevice(record.id, { status: 'denied', deniedBy: String(deniedBy || ''), deniedAt: now() });
  }

  async function exchange(deviceCode) {
    const record = await store.findDeviceByHash(hashSecret(deviceCode));
    if (!record || record.status === 'consumed') throw codedError('expired_token', 'Device code is invalid or already used.', 401);
    if (now() > record.expiresAt) throw codedError('expired_token', 'Device request expired.', 401);
    if (record.status === 'pending') throw codedError('authorization_pending', 'Waiting for approval.', 428);
    if (record.status === 'denied') throw codedError('access_denied', 'Device request was denied.', 403);
    if (record.status !== 'approved') throw codedError('invalid_request', 'Device request cannot be exchanged.');
    const token = secret('agf');
    const integration = {
      id: crypto.randomUUID(),
      workspaceId: record.workspaceId,
      name: record.name,
      tokenHash: hashSecret(token),
      scopes: normalizeScopes(record.scopes),
      approvedBy: record.approvedBy,
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
    };
    if (typeof store.consumeApprovedDevice === 'function') {
      const consumed = await store.consumeApprovedDevice(record.id, integration, now());
      if (!consumed) throw codedError('expired_token', 'Device code is invalid or already used.', 401);
    } else {
      await store.insertIntegration(integration);
      await store.updateDevice(record.id, { status: 'consumed', consumedAt: now(), integrationId: integration.id });
    }
    return { token, integrationId: integration.id, workspaceId: integration.workspaceId, scopes: integration.scopes };
  }

  async function authenticate(token, requiredScope = null) {
    if (!String(token || '').startsWith('agf_')) throw codedError('invalid_token', 'Invalid Farm integration token.', 401);
    const integration = await store.findIntegrationByHash(hashSecret(token));
    if (!integration || integration.revokedAt) throw codedError('invalid_token', 'Invalid Farm integration token.', 401);
    if (requiredScope && !integration.scopes.includes(requiredScope)) {
      throw codedError('insufficient_scope', `Integration token lacks ${requiredScope}.`, 403);
    }
    await store.touchIntegration?.(integration.id, now());
    return integration;
  }

  async function revoke(integrationId) {
    return store.revokeIntegration(String(integrationId), now());
  }

  return { start, approve, deny, exchange, authenticate, revoke };
}

function createMemoryFarmIntegrationStore() {
  const devices = new Map();
  const integrations = new Map();
  return {
    async insertDevice(record) { devices.set(record.id, { ...record }); return record; },
    async pruneDevices(expiredBefore) {
      for (const [id, record] of devices) if (record.expiresAt < expiredBefore) devices.delete(id);
    },
    deviceCount() { return devices.size; },
    async findDeviceByHash(hash) { return [...devices.values()].find((record) => record.deviceCodeHash === hash) || null; },
    async findDeviceByUserCode(code) { return [...devices.values()].find((record) => record.userCode.toUpperCase() === code) || null; },
    async updateDevice(id, patch) { const next = { ...devices.get(id), ...patch }; devices.set(id, next); return next; },
    async insertIntegration(record) { integrations.set(record.id, { ...record }); return record; },
    async consumeApprovedDevice(id, integration, consumedAt) {
      const current = devices.get(id);
      if (!current || current.status !== 'approved') return null;
      devices.set(id, { ...current, status: 'consumed', consumedAt, integrationId: integration.id });
      integrations.set(integration.id, { ...integration });
      return integration;
    },
    async findIntegrationByHash(hash) { return [...integrations.values()].find((record) => record.tokenHash === hash) || null; },
    async revokeIntegration(id, revokedAt) { const next = { ...integrations.get(id), revokedAt }; integrations.set(id, next); return next; },
    async touchIntegration(id, lastSeenAt) { const next = { ...integrations.get(id), lastSeenAt }; integrations.set(id, next); return next; },
    async listIntegrations() { return [...integrations.values()]; },
  };
}

module.exports = {
  FARM_SCOPES,
  createFarmIntegrationCore,
  createMemoryFarmIntegrationStore,
  hashSecret,
  normalizeScopes,
};
