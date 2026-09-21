import test from 'node:test';
import assert from 'node:assert/strict';
import { forceDrainMessage } from '../../src/lib/forceDrainAgentQueue';

// Unit tests for forceDrainMessage — the only pure, decision-bearing
// function exported from src/lib/forceDrainAgentQueue.ts. The button is a
// thin shell, and the fetch wrapper is best tested as an integration with a
// real server, but THIS function decides what the operator sees after a
// drain, and there are five distinct branches the operator cares about.

test('a dispatched task reads as "Drained · dispatched task t-2"', () => {
 const out = forceDrainMessage({
  kind: 'all',
  dispatchedTask: true,
  dispatchedTaskId: 't-2',
  foundParkedChat: 0,
  drainReason: 'dispatched',
 });
 assert.equal(out, 'Drained · dispatched task t-2');
});

test('parked chat turns are reported with correct singular/plural', () => {
 const one = forceDrainMessage({
  kind: 'chat',
  dispatchedTask: false,
  dispatchedTaskId: null,
  foundParkedChat: 1,
  drainReason: 'dispatched',
 });
 assert.equal(one, 'Drained · 1 parked chat turn');
 const many = forceDrainMessage({
  kind: 'chat',
  dispatchedTask: false,
  dispatchedTaskId: null,
  foundParkedChat: 4,
  drainReason: 'dispatched',
 });
 assert.equal(many, 'Drained · 4 parked chat turns');
});

test('a drain that dispatched a task AND found parked chat reports both', () => {
 const out = forceDrainMessage({
  kind: 'all',
  dispatchedTask: true,
  dispatchedTaskId: 't-2',
  foundParkedChat: 3,
  drainReason: 'dispatched',
 });
 assert.equal(out, 'Drained · dispatched task t-2, 3 parked chat turns');
});

test('an empty queue reads as "Queue empty, nothing to drain"', () => {
 const out = forceDrainMessage({
  kind: 'all',
  dispatchedTask: false,
  dispatchedTaskId: null,
  foundParkedChat: 0,
  drainReason: 'empty',
 });
 assert.equal(out, 'Queue empty, nothing to drain');
});

test('a drain held off because the agent is mid-turn reads as "held off"', () => {
 const out = forceDrainMessage({
  kind: 'all',
  dispatchedTask: false,
  dispatchedTaskId: null,
  foundParkedChat: 0,
  drainReason: 'busy',
 });
 assert.equal(out, 'Agent is mid-turn, drain held off');
});

test('a drain that ran but had no work falls back to a generic line', () => {
 const out = forceDrainMessage({
  kind: 'all',
  dispatchedTask: false,
  dispatchedTaskId: null,
  foundParkedChat: 0,
  drainReason: 'no_eligible',
 });
 assert.equal(out, 'Drain ran · no work to dispatch');
});