import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueue } from '../agent/agensis-cli/src/queue.mjs';

test('queue cancellation targets one job key without aborting another lane', async () => {
  const observed = [];
  const queue = createQueue({
    concurrency: 2,
    runJob: (job, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { observed.push(`cancel:${job.key}`); resolve(); }, { once: true });
      if (job.key === 'keep') setTimeout(() => { observed.push('done:keep'); resolve(); }, 10);
    }),
  });
  queue.enqueue({ key: 'cancel-me', lane: 'one' });
  queue.enqueue({ key: 'keep', lane: 'two' });
  await Promise.resolve();
  assert.equal(queue.cancel('cancel-me', 'server requested cancellation'), true);
  await queue.idle();
  assert.deepEqual(observed.sort(), ['cancel:cancel-me', 'done:keep']);
});

test('queue cancellation removes a queued job before it starts', async () => {
  const started = [];
  let release;
  const queue = createQueue({ runJob: (job) => new Promise((resolve) => { started.push(job.key); release = resolve; }) });
  queue.enqueue({ key: 'active' });
  await Promise.resolve();
  queue.enqueue({ key: 'queued' });
  assert.equal(queue.cancel('queued'), true);
  release();
  await queue.idle();
  assert.deepEqual(started, ['active']);
});

test('queue cancellation before the worker microtask prevents the job from starting', async () => {
  const started = [];
  const queue = createQueue({ runJob: (job) => { started.push(job.key); } });
  queue.enqueue({ key: 'cancel-before-start' });
  assert.equal(queue.cancel('cancel-before-start'), true);
  await queue.idle();
  assert.deepEqual(started, []);
});
