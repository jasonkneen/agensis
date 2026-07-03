'use strict';

// Coverage for mergeSlashCommands — the pure merge behind /backend/system/slash-commands.
// It folds the slash commands/skills each connected daemon pushed (in its
// agent_connections.capabilities) into one deduped SlashItem[] for the composer's `/` menu.

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');
const { mergeSlashCommands } = __test;

test('loose commands become kind:command with a /name', () => {
  const items = mergeSlashCommands([{ commands: [{ name: 'debug', parent: null }] }]);
  assert.deepEqual(items, [
    { id: 'command:debug', name: 'debug', kind: 'command', run: 'insert', detail: 'Command' },
  ]);
});

test('namespaced commands become kind:skill-command with parent preserved', () => {
  const items = mergeSlashCommands([{ commands: [{ name: 'cascade-plan', parent: 'cascade' }] }]);
  assert.deepEqual(items, [
    {
      id: 'skill-command:cascade:cascade-plan',
      name: 'cascade-plan',
      kind: 'skill-command',
      parent: 'cascade',
      run: 'insert',
      detail: 'cascade',
    },
  ]);
});

test('skills become kind:skill', () => {
  const items = mergeSlashCommands([{ skills: ['agent-browser'] }]);
  assert.deepEqual(items, [
    { id: 'skill:agent-browser', name: 'agent-browser', kind: 'skill', run: 'insert', detail: 'Skill' },
  ]);
});

test('dedupes identical items across multiple connections', () => {
  const items = mergeSlashCommands([
    { commands: [{ name: 'debug', parent: null }] },
    { commands: [{ name: 'debug', parent: null }] },
  ]);
  assert.equal(items.length, 1);
});

test('tolerates missing/malformed capability blobs', () => {
  assert.deepEqual(mergeSlashCommands(null), []);
  assert.deepEqual(mergeSlashCommands([null, {}, { commands: 'nope' }, { skills: 42 }]), []);
  assert.deepEqual(mergeSlashCommands([{ commands: [{}, { name: '' }, { parent: 'x' }] }]), []);
});

test('merges commands and skills from several connections', () => {
  const items = mergeSlashCommands([
    { commands: [{ name: 'debug', parent: null }, { name: 'cascade-plan', parent: 'cascade' }] },
    { skills: ['improve', 'improve'] },
  ]);
  const ids = items.map(i => i.id).sort();
  assert.deepEqual(ids, ['command:debug', 'skill-command:cascade:cascade-plan', 'skill:improve']);
});
