// THE GATE: every main surface, seeded with data, must show that data and must
// NOT be showing its "nothing here" copy.
//
// Read tests/smoke/harness.ts for why this layer exists. In one line: on
// 2026-07-27 a workspace holding 8 agents rendered "you haven't created any
// agents yet" with a green typecheck, lint, vitest, node suite and build,
// because none of those render anything.
//
// Written with createElement rather than JSX so these stay .ts files, matching
// tests/unit/windowBodies.test.ts and the rest of the mounting tests.

import { afterEach, beforeEach, describe, it } from 'vitest';
import { createElement } from 'react';
import { assertPopulated, backend, mount, type Mounted } from './harness';
import {
  ACTIVITY_MARKERS,
  AGENT_MARKERS,
  CURRENT_USER_EMAIL,
  CURRENT_USER_ID,
  INBOX_MARKERS,
  MEMBER_MARKERS,
  MEMORY_MARKERS,
  MESSAGE_MARKERS,
  SKILL_MARKERS,
  TASK_MARKERS,
  TENANT_MARKERS,
  WORKSPACE_ID,
  asyncNoop,
  asyncNull,
  asyncTrue,
  noop,
  seedActivity,
  seedAgents,
  seedConnections,
  seedInboxItems,
  seedMemoryFiles,
  seedMembers,
  seedMessages,
  seedTaskMembers,
  seedTasks,
  seedTenants,
} from './fixtures';

import { AgentsWindowContent } from '../../src/components/windows/AgentsWindowContent';
import { TasksWindowContent } from '../../src/components/windows/TasksWindowContent';
import { SkillsWindowContent } from '../../src/components/windows/SkillsWindowContent';
import { ActivityWindowContent } from '../../src/components/windows/ActivityWindowContent';
import { UsersWindowContent } from '../../src/components/windows/UsersWindowContent';
import { ChatWindowContent } from '../../src/components/windows/ChatWindowContent';
import { InboxWindowContent } from '../../src/components/inbox/InboxWindowContent';
import { TenantsWindowContent } from '../../src/components/tenants/TenantsWindowContent';
import { AgentMemoryBrowser } from '../../src/components/memory/AgentMemoryBrowser';

let mounted: Mounted | null = null;

beforeEach(() => {
  localStorage.clear();
  backend.reset();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('smoke: every surface shows its data', () => {
  it('Agents lists every agent in the workspace', async () => {
    const agents = seedAgents();
    mounted = await mount(createElement(AgentsWindowContent, {
      agents,
      webhooks: [],
      connections: seedConnections(agents),
      workspaceId: WORKSPACE_ID,
      currentUserId: CURRENT_USER_ID,
      onCreateAgent: asyncTrue,
      onUpdateAgent: noop,
      onDeleteAgent: noop,
      onDisconnectAgent: asyncNull,
      onCreateWebhook: asyncNull,
      onUpdateWebhook: asyncNull,
      onConfigureWebhook: async () => ({ webhook: null, error: null }),
      onOpenConnections: noop,
    }));
    assertPopulated(mounted, {
      surface: 'Agents',
      seeded: AGENT_MARKERS,
      emptyStates: ['No agents yet', 'No agents match', "You haven't created any agents yet"],
    });
  });

  it('Tasks lists every task', async () => {
    mounted = await mount(createElement(TasksWindowContent, {
      tasks: seedTasks(),
      members: seedTaskMembers(),
      agents: seedAgents(),
      agentConnections: [],
      currentUserEmail: CURRENT_USER_EMAIL,
      workspaceId: WORKSPACE_ID,
      currentUserId: CURRENT_USER_ID,
      onCreateTask: noop,
      onUpdateTask: noop,
      onToggleStatus: noop,
      onDeleteTask: noop,
      onUpdateAgent: noop,
    }));
    assertPopulated(mounted, {
      surface: 'Tasks',
      seeded: TASK_MARKERS,
      emptyStates: ['No tasks here', 'No tasks to chart'],
    });
  });

  it('Skills lists every skill the connected agents carry', async () => {
    const agents = seedAgents();
    mounted = await mount(createElement(SkillsWindowContent, {
      agents,
      agentConnections: seedConnections(agents),
      systemCapabilities: null,
      workspaceId: WORKSPACE_ID,
    }));
    assertPopulated(mounted, {
      surface: 'Skills',
      seeded: SKILL_MARKERS,
      emptyStates: ['No skills yet', 'No skills or libraries match'],
    });
  });

  it('Activity lists every event', async () => {
    mounted = await mount(createElement(ActivityWindowContent, {
      events: seedActivity(),
      loading: false,
      workspaceId: WORKSPACE_ID,
      currentUserId: CURRENT_USER_ID,
    }));
    assertPopulated(mounted, {
      surface: 'Activity',
      seeded: ACTIVITY_MARKERS,
      emptyStates: ['No activity yet', 'Loading activity'],
    });
  });

  it('Members lists every member', async () => {
    mounted = await mount(createElement(UsersWindowContent, {
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Smoke',
      currentUserId: CURRENT_USER_ID,
      currentUserEmail: CURRENT_USER_EMAIL,
      inviteOrigin: 'https://smoke.test',
      members: seedMembers(),
      invites: [],
      onCreateInvite: asyncNull,
      onRevokeInvite: asyncNoop,
      onSetInviteDismissed: asyncNoop,
      onDismissSpentInvites: asyncNoop,
      onRemoveMember: asyncNoop,
      onChangeMemberRole: asyncNoop,
    }));
    assertPopulated(mounted, {
      surface: 'Members',
      seeded: MEMBER_MARKERS,
      emptyStates: ['No members yet'],
    });
  });

  it('Channel shows every message in the transcript', async () => {
    mounted = await mount(createElement(ChatWindowContent, {
      messages: seedMessages(),
      streaming: false,
      memoryFacts: [],
      documents: [],
      agents: seedAgents(),
      workspaceId: WORKSPACE_ID,
      channelTitle: 'smoke-channel',
      currentUserId: CURRENT_USER_ID,
      onSendMessage: noop,
    }));
    assertPopulated(mounted, {
      surface: 'Channel',
      seeded: MESSAGE_MARKERS,
      emptyStates: ['Channel is open', 'Direct message is open'],
    });
  });

  // The three below load their OWN data. They are mounted against the seeded
  // backend rather than given props, so the gate covers the whole path — hook,
  // request, parse, render — not just the last step.

  it('Inbox lists every inbox item', async () => {
    backend.routes.set('/inbox', { items: seedInboxItems(), unreadCount: 8 });
    mounted = await mount(createElement(InboxWindowContent, { workspaceId: WORKSPACE_ID }));
    assertPopulated(mounted, {
      surface: 'Inbox',
      seeded: INBOX_MARKERS,
      emptyStates: ['Inbox zero', 'Nothing unread', 'Nothing needs you'],
    });
  });

  it('Tenants lists every account', async () => {
    backend.routes.set('/backend/tenants', { accounts: seedTenants(), total: 8, truncated: false });
    mounted = await mount(createElement(TenantsWindowContent, {}));
    assertPopulated(mounted, {
      surface: 'Tenants',
      seeded: TENANT_MARKERS,
      emptyStates: ['No accounts yet', 'No matching accounts'],
    });
  });

  it('Memory lists every mirrored file', async () => {
    backend.tables.set('agent_memory_files', seedMemoryFiles());
    mounted = await mount(createElement(AgentMemoryBrowser, {
      workspaceId: WORKSPACE_ID,
      agents: seedAgents(),
      userId: CURRENT_USER_ID,
      userEmail: CURRENT_USER_EMAIL,
    }));
    assertPopulated(mounted, {
      surface: 'Memory',
      seeded: MEMORY_MARKERS,
      emptyStates: ['No agent file memory yet', 'No files for this agent'],
    });
  });
});
