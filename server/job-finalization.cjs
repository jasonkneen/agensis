'use strict';

// A lost COMMIT reply is not proof of rollback. Read the exact job once; a
// terminal state reached by this transaction also proves its transcript wrote.
async function commitJobOutcome(db, expected, work) {
 let completed = false;
 let result;
 try {
  return await db.begin(async tx => {
   result = await work(tx);
   completed = true;
   return result;
  });
 } catch (cause) {
  let current;
  try {
   [current] = await db.unsafe('select * from agent_jobs where id = $1 limit 1', [expected.id]);
  } catch { /* outcome remains unknown; never infer rollback */ }
  if (completed && current?.status === expected.status
      && String(current[expected.field] ?? '') === String(expected.value ?? '')) return result;
  const error = new Error(`Agent job finalization failed for ${expected.id}`, { cause });
  error.code = 'agent_job_finalization_failed';
  error.jobId = expected.id;
  error.outcome = current ? 'not_committed' : 'unknown';
  throw error;
 }
}

module.exports = { commitJobOutcome };
