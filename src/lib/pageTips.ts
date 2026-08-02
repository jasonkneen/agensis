// Per-surface tips for the panel in the sidebar footer — the same space the
// "Get started" checklist occupies, reused once there is no onboarding left.
//
// Three rules this module exists to keep in one place:
//
//   1. THE CHECKLIST OUTRANKS TIPS. A half-finished setup step must never be
//      covered by advice about the canvas. `resolveGetStartedSlot` is the only
//      place that decides which of the two the space shows.
//   2. WHICH SURFACE IS A MAPPING, NOT A LOOKUP. This app is a windowed
//      desktop, so "the current page" is the focused window — a notion the app
//      already computes (top non-minimized window by zIndex). This module maps
//      that window's TYPE to a surface and nothing more, so there is no second
//      copy of the focus rule to drift.
//   3. EVERY CLAIM IS TRUE OF THE CODE. A tip that describes a feature the app
//      does not have is worse than no tip. Each one below was written against
//      the implementation, and the surrounding comments say where.
//
// Deliberately free of React so the whole thing is unit-testable.

import type { FloatingWindowType } from '../types';

/**
 * A place the user can be. Mostly one per window type, with two exceptions:
 * `chat` splits into `channel` and `dm` (very different advice), and `canvas` is
 * the desktop itself — no window focused.
 */
export type TipSurface =
  | 'canvas'
  | 'channel'
  | 'dm'
  | 'document'
  | 'agents'
  | 'resources'
  | 'inbox'
  | 'tasks'
  | 'activity'
  | 'memory'
  | 'skills'
  | 'users'
  | 'schedules'
  | 'tenants';

/** A full-canvas overlay that is not a floating window, and so has no type. */
export type TipOverlay = 'tenants';

export interface PageTip {
  /** Stable across releases — it is the dismissal key. Never renumber these. */
  id: string;
  surface: TipSurface;
  /** One line, sentence case, no trailing period-free headline style. */
  title: string;
  /** Two sentences at most. Says what the surface is for, or one non-obvious thing. */
  body: string;
}

/** What the panel calls the surface, next to the word "Tip". */
export const TIP_SURFACE_LABEL: Record<TipSurface, string> = {
  canvas: 'Desktop',
  channel: 'Channels',
  dm: 'Direct messages',
  document: 'Documents',
  agents: 'Agents',
  resources: 'Resources',
  inbox: 'Inbox',
  tasks: 'Tasks',
  activity: 'Activity',
  memory: 'Memory',
  skills: 'Skills',
  users: 'Users',
  schedules: 'Schedules',
  tenants: 'Tenants',
};

/**
 * The tips themselves, in the order they are shown. Adding one is editing this
 * list — nothing else. Dismissing the visible tip reveals the next one on that
 * surface, so put the thing a first-time visitor most needs first.
 */
export const PAGE_TIPS: readonly PageTip[] = [
  // Canvas — no window focused. src/hooks/useWindows.ts owns the windows;
  // src/lib/windowGroups.ts the tiling; CanvasDropZone the uploads.
  {
    id: 'canvas-windows',
    surface: 'canvas',
    title: 'This is a desktop, not a page',
    body: 'Everything opens as a window on the canvas and several can be open at once. The one on top is the one the sidebar highlights, and the one this panel talks about.',
  },
  {
    id: 'canvas-tile',
    surface: 'canvas',
    title: 'Drag one window onto another to tile them',
    body: 'Tiled windows become a single composite window with one title bar, and minimising or closing it takes every pane with it. Ungroup windows, in that title bar, splits them again.',
  },
  {
    id: 'canvas-projects',
    surface: 'canvas',
    title: 'Each project keeps its own windows',
    body: 'Switching project in the rail on the left swaps the whole desktop. Whatever you left open in the other project is still open when you come back.',
  },
  {
    id: 'canvas-drop',
    surface: 'canvas',
    title: 'Drop files straight onto the canvas',
    body: 'A file dropped anywhere on the canvas is uploaded to the workspace. From then on you can attach it to any chat with the + button in the composer.',
  },

  // Channel. Threaded replies + broadcast: src/components/chat/channelView.ts.
  // Intent: src/components/chat/EditChannelDialog.tsx. Split/merge: App.tsx.
  {
    id: 'channel-mention',
    surface: 'channel',
    title: 'A channel is a room the agents are in too',
    body: 'Mention an agent with @ and it works in a thread under your message; only its final answer is posted back to the channel, so the room stays readable.',
  },
  {
    id: 'channel-intent',
    surface: 'channel',
    title: 'Tell the agents how to behave in here',
    body: "Edit channel, in the channel's menu, has an Intent field, and every agent reply in this channel is given it. Tone becomes a property of the room rather than the agent; it does not change what an agent is allowed to do.",
  },
  {
    id: 'channel-split',
    surface: 'channel',
    title: 'Split a thread when it becomes its own job',
    body: 'A split gets its own channel that remembers this one as its parent. Merge later hands both sides back to the parent agent to reconcile.',
  },
  {
    id: 'channel-huddle',
    surface: 'channel',
    title: 'Huddle when typing is the slow part',
    body: 'The huddle button opens a voice conversation with the agents in this channel, transcribed into the thread as you go. It changes how you talk to the agent, not how the agent thinks.',
  },

  // DM. One live job per (session, agent): the uq_agent_jobs_active_per_session_agent
  // index in server/index.cjs. Assign-dispatch: dispatchTaskAssignment ->
  // findOrCreateDirectSession. Widget rail: ThreadWidgetRail + MCP thread_items.
  {
    id: 'dm-one-turn',
    surface: 'dm',
    title: "A DM is one agent's own room",
    body: 'An agent runs one turn at a time in a conversation, so messaging again while it is working will not start a second run beside the first.',
  },
  {
    id: 'dm-task',
    surface: 'dm',
    title: 'Assigning a task to an agent starts it here',
    body: "Make an agent the assignee of a task and the work begins in that agent's DM, linked back to the task. Assigning to a person never runs anything.",
  },
  {
    id: 'dm-widgets',
    surface: 'dm',
    title: "The rail beside a thread is the agent's own list",
    body: 'To-dos, plan and blockers are written by the agent as it works, not by you. When it raises a blocker, your answer goes straight into the rail.',
  },

  // Document. Composer context: ComposerAddContent "Documents and canvas".
  // Selection-anchored comments + version history: DocWindowContent.tsx.
  // Applets: src/lib/canvasApps.ts + AppletDocWindowContent.tsx.
  {
    id: 'document-context',
    surface: 'document',
    title: 'Documents are the long-form half of the workspace',
    body: "To let an agent read one, use + in a chat composer and pick it under Documents and canvas. The document's text is sent with that turn.",
  },
  {
    id: 'document-comment-anchor',
    surface: 'document',
    title: 'Select text before opening comments',
    body: 'A comment started while text is selected is anchored to that passage rather than to the document as a whole, which is what makes it findable later.',
  },
  {
    id: 'document-history',
    surface: 'document',
    title: 'Edits are saved for you, and kept',
    body: 'Typing autosaves, and a version is snapshotted as you go. Version history, in the toolbar, is where you go back.',
  },
  {
    id: 'document-applet',
    surface: 'document',
    title: 'An applet is a document whose body is code',
    body: 'Applets live in their own folder and hold HTML instead of prose, which is why they open in a code editor. Add one to the canvas and it runs there as a live panel.',
  },

  // Agents. Run modes + host folders + webhook tab + voice: AgentsWindowContent.tsx.
  {
    id: 'agents-run-mode',
    surface: 'agents',
    title: 'How an agent runs is the choice that matters',
    body: 'Direct agents run on agensis with hosted model access. Relay agents run on a linked host — desktop ACP or the agensis CLI — so web and desktop both see them when that host is online. Connector agents are external MCP clients that answer as the agent.',
  },
  {
    id: 'agents-host-folders',
    surface: 'agents',
    title: 'A Relay agent only sees the folders you list',
    body: 'Host folders on a Relay agent are the directories the host opens when a turn starts. Nothing outside that list is visible to it.',
  },
  {
    id: 'agents-webhook',
    surface: 'agents',
    title: 'An agent can be woken by a webhook',
    body: "Connect gives an agent its own URL (a trigger, not a run mode). Add the provider's signing secret and a delivery that fails to verify is refused, while a retry of one already handled is ignored rather than run twice.",
  },
  {
    id: 'agents-voice',
    surface: 'agents',
    title: 'Give each agent a different voice',
    body: 'Voice is set per agent here. In a huddle with several agents sharing one voice, you cannot tell who is talking.',
  },

  // Resources. The steward is the only actor that touches the underlying
  // artifact; the window creates metadata and queued requests, never a backdoor.
  {
    id: 'resources-steward',
    surface: 'resources',
    title: 'Every shared resource has one gatekeeper',
    body: 'The steward is a resource-purpose agent. People and collaborator agents can request work, but only that steward reads or changes the underlying resource.',
  },
  {
    id: 'resources-operations',
    surface: 'resources',
    title: 'Apply is a request, not a direct write',
    body: 'Read, propose, apply and publish enter the same fenced queue. The operation history shows which version the steward worked against and whether it completed, refused or failed.',
  },

  // Inbox. Grouping + blocker rank: src/components/inbox/inboxModel.ts.
  // Bulk actions: InboxSelectionBar.tsx.
  {
    id: 'inbox-scope',
    surface: 'inbox',
    title: 'The inbox is only what is addressed to you',
    body: 'Mentions, replies to your comments, and blockers or errors raised by your agents. Everything else that happened in the workspace is in Activity.',
  },
  {
    id: 'inbox-grouping',
    surface: 'inbox',
    title: 'A burst of replies on one thread is one row',
    body: 'Rows are keyed to the conversation, so a message arriving while you read cannot move your place in the list. Blockers stay above everything else regardless of age.',
  },
  {
    id: 'inbox-bulk',
    surface: 'inbox',
    title: 'Select rows to clear them together',
    body: 'Selecting more than one row turns the header into actions for the whole selection, and only offers the ones that apply to what you picked.',
  },

  // Tasks. One assignee field for agents and people (assignee_id has no FK);
  // dispatch-on-assign in server/index.cjs. Views + hide-done are persisted
  // per workspace via viewPreferenceKey('tasks.view' | 'tasks.hide-done').
  {
    id: 'tasks-assignee',
    surface: 'tasks',
    title: 'One assignee field, agents and people alike',
    body: 'Picking an agent as the assignee starts the work in its DM. Picking a teammate simply tells them.',
  },
  {
    id: 'tasks-views',
    surface: 'tasks',
    title: 'Three views over the same tasks',
    body: 'List, kanban and a timeline. Which one you were last in, and whether done work is hidden, is remembered for this workspace.',
  },
  {
    id: 'tasks-depends',
    surface: 'tasks',
    title: 'A task can wait on other tasks',
    body: 'Open one and add any other task in the workspace as a dependency. The timeline is where the ordering becomes obvious.',
  },

  // Activity. Newest first (useActivity orders created_at desc); per-entry
  // comments via useActivityEventComments.
  {
    id: 'activity-scope',
    surface: 'activity',
    title: "Activity is the workspace's log, not your notifications",
    body: 'Documents, canvas, chats and members, newest first, whoever did it. What was aimed at you specifically is in the Inbox.',
  },
  {
    id: 'activity-comment',
    surface: 'activity',
    title: 'You can comment on an entry',
    body: 'Useful for marking something to come back to: the note stays attached to that event rather than to a chat you will have to find again.',
  },

  // Memory. Facts are sent as context on agent turns (useChat.buildContextStrings).
  // Agent files are a mirror of the host machine, per-file editable or read-only.
  {
    id: 'memory-facts',
    surface: 'memory',
    title: 'A fact here is given to the agents',
    body: 'Every fact in this list is sent as context with agent replies in this workspace. Keep them short, true and able to stand alone.',
  },
  {
    id: 'memory-agent-files',
    surface: 'memory',
    title: 'Agent files are a mirror, not the original',
    body: 'They are what a connected agent has written to its own memory on its machine, and each file says whether it is editable or read-only. You can comment on any of them.',
  },

  // Skills. Live daemon capabilities with the configured skills as fallback;
  // read-only, distinct from the composer's / menu. SkillsWindowContent.tsx.
  {
    id: 'skills-source',
    surface: 'skills',
    title: 'A census of what your agents can actually do',
    body: "The list comes from each connected agent's live capabilities, falling back to the skills you configured by hand. It is read-only on purpose.",
  },
  {
    id: 'skills-invoke',
    surface: 'skills',
    title: 'This is the browse view, not the invoke one',
    body: 'To use a skill in a conversation, type / in the composer and pick it there.',
  },

  // Users. WORKSPACE_ROLE_CAPABILITIES in shared/backend-core.cjs: run_agents
  // is owner/admin/editor only. Invite role is fixed at link creation.
  {
    id: 'users-roles',
    surface: 'users',
    title: 'Roles decide who can run agents',
    body: 'Owner, admin and editor can. A commenter or viewer cannot, so an @mention from them will not wake an agent even in a channel they can write in.',
  },
  {
    id: 'users-invite-role',
    surface: 'users',
    title: 'An invite link carries its role',
    body: 'The role is fixed when the link is created, not when it is used. Invite a viewer with a viewer link rather than demoting them afterwards.',
  },

  // Schedules. runDueSchedules in server/index.cjs posts a message authored
  // "Schedule", prefixed with @handle so mention-mode channels still dispatch.
  {
    id: 'schedules-shape',
    surface: 'schedules',
    title: 'One prompt, one agent, one channel, on a cadence',
    body: 'Each run is posted into the channel you choose as a message from Schedule, addressed to the agent. The run and its answer are both visible in the room, so this is not a silent cron job.',
  },
  {
    id: 'schedules-prompt',
    surface: 'schedules',
    title: 'Write the prompt as a standing instruction',
    body: 'The same text is sent on every run, so it should not depend on what happened in the last one.',
  },

  // Tenants. Owner-only overlay, enforced server-side per request
  // (AGENSIS_SYSTEM_OWNER_EMAIL in shared/backend-core.cjs).
  {
    id: 'tenants-scope',
    surface: 'tenants',
    title: "The deployment's account list",
    body: "Every account on this deployment and the workspaces it owns or was invited into. Read-only by design: nothing on this screen can change anyone's data.",
  },
  {
    id: 'tenants-owner',
    surface: 'tenants',
    title: 'You see this because the server names you',
    body: "Visibility comes from the deployment owner's email in the server's configuration, and is checked on the server for every request. Hiding the button is not the protection.",
  },
];

/** Every tip id, for the dismissal codec's closed option set. */
export const ALL_TIP_IDS: readonly string[] = PAGE_TIPS.map(tip => tip.id);

/**
 * Which surface the user is on.
 *
 * An overlay (Tenants) covers the canvas without being a floating window, so it
 * outranks the focused window. Otherwise the answer is the focused window's
 * type, and `null` — nothing open — means the canvas itself.
 *
 * `isDirectMessage` is only consulted for a chat window. It is the caller's job
 * to resolve it from the session, because this module does not know about
 * sessions.
 */
export function tipSurfaceFor(input: {
  overlay?: TipOverlay | null;
  focusedWindowType?: FloatingWindowType | null;
  isDirectMessage?: boolean;
}): TipSurface {
  if (input.overlay === 'tenants') return 'tenants';
  switch (input.focusedWindowType) {
    case 'chat':
      return input.isDirectMessage ? 'dm' : 'channel';
    case 'document':
      return 'document';
    case 'agents':
      return 'agents';
    case 'resources':
      return 'resources';
    // Tenants is a WINDOW now, not an overlay. Without this case its tips
    // silently stopped resolving when it stopped being passed as `overlay`.
    case 'tenants':
      return 'tenants';
    case 'inbox':
      return 'inbox';
    case 'tasks':
      return 'tasks';
    case 'activity':
      return 'activity';
    case 'memory':
      return 'memory';
    case 'skills':
      return 'skills';
    case 'users':
      return 'users';
    case 'schedules':
      return 'schedules';
    default:
      return 'canvas';
  }
}

/** The tips for one surface, in authored order. */
export function tipsForSurface(surface: TipSurface): PageTip[] {
  return PAGE_TIPS.filter(tip => tip.surface === surface);
}

/**
 * The tip to show on a surface: the first one the user has not dismissed.
 *
 * Deliberately not random and not rotating — dismissing the visible tip is what
 * advances the list, so the panel is never showing something the user has
 * already read and never changes under them while they read it. Returns null
 * once every tip for the surface has been dismissed, which is how the space
 * empties out for good.
 */
export function nextTipFor(surface: TipSurface, dismissedIds: Iterable<string>): PageTip | null {
  const dismissed = dismissedIds instanceof Set ? dismissedIds : new Set(dismissedIds);
  return tipsForSurface(surface).find(tip => !dismissed.has(tip.id)) ?? null;
}

/** What the shared sidebar-footer space should render. */
export type SlotContent =
  | { kind: 'owner-message' }
  | { kind: 'checklist' }
  | { kind: 'tip'; tip: PageTip }
  | { kind: 'none' };

/**
 * The priority rule for the one space these three things share.
 *
 * OWNER MESSAGE FIRST, then the checklist, then tips.
 *
 * That an operator broadcast outranks onboarding is the one ordering here worth
 * arguing about, so: the broadcast is targeted by BEHAVIOUR — "has no agents",
 * "never started a huddle", "no activity for 30 days" — which describes exactly
 * the accounts that still have an unfinished checklist. Rank it below the
 * checklist and the feature inverts: the message reaches everyone EXCEPT the
 * people it was segmented for. Nothing is lost by putting it first either: the
 * checklist does not expire, it is restored the moment the message is dismissed,
 * and dismissal is one click.
 *
 * Below that the old rule is unchanged. Onboarding outranks tips whenever there
 * is any of it left — a partially complete checklist is a user who started
 * setting up and stopped, and must not be buried. Tips take the space when the
 * checklist is complete, or when the user closed it: dismissing the checklist
 * says "stop tracking my setup", not "never tell me anything again".
 */
export function resolveGetStartedSlot(input: {
  /** An undismissed owner broadcast for the sidebar surface. */
  hasOwnerMessage?: boolean;
  /** Unfinished checklist steps. */
  onboardingRemaining: number;
  /** The user closed the checklist with the X. */
  checklistDismissed: boolean;
  surface: TipSurface;
  dismissedTipIds: Iterable<string>;
}): SlotContent {
  if (input.hasOwnerMessage) return { kind: 'owner-message' };
  if (!input.checklistDismissed && input.onboardingRemaining > 0) return { kind: 'checklist' };
  const tip = nextTipFor(input.surface, input.dismissedTipIds);
  return tip ? { kind: 'tip', tip } : { kind: 'none' };
}
