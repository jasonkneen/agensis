'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The OpenAI-compatible inference surface: /backend/inference/v1/models and
// /v1/chat/completions.
//
// This is the SHARED-MODEL relay, not the chat backend. Connected daemons
// advertise models they can serve in their capabilities; liveSharedModelRoutes
// resolves which of those are reachable right now, and the relay streams a
// completion back through the daemon that owns the model.
//
// Authorized by requireUserOrFarm, not requireAuth: a farm device token with
// the models:read / models:invoke scope is a legitimate caller here, and that
// is the whole point of the surface.

function mountInferenceRoutes(app, deps = {}) {
 const {
  requireUserOrFarm, jsonError, authorizeUserOrFarmWorkspace,
  bindInferenceAbort, createOpenAIInferenceStreamRelay, inferenceBroker,
  liveSharedModelRoutes, publicInferenceModel,
 } = deps;

 app.get('/backend/inference/v1/models', requireUserOrFarm('models:read'), async (req, res) => {
  try {
   const workspaceId = String(req.query.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await authorizeUserOrFarmWorkspace(req, workspaceId, 'read');
   const routes = await liveSharedModelRoutes(workspaceId);
   return res.json({ object: 'list', data: routes.map(publicInferenceModel) });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/inference/v1/chat/completions', requireUserOrFarm('models:invoke'), async (req, res) => {
  let completed = false;
  const controller = new AbortController();
  bindInferenceAbort(req, res, controller, () => completed);
  try {
   const { workspaceId, ...request } = req.body || {};
   if (!workspaceId || !request.model || !Array.isArray(request.messages)) {
    return jsonError(res, 400, new Error('workspaceId, model, and messages are required'));
   }
   await authorizeUserOrFarmWorkspace(req, workspaceId, 'run_agents');
   const routes = await liveSharedModelRoutes(workspaceId);
   const route = routes.find((candidate) => candidate.id === request.model);
   if (!route) return jsonError(res, 404, new Error(`Shared model '${request.model}' is not available`));

   if (request.stream === true) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
   }
   const streamRelay = request.stream === true ? createOpenAIInferenceStreamRelay(res, request.model) : null;
   const result = await inferenceBroker.request(route, request, {
    signal: controller.signal,
    onEvent(event) {
     streamRelay?.onEvent(event);
    },
   });
   completed = true;
   if (request.stream === true) {
    streamRelay.appendUsage(result);
    res.end('data: [DONE]\n\n');
    return;
   }
   return res.json({ ...(result.response || {}), model: request.model });
  } catch (error) {
   completed = true;
   const status = error.code === 'agent_offline' || error.code === 'capacity_exhausted' ? 503
    : error.code === 'timeout' ? 504
     : error.code === 'cancelled' ? 499
      : error.status || 500;
   if (res.headersSent) {
    try { res.write(`data: ${JSON.stringify({ error: { message: error.message, code: error.code || 'inference_failed' } })}\n\n`); } catch { /* client gone */ }
    return res.end('data: [DONE]\n\n');
   }
   return jsonError(res, status, error);
  }
 });
}

module.exports = { mountInferenceRoutes };
