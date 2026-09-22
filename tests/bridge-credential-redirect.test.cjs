'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slackAdapter, telegramAdapter, telegramSetWebhook } = require('../server/bridge-routes.cjs');

test('Slack and Telegram calls refuse redirects so a bot token cannot follow one', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), redirect: init && init.redirect });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 7 }, ts: '1.0' }),
    };
  };
  const bridge = { config: { botToken: '123:abc' }, external_id: '9' };

  await slackAdapter({ fetchImpl }).send({ ...bridge, config: { botToken: 'xoxb-test' }, external_id: 'C1' }, 'hi', {});
  await telegramAdapter({ fetchImpl }).send(bridge, 'hi', {});
  await telegramSetWebhook({ botToken: '123:abc', url: 'https://agensis.example/hook', secretToken: 's', fetchImpl });

  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.redirect, 'error', call.url);
  assert.equal(calls.some((call) => call.url.includes('123:abc')), true);
});
