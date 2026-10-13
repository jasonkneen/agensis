const test = require('node:test');
const assert = require('node:assert/strict');
const { optSharingArgs, readableProjectSql, mcpViewerUserId, TASK_STATUSES } = require('../server/mcp.cjs').__test;

const PERSON = { kind: 'user', userId: '0dde8e09-e91d-48b3-858d-1af95b6c1ea6', subject: '0dde8e09-e91d-48b3-858d-1af95b6c1ea6' };
const AGENT = { kind: 'agent', agentId: 'a1', name: 'Bot' };

test('task statuses are the six the schema allows', () => {
 assert.deepEqual(TASK_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
});

test('only a signed-in person can be a private project viewer', () => {
 assert.ok(mcpViewerUserId(PERSON));
 assert.equal(mcpViewerUserId(AGENT), null);
 assert.equal(mcpViewerUserId({ kind: 'workspace' }), null);
});

test('readableProjectSql binds the viewer and never interpolates it', () => {
 const params = ['w1'];
 const sql = readableProjectSql(PERSON, params, 'p');
 assert.deepEqual(params, ['w1', mcpViewerUserId(PERSON)]);
 assert.match(sql, /p\.visibility = 'workspace' or p\.created_by = \$2::uuid or \$2::uuid = any\(p\.member_ids\)/);
 assert.ok(!sql.includes(mcpViewerUserId(PERSON)));
});

test('an agent viewer is bound as null so private projects never match', () => {
 const params = [];
 readableProjectSql(AGENT, params);
 assert.deepEqual(params, [null]);
});

test('optSharingArgs changes nothing when sharing is not mentioned', () => {
 assert.deepEqual(optSharingArgs({ name: 'x' }, AGENT), { visibility: null, memberIds: null });
});

test('an agent cannot change project sharing', () => {
 assert.throws(() => optSharingArgs({ visibility: 'private' }, AGENT), /Only a person/);
 assert.throws(() => optSharingArgs({ member_ids: [] }, AGENT), /Only a person/);
});

test('a person can set visibility and members, validated', () => {
 assert.deepEqual(optSharingArgs({ visibility: 'private', member_ids: [' u1 ', 'u1', 'u2'] }, PERSON), { visibility: 'private', memberIds: ['u1', 'u2'] });
 assert.throws(() => optSharingArgs({ visibility: 'friends' }, PERSON), /visibility must be/);
 assert.throws(() => optSharingArgs({ member_ids: 'u1' }, PERSON), /array of user ids/);
});
