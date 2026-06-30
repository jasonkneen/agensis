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
  version?: number;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
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
  folder?: string | null;
  is_favorite?: boolean;
  participants?: ChannelParticipant[] | null;
  conversation_mode?: 'mention' | 'auto' | null;
  max_agent_turns?: number | null;
  auto_rounds?: number | null;
  archived_at?: string | null;
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
  created_at: string;
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
  content_cache: string;
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

export type ActiveView = 'chat' | 'document' | 'memory' | 'files' | 'tasks' | 'activity' | 'agents' | 'users';

export type FloatingWindowType = 'chat' | 'document' | 'memory' | 'tasks' | 'activity' | 'agents' | 'users';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskSourceType = 'manual' | 'chat' | 'document' | 'canvas' | 'ai';

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
  source_type: TaskSourceType | null;
  source_id: string | null;
  completed_at: string | null;
  version?: number;
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
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
  | 'message_sent';

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

export const AI_MODELS: AIModel[] = [
  { id: 'auto', label: 'Auto', description: 'Uses the workspace default model' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Most capable model' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Balanced performance' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fastest model' },
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
  handle?: string | null;
  model: string;
  run_mode?: 'builtin' | 'daemon';
  enabled?: boolean;
  permission_mode?: AgentPermissionMode;
  version?: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
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
  connected_at: string;
  last_seen_at: string;
  updated_at: string;
}

export interface AgentWebhook {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  name: string;
  token: string;
  enabled: boolean;
  last_triggered_at: string | null;
  version?: number;
  created_at: string;
  updated_at: string;
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
