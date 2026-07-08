'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

function makeDb({ roles = {}, owners = {}, authSecret = 'bootstrap-secret' } = {}) {
  const settingRows = { AUTH_SECRET: authSecret };
  return {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (
        n.startsWith('alter table') ||
        n.startsWith('create table') ||
        n.startsWith('create index') ||
        n.startsWith('do $$')
      ) {
        return [];
      }
      if (n.startsWith('select value from app_settings')) {
        const value = settingRows[params[0]];
        return value ? [{ value }] : [];
      }
      if (n.startsWith('select token_version from app_users')) {
        return [{ token_version: '1' }];
      }
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }
      if (n.startsWith('select role from workspace_members')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      // bootstrap workspace row
      if (n.includes('from workspaces w') && n.includes('where w.id = $1')) {
        return [{
          id: params[0],
          name: 'Bootstrap WS',
          description: '',
          local_path: '',
          project_kind: '',
          git_root: '',
          git_remote: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          role: owners[params[0]] === params[1] ? 'owner' : (roles[`${params[0]}:${params[1]}`] || 'viewer'),
        }];
      }
      if (n.includes('from workspace_agents')) {
        return [{
          id: 'agent-1',
          workspace_id: params[0],
          name: 'Coder',
          handle: 'coder',
          avatar: 'AI',
          openpet_avatar_id: '',
          accent_color: '',
          description: '',
          system_prompt: 'hi',
          soul: '',
          instructions: '',
          tools: '[]',
          skills: '[]',
          model: 'auto',
          run_mode: 'builtin',
          memory_dir: '',
          permission_mode: 'default',
          version: 1,
          enabled: true,
        }];
      }
      if (n.includes('from chat_sessions')) {
        return [{
          id: 'sess-1',
          workspace_id: params[0],
          title: 'General',
          kind: 'channel',
          parent_message_id: null,
          folder: '',
          archived_at: null,
          deleted_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }];
      }
      if (n.includes('from documents')) {
        return [{
          id: 'doc-1',
          workspace_id: params[0],
          title: 'Notes',
          folder: '',
          favorite: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }];
      }
      if (n.includes('from tasks')) {
        return [{
          id: 'task-1',
          workspace_id: params[0],
          title: 'Ship it',
          description: '',
          status: 'todo',
          priority: 'medium',
          due_date: null,
          assignee_id: null,
          parent_id: null,
          source_type: null,
          source_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }];
      }
      if (n.includes('from uploaded_files')) {
        return [{
          id: 'file-1',
          workspace_id: params[0],
          name: 'a.png',
          size: 12,
          type: 'image/png',
          content_sha256: 'abc',
          created_at: new Date().toISOString(),
        }];
      }
      if (n.includes('from agent_connections')) {
        return [{
          id: 'conn-1',
          workspace_id: params[0],
          agent_id: 'agent-1',
          name: 'mac',
          handle: 'mac',
          host: 'localhost',
          cwd: '/tmp',
          status: 'online',
          last_seen_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }];
      }
      if (n.includes('from memory_facts')) {
        return [{
          id: 'mem-1',
          workspace_id: params[0],
          category: 'general',
          content: 'fact',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }];
      }
      throw new Error(`Unexpected SQL in bootstrap test: ${sql}`);
    },
  };
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test.beforeEach(() => {
  __test.resetTestState();
});
test.afterEach(() => {
  __test.resetTestState();
});

test('GET /backend/workspaces/:id/bootstrap requires auth', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:user-editor': 'editor' } }));
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/workspaces/ws-1/bootstrap`);
    assert.equal(res.status, 401);
  });
});

test('GET /backend/workspaces/:id/bootstrap rejects non-members', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:user-editor': 'editor' } }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('stranger', '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/ws-1/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });
});

test('GET /backend/workspaces/:id/bootstrap returns snapshot keys for members', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:user-editor': 'editor' } }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-editor', '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/ws-1/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, null);
    assert.ok(body.data);
    assert.equal(body.data.workspace.id, 'ws-1');
    assert.equal(body.data.agents[0].handle, 'coder');
    assert.equal(body.data.sessions[0].id, 'sess-1');
    assert.equal(body.data.documents[0].title, 'Notes');
    assert.equal(body.data.tasks[0].title, 'Ship it');
    assert.equal(body.data.files[0].name, 'a.png');
    assert.equal(body.data.connections[0].id, 'conn-1');
    assert.equal(body.data.memoryFacts[0].content, 'fact');
    assert.ok(body.data.limits);
  });
});
