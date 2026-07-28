// Type-only, so it erases at build time and cannot create a runtime cycle.
import type { AgentVoicePreference } from '../lib/agentVoice';
import type { ConversationMode } from '../lib/channelMentions';

export interface Workspace {
 id: string;
 name: string;
 description: string;
 icon: string;
 user_id?: string | null;
 auto_share?: boolean;
 local_path?: string;
 project_kind?: string;
 git_root?: string;
 git_remote?: string;
 background_opacity?: number | null;
 background_image?: string | null;
 /**
  * The System workspace: where in-app feedback reports land as ordinary tasks.
  * A flag, not a type — it has members, roles and invites like any other
  * workspace, and only one row may carry it (partial unique index
  * `uq_workspaces_system`). Included in the `/backend/workspaces` projection
  * (which lists its columns explicitly) so the workspace rail can group it
  * below a divider; also present on generic `select('*')` reads.
  */
 is_system?: boolean;
 /**
  * The group this workspace sits inside; `null` (or absent) means top level.
  *
  * Grouping is EMERGENT, not a new entity — a workspace with children renders
  * as a group, one without renders as a leaf. Children inherit AGENTS and
  * MEMBERS from their ancestors; CONTENT (channels, documents, tasks, memory)
  * belongs to exactly one workspace and is never visible from a sibling or a
  * parent.
  *
  * Foundation only: nothing creates a child yet, so this is `null` on every
  * row today. Present in the `/backend/workspaces` projection on BOTH backends.
  */
 parent_id?: string | null;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface Document {
 id: string;
 workspace_id: string;
 title: string;
 // NET-06: content is lazy-loaded. The documents LIST holds metadata only; a
 // doc's body is fetched on demand (editor open, search, applet render) via
 // useDocuments().fetchDocumentContent(id). Absent on list rows.
 content?: string;
 is_favorite: boolean;
 folder?: string | null;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface ChatSession {
 id: string;
 workspace_id: string;
 title: string;
 model: string;
 /** Canvas layer (project) this session belongs to. Null = unassigned, shown in every project. Mirrors canvas_objects.layer_id (client-generated id, no FK). */
 canvas_id?: string | null;
 folder?: string | null;
 /** What the channel is for, shown under its name. */
 description?: string | null;
 /** Icon KEY (see src/lib/channelProfile.ts), not a glyph. '' = the default hash. */
 icon?: string | null;
 /**
  * How people and AGENTS should behave in this channel, in the owner's words.
  * The server injects it into every agent turn here, so it sets their tone.
  */
 intent?: string | null;
 is_favorite?: boolean;
 participants?: ChannelParticipant[] | null;
 /**
  * How eagerly this channel answers a post that named nobody: 'auto' at once
  * (the default), 'social' unhurried (see src/lib/replyCadence.ts), 'mention'
  * not at all. Normalized by src/lib/channelMentions.ts.
  */
 conversation_mode?: ConversationMode | null;
 max_agent_turns?: number | null;
 auto_rounds?: number | null;
 archived_at?: string | null;
 parent_message_id?: string | null;
 /** Set on a fork created via "split" — points at the source session it was cloned from. */
 split_parent_id?: string | null;
 /** When the split happened; the divergence baseline for merging the two branches. */
 split_at?: string | null;
 /** Soft-delete marker. Sessions are never hard-deleted so the data stays usable. */
 deleted_at?: string | null;
 version?: number;
 created_at: string;
 updated_at: string;
}

export type ChannelParticipant = {
 id: string;
 name: string;
 kind: 'user' | 'agent';
 status?: string | null;
 handle?: string | null;
 user_id?: string | null;
 agent_id?: string | null;
 added_at?: string | null;
 direct?: boolean | null;
};

export interface Message {
 id: string;
 session_id: string;
 role: 'user' | 'assistant';
 content: string;
 thread_parent_id?: string | null;
 sender_kind?: string | null;
 sender_id?: string | null;
 sender_name?: string | null;
 pinned?: boolean;
 reactions?: Record<string, string[]>;
 deleted_at?: string | null;
 // '' or absent for a normal message, 'tool_step' for one agent tool call. Steps
 // render as compact chips instead of full message rows (components/chat/toolSteps.ts).
 // `content` keeps its human-readable fallback ("Bash · cd ~/repo && git log") so
 // rows written before these columns existed still read sensibly.
 // ...and 'huddle' for the single marker row a finished huddle leaves in the
 // channel it was called from ("You were in a huddle · 12:04 · Ada, Sam"). Its
 // `content` is a complete sentence, so a client that does not know the kind
 // still renders something true; huddle_id below is what makes it a link back
 // to the transcript.
 message_kind?: string | null;
 tool_name?: string | null;
 tool_detail?: string | null;
 /** Set only on a huddle marker row. Null/absent everywhere else. */
 huddle_id?: string | null;
 // "Send to channel": a thread reply that is ALSO shown in the channel/DM view.
 // An agent works inside a thread and flags only its final answer; a human can
 // flag a reply from the thread composer. The row KEEPS its thread_parent_id, so a
 // broadcast reply shows in BOTH views (see isChannelMessage in
 // components/chat/channelView.ts).
 broadcast_to_channel?: boolean | null;
 // Structured REFERENCES to uploaded_files rows, for rendering: images inline,
 // everything else as a download chip. Never file bytes — just the pointer plus
 // the metadata needed to draw a chip before the file is fetched.
 //
 // This does NOT replace the human-readable "[Linked files]" block that
 // buildFileContext folds into `content`: that text is how an AGENT learns a
 // file was attached, and it stays. See lib/messageAttachments.ts.
 //
 // The three fields after `id` are CLIENT-SUPPLIED and therefore untrusted —
 // parse every read through parseMessageAttachments rather than using the raw
 // jsonb.
 attachments?: MessageAttachment[] | null;
 created_at: string;
}

export interface MessageAttachment {
 /** uploaded_files.id — the only field the server can act on. */
 id: string;
 /** Display name as the uploader's browser reported it. Untrusted. */
 name: string;
 /** MIME type as the uploader's browser reported it. Untrusted; render hint only. */
 type: string;
 /** Byte size as recorded at upload. Untrusted; display only. */
 size: number;
}

export interface MemoryFact {
 id: string;
 workspace_id: string;
 fact: string;
 category: string;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface AgentMemoryFile {
 id: string;
 workspace_id: string;
 agent_id: string;
 path: string;
 kind: string;
 summary: string;
 content_cache?: string;
 byte_size: number;
 editable: boolean;
 last_synced: string;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface MemoryFileComment {
 id: string;
 workspace_id: string;
 agent_id: string;
 path: string;
 user_id: string | null;
 parent_id: string | null;
 content: string;
 anchor_text: string;
 resolved: boolean;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface UploadedFile {
 id: string;
 workspace_id: string;
 name: string;
 size: number;
 type: string;
 storage_path: string;
 version?: number;
 created_at: string;
}

export type CanvasObjectType = 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'pen' | 'text' | 'image' | 'video' | 'file' | 'applet' | 'sticky_note';

export interface CanvasObject {
 id: string;
 workspace_id: string;
 user_id: string | null;
 type: CanvasObjectType;
 x: number;
 y: number;
 width: number;
 height: number;
 rotation: number;
 fill: string;
 stroke: string;
 stroke_width: number;
 opacity: number;
 points: Array<{ x: number; y: number }>;
 text_content: string;
 src: string;
 file_name: string;
 z_index: number;
 locked: boolean;
 group_id: string | null;
 attached_to: string | null;
 font_size: number;
 layer_id: string | null;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface CanvasGroup {
 id: string;
 workspace_id: string;
 name: string;
 color: string;
 version?: number;
 created_by: string | null;
 created_at: string;
}

export type CanvasTool = 'select' | 'pen' | 'rect' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'text' | 'eraser' | 'sticky_note';

export type ActiveView = 'chat' | 'document' | 'memory' | 'skills' | 'files' | 'tasks' | 'activity' | 'agents' | 'users' | 'schedules';

export type FloatingWindowType = 'chat' | 'document' | 'memory' | 'skills' | 'tasks' | 'activity' | 'agents' | 'users' | 'schedules' | 'inbox' | 'tenants' | 'browser' | 'terminal';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
/** Mirrors the `tasks_source_type_check` constraint — keep the two in step. */
export type TaskSourceType = 'manual' | 'chat' | 'document' | 'canvas' | 'ai' | 'feedback';

export interface Task {
 id: string;
 workspace_id: string;
 created_by: string | null;
 assignee_id: string | null;
 parent_id: string | null;
 title: string;
 description: string;
 status: TaskStatus;
 priority: TaskPriority;
 due_date: string | null;
 /** Gantt bar start; falls back to created_at when null. */
 start_date: string | null;
 /** Task ids this task depends on (postgres uuid[]). */
 depends_on?: string[];
 source_type: TaskSourceType | null;
 source_id: string | null;
 completed_at: string | null;
 version?: number;
 created_at: string;
 updated_at: string;
}

export type ThreadItemKind = 'todo' | 'plan' | 'blocker';
export type ThreadItemStatus = 'open' | 'done' | 'answered' | 'dismissed';

export interface ThreadItem {
 id: string;
 workspace_id: string;
 session_id: string;
 kind: ThreadItemKind;
 content: string;
 status: ThreadItemStatus;
 order_index: number;
 message_id: string | null;
 response: string | null;
 created_by: string | null;
 created_by_agent: string | null;
 created_at: string;
 updated_at: string;
}

export interface TaskComment {
 id: string;
 task_id: string;
 workspace_id: string;
 user_id: string | null;
 /** Set when the comment was authored by an agent (a mirrored subthread reply). */
 agent_id?: string | null;
 parent_id: string | null;
 content: string;
 resolved: boolean;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface ActivityEventComment {
 id: string;
 event_id: string;
 workspace_id: string;
 user_id: string | null;
 parent_id: string | null;
 content: string;
 resolved: boolean;
 version?: number;
 created_at: string;
 updated_at: string;
}

export interface DocumentComment {
 id: string;
 // Optional so MemoryFileComment (anchored to a workspace file, not a
 // document) can also flow through DocumentComments without a shim type.
 document_id?: string;
 workspace_id: string;
 user_id: string | null;
 parent_id: string | null;
 content: string;
 anchor_text: string;
 resolved: boolean;
 version?: number;
 created_at: string;
 updated_at: string;
}

export type ActivityEventType =
 | 'document_created'
 | 'document_updated'
 | 'document_deleted'
 | 'task_created'
 | 'task_completed'
 | 'task_updated'
 | 'comment_created'
 | 'chat_created'
 | 'memory_added'
 | 'member_joined'
 | 'canvas_updated'
 | 'message_sent'
 | 'agent_connected'
 | 'agent_disconnected'
 // An agent made a credentialed call to a provider skill through the server (it
 // never holds the credential itself). The audit trail for that: metadata carries
 // the provider, the operation, the resolved URL and the HTTP status — never a
 // request or response body, and never a header.
 | 'provider_call'
 // The single-use join URL. Created by someone with manage; redeemed once by
 // either a person or an agent. metadata carries the link's id, the lane it was
 // redeemed on and the role — never the token, which exists only as a hash.
 | 'join_link_created'
 | 'join_link_redeemed';

export interface ActivityEvent {
 id: string;
 workspace_id: string;
 user_id: string | null;
 event_type: ActivityEventType;
 entity_type: string | null;
 entity_id: string | null;
 title: string;
 metadata: Record<string, unknown>;
 created_at: string;
}

/** Triage categories, most urgent first. `blocker` is the one an agent raises
 *  when it hits a decision it cannot make — that is what the inbox exists for. */
export type InboxCategory = 'blocker' | 'comment' | 'mention' | 'error';

export type InboxFilter = 'all' | InboxCategory;

/**
 * One row in the triage inbox. Aggregated server-side from data that already
 * exists (thread_items, the three comment tables, activity_events, agent_jobs)
 * — the inbox adds no producers of its own.
 *
 * `contextKey` is the READ-STATE key AND the grouping key: every item sharing
 * one is one conversation, marked read together (see inbox_read_state).
 */
export interface InboxItem {
 /** Stable, unique across categories (prefixed by category). */
 id: string;
 category: InboxCategory;
 /** One line, already human-readable. */
 title: string;
 /** Short preview, may be ''. */
 body: string;
 /** Read-state key, e.g. 'blocker:<uuid>' / 'thread:<uuid>' / 'comment:<uuid>'. */
 contextKey: string;
 /** Chat session to open, when there is one. */
 sessionId: string | null;
 /** 'document' | 'task' | 'memory_file' | 'agent_job' | … */
 entityType: string | null;
 entityId: string | null;
 /** Who/what caused it, may be ''. */
 actorName: string;
 createdAt: string;
 unread: boolean;
}

export interface FloatingWindow {
 id: string;
 type: FloatingWindowType;
 title: string;
 x: number;
 y: number;
 width: number;
 height: number;
 zIndex: number;
 minimized: boolean;
 maximized?: boolean;
 restoreBounds?: {
  x: number;
  y: number;
  width: number;
  height: number;
 };
 canvasId?: string;
 sessionId?: string;
 documentId?: string;
 ownerUserId?: string | null;
 isPrivate?: boolean;
 locked?: boolean;
 shared?: boolean;
 /** A task to scroll to and expand once the tasks window renders (e.g. from
  *  search) — consumed and cleared by the window content, not persisted. */
 focusTaskId?: string;
 /** Set when this window is tiled with another (drag-to-split) — windows
  *  sharing a groupId are shown as one unit in the dock and move together. */
 groupId?: string | null;
}

export type PresenceVisibilityMode = 'visible' | 'dimmed' | 'hidden';
export type WorkspaceInstanceShareMode = 'off' | 'all' | 'selected';

export interface ItemPresenceUser {
 userId: string;
 name: string;
 color: string;
 typing?: boolean;
}

export type AIModel = {
 id: string;
 label: string;
 description: string;
};

export type SharedAgentModel = {
 id: string;
 name: string;
 provider: string;
 protocol: 'openai-chat' | string;
 upstreamModel: string;
 capabilities: string[];
 contextWindow?: number;
 maxConcurrency: number;
 shared: true;
};

export interface GatewayConfig {
 id: string;
 workspace_id: string;
 name: string;
 base_url: string;
 model: string;
 protocol: string;
 headers?: Record<string, unknown>;
 has_key?: boolean;
 created_at?: string;
 updated_at?: string;
}

export const AI_MODELS: AIModel[] = [
 { id: 'auto', label: 'Auto', description: 'Uses the workspace default model' },
 { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Most capable model' },
 { id: 'claude-fable-5', label: 'Fable 5', description: 'Claude 5 family model' },
 { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Latest balanced model' },
 { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Balanced performance' },
 { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest model' },
];

export type AgentPermissionMode = 'default' | 'accept_edits' | 'yolo';

export interface DocumentVersion {
 id: string;
 document_id: string;
 workspace_id: string;
 user_id: string | null;
 title: string;
 content: string;
 version_number: number;
 created_at: string;
}

export interface WorkspaceAgent {
 id: string;
 workspace_id: string;
 name: string;
 avatar: string;
 openpet_avatar_id?: string | null;
 accent_color?: string | null;
 description: string;
 system_prompt: string;
 soul?: string;
 instructions?: string;
 tools?: string[];
 skills?: string[];
 metadata?: Record<string, unknown> | null;
 /**
  * How this agent presents itself, and who chose it.
  *
  * `voice` is a PORTABLE preference (accent + variant index + rate/pitch),
  * never a device voice name — see src/lib/agentVoice.ts. `human_set` records
  * which identity fields a person explicitly chose, so the agent's
  * self-declaration on every reconnect can fill in the rest without
  * overwriting them (shared/agentIdentity.cjs).
  */
 identity?: {
  voice?: AgentVoicePreference | null;
  human_set?: Record<string, boolean> | null;
 } | null;
 handle?: string | null;
 model: string;
 /** How this agent's turns are served. 'external' = an MCP client registered
  *  itself (register_agent) and works AS this agent via claim_job — remote, but
  *  with no daemon CLI to connect, so the daemon Connect flow does not apply. */
 run_mode?: 'builtin' | 'daemon' | 'sandbox' | 'external';
 sandbox_provider?: string | null;
 sandbox_config?: Record<string, unknown>;
 enabled?: boolean;
 permission_mode?: AgentPermissionMode;
 version?: number;
 created_by: string | null;
 created_at: string;
 updated_at: string;
}

export interface AgentCapabilities {
 skills: string[];
 commands?: Array<{ name: string; parent?: string | null }>;
 clis: string[];
 mcpServers: string[];
 sharedModels?: SharedAgentModel[];
 codingRoute?: boolean;
 shared?: boolean;
 memoryRoot: string | null;
}

export interface AgentConnection {
 id: string;
 workspace_id: string;
 agent_id: string | null;
 name: string;
 handle: string;
 host: string;
 cwd: string;
 status: 'online' | 'offline' | 'busy';
 metadata: Record<string, unknown>;
 capabilities?: AgentCapabilities;
 connected_at: string;
 last_seen_at: string;
 updated_at: string;
}

/**
 * One row of `agent_jobs` — an agent turn the server has queued/started.
 *
 * Only the columns the client actually reads are typed: the row also carries
 * `prompt` and `response`, which are the FULL daemon prompt and the FULL reply,
 * so nothing client-side should select them (see useAgentWorkFeed).
 * `metadata.threadParentId` is what ties a job to a thread rather than just to
 * the session it runs in.
 */
export interface AgentJobRow {
 id: string;
 workspace_id: string;
 agent_id: string | null;
 session_id: string | null;
 status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
 started_at: string | null;
 created_at: string;
 metadata: Record<string, unknown>;
}

/** Which provider signs deliveries to an orb, and therefore how they verify. */
export type OrbProvider = 'generic' | 'github' | 'stripe';

/** 'new' opens a session per delivery; 'thread' appends to one stable thread. */
export type OrbRouting = 'new' | 'thread';

export interface AgentWebhook {
 id: string;
 workspace_id: string;
 agent_id: string | null;
 name: string;
 token: string;
 enabled: boolean;
 last_triggered_at: string | null;
 version?: number;
 /** Orb config (plans/021). Every default reproduces the pre-orb behaviour. */
 provider?: OrbProvider;
 /** The operator's instruction — the ONLY instruction region in the composed message. */
 prompt?: string;
 /** Allowlist of dot-paths projected out of the payload. Empty = whole body, truncated. */
 payload_fields?: string[];
 routing?: OrbRouting;
 rate_limit_per_hour?: number;
 /**
  * Advisory hint only. The secret itself lives in the workspace vault and is
  * never sent to the browser; the trigger route reads the vault, not this flag.
  */
 has_signing_secret?: boolean;
 session_id?: string | null;
 thread_root_message_id?: string | null;
 created_at: string;
 updated_at: string;
}

/**
 * What the orb config route accepts. `signing_secret` is WRITE-ONLY — it is
 * stored in the workspace vault and never read back, so there is no matching
 * field on AgentWebhook. An empty string clears it.
 */
export type OrbConfigInput = Partial<
 Pick<AgentWebhook, 'name' | 'enabled' | 'provider' | 'prompt' | 'payload_fields' | 'routing' | 'rate_limit_per_hour'>
> & { signing_secret?: string };

/** One inbound orb delivery: the dedupe record and the operator-visible log row. */
export interface OrbDelivery {
 id: string;
 webhook_id: string;
 workspace_id: string;
 delivery_key: string | null;
 body_hash: string;
 event_type: string;
 status: 'accepted' | 'duplicate' | 'rejected' | 'throttled' | 'failed';
 session_id: string | null;
 message_id: string | null;
 detail: string;
 created_at: string;
}

/** A huddle row — an ad-hoc voice call bound to the channel it happened in. */
export interface Huddle {
 id: string;
 workspace_id: string;
 /** The channel/DM the huddle was CALLED FROM. Not where its conversation lives. */
 session_id: string;
 /**
  * The huddle's OWN conversation — a chat_sessions row of its own, where the
  * transcript and the agents' replies land instead of in the host channel.
  * Null for huddles that predate it; readers fall back to session_id, which is
  * what those huddles actually did.
  */
 transcript_session_id?: string | null;
 /** Namespaced 'agensis-<huddleId>': the LiveKit project is shared with other apps. */
 room_name: string;
 started_by: string | null;
 started_at: string;
 ended_at: string | null;
}

/**
 * One APPEND-ONLY huddle event. Never updated, never deleted — participant
 * state is folded from the log (see lib/huddleState), which is what lets the
 * card survive a reconnect and out-of-order delivery with no reconciliation.
 */
export interface HuddleEvent {
 id: string;
 huddle_id: string;
 workspace_id: string;
 session_id: string;
 kind: 'started' | 'participant_joined' | 'participant_left' | 'ended';
 /** Server-assigned LiveKit identity, 'user:<userId>'. Never client-supplied. */
 identity: string;
 display_name: string;
 event_id: string;
 seq: number | string;
 created_at: string;
}

export interface HuddleParticipant {
 identity: string;
 userId: string;
 name: string;
 joinedAt: string | null;
}

/** Folded huddle state — the shape both the server route and the client fold return. */
export interface HuddleState {
 id: string;
 workspaceId: string;
 /** The channel/DM the huddle was called from. */
 sessionId: string;
 /** The huddle's own conversation session, or null for a pre-transcript huddle. */
 transcriptSessionId: string | null;
 roomName: string;
 startedBy: string | null;
 startedAt: string | null;
 endedAt: string | null;
 active: boolean;
 participants: HuddleParticipant[];
 /** Exactly participants.length. An ended huddle reports 0 — never a phantom 1. */
 participantCount: number;
 /** Truthful "how busy did it get": max concurrent participants seen in the log. */
 peakParticipants: number;
 /** Distinct people who joined at any point. */
 everJoinedCount: number;
}

/** What the start/join routes hand back. The API secret never leaves the server. */
export interface HuddleJoinGrant {
 huddle: HuddleState | null;
 /** Short-lived, room-scoped LiveKit access token minted server-side. */
 token: string;
 /** Public LiveKit wss:// endpoint. */
 url: string;
 identity: string;
 roomName: string;
}

export interface OnboardingStep {
 id: number;
 title: string;
 body: string;
 target: string;
 placement: 'top' | 'bottom' | 'left' | 'right';
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
 {
  id: 1,
  title: 'Documents are powerful.',
  body: 'Create, organize, and edit rich documents right in your workspace. Use formatting, headings, and more.',
  target: 'doc-editor-area',
  placement: 'right',
 },
 {
  id: 2,
  title: 'Link documents in channels.',
  body: 'Type @ in any channel post to reference and link a document directly.',
  target: 'chat-input',
  placement: 'top',
 },
];
