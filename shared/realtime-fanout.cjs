// Which tables ride the realtime fanout, and which deliberately do not.
//
// WHY THIS FILE EXISTS
//
// `notifyDbSubscribers(table, ...)` fans a row change to every socket subscribed
// to that table. A client subscribes with `{ type: 'db_changes', table }`, and
// `authorizeRealtimeBinding` -> `ensureTable` refuses any table not in
// `ALLOWED_TABLES` (shared/backend-core.cjs). So the two halves have to agree,
// and NOTHING made them agree: the server would happily broadcast a table no
// client could ever subscribe to, and the client's subscribe request would be
// refused with an `{type:'error'}` frame that `src/lib/backendClient.ts` drops
// on the floor. Silence on both ends.
//
// AGENTS.md carried the rule as prose — "if a column is workspace-scoped, also
// confirm the table is in the access allowlists" — and prose is exactly what
// failed. An audit of `main-next` found EIGHT tables broadcast but not
// subscribable, two of them with live client subscriptions that had never once
// worked. This file plus tests/realtime-fanout-allowlist.test.cjs turns that
// sentence into a check that fails the build.
//
// Those two — agent_schedules and gateway_configs — are FIXED and allowlisted
// now, so FANOUT_BROKEN is empty. The remaining six are exemptions on purpose and
// each one still carries its reason. Read the reason before changing a category:
// one of them is the vault.
//
// THE RULE
//
// Every table name passed to `notifyDbSubscribers` must be exactly one of:
//   - in ALLOWED_TABLES            — clients may subscribe; the normal case
//   - in FANOUT_EXEMPT below       — deliberately unsubscribable, with a reason
//   - in FANOUT_BROKEN below       — a known live defect, with the fix recorded
// A table in none of them fails the test. A table in two of them fails the test.
//
// WHY "EXEMPT" IS NOT THE SAME AS "SHOULD BE ALLOWLISTED"
//
// The tempting version of this check is "every broadcast table must be in
// ALLOWED_TABLES". That check is worse than useless here, because the fastest
// way to make it pass is to add the missing tables — and one of them is
// `workspace_secrets`, whose absence from ALLOWED_TABLES is a deliberate,
// documented layer of the vault's defence in depth (see the comment above
// REALTIME_HEAVY_FIELDS in server/realtime.cjs). A check that pressures the next
// maintainer into allowlisting the secrets table is a security regression
// wearing a green tick. Hence three categories, not two.

// Deliberately broadcast-but-not-subscribable. Each entry is a decision someone
// made on purpose; the reason is the point of the entry.
//
// The test asserts NOTHING IN `src/` SUBSCRIBES to these. If you add a
// subscription for one, the test fails and you have to move it out of this list
// on purpose — which is the whole mechanism.
const FANOUT_EXEMPT = {
 workspace_secrets:
  'Vault. Absence from ALLOWED_TABLES is the second of three layers (write-only '
  + 'routes, no subscription, sanitizeRealtimeRow strips the cipher columns) and '
  + 'is called out in the REALTIME_HEAVY_FIELDS comment in server/realtime.cjs. '
  + 'The vault routes broadcast { workspace_id, key }, never a row. Do not '
  + 'allowlist this table.',

 bridge_qr:
  'Not a table. A pseudo-name (server/channel-bridges.cjs) carrying a live '
  + 'WhatsApp/Signal linking QR, which is a credential with a lifetime of '
  + 'seconds: whoever scans it links a device to the operator messaging account. '
  + 'A generic /db/select on it would hit Postgres and error. It must never be '
  + 'allowlisted. If the QR ever needs to reach the dialog it belongs on a '
  + 'broadcast channel gated above `read` — authorizeRealtimeBroadcast currently '
  + 'hardcodes `read` for every prefix, so that needs a per-prefix role first.',

 channel_bridges:
  'All four fanout calls (server/bridge-admin-routes.cjs, '
  + 'server/channel-bridges.cjs) pass raw `returning *` rows, NOT the publicBridge '
  + 'projection the REST routes use. The `config` jsonb holds Slack/Telegram '
  + 'botToken, Slack signingSecret and OpenClaw authToken. sanitizeRealtimeRow now '
  + 'strips `config` structurally, but allowlisting this table still needs a role '
  + 'review first. Nothing subscribes today.',

 cursorbuddy_connection_keys:
  'Fanout already maps through publicCursorBuddyConnectionKey, so the payload is '
  + 'projected rather than raw — but nothing subscribes, so the table stays shut '
  + 'until something needs it.',

 workspace_invites:
  'Broadcast by server/members-invites-routes.cjs; nothing in src/ subscribes. '
  + 'Note workspace_join_links is already pre-emptively in REALTIME_HEAVY_FIELDS '
  + 'for the day someone copies this fanout across.',

 agent_schedule_runs:
  'Broadcast by server/index.cjs; nothing in src/ subscribes. The schedules UI '
  + 'reads runs over REST.',
};

// Known live defects: a client DOES subscribe, the table is NOT allowlisted, so
// the subscription is refused and that surface has never been live.
//
// This is not a parking bay. The test asserts every entry here really does have
// a subscriber in `src/` — an entry with no subscriber belongs in FANOUT_EXEMPT
// instead, and the test will say so.
//
// Fixing these is a security-surface change: adding a table to ALLOWED_TABLES
// also opens the generic /backend/db path to it on BOTH backends (Fly and
// netlify/functions/backend.mjs), so each needs a DB_TABLE_ACCESS entry in the
// same commit or it falls through to DEFAULT_TABLE_ACCESS (read/write).
//
// EMPTY IS THE GOAL STATE, NOT A DISABLED CHECK. Both original entries —
// agent_schedules (src/hooks/useSchedules.ts) and gateway_configs
// (src/hooks/useGateways.ts) — were fixed rather than reclassified: they are in
// ALLOWED_TABLES now, so fanoutTableStatus reports them 'allowlisted' and leaving
// them here would be a `conflict:allowlisted+broken` failure. What each fix
// actually required is pinned by tests, not by prose — see
// `the two subscriptions this file was written for are live` in
// tests/realtime-fanout-allowlist.test.cjs, which asserts the allowlist entry,
// the workspace scoping, the per-operation roles, the selectable-column
// projection and the fanout strip. Those assertions are the record; if you are
// tempted to move a table back in here, read them first.
const FANOUT_BROKEN = {};

// `notifyDbSubscribers` is also called with a VARIABLE table name by the generic
// /backend/db insert/update/delete routes in server/index.cjs. Those are safe by
// construction: the same routes run ensureTable(table) against ALLOWED_TABLES
// before they get near the fanout, so a non-allowlisted table cannot reach them.
//
// The count is pinned so a NEW dynamic call site — one that might not have that
// guard — fails the test instead of escaping the scan. If you add one, prove it
// is gated and then bump this number.
const DYNAMIC_FANOUT_SITE_COUNT = 3;

function fanoutTableStatus(table, isAllowlisted) {
 const categories = [];
 if (isAllowlisted) categories.push('allowlisted');
 if (Object.prototype.hasOwnProperty.call(FANOUT_EXEMPT, table)) categories.push('exempt');
 if (Object.prototype.hasOwnProperty.call(FANOUT_BROKEN, table)) categories.push('broken');
 if (categories.length === 0) return 'undeclared';
 if (categories.length > 1) return `conflict:${categories.join('+')}`;
 return categories[0];
}

module.exports = {
 FANOUT_EXEMPT,
 FANOUT_BROKEN,
 DYNAMIC_FANOUT_SITE_COUNT,
 fanoutTableStatus,
};
