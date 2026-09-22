'use strict';
const { randomUUID } = require('node:crypto');

function createCadenceWakes({ getDb, continueConversation }) {
 const cadenceWakes = new Map();
 const cadenceWrites = new Map();
 const query = (sql, args) => getDb().unsafe(sql, args);
 const leaseMs = 60_000;
 async function dispatch(row) {
  const token = row.claim_token;
  let renewing = false;
  const renewal = setInterval(() => {
   if (renewing) return;
   renewing = true;
   void query(`update pending_cadence_wakes set lease_until = now() + interval '60 seconds'
    where lock_key = $1 and claim_token = $2`, [row.lock_key, token])
    .catch(error => console.error('Cadence lease renewal failed', error))
    .finally(() => { renewing = false; });
  }, leaseMs / 3);
  renewal.unref?.();
  try {
   const outcome = await continueConversation({ workspaceId: row.workspace_id, sessionId: row.session_id,
    targetAgentId: row.agent_id || null, threadParentId: row.thread_parent_id,
    dispatchWakeId: row.wake_id });
   if (outcome && !outcome.started && ['locked', 'agent_busy', 'refused'].includes(outcome.reason)) {
    throw new Error(`Dispatch deferred: ${outcome.reason}`);
   }
   await query('delete from pending_cadence_wakes where lock_key = $1 and claim_token = $2', [row.lock_key, token]);
  } catch (error) {
   await query(`update pending_cadence_wakes set claim_token = null, lease_until = null,
    next_fire_at = now() + interval '30 seconds', last_error = $3,
    failed_at = case when attempts >= 4 then now() else null end
    where lock_key = $1 and claim_token = $2`, [row.lock_key, token, String(error?.message || error).slice(0, 500)]);
   console.error('Cadence dispatch failed; wake retained', error);
  } finally { clearInterval(renewal); }
 }
 async function reapCadenceWakes({ now = Date.now(), maxBatch = 32, key = null } = {}) {
  const limit = Math.max(1, Math.min(128, Math.trunc(Number(maxBatch) || 32)));
  // Exhaustion after crashes is visible too, even if the catch never ran.
  await query(`update pending_cadence_wakes set failed_at = now(), last_error = coalesce(last_error, 'Dispatch lease expired')
   where attempts >= 4 and failed_at is null and lease_until <= now()`, []);
  const rows = await query(`with due as (
   select lock_key from pending_cadence_wakes
   where next_fire_at <= to_timestamp($1 / 1000.0) and failed_at is null and attempts < 4
    and (lease_until is null or lease_until <= now()) and ($3::text is null or lock_key = $3)
   order by next_fire_at, lock_key limit $2 for update skip locked
  ) update pending_cadence_wakes wake set claim_token = gen_random_uuid(),
    lease_until = now() + interval '60 seconds', attempts = attempts + 1
   from due where wake.lock_key = due.lock_key returning wake.*`, [now, limit, key]);
  await Promise.all(rows.map(async row => {
   const timer = cadenceWakes.get(row.lock_key);
   if (timer) clearTimeout(timer);
   cadenceWakes.delete(row.lock_key);
   cadenceWrites.delete(row.lock_key);
   await dispatch(row);
  }));
  return rows.length;
 }
 function scheduleCadenceWake(key, delayMs, target) {
  if (cadenceWakes.has(key)) return false;
  const delay = Math.max(0, Math.min(2_147_483_647, Number(delayMs) || 0));
  const wakeId = randomUUID();
  const persisted = Promise.resolve().then(() => query(`insert into pending_cadence_wakes
   (lock_key, workspace_id, session_id, agent_id, thread_parent_id, next_fire_at, wake_id)
   values ($1,$2,$3,$4,$5,$6,$7)
   on conflict (lock_key) do update set next_fire_at = excluded.next_fire_at,
    wake_id = excluded.wake_id, claim_token = null, lease_until = null, attempts = 0,
    failed_at = null, last_error = null
   where pending_cadence_wakes.claim_token is not null`,
   [key, target.workspaceId, target.sessionId, target.targetAgentId || null, target.threadParentId || null,
    new Date(Date.now() + delay).toISOString(), wakeId]));
  cadenceWrites.set(key, persisted);
  void persisted.catch(error => console.error('Cadence persistence failed; local timer will retry', error));
  const timer = setTimeout(() => {
   void (async () => {
    try {
     await persisted;
     if (cadenceWakes.get(key) !== timer) return;
     await reapCadenceWakes({ key, maxBatch: 1 });
    } catch (error) {
     console.error('Cadence wake failed', error);
     if (cadenceWakes.get(key) === timer) {
      cadenceWakes.delete(key);
      scheduleCadenceWake(key, 30_000, target);
     }
    } finally {
     if (cadenceWakes.get(key) === timer) { cadenceWakes.delete(key); cadenceWrites.delete(key); }
    }
   })();
  }, delay);
  timer.unref?.();
  cadenceWakes.set(key, timer);
  return true;
 }
 function clearCadenceWakes() {
  for (const [key, timer] of cadenceWakes) {
   clearTimeout(timer);
   void Promise.resolve(cadenceWrites.get(key)).then(() => {
    if (!cadenceWakes.has(key)) return query('delete from pending_cadence_wakes where lock_key = $1', [key]);
   }).catch(error => console.error('Cadence cancellation failed', error));
  }
  cadenceWakes.clear(); cadenceWrites.clear();
 }
 return { cadenceWakes, scheduleCadenceWake, clearCadenceWakes, reapCadenceWakes,
  awaitCadenceWake: key => cadenceWrites.get(key) || Promise.resolve() };
}
module.exports = { createCadenceWakes };
