'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  toWsUrl,
  resolveHttpBackendBase,
  resolveDeclaredRuntime,
  mapHarnessToRuntime,
} = require('../electron/acp/agentBridge.cjs');

test('resolveHttpBackendBase rewrites Vite/Netlify loopback to the local Fly port', () => {
  assert.equal(resolveHttpBackendBase('http://127.0.0.1:5173'), 'http://127.0.0.1:3142');
  assert.equal(resolveHttpBackendBase('http://localhost:5173/'), 'http://127.0.0.1:3142');
  assert.equal(resolveHttpBackendBase('http://127.0.0.1:8888'), 'http://127.0.0.1:3142');
  assert.equal(resolveHttpBackendBase('http://127.0.0.1:3142'), 'http://127.0.0.1:3142');
  assert.equal(resolveHttpBackendBase('https://agensis-backend.fly.dev'), 'https://agensis-backend.fly.dev');
});

test('toWsUrl never points agent traffic at the Vite HMR port', () => {
  assert.equal(toWsUrl('http://127.0.0.1:5173'), 'ws://127.0.0.1:3142/backend/ws');
  assert.equal(toWsUrl('http://127.0.0.1:3142'), 'ws://127.0.0.1:3142/backend/ws');
  assert.equal(toWsUrl('https://agensis-backend.fly.dev'), 'wss://agensis-backend.fly.dev/backend/ws');
});

test('resolveDeclaredRuntime enforces agent pin vs harness', () => {
  assert.equal(resolveDeclaredRuntime('claude', 'claude'), 'claude');
  assert.equal(resolveDeclaredRuntime('codex', ''), 'codex');
  assert.equal(resolveDeclaredRuntime('grok', ''), '');
  assert.throws(() => resolveDeclaredRuntime('grok', 'claude'), /requires runtime "claude"/);
  assert.throws(() => resolveDeclaredRuntime('codex', 'claude'), /pinned to the claude runtime/);
});

test('mapHarnessToRuntime only maps classic executors', () => {
  assert.equal(mapHarnessToRuntime('claude'), 'claude');
  assert.equal(mapHarnessToRuntime('grok'), '');
  assert.equal(mapHarnessToRuntime('hermes'), '');
});
