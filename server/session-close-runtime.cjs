'use strict';

function rows(value) {
 return Array.isArray(value) ? value : [];
}

/**
 * Apply only the side effects whose durable compare-and-set rows were returned
 * by settleSessionClosure. This must run after commit: a daemon must never be
 * told "cancelled" for a transaction that later rolls back.
 */
async function applySessionClosureRuntimeEffects(effects, deps = {}) {
 const {
  notifyDbSubscribers,
  cancelBuiltinJob,
  sendToConnection,
  scheduleTaskQueueDrain,
  endHuddleRoom,
  onWarn = () => {},
 } = deps;
 for (const [name, value] of Object.entries({
  notifyDbSubscribers,
  cancelBuiltinJob,
  sendToConnection,
  scheduleTaskQueueDrain,
  endHuddleRoom,
 })) {
  if (typeof value !== 'function') {
   throw new TypeError(`applySessionClosureRuntimeEffects requires deps.${name}`);
  }
 }
 const sessions = rows(effects?.sessions);
 const jobs = rows(effects?.jobs);
 const schedules = rows(effects?.schedules);
 const permissionRequests = rows(effects?.permissionRequests);
 const huddles = rows(effects?.huddles);

 if (sessions.length > 0) notifyDbSubscribers('chat_sessions', 'UPDATE', sessions);
 if (jobs.length > 0) notifyDbSubscribers('agent_jobs', 'UPDATE', jobs);
 if (schedules.length > 0) notifyDbSubscribers('agent_schedules', 'UPDATE', schedules);
 if (permissionRequests.length > 0) {
  notifyDbSubscribers('agent_permission_requests', 'UPDATE', permissionRequests);
 }
 if (huddles.length > 0) notifyDbSubscribers('huddles', 'UPDATE', huddles);

 const drains = new Set();
 for (const job of jobs) {
  const jobId = String(job?.id || '');
  if (!jobId) continue;
  try {
   cancelBuiltinJob(jobId, 'Conversation deleted');
  } catch (error) {
   onWarn(`could not abort built-in job ${jobId}: ${error?.message || error}`);
  }
  if (job.connection_id) {
   try {
    const delivered = sendToConnection(String(job.connection_id), {
     type: 'agent_job_cancel',
     jobId,
     reason: 'Conversation deleted',
    });
    if (!delivered) onWarn(`daemon cancellation was not delivered for job ${jobId}`);
   } catch (error) {
    onWarn(`could not cancel daemon job ${jobId}: ${error?.message || error}`);
   }
  }
  if (job.workspace_id && job.agent_id) {
   drains.add(`${job.workspace_id}\u0000${job.agent_id}`);
  }
 }

 for (const request of permissionRequests) {
  if (!request?.connection_id || !request?.request_key) continue;
  try {
   const delivered = sendToConnection(String(request.connection_id), {
    type: 'agent_permission_abort',
    requestId: String(request.request_key),
    message: 'Conversation deleted.',
   });
   if (!delivered) {
    onWarn(`permission denial was not delivered for request ${request.id || ''}`);
   }
  } catch (error) {
   onWarn(`could not expire permission request ${request.id || ''}: ${error?.message || error}`);
  }
 }

 for (const key of drains) {
  const [workspaceId, agentId] = key.split('\u0000');
  try {
   scheduleTaskQueueDrain(workspaceId, agentId, 'conversation_deleted');
  } catch (error) {
   onWarn(`could not schedule task drain for ${agentId}: ${error?.message || error}`);
  }
 }

 await Promise.all(huddles.map(async (huddle) => {
  if (!huddle?.room_name) return;
  try {
   await endHuddleRoom(String(huddle.room_name));
  } catch (error) {
   onWarn(`could not delete LiveKit room ${huddle.room_name}: ${error?.message || error}`);
  }
 }));
}

module.exports = { applySessionClosureRuntimeEffects };
