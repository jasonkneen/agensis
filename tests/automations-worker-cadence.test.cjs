'use strict';

// ============================================================================
// tests/automations-worker-cadence.test.cjs
// ----------------------------------------------------------------------------
// The automation drain runs on its OWN 1s worker, and a faster tick did NOT
// become a bigger tick.
//
// That second half is the point of this file. Moving a drain from a 30s tick to
// a 1s tick is safe only while the per-tick bound stays put; raising the bound
// at the same time would multiply the work by 30 and quietly undo every reason
// the bound exists. So these assert the cadence AND that every safety constant
// is unchanged.
//
// The wiring lives at module scope inside startBackendServer, which cannot be
// invoked without binding a port, so the cadence assertions read the SOURCE.
// That is honest for wiring: the thing being pinned is which callback sits in
// which setInterval, and there is no runtime seam that exposes it. The
// behavioural half — that the drain is bounded at all — is covered by the real
// factory in tests/automations.test.cjs.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
 AUTOMATION_MAX_RUNS_PER_TICK,
 AUTOMATION_MAX_MATCHES_PER_EVENT,
 AUTOMATION_MAX_RUNS_PER_MINUTE,
 AUTOMATION_RUNAWAY_STRIKES,
 AUTOMATION_MAX_ATTEMPTS,
} = require('../server/automations.cjs');

const source = fs.readFileSync(path.resolve(__dirname, '../server/index.cjs'), 'utf8');

/**
 * The whole setInterval call whose callback mentions `needle`, including its
 * cadence argument.
 *
 * The end is found by the cadence pattern itself (`}, 1_000);`) rather than the
 * next `);`, because the callbacks contain nested calls — searching for the
 * first `);` truncates inside a .catch() and silently drops the cadence.
 */
function intervalAround(needle) {
 const at = source.indexOf(needle);
 assert.ok(at > 0, `${needle} is not wired anywhere`);
 const start = source.lastIndexOf('setInterval(', at);
 assert.ok(start > 0, `${needle} is not inside a setInterval`);
 const rest = source.slice(at);
 const cadence = /\}, (\d[\d_]*)\);/.exec(rest);
 assert.ok(cadence, `no cadence argument found after ${needle}`);
 return source.slice(start, at + cadence.index + cadence[0].length);
}

test('the automation drain runs on a 1 second worker', () => {
 // MUTATION: move runDueAutomations back onto the 30s jobReaper -> this fails.
 // "When X happens, do Y" arriving up to 30 seconds later reads as broken.
 const block = intervalAround('void runDueAutomations()');
 assert.match(block, /\}, 1_000\)/, 'the drain must be on a 1s interval');
 assert.equal(/30_000/.test(block), false, 'the drain must not be on the 30s tick');
});

test('the drain is a SIBLING of the flow delivery worker, not merged into it', () => {
 // A slow automation must not delay a webhook delivery, and vice versa.
 // MUTATION: call runDueAutomations inside flowDeliveryWorker -> this fails.
 const flowBlock = intervalAround('void deliverNextFlowWebhook()');
 assert.equal(/runDueAutomations/.test(flowBlock), false, 'the two workers must stay separate');
 assert.match(source, /const automationWorker = setInterval\(/);
});

test('the drain has its own in-flight guard, so ticks cannot stack', () => {
 // At 1s a drain that takes longer than its interval would otherwise overlap
 // itself and run the queue concurrently, defeating the per-tick bound.
 // MUTATION: drop the automationRunning boolean -> this fails.
 const block = intervalAround('void runDueAutomations()');
 assert.match(block, /if \(automationRunning\) return;/);
 assert.match(block, /automationRunning = true;/);
 assert.match(block, /\.finally\(\(\) => \{ automationRunning = false; \}\)/);
});

test('the sweep stays on the 30s tick', () => {
 // Reclaiming a lease that expired because a process died is housekeeping;
 // running it every second is 30x the query for no benefit.
 // MUTATION: move sweepAutomationRuns onto the 1s worker -> this fails.
 //
 // The needle is the guardedSweep call rather than the old bare
 // `void sweepAutomationRuns()`: the reaper's passengers each gained their own
 // in-flight guard (see the test below). What this pins is unchanged — which
 // tick the sweep sits on.
 const block = intervalAround("guardedSweep('sweepAutomationRuns'");
 assert.match(block, /\}, 30_000\)/);
 assert.equal(/runDueAutomations/.test(block), false, 'the drain must have left the reaper tick');
});

test('the reaper sweep has its own in-flight guard, so slow ticks cannot stack', () => {
 // The 30s tick carries the SLOW passengers — runDueThreadHarvests makes model
 // calls, runDueSchedules and sweepAutomationRuns are DB scans that grow with
 // the workspace — and it carried no guard at all, so a sweep that outlived its
 // interval simply started again on top of itself. The slower the database, the
 // more concurrent copies of the same scan it was asked to serve.
 // MUTATION: go back to bare `void sweepAutomationRuns()` -> this fails.
 const block = intervalAround("guardedSweep('sweepAutomationRuns'");
 assert.equal(/void sweepAutomationRuns\(\)/.test(block), false, 'the bare fire-and-forget call must be gone');
 // PER-SWEEP, not one boolean for the whole tick: a slow harvest must not stop
 // stuck jobs from being reaped.
 assert.match(source, /if \(sweepsInFlight\.has\(name\)\) return;/);
 assert.match(source, /sweepsInFlight\.add\(name\);/);
 assert.match(source, /\.finally\(\(\) => \{ sweepsInFlight\.delete\(name\); \}\)/);
});

test('the worker is cleared when the server closes', () => {
 // MUTATION: forget the clearInterval -> this fails, and the interval outlives
 // the server in every test that starts one.
 assert.match(source, /clearInterval\(automationWorker\)/);
 assert.match(source, /automationWorker\.unref\?\.\(\)/);
});

test('a FASTER tick did not become a BIGGER tick', () => {
 // THE assertion this file exists for. The interval got 30x shorter; the batch
 // must not have grown to compensate, or peak work per tick multiplies.
 // MUTATION: raise AUTOMATION_MAX_RUNS_PER_TICK alongside the cadence change
 // -> this fails.
 assert.equal(AUTOMATION_MAX_RUNS_PER_TICK, 20, 'the per-tick drain bound must not grow with the faster tick');
});

test('every other safety constant is unchanged', () => {
 // The cadence change must not have been a place to loosen anything else.
 // MUTATION: raise any of these -> this fails.
 assert.equal(AUTOMATION_MAX_MATCHES_PER_EVENT, 10, 'fan-out cap');
 assert.equal(AUTOMATION_MAX_RUNS_PER_MINUTE, 10, 'per-automation rate limit');
 assert.equal(AUTOMATION_RUNAWAY_STRIKES, 3, 'strikes before auto-disable');
 assert.equal(AUTOMATION_MAX_ATTEMPTS, 3, 'attempts before dead-letter');
});

test('the guards still live in the engine, not in the wiring', () => {
 // If a guard had been re-implemented at the call site to make the faster tick
 // work, it would be enforced in one lane and not the other.
 const engine = fs.readFileSync(path.resolve(__dirname, '../server/automations.cjs'), 'utf8');
 assert.match(engine, /for \(let i = 0; i < limit; i \+= 1\)/, 'the bounded drain loop');
 assert.match(engine, /and status = 'pending'/, 'the compare-and-set claim');
 assert.match(engine, /on conflict \(automation_id, event_id\) do nothing/, 'idempotent enqueue');
 assert.match(engine, /AUTOMATION_MAX_MATCHES_PER_EVENT\)/, 'the fan-out cap');
 assert.match(engine, /disableRunaway/, 'the runaway guard disables rather than throttles');
});
