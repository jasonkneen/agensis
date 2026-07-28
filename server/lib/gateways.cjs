'use strict';

// Inference gateways — the workspace-configured OpenAI-compatible endpoints a
// `gateway:<id>` model routes through.
//
// This is one function, in its own file, because it has TWO consumers that are
// now separate modules: server/workspaces-routes.cjs owns the CRUD for
// gateway_configs, and server/ai-chat-routes.cjs resolves a route per turn.
// While both lived in createApp() it was a nested helper; splitting them made it
// a shared one, and passing it from one route module through index.cjs into
// another would have made index.cjs a courier for something neither owns.
//
// A factory rather than a plain export: it needs getDb, the vault decryptor and
// the JSON parser, and those are injected everywhere else in this backend for
// the same reason — so the decryption path stays single-sourced.
//
// SERVER-ONLY. The returned object carries the DECRYPTED api key. It must never
// be handed to a response; the routes that read gateway rows for the browser use
// publicGatewayConfig, which reports only `has_key`.

function createGatewayResolver({ getDb, decryptVaultSecret, parseJsonObject }) {
 // Resolve a `gateway:<id>` model to its upstream call config (with the decrypted
 // key) for server-side inference. Returns null when the id is unknown to the
 // workspace. Server-only — the plaintext key never leaves this process.
 return async function resolveGatewayRoute(workspaceId, gatewayId) {
  const rows = await getDb().unsafe(
   'select * from gateway_configs where id = $1 and workspace_id = $2 limit 1',
   [String(gatewayId || ''), String(workspaceId || '')],
  );
  const row = rows[0];
  if (!row) return null;
  let apiKey = '';
  if (row.api_key_cipher) {
   try { apiKey = await decryptVaultSecret(row.api_key_cipher); } catch { apiKey = ''; }
  }
  return {
   id: row.id,
   name: row.name,
   baseUrl: String(row.base_url || '').replace(/\/+$/, ''),
   model: row.model,
   protocol: row.protocol || 'openai-chat',
   headers: parseJsonObject(row.headers),
   apiKey,
  };
 };
}

module.exports = { createGatewayResolver };
