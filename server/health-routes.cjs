'use strict';

const express = require('express');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// /backend/health and the CSP violation report sink.
//
// Health is what fly.toml's check reads, and it deliberately reports MORE than
// "the process is up": if the runtime schema migration failed, every route
// behind the /backend gate is broken, so a 200 here would keep Fly routing
// traffic to a dead instance. The check only looks at the HTTP status, so the
// status has to carry that.
//
// The /backend runtime-schema gate itself is NOT here — it is app-level
// middleware in index.cjs guarding every route in the app, including ones this
// module never sees. It merely happened to sit next to this route.

function mountHealthRoutes(app, deps = {}) {
 const {
  jsonError, getDb, rateLimitBlocked, clientIpFromReq, cspReportRateLimiter,
  // A GETTER, not the value. runtimeSchemaError starts null and is assigned
  // later, from runtimeSchemaReady's .catch() — capturing it at mount time would
  // freeze it at null and this route would report a green light forever while
  // every other /backend route was broken. Same rule as getDb in coreDeps().
  getRuntimeSchemaError,
 } = deps;

 app.get('/backend/health', async (_req, res) => {
  try {
   await getDb().unsafe('select 1');
   // The DB answering is not enough: if the runtime schema migration failed every
   // route behind the gate below is broken, so a 200 here would keep Fly routing
   // traffic to a dead instance. fly.toml's check only looks at the HTTP status.
   const runtimeSchemaError = getRuntimeSchemaError();
   if (runtimeSchemaError) {
    return res.status(503).json({ ok: false, schema: 'failed', error: runtimeSchemaError.message || String(runtimeSchemaError) });
   }
   res.json({ ok: true });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // CSP violation sink. The Content-Security-Policy-Report-Only header on the
 // Netlify side is inert without somewhere to report TO — without this, "ship
 // report-only, watch the violations, then enforce" collects nothing and the
 // policy can never be safely promoted. Deliberately:
 //  - unauthenticated: the browser posts these with no credentials, by spec;
 //  - registered ABOVE the runtime-schema gate: it needs no DB, and a violation
 //    report is most interesting precisely when the rest of the API is broken;
 //  - rate limited per IP and body-capped, since it is an open endpoint;
 //  - always 204, so a misbehaving report can never surface to a user.
 app.post(
  '/backend/csp-report',
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  (req, res) => {
   if (rateLimitBlocked(res, cspReportRateLimiter, clientIpFromReq(req))) return;
   try {
    const body = req.body || {};
    // Level 2 sends {"csp-report": {...}}; the Reporting API sends an array.
    const reports = Array.isArray(body) ? body : [body['csp-report'] || body];
    for (const report of reports.slice(0, 10)) {
     if (!report || typeof report !== 'object') continue;
     const directive = report['effective-directive'] || report['violated-directive'] || report.effectiveDirective || '';
     const blocked = report['blocked-uri'] || report.blockedURL || '';
     const documentUri = report['document-uri'] || report.documentURL || '';
     console.warn('[csp] violation:', JSON.stringify({ directive, blocked, documentUri }));
    }
   } catch (error) {
    console.warn('[csp] malformed report:', error?.message || error);
   }
   res.status(204).end();
  },
 );

}

module.exports = { mountHealthRoutes };
