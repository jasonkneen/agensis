import { useFidgetDrag } from '@/hooks/useFidgetDrag';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  Code2,
  Command,
  Copy,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  Link2,
  LayoutGrid,
  Monitor,
  Pencil,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  Rows2,
  Save,
  ShieldCheck,
  Share2,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  Volume2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AI_MODELS, type AgentConnection, type AgentPermissionMode, type AgentWebhook, type ChatSession, type Task, type WorkspaceAgent } from '../../types';
import { apiAuthHeaders, apiBaseUrl, apiUrl, getSystemCapabilities, type SystemCapabilities } from '../../lib/backendClient';
import { CODEX_MODEL_LIST_ID, modelOptionsForRuntime, modelSurvivesRuntimeChange } from '../../lib/runtimeModels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AgentNetworkDiagram } from './AgentNetworkDiagram';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  MAX_SPEED,
  MIN_SPEED,
  VOICE_EMOTIONS,
  assignAgentVoices,
  describeVoice,
  englishVoiceIds,
  filterVoices,
  readAgentVoice,
  resolveAgentVoice,
  type AgentVoicePreference,
} from '../../lib/agentVoice';
import { useCartesiaVoices } from '../../hooks/useCartesiaVoices';
import { useAgentTemplates } from '../../hooks/useAgentTemplates';

// 418 English voices in one <select> is a scroll nobody finishes; the search
// box above it is the real control.
const VOICE_OPTION_LIMIT = 60;
import { AGENT_ACCENT_CHOICES, DEFAULT_AGENT_ACCENT, agentAccentColor, agentAccentPaletteColor, agentAccentStyle, validAgentAccentColor } from '../../lib/agentAccent';
import { AGENT_AVATAR_CHOICES } from '../../lib/agentAvatars';
import { fetchFeaturedOpenPets, isImageAvatar, isPetSpritesheetAvatar, openPetAvatarSrc, renderablePetAssetUrl, type OpenPet } from '../../lib/openpets';
import {
  AGENT_TEMPLATES,
  mergeTemplateSources,
  type GalleryTemplate,
  agentMetadataWithRuntime,
  runtimeChoicesFromConnections,
  type AgentExecutionRuntime,
  type AgentRuntimeChoice,
  type AgentTemplate,
} from '../../lib/agentTemplates';
import { MarkdownContent } from '../chat/MarkdownContent';
import { SkillChipsInput } from '../agents/SkillChipsInput';
import { buildSkillEntries } from '../../lib/skillsView';
import { buildSkillSuggestions, type SkillSuggestion } from '../../lib/skillTokens';
import { oneOf, setOf, viewPreferenceKey } from '../../lib/viewPreferences';
import { usePersistedPreference } from '../../hooks/usePersistedPreference';
import { useSplitResize } from '../../hooks/useSplitResize';
import {
  AGENT_LAYOUT_VIEW_PREF,
  AGENT_SPLIT_PREF,
  AGENTS_SPLIT_HIDE_BELOW,
  AGENTS_SPLIT_ONLY_BELOW,
  agentFormBarPlacement,
  agentSplitGridHeight,
  toggleAgentSelection,
  type AgentLayoutView,
} from '../../lib/agentsView';

// Remembered per workspace: how the roster is sliced and drawn (the layout
// view codec lives in lib/agentsView with the rest of the view decisions).
// The search box and which agent is open are NOT — those are where you are,
// not how you look.
const AGENT_OWNER_FILTER_PREF = oneOf<'all' | 'mine'>(['all', 'mine']);
const AGENT_STATUS_FILTER_PREF = setOf<AgentPresence>(['busy', 'idle', 'disconnected', 'inactive']);
const NO_STATUS_FILTER: Set<AgentPresence> = new Set();

interface AgentsWindowContentProps {
  agents: WorkspaceAgent[];
  webhooks: AgentWebhook[];
  connections?: AgentConnection[];
  /** Network view only: the sessions/tasks it drills through. Read-only. */
  sessions?: ChatSession[];
  /**
   * Renders a live chat for one session, beside the map. Supplied as a RENDER
   * PROP rather than a component plus twenty data props: the chat surface needs
   * ~40 inputs (messages, streaming, threads, uploads, capabilities…) that App
   * already has in scope, and threading them through this window would duplicate
   * that wiring and let the two copies drift. Absent = the pane never appears.
   */
  renderSessionChat?: (session: ChatSession) => React.ReactNode;
  tasks?: Task[];
  workspaceId?: string | null;
  workspaceName?: string;
  currentUserId?: string | null;
  focusedAgentKey?: string | null;
  onCreateAgent: (input: {
    name: string;
    avatar?: string;
    openpet_avatar_id?: string | null;
    accent_color?: string | null;
    description?: string;
    system_prompt: string;
    soul?: string;
    instructions?: string;
    tools?: string[];
    skills?: string[];
    metadata?: Record<string, unknown>;
    handle?: string;
    model?: string;
    run_mode?: 'builtin' | 'daemon' | 'sandbox';
    sandbox_provider?: string | null;
    sandbox_config?: Record<string, unknown>;
    // Resolves false when the agent was NOT created, so the form can stay put
    // with the filled-in fields instead of returning to the list as if it had
    // worked.
  }) => Promise<boolean>;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
  onDisconnectAgent: (id: string) => Promise<unknown>;
  onCreateWebhook: (input: { agent_id?: string | null; name: string }) => Promise<AgentWebhook | null>;
  onUpdateWebhook: (id: string, updates: Partial<AgentWebhook>) => Promise<AgentWebhook | null>;
  onOpenConnections: () => void;
}

const TEMPLATE_CATEGORIES = ['All', ...Array.from(new Set(AGENT_TEMPLATES.map(t => t.category)))];

// Parse the Advanced sandbox config JSON, tolerating an empty or malformed value
// (the daemon defaults everything, so a bad draft must not block agent creation).
function safeParseSandboxConfig(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

// The raw strings the edit form holds for an agent.
interface AgentEditForm {
  name: string;
  avatar: string;
  openPetAvatarId: string;
  accentColor: string;
  handle: string;
  description: string;
  systemPrompt: string;
  soul: string;
  instructions: string;
  tools: string;
  skills: string;
  model: string;
  runMode: 'builtin' | 'daemon' | 'sandbox';
  runtime: AgentExecutionRuntime;
  metadata: Record<string, unknown>;
  sandboxProvider: string;
  sandboxConfig: string;
}

// One normalization for BOTH the save candidate and the baseline captured when
// the form was seeded — handleSave diffs the two field-by-field, and they only
// stay comparable if they went through the same trims and fallbacks.
function agentFormUpdates(form: AgentEditForm): Partial<WorkspaceAgent> {
  return {
    name: form.name.trim(),
    avatar: form.avatar.trim() || DEFAULT_AGENT_AVATAR,
    openpet_avatar_id: form.openPetAvatarId,
    accent_color: validAgentAccentColor(form.accentColor),
    handle: form.handle.trim() || agentHandle(form.name),
    description: form.description.trim(),
    system_prompt: form.systemPrompt.trim(),
    soul: form.soul.trim(),
    instructions: form.instructions.trim(),
    tools: splitList(form.tools),
    skills: splitList(form.skills),
    model: form.model,
    run_mode: form.runMode,
    metadata: agentMetadataWithRuntime(form.metadata, form.runtime, form.runMode),
    ...(form.runMode === 'sandbox' ? { sandbox_provider: form.sandboxProvider, sandbox_config: safeParseSandboxConfig(form.sandboxConfig) } : {}),
  };
}

const DEFAULT_AGENT_AVATAR = 'AI';
const AGENT_ICON_CHOICES: Array<{ value: string; label: string; icon: LucideIcon }> = [
  { value: 'icon:bot', label: 'Bot', icon: Bot },
  { value: 'icon:sparkles', label: 'Sparkles', icon: Sparkles },
  { value: 'icon:brain', label: 'Brain', icon: Brain },
  { value: 'icon:terminal', label: 'Terminal', icon: Terminal },
  { value: 'icon:code', label: 'Code', icon: Code2 },
  { value: 'icon:command', label: 'Command', icon: Command },
  { value: 'icon:wrench', label: 'Tools', icon: Wrench },
  { value: 'icon:database', label: 'Data', icon: Database },
  { value: 'icon:shield', label: 'Shield', icon: ShieldCheck },
  { value: 'icon:rocket', label: 'Rocket', icon: Rocket },
  { value: 'icon:globe', label: 'Globe', icon: Globe },
  { value: 'icon:monitor', label: 'Monitor', icon: Monitor },
];

// How an agent's turns are actually served. 'external' means an MCP client
// registered itself and works AS this agent (register_agent + claim_job) — it is
// remote like a daemon, but there is no daemon CLI to connect, so offering the
// daemon Connect flow for one is a wrong door.
function agentTransportLabel(runMode?: string | null): string {
  if (runMode === 'daemon' || runMode === 'sandbox') return 'Remote';
  if (runMode === 'external') return 'MCP client';
  return 'Built-in';
}

function isAmpAgent(agent: WorkspaceAgent): boolean {
  return String(agent.metadata?.runtime || '').trim().toLowerCase() === 'amp';
}

function agentExecutionRuntime(agent: WorkspaceAgent): AgentExecutionRuntime {
  const runtime = String(agent.metadata?.runtime || '').trim().toLowerCase();
  return runtime === 'codex' || runtime === 'amp' ? runtime : 'claude';
}

function runtimeChoiceNote(choice: AgentRuntimeChoice): string {
  if (choice.available === true) return 'ready';
  if (choice.available === null) return 'not reported by a connected daemon';
  switch (choice.reason) {
    case 'amp_not_installed': return 'Amp not installed';
    case 'amp_not_authenticated': return 'Amp not signed in';
    case 'amp_auth_expired': return 'Amp sign-in expired';
    case 'amp_project_not_found':
    case 'amp_project_unmatched': return 'repository not linked to an Amp project';
    case 'amp_project_forbidden': return 'Amp project access denied';
    case 'codex_not_installed': return 'Codex not installed';
    case 'claude_not_installed': return 'Claude not installed';
    default: return 'unavailable on connected daemons';
  }
}

function ampRuntimeStatusText(reason?: string | null): string {
  switch (reason) {
    case 'amp_not_installed': return 'Amp CLI is not installed on this machine.';
    case 'amp_version_unsupported': return 'Amp CLI needs to be updated.';
    case 'amp_not_authenticated': return 'Amp is not signed in. Run amp login on this machine.';
    case 'amp_auth_expired': return 'Amp sign-in expired. Run amp login on this machine.';
    case 'amp_project_not_found': return 'This repository is not linked to an Amp project.';
    case 'amp_project_unmatched': return 'This repository is not linked to an Amp project.';
    case 'amp_project_forbidden': return 'This Amp account cannot access the repository project.';
    default: return 'Amp is not ready on this machine.';
  }
}

export const AgentsWindowContent = memo(function AgentsWindowContent({
  agents,
  webhooks,
  connections = [],
  sessions = [],
  renderSessionChat,
  tasks = [],
  workspaceId = null,
  workspaceName = 'agensis',
  currentUserId,
  focusedAgentKey,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onDisconnectAgent,
  onCreateWebhook,
  onUpdateWebhook,
  onOpenConnections,
}: AgentsWindowContentProps) {
  // Creation flow: null = not creating, 'choose' = Template/Custom/BYO picker,
  // 'form' = the full agent form (reached via Custom or after picking a template).
  const [createStep, setCreateStep] = useState<null | 'choose' | 'form'>(null);
  const [templateQuery, setTemplateQuery] = useState('');
  const [templateCategory, setTemplateCategory] = useState('All');
  const [connectAgentId, setConnectAgentId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState(DEFAULT_AGENT_AVATAR);
  const [newOpenPetAvatarId, setNewOpenPetAvatarId] = useState('');
  const [newAccentColor, setNewAccentColor] = useState(DEFAULT_AGENT_ACCENT);
  const [newHandle, setNewHandle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSystemPrompt, setNewSystemPrompt] = useState('');
  const [newSoul, setNewSoul] = useState('');
  const [newInstructions, setNewInstructions] = useState('');
  const [newTools, setNewTools] = useState('');
  const [newSkills, setNewSkills] = useState('');
  const [newModel, setNewModel] = useState('auto');
  const [newRunMode, setNewRunMode] = useState<'builtin' | 'daemon' | 'sandbox'>('builtin');
  const [newRuntime, setNewRuntime] = useState<AgentExecutionRuntime>('claude');
  const [newMetadata, setNewMetadata] = useState<Record<string, unknown>>({});
  const [newSandboxProvider, setNewSandboxProvider] = useState('e2b');
  const [newSandboxConfig, setNewSandboxConfig] = useState('{}');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [statusFilter, setStatusFilter] = usePersistedPreference(
    viewPreferenceKey('agents.status-filter', workspaceId), AGENT_STATUS_FILTER_PREF, NO_STATUS_FILTER,
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [ownerFilter, setOwnerFilter] = usePersistedPreference(
    viewPreferenceKey('agents.owner-filter', workspaceId), AGENT_OWNER_FILTER_PREF, 'all' as 'all' | 'mine',
  );
  const [layoutView, setLayoutView] = usePersistedPreference(
    viewPreferenceKey('agents.layout-view', workspaceId), AGENT_LAYOUT_VIEW_PREF, 'grid' as AgentLayoutView,
  );
  // Where the Both view's divider sits, in px of grid height. A REQUEST, never
  // the layout: `agentSplitGridHeight` re-clamps it against the live container
  // on every render, so a split stored for a tall window cannot hide the map in
  // a short one — and because nothing is written back, growing the window
  // returns the split that was actually chosen.
  const [storedSplit, setStoredSplit] = usePersistedPreference(
    viewPreferenceKey('agents.split', workspaceId), AGENT_SPLIT_PREF, 0,
  );
  // The live value while the divider is under the pointer. The persisted setter
  // is only touched on release: it writes through to storage on every change,
  // and a drag changes sixty times a second.
  const [draftSplit, setDraftSplit] = useState<number | null>(null);
  const [splitBox, setSplitBox] = useState(0);
  const splitObserverRef = useRef<ResizeObserver | null>(null);
  // A callback ref rather than an effect: the split root mounts and unmounts
  // with the view mode and the empty states, and this way the measurement is
  // tied to the node existing rather than to a dependency list that has to
  // predict every reason it might not.
  const attachSplit = useCallback((node: HTMLDivElement | null) => {
    splitObserverRef.current?.disconnect();
    splitObserverRef.current = null;
    if (!node) return;
    const measure = () => setSplitBox(current => (current === node.clientHeight ? current : node.clientHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    splitObserverRef.current = observer;
  }, []);
  useEffect(() => () => splitObserverRef.current?.disconnect(), []);

  const splitGridHeight = agentSplitGridHeight(draftSplit ?? storedSplit, splitBox);

  // The drag itself is `useSplitResize` — one implementation of pointer capture
  // (including the NotFoundError guard), the keyboard equivalent and
  // double-click-to-reset, shared with the Memory browser's divider.
  const clampSplit = useCallback(
    (value: number) => agentSplitGridHeight(value, splitBox),
    [splitBox],
  );
  const { handlers: splitHandlers } = useSplitResize({
    axis: 'y',
    size: splitGridHeight,
    clamp: clampSplit,
    // Raw on the way in, clamped on the way out: dragging past a floor and back
    // again tracks the pointer instead of sticking there.
    onPreview: setDraftSplit,
    onCommit: value => { setStoredSplit(value); setDraftSplit(null); },
    onReset: () => { setDraftSplit(null); setStoredSplit(0); },
  });
  const normalizedFocusedAgentKey = normalizeAgentKey(focusedAgentKey);
  const focusedAgent = agents.find(agent => agentMatchesKey(agent, normalizedFocusedAgentKey)) || null;
  // Cards are draggable and spring back — a fidget, not a layout. One hook for
  // the whole grid: a pointer drags one card at a time. See useFidgetDrag.
  const fidget = useFidgetDrag();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId) || null;
  // The side pane shows ONE thing. A session wins over an agent because it is the
  // more specific click: you drilled from the agent into its conversation. Close
  // the chat and the agent's detail is still there underneath.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectedSession = sessions.find(session => session.id === selectedSessionId) || null;
  const sessionChat = selectedSession && renderSessionChat ? renderSessionChat(selectedSession) : null;
  const connectAgent = agents.find(agent => agent.id === connectAgentId) || null;
  // An external focus request (e.g. opening an agent from elsewhere) drills into it;
  // otherwise the window opens on the card grid, not a pre-selected agent.
  // A NEW external focus request drills into that agent exactly once; otherwise the
  // window always opens on the card grid. A ref guards against a stale focus key
  // re-drilling after the user has navigated back to the grid.
  const focusedAgentId = focusedAgent?.id || null;
  const consumedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedAgentId && consumedFocusRef.current !== focusedAgentId) {
      consumedFocusRef.current = focusedAgentId;
      setSelectedAgentId(focusedAgentId);
    }
  }, [focusedAgentId]);

  const presenceByAgent = new Map<string, AgentPresence>(
    agents.map(agent => [
      agent.id,
      agentPresenceStatus(agent, connections.filter(connection => connection.agent_id === agent.id)),
    ]),
  );
  const presenceCounts = AGENT_PRESENCE_FILTERS.reduce<Record<AgentPresence, number>>((acc, filter) => {
    acc[filter.key] = 0;
    return acc;
  }, { busy: 0, idle: 0, disconnected: 0, inactive: 0 });
  presenceByAgent.forEach(status => { presenceCounts[status] += 1; });
  const mineAgents = currentUserId ? agents.filter(agent => agent.created_by === currentUserId) : [];
  // A persisted 'mine' filter must never hide EVERYTHING. The toggle that
  // clears it only renders when there is at least one of your own agents
  // (below), so a workspace whose agents were all created by someone else —
  // or by an older build that did not stamp created_by — showed "you haven't
  // created any agents yet" over a full workspace, with no control on screen
  // to undo it. The filter now yields only when it would match nothing.
  const ownerVisibleAgents = ownerFilter === 'mine' && currentUserId && mineAgents.length > 0
    ? mineAgents
    : agents;
  const mineCount = mineAgents.length;
  const statusVisibleAgents = statusFilter.size === 0
    ? ownerVisibleAgents
    : ownerVisibleAgents.filter(agent => statusFilter.has(presenceByAgent.get(agent.id) as AgentPresence));
  const searchQuery = searchTerm.trim().toLowerCase();
  const visibleAgents = searchQuery === ''
    ? statusVisibleAgents
    : statusVisibleAgents.filter(agent =>
      `${agent.name} ${agent.handle || ''} ${agent.description || ''}`.toLowerCase().includes(searchQuery));

  const toggleStatusFilter = (key: AgentPresence) => {
    setStatusFilter(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    getSystemCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  // What the Skills field offers, computed once for BOTH forms. The union of
  // everything the workspace knows a skill name for — advertised by a live
  // daemon, configured on any agent, shipped by agensis, or a library on the
  // backend host. The old field only ever knew the last of those, so a skill
  // sitting on the agent next to this one couldn't be suggested.
  const skillSuggestions = useMemo(
    () => buildSkillSuggestions(buildSkillEntries(agents, connections), capabilities),
    [agents, connections, capabilities],
  );
  const runtimeChoices = useMemo(() => runtimeChoicesFromConnections(connections), [connections]);

  const resetNewAgentFields = () => {
    setNewName('');
    setNewAvatar(DEFAULT_AGENT_AVATAR);
    setNewOpenPetAvatarId('');
    setNewAccentColor(agentAccentPaletteColor(agents.length + 1));
    setNewHandle('');
    setNewDescription('');
    setNewSystemPrompt('');
    setNewSoul('');
    setNewInstructions('');
    setNewTools('');
    setNewSkills('');
    setNewModel('auto');
    setNewRunMode('builtin');
    setNewRuntime('claude');
    setNewMetadata({});
  };
  // Awaits the write before resetting the form and going back to the list.
  // Previously this fired and forgot, so a rejected create — or one that never
  // even left the browser because the workspace hadn't loaded — landed you back
  // on "No agents yet" looking exactly like a success.
  const handleCreate = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    let created = false;
    try {
      created = await onCreateAgent({
        name: newName.trim(),
        avatar: newAvatar.trim() || DEFAULT_AGENT_AVATAR,
        openpet_avatar_id: newOpenPetAvatarId,
        accent_color: validAgentAccentColor(newAccentColor),
        handle: newHandle.trim() || agentHandle(newName),
        description: newDescription.trim(),
        system_prompt: newSystemPrompt.trim(),
        soul: newSoul.trim(),
        instructions: newInstructions.trim(),
        tools: splitList(newTools),
        skills: splitList(newSkills),
        model: newModel,
        run_mode: newRunMode,
        metadata: agentMetadataWithRuntime(newMetadata, newRuntime, newRunMode),
        ...(newRunMode === 'sandbox' ? { sandbox_provider: newSandboxProvider, sandbox_config: safeParseSandboxConfig(newSandboxConfig) } : {}),
      });
    } finally {
      setCreating(false);
    }
    // Not created: keep the form and everything typed into it. The caller has
    // already said why.
    if (!created) return;
    resetNewAgentFields();
    setCreateStep(null);
  };
  const startCustom = () => {
    resetNewAgentFields();
    setCreateStep('form');
  };
  // Authored templates merged over the bundled array. The hook falls back to an
  // empty list when the route is unreachable, so the gallery degrades to exactly
  // today's behaviour rather than showing an error — that is also the rollback
  // path if the server is reverted.
  const { templates: authoredTemplates, saveAgentAsTemplate } = useAgentTemplates(workspaceId);
  const galleryTemplates = useMemo(
    () => mergeTemplateSources(AGENT_TEMPLATES, authoredTemplates),
    [authoredTemplates],
  );

  const applyTemplate = (tpl: GalleryTemplate | AgentTemplate) => {
    setNewName(tpl.name);
    setNewHandle(tpl.handle);
    setNewDescription(tpl.description);
    setNewSystemPrompt(tpl.systemPrompt);
    setNewTools(tpl.tools.join(', '));
    setNewSkills(tpl.skills.join(', '));
    const stored = 'stored' in tpl ? tpl.stored : undefined;
    setNewModel(stored?.model || 'auto');
    setNewRunMode(tpl.runMode);
    setNewRuntime(tpl.runtime || 'claude');
    // An authored template has no metadata to carry — the table has no column
    // for it, deliberately (see shared/agentTemplates.cjs). Only a bundled
    // template, which is reviewed code, can set it.
    setNewMetadata(stored ? {} : (tpl.metadata || {}));
    setNewAvatar(DEFAULT_AGENT_AVATAR);
    setNewOpenPetAvatarId('');
    setNewAccentColor(agentAccentPaletteColor(agents.length + 1));
    setNewSoul(stored?.soul || '');
    setNewInstructions(stored?.instructions || '');
    setCreateStep('form');
  };

  const [templateSavedFor, setTemplateSavedFor] = useState<string | null>(null);
  const handleSaveAsTemplate = async (id: string) => {
    const saved = await saveAgentAsTemplate(id);
    setTemplateSavedFor(saved ? id : null);
    if (saved) window.setTimeout(() => setTemplateSavedFor(current => (current === id ? null : current)), 3000);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      onDeleteAgent(id);
      setConfirmDeleteId(null);
      return;
    }
    setConfirmDeleteId(id);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/65 px-3 py-2 backdrop-blur-md">
        <div className="relative min-w-0 max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search agents"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!createStep && agents.length > 0 && (
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card/40 p-0.5">
              <Button type="button" size="icon-sm" variant={layoutView === 'grid' ? 'default' : 'ghost'} onClick={() => setLayoutView('grid')} aria-label="Grid view" aria-pressed={layoutView === 'grid'} title="Grid view">
                <LayoutGrid />
              </Button>
              <Button type="button" size="icon-sm" variant={layoutView === 'network' ? 'default' : 'ghost'} onClick={() => setLayoutView('network')} aria-label="Map view" aria-pressed={layoutView === 'network'} title="Network map">
                <Share2 />
              </Button>
              <Button type="button" size="icon-sm" variant={layoutView === 'both' ? 'default' : 'ghost'} onClick={() => setLayoutView('both')} aria-label="Grid and map view" aria-pressed={layoutView === 'both'} title="Grid and map">
                <Rows2 />
              </Button>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenConnections}
          >
            <Plug data-icon="inline-start" />
            Invite an Agent
          </Button>
          <Button
            type="button"
            size="sm"
            variant={createStep ? 'outline' : 'default'}
            onClick={() => setCreateStep(createStep ? null : 'choose')}
          >
            <Plus data-icon="inline-start" />
            Create Agent
          </Button>
        </div>
      </div>
      <AgentConnectDialog
        agent={connectAgent}
        open={connectAgentId != null}
        onOpenChange={(o) => { if (!o) setConnectAgentId(null); }}
        runtimeChoices={runtimeChoices}
        webhooks={connectAgent ? webhooks.filter(webhook => webhook.agent_id === connectAgent.id) : []}
        onCreateWebhook={() => connectAgent ? onCreateWebhook({ agent_id: connectAgent.id, name: `${connectAgent.name} webhook` }) : Promise.resolve(null)}
        onToggleWebhook={(webhook, enabled) => onUpdateWebhook(webhook.id, { enabled })}
      />

      <div className="agents-window-body min-h-0 flex-1 overflow-hidden p-3">
        {createStep === 'choose' ? (
          <div className="flex h-full min-h-0 flex-col rounded-lg border bg-card/55 backdrop-blur-md">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => setCreateStep(null)} aria-label="Back to agents">
                <ArrowLeft />
              </Button>
              <Plus className="size-4 text-primary" />
              <span className="text-sm font-semibold">Create an agent</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mb-3 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                <button
                  type="button"
                  onClick={startCustom}
                  className="group flex min-h-[104px] flex-col items-start gap-2 rounded-xl border-2 border-dashed border-border bg-card/40 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/60 hover:bg-card/80 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30">
                  <span className="grid size-9 place-items-center rounded-lg bg-muted"><Plus className="size-5" /></span>
                  <span className="text-sm font-semibold">Custom</span>
                  <span className="text-xs text-muted-foreground">Build your own agent from scratch.</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenConnections}
                  className="group flex min-h-[104px] flex-col items-start gap-2 rounded-xl border border-border bg-card/40 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/60 hover:bg-card/80 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30">
                  <span className="grid size-9 place-items-center rounded-lg bg-muted"><Plug className="size-5" /></span>
                  <span className="text-sm font-semibold">Bring your own</span>
                  <span className="text-xs text-muted-foreground">Connect a local CLI or MCP client as an agent.</span>
                </button>
              </div>

              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Templates</div>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={templateQuery} onChange={e => setTemplateQuery(e.target.value)} placeholder="Search templates" className="h-8 pl-8 text-sm" />
              </div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {TEMPLATE_CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setTemplateCategory(cat)}
                    className={cn(
                      'control-outer-ring rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                      templateCategory === cat
                        ? 'border-primary/60 bg-primary/15 text-foreground'
                        : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {(() => {
                const q = templateQuery.trim().toLowerCase();
                const filtered = galleryTemplates.filter(tpl =>
                  (templateCategory === 'All' || tpl.category === templateCategory) &&
                  (q === '' || `${tpl.name} ${tpl.description} ${tpl.category}`.toLowerCase().includes(q)));
                if (filtered.length === 0) {
                  return <div className="py-8 text-center text-sm text-muted-foreground">No templates match. <button type="button" className="text-primary underline" onClick={startCustom}>Build a custom agent</button> instead.</div>;
                }
                return (
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                    {filtered.map(tpl => {
                      const TplIcon = tpl.icon;
                      return (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => applyTemplate(tpl)}
                          className="group flex min-h-[132px] flex-col items-start gap-2 rounded-xl border border-border bg-card/40 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/60 hover:bg-card/80 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30">
                          <span className="grid size-9 place-items-center rounded-lg bg-muted"><TplIcon className="size-5" /></span>
                          <span className="text-sm font-semibold">{tpl.name}</span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">{tpl.description}</span>
                          <span className="mt-auto text-[11px] text-muted-foreground opacity-70">
                            {tpl.category} · {tpl.runMode === 'daemon' ? `Remote · ${runtimeChoices.find(choice => choice.id === tpl.runtime)?.label || 'Claude'}` : 'Built-in'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        ) : createStep === 'form' ? (
          <div className="flex h-full min-h-0 flex-col rounded-lg border bg-card/55 backdrop-blur-md">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => setCreateStep('choose')} aria-label="Back to templates">
                <ArrowLeft />
              </Button>
              <Plus className="size-4 text-primary" />
              <span className="text-sm font-semibold">Create agent</span>
            </div>
              <AgentForm
                name={newName}
                avatar={newAvatar}
                openPetAvatarId={newOpenPetAvatarId}
                accentColor={newAccentColor}
                handle={newHandle}
                description={newDescription}
                systemPrompt={newSystemPrompt}
                soul={newSoul}
                instructions={newInstructions}
                tools={newTools}
                skills={newSkills}
                model={newModel}
                runMode={newRunMode}
                runtime={newRuntime}
                runtimeChoices={runtimeChoices}
                capabilities={capabilities}
                skillSuggestions={skillSuggestions}
                onNameChange={setNewName}
                onAvatarChange={(value) => {
                  setNewAvatar(value);
                  setNewOpenPetAvatarId('');
                }}
                onOpenPetAvatarChange={(pet) => {
                  setNewAvatar(openPetAvatarSrc(pet));
                  setNewOpenPetAvatarId(pet.id);
                }}
                onAccentColorChange={setNewAccentColor}
                onHandleChange={setNewHandle}
                onDescriptionChange={setNewDescription}
                onSystemPromptChange={setNewSystemPrompt}
                onSoulChange={setNewSoul}
                onInstructionsChange={setNewInstructions}
                onToolsChange={setNewTools}
                onSkillsChange={setNewSkills}
                onModelChange={setNewModel}
                onRunModeChange={setNewRunMode}
                onRuntimeChange={setNewRuntime}
                sandboxProvider={newSandboxProvider}
                sandboxConfig={newSandboxConfig}
                onSandboxProviderChange={setNewSandboxProvider}
                onSandboxConfigChange={setNewSandboxConfig}
                onCancel={() => setCreateStep(null)}
                onSubmit={handleCreate}
                submitting={creating}
                submitLabel="Create"
                submitIcon={<Plus data-icon="inline-start" />}
              />
          </div>
        ) : (
          // Master-detail, the inbox's pattern: grid/map stays on the LEFT and
          // the selected agent's detail opens beside it, one hairline between
          // them. Below 42rem the detail replaces the list instead, with a
          // back affordance — the threshold is stated in lib/agentsView.ts.
          <div className="@container/agentswin flex h-full min-h-0">
            <section
              className={cn(
                'flex min-h-0 min-w-0 flex-1 flex-col',
                selectedAgent && cn('border-r border-border/60 pr-3', AGENTS_SPLIT_HIDE_BELOW),
              )}
            >
            {/* Shown when there is something to filter TO, or when the filter is
                already engaged — otherwise an active filter can hide its own
                control. */}
            {agents.length > 0 && (mineCount > 0 || ownerFilter === 'mine') && (
              <div className="mb-2 inline-flex shrink-0 items-center gap-0.5 self-start rounded-lg border border-border bg-card/40 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setOwnerFilter('mine')}
                  aria-pressed={ownerFilter === 'mine'}
                  className={cn(
                    'rounded-md px-3 py-1 transition',
                    ownerFilter === 'mine' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Yours <span className="tabular-nums opacity-70">{mineCount}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setOwnerFilter('all')}
                  aria-pressed={ownerFilter === 'all'}
                  className={cn(
                    'rounded-md px-3 py-1 transition',
                    ownerFilter === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  All <span className="tabular-nums opacity-70">{agents.length}</span>
                </button>
              </div>
            )}
            {agents.length > 0 && (
              <div className="agents-status-filter mb-3 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setStatusFilter(new Set())}
                  aria-pressed={statusFilter.size === 0}
                  className={cn(
                    'control-outer-ring inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                    statusFilter.size === 0
                      ? 'border-primary/60 bg-primary/15 text-foreground'
                      : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  All
                  <span className="tabular-nums opacity-70">{agents.length}</span>
                </button>
                {(() => {
                  const activeCount = presenceCounts.busy + presenceCounts.idle;
                  const isActiveFilter = statusFilter.size === 2 && statusFilter.has('busy') && statusFilter.has('idle');
                  return (
                    <button
                      type="button"
                      onClick={() => setStatusFilter(new Set(['busy', 'idle']))}
                      aria-pressed={isActiveFilter}
                      className={cn(
                        'control-outer-ring inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                        isActiveFilter
                          ? 'border-primary/60 bg-primary/15 text-foreground'
                          : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                      Active
                      <span className="tabular-nums opacity-70">{activeCount}</span>
                    </button>
                  );
                })()}
                {AGENT_PRESENCE_FILTERS.map(filter => {
                  const active = statusFilter.has(filter.key);
                  return (
                    <button
                      key={filter.key}
                      type="button"
                      onClick={() => toggleStatusFilter(filter.key)}
                      aria-pressed={active}
                      className={cn(
                        'control-outer-ring inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                        active
                          ? 'border-primary/60 bg-primary/15 text-foreground'
                          : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      <span className={cn('size-1.5 rounded-full', filter.tone)} aria-hidden />
                      {filter.label}
                      <span className="tabular-nums opacity-70">{presenceCounts[filter.key]}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {agents.length === 0 ? (
              <Empty className="h-full border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bot />
                  </EmptyMedia>
                  <EmptyTitle>No agents yet</EmptyTitle>
                  <EmptyDescription>Create an agent, copy its connection command, and run it where the daemon should execute.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : visibleAgents.length === 0 ? (
              <Empty className="border-0 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bot />
                  </EmptyMedia>
                  <EmptyTitle>No agents match</EmptyTitle>
                  <EmptyDescription>{searchQuery ? `No agents match "${searchTerm.trim()}".` : ownerFilter === 'mine' && statusFilter.size === 0 ? "You haven't created any agents yet." : `No agents are ${AGENT_PRESENCE_FILTERS.filter(f => statusFilter.has(f.key)).map(f => f.label.toLowerCase()).join(' or ')}. Adjust the filter above.`}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (() => {
              // Grid, map, or both stacked — assembled once here so the three
              // modes share the same live pieces instead of duplicating them.
              const diagram = (
                <AgentNetworkDiagram
                  agents={visibleAgents}
                  connections={connections}
                  sessions={sessions}
                  tasks={tasks}
                  workspaceName={workspaceName}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={setSelectedAgentId}
                  onSelectSession={renderSessionChat ? setSelectedSessionId : undefined}
                />
              );
              if (layoutView === 'network') {
                return <div className="min-h-0 flex-1 overflow-hidden">{diagram}</div>;
              }
              const grid = (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))]">
                  {visibleAgents.map(agent => {
                    const accent = agentAccentColor(agent);
                    const presence = presenceByAgent.get(agent.id);
                    const live = presence === 'busy' || presence === 'idle';
                    const active = isAgentActive(agent);
                    const selected = agent.id === selectedAgentId;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        // The card is its own toggle: clicking the open agent
                        // again closes the detail pane (lib/agentsView.ts).
                        onClick={() => { setSelectedAgentId(prev => toggleAgentSelection(prev, agent.id)); setEditingId(null); }}
                        // Drag handlers ride alongside the click: the fidget
                        // hook swallows a click that turned into a drag, so a
                        // pull never opens the detail pane by accident.
                        {...fidget.handlers}
                        style={agentAccentStyle(agent)}
                        data-agent-selected={selected ? 'true' : undefined}
                        aria-pressed={selected}
                        title={[
                          `@${agent.handle || agentHandle(agent.name)}`,
                          agentTransportLabel(agent.run_mode),
                          agent.description,
                        ].filter(Boolean).join(' · ')}
                        className={cn(
                          // agents-list-card carries the selected wash (accent
                          // over card, index.css) and the neo depth treatment.
                          'agents-list-card group relative flex flex-col items-center gap-2.5 rounded-2xl border bg-card/60 p-4 text-center shadow-sm shadow-black/5 backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:bg-card/85 hover:shadow-lg hover:shadow-black/10 dark:shadow-black/20 dark:hover:shadow-black/30',
                          selected && 'border-primary/50',
                          !active && 'opacity-60',
                        )}
                      >
                        <span className="relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-muted text-2xl ring-1 ring-inset ring-black/5 dark:ring-white/10">
                          <AgentAvatarPreview value={agent.avatar || DEFAULT_AGENT_AVATAR} className="size-full" />
                          {live && (
                            <span
                              className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-emerald-500 ring-2 ring-card"
                              title="Connected"
                              aria-hidden
                            />
                          )}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center justify-center gap-1.5">
                            <span className="agent-accent-dot" style={{ backgroundColor: accent }} aria-hidden />
                            <span className="truncate text-sm font-semibold">{agent.name}</span>
                          </div>
                          <span className="block truncate text-[11px] text-muted-foreground opacity-70">@{agent.handle || agentHandle(agent.name)}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground opacity-80">{displayModel(agent.model)}</span>
                        </div>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setCreateStep('choose')}
                    className="flex min-h-[124px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-card/20 p-4 text-center text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/60 hover:bg-card/60 hover:text-foreground"
                  >
                    <span className="grid size-16 place-items-center rounded-2xl border-2 border-dashed border-border/70">
                      <Plus className="size-6" />
                    </span>
                    <span className="text-sm font-medium">New agent</span>
                  </button>
                </div>
              );
              if (layoutView === 'both') {
                // Stacked and RESIZABLE: the card grid above, the live map
                // below, a draggable divider between them.
                //
                // The grid owns a HEIGHT, not the height its cards happen to
                // need. That is the whole behaviour: dragging up genuinely
                // shrinks it and it scrolls inside itself, instead of the pair
                // sharing one scroller where growing the roster pushes the map
                // off the bottom. Neither pane can be dragged away — usePaneSplit
                // re-clamps against the measured container on every render, so a
                // window resize cannot orphan one either.
                return (
                  <div className="flex min-h-0 flex-1 flex-col px-1 pt-1.5 pb-2">
                    <div ref={attachSplit} className="flex min-h-0 flex-1 flex-col">
                      {/* pb-2 is the gutter between the panes, INSIDE the grid
                          pane's own box, so the two heights still sum to the
                          container the clamp was handed. */}
                      <div className="relative shrink-0 pb-2" style={{ height: `${splitGridHeight}px` }}>
                        <div className="h-full overflow-y-auto pr-0.5">{grid}</div>
                        {/* The same invisible grab strip the account list uses,
                            turned on its side: a hairline that only appears
                            under the pointer or focus. */}
                        <button
                          type="button"
                          aria-label="Resize agent grid"
                          title="Drag to resize. Double-click to reset."
                          {...splitHandlers}
                          className="group/split absolute inset-x-0 bottom-0 z-30 flex h-2 cursor-row-resize items-center rounded-none outline-none"
                        >
                          <span
                            aria-hidden="true"
                            className="h-px w-full bg-transparent transition-colors group-hover/split:bg-border group-focus-visible/split:bg-primary/70"
                          />
                        </button>
                      </div>
                      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card/40">
                        <div className="min-h-0 min-w-0 flex-1">{diagram}</div>
                      </div>
                    </div>
                  </div>
                );
              }
              return <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-1.5 pb-2">{grid}</div>;
            })()}
            </section>
            {sessionChat ? (
              <section className="flex min-h-0 w-[clamp(24rem,45%,34rem)] shrink-0 flex-col overflow-hidden pl-3 @max-2xl/agentswin:w-full @max-2xl/agentswin:pl-0">
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/40">
                  <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {selectedSession?.title || 'Conversation'}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Close conversation"
                      onClick={() => setSelectedSessionId(null)}
                    >
                      <X />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">{sessionChat}</div>
                </div>
              </section>
            ) : selectedAgent && (
              <section className="flex min-h-0 w-[clamp(24rem,45%,34rem)] shrink-0 flex-col overflow-hidden pl-3 @max-2xl/agentswin:w-full @max-2xl/agentswin:pl-0">
                <AgentDetailPane
                  agent={selectedAgent}
                  isEditing={editingId === selectedAgent.id}
                  confirmDelete={confirmDeleteId === selectedAgent.id}
                  onEdit={() => setEditingId(selectedAgent.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSave={(updates) => {
                    onUpdateAgent(selectedAgent.id, updates);
                    setEditingId(null);
                  }}
                  onDelete={() => handleDelete(selectedAgent.id)}
                  onSaveAsTemplate={() => { void handleSaveAsTemplate(selectedAgent.id); }}
                  templateSaved={templateSavedFor === selectedAgent.id}
                  onToggleEnabled={() => onUpdateAgent(selectedAgent.id, { enabled: selectedAgent.enabled === false })}
                  capabilities={capabilities}
                  runtimeChoices={runtimeChoices}
                  skillSuggestions={skillSuggestions}
                  webhooks={webhooks.filter(webhook => webhook.agent_id === selectedAgent.id)}
                  connections={connections.filter(connection => connection.agent_id === selectedAgent.id)}
                  roster={agents}
                  workspaceId={workspaceId}
                  onUpdateAgent={onUpdateAgent}
                  onConnect={() => setConnectAgentId(selectedAgent.id)}
                  onDisconnect={() => onDisconnectAgent(selectedAgent.id)}
                  onToggleWebhook={(webhook, enabled) => onUpdateWebhook(webhook.id, { enabled })}
                  onClose={() => { setSelectedAgentId(null); setEditingId(null); }}
                  backButtonClass={AGENTS_SPLIT_ONLY_BELOW}
                />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * The agent form's runtime/model selects and its Cancel/Save pair — ONE
 * definition, mounted twice (pinned to the top of the edit pane and to the
 * bottom of it) so the two can never drift apart. Everything it shows is a
 * prop, so both mounts read the same state and either one saves the same form.
 *
 * The dormant one is hidden with `visibility`, NOT `display: none`, and this is
 * load-bearing rather than a style choice: `display: none` takes the bar out of
 * the flow, which shortens the scrolled content, which makes the browser adjust
 * `scrollTop` to anchor what you were looking at — and that adjustment feeds
 * straight back into the decision that hid it. Measured in Chrome, the two bars
 * flickered against each other around the swap point and settled on the wrong
 * one. `visibility: hidden` keeps both boxes in the flow, so the swap changes no
 * geometry at all and the decision is stable. It is still a real hide: an
 * invisible bar paints nothing (the form scrolls under it as if it were not
 * there), takes no clicks, takes no focus, and is not in the accessibility tree,
 * so a screen reader is never offered two Save buttons.
 */
function AgentFormActionBar({
  barRef,
  placement,
  dormant,
  runMode,
  runtime,
  runtimeChoices,
  model,
  modelChoices,
  canSubmit,
  submitting,
  submitLabel,
  submitIcon,
  onRunModeChange,
  onRuntimeChange,
  onModelChange,
  onCancel,
  onSubmit,
}: {
  barRef: React.RefObject<HTMLDivElement | null>;
  placement: 'top' | 'bottom';
  /** Initial state only — after mount the pane toggles `invisible` on the ref. */
  dormant?: boolean;
  runMode: 'builtin' | 'daemon' | 'sandbox';
  runtime: AgentExecutionRuntime;
  runtimeChoices: AgentRuntimeChoice[];
  model: string;
  modelChoices: { id: string; label: string }[];
  canSubmit: boolean;
  submitting: boolean;
  submitLabel: string;
  submitIcon: React.ReactNode;
  onRunModeChange: (value: 'builtin' | 'daemon' | 'sandbox') => void;
  onRuntimeChange: (value: AgentExecutionRuntime) => void;
  onModelChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      ref={barRef}
      // Pinned by the browser, not by measured offsets in JS: `sticky` against
      // the pane's own scrollport. The negative margin cancels the pane's side
      // padding so the bar spans the full width and nothing scrolls past it
      // through a gutter. The pane deliberately carries NO vertical padding —
      // that lives on the field group inside, so the sticky edge is the pane's
      // own edge and no sliver of scrolling text shows above the pinned bar.
      className={cn(
        'sticky z-10 -mx-3 flex flex-wrap items-center gap-2 bg-card/85 px-3 py-2 backdrop-blur-md',
        placement === 'top' ? 'top-0 border-b' : 'bottom-0 border-t',
        dormant && 'invisible',
      )}
    >
      <NativeSelect
        value={runMode}
        onChange={e => onRunModeChange(e.target.value === 'daemon' ? 'daemon' : 'builtin')}
        size="sm"
        className="max-w-48"
        aria-label="Agent execution location"
      >
        <NativeSelectOption value="builtin">Built-in</NativeSelectOption>
        <NativeSelectOption value="daemon">Remote</NativeSelectOption>
        {/* Not an offer — it is disabled, and only exists for a row that is
            already one. Sandbox was withdrawn as a runtime you can choose, but
            a <select> whose value matches no option silently falls back to the
            FIRST one, so without this a sandbox agent would read as "Built-in"
            while its sandbox settings sat open right below. Measured, not
            assumed: selectedIndex came back 0. */}
        {runMode === 'sandbox' && (
          <NativeSelectOption value="sandbox" disabled>Sandbox (retired)</NativeSelectOption>
        )}
      </NativeSelect>
      {runMode === 'daemon' && (
        <NativeSelect
          value={runtime}
          onChange={event => onRuntimeChange(event.target.value as AgentExecutionRuntime)}
          size="sm"
          className="max-w-72"
          aria-label="Agent execution runtime"
        >
          {runtimeChoices.map(choice => (
            <NativeSelectOption key={choice.id} value={choice.id}>
              {choice.label} — {runtimeChoiceNote(choice)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      {/* Codex takes ANY model id — the daemon passes it straight through as
          `codex --model <id>` — so a fixed select can only ever be wrong the
          moment OpenAI ships a new name. It also only ever offered "Codex
          default", which is what made picking the Codex runtime look like the
          model list had stopped updating. Free text with suggestions is the
          honest shape: everything the daemon accepts is reachable, and the ids
          we do know about are one keystroke away. Blank means "Codex default",
          which is the 'auto' the rest of the form already speaks. */}
      {runMode === 'daemon' && runtime === 'codex' ? (
        <>
          <Input
            value={model === 'auto' ? '' : model}
            onChange={e => onModelChange(e.target.value.trim() || 'auto')}
            list={CODEX_MODEL_LIST_ID}
            className="h-8 max-w-56 text-sm"
            placeholder="Codex default"
            aria-label="Agent model"
            spellCheck={false}
          />
          <datalist id={CODEX_MODEL_LIST_ID}>
            {modelChoices
              .filter(option => option.id !== 'auto')
              .map(option => <option key={option.id} value={option.id} />)}
          </datalist>
        </>
      ) : (
        <NativeSelect
          value={model}
          onChange={e => onModelChange(e.target.value)}
          size="sm"
          className="max-w-56"
          aria-label="Agent model"
        >
          {modelChoices.map(option => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      <div className="flex-1" />
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        <X data-icon="inline-start" />
        Cancel
      </Button>
      <Button type="button" size="sm" onClick={onSubmit} disabled={!canSubmit || submitting}>
        {submitIcon}
        {submitLabel}
      </Button>
    </div>
  );
}

function AgentForm({
  name,
  avatar,
  openPetAvatarId,
  accentColor,
  handle,
  description,
  systemPrompt,
  soul,
  instructions,
  tools,
  skills,
  model,
  runMode,
  runtime,
  runtimeChoices,
  capabilities,
  skillSuggestions,
  onNameChange,
  onAvatarChange,
  onOpenPetAvatarChange,
  onAccentColorChange,
  onHandleChange,
  onDescriptionChange,
  onSystemPromptChange,
  onSoulChange,
  onInstructionsChange,
  onToolsChange,
  onSkillsChange,
  onModelChange,
  onRunModeChange,
  onRuntimeChange,
  sandboxProvider,
  sandboxConfig,
  onSandboxProviderChange,
  onSandboxConfigChange,
  onCancel,
  onSubmit,
  submitting = false,
  submitLabel,
  submitIcon,
  extraSections = null,
}: {
  name: string;
  avatar: string;
  openPetAvatarId: string;
  accentColor: string;
  handle: string;
  description: string;
  systemPrompt: string;
  soul: string;
  instructions: string;
  tools: string;
  skills: string;
  model: string;
  runMode: 'builtin' | 'daemon' | 'sandbox';
  runtime: AgentExecutionRuntime;
  runtimeChoices: AgentRuntimeChoice[];
  sandboxProvider: string;
  sandboxConfig: string;
  capabilities: SystemCapabilities | null;
  /** Every skill name this workspace knows, for the Skills field's menu. */
  skillSuggestions: SkillSuggestion[];
  onNameChange: (value: string) => void;
  onAvatarChange: (value: string) => void;
  onOpenPetAvatarChange: (pet: OpenPet) => void;
  onAccentColorChange: (value: string) => void;
  onHandleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onSoulChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
  onToolsChange: (value: string) => void;
  onSkillsChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onRunModeChange: (value: 'builtin' | 'daemon' | 'sandbox') => void;
  onRuntimeChange: (value: AgentExecutionRuntime) => void;
  onSandboxProviderChange: (value: string) => void;
  onSandboxConfigChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** Write in flight — the submit button must not fire a second one. */
  submitting?: boolean;
  submitLabel: string;
  submitIcon: React.ReactNode;
  /**
   * Extra form sections rendered above the submit row — the edit screen slots
   * the voice editor here so its draft is committed by the SAME Save button as
   * every other field, instead of persisting on change from a view screen.
   */
  extraSections?: React.ReactNode;
}) {
  const options = modelOptionsForRuntime(model, runMode, runtime);
  const canSubmit = Boolean(name.trim());
  const paneRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [openPets, setOpenPets] = useState<OpenPet[]>([]);
  const [avatarTab, setAvatarTab] = useState<'icon' | 'avatar' | 'openpets' | 'upload'>('icon');
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFeaturedOpenPets().then(pets => {
      if (!cancelled) setOpenPets(pets);
    }).catch(() => {
      if (!cancelled) setOpenPets([]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The action bar follows the scroll: top bar for the first half of the
  // travel, bottom bar after it. Done by toggling one class on two refs rather
  // than through React state, because this fires on every scroll frame of a
  // pane that can be several screens long — a setState per frame would
  // re-render every field in the form, and every controlled input in it, just
  // to move one row. A ResizeObserver covers the two ways the geometry can
  // change without a scroll: the window being resized, and the form growing or
  // shrinking (the Advanced disclosure, the voice section, the avatar tabs).
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const apply = () => {
      const placement = agentFormBarPlacement(pane.scrollTop, pane.scrollHeight, pane.clientHeight);
      topBarRef.current?.classList.toggle('invisible', placement !== 'top');
      bottomBarRef.current?.classList.toggle('invisible', placement !== 'bottom');
    };
    apply();
    pane.addEventListener('scroll', apply, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    observer?.observe(pane);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      pane.removeEventListener('scroll', apply);
      observer?.disconnect();
    };
  }, []);

  const actionBarProps = {
    runMode,
    runtime,
    runtimeChoices,
    model,
    modelChoices: options,
    canSubmit,
    submitting,
    submitLabel,
    submitIcon,
    onRunModeChange,
    onRuntimeChange: (value: AgentExecutionRuntime) => {
      onRuntimeChange(value);
      // Was one-directional: it cleared the model on the way OUT of Claude but
      // not on the way back IN, so Codex -> Claude left a `gpt-…` id selected
      // and the Claude picker re-offered it as "gpt-5.6-sol (saved)". The rule
      // is narrow on purpose — it only drops an id that belongs to a different
      // runtime, so a shared/custom model the user set is left alone.
      if (!modelSurvivesRuntimeChange(model, value)) onModelChange('auto');
    },
    onModelChange,
    onCancel,
    onSubmit,
  };

  const handleUploadAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onAvatarChange(reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    // The form OWNS its scroll pane, so the sticky bars have a scrollport to
    // pin against and both call sites (create + edit) get the same behaviour
    // from one place.
    <div ref={paneRef} className="min-h-0 flex-1 overflow-y-auto px-3">
    <FieldGroup ref={contentRef} className="agent-form-fields gap-3 py-3">
      <AgentFormActionBar {...actionBarProps} barRef={topBarRef} placement="top" />
      <div className="grid grid-cols-[4.5rem_1fr_10rem] gap-2">
        <Field>
          <FieldLabel>Preview</FieldLabel>
          <div className="grid aspect-square place-items-center overflow-hidden rounded-xl border bg-muted text-lg font-semibold">
            <AgentAvatarPreview value={avatar} className="size-full" />
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-name">Name</FieldLabel>
          <Input
            id="agent-name"
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder="Agent name"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-handle">Handle</FieldLabel>
          <Input
            id="agent-handle"
            value={handle}
            onChange={e => onHandleChange(e.target.value)}
            placeholder={`@${agentHandle(name || 'agent')}`}
          />
        </Field>
      </div>

      <Tabs value={avatarTab} onValueChange={value => setAvatarTab(value as typeof avatarTab)} className="agent-avatar-tabs gap-3">
        <TabsList className="grid h-10 w-full grid-cols-4 rounded-xl">
          <TabsTrigger value="icon">Icon</TabsTrigger>
          <TabsTrigger value="avatar">Avatar</TabsTrigger>
          <TabsTrigger value="openpets">OpenPets</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
        </TabsList>
        <TabsContent value="icon" className="mt-0">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-2">
            {AGENT_ICON_CHOICES.map(choice => {
              const Icon = choice.icon;
              return (
                <button
                  key={choice.value}
                  type="button"
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-lg border bg-muted/40 transition hover:border-primary/60',
                    avatar === choice.value && 'border-primary ring-2 ring-primary/40',
                  )}
                  onClick={() => onAvatarChange(choice.value)}
                  title={choice.label}
                  aria-label={`Use ${choice.label} icon`}
                >
                  <Icon className="size-5" />
                </button>
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="avatar" className="mt-0">
          <div className="agent-avatar-grid grid max-h-72 grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-2 overflow-y-auto pr-1">
            {AGENT_AVATAR_CHOICES.map(choice => (
              <button
                key={choice.id}
                type="button"
                className={cn(
                  'agent-avatar-tile flex aspect-square items-center justify-center rounded-lg border bg-muted/40 p-1.5 transition hover:border-primary/60',
                  avatar === choice.src && 'border-primary ring-2 ring-primary/40',
                )}
                onClick={() => onAvatarChange(choice.src)}
                title={choice.label}
                aria-label={`Use ${choice.label} avatar`}
              >
                <img src={choice.src} alt="" className="agent-avatar-tile-image" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="openpets" className="mt-0">
          {openPets.length > 0 ? (
            <div className="agent-avatar-grid grid max-h-72 grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-2 overflow-y-auto pr-1">
              {openPets.map(pet => (
                <button
                  key={pet.id}
                  type="button"
                  className={cn(
                    'agent-avatar-tile flex aspect-square items-center justify-center rounded-lg border bg-muted/40 p-1.5 transition hover:border-primary/60',
                    openPetAvatarId === pet.id && 'border-primary ring-2 ring-primary/40',
                  )}
                  onClick={() => onOpenPetAvatarChange(pet)}
                  title={pet.displayName}
                  aria-label={`Use ${pet.displayName} OpenPets avatar`}
                >
                  <AgentAvatarPreview value={openPetAvatarSrc(pet)} className="size-full" />
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">No OpenPets available.</div>
          )}
        </TabsContent>
        <TabsContent value="upload" className="mt-0">
          <button
            type="button"
            className="flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 text-sm text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
            onClick={() => uploadInputRef.current?.click()}
          >
            <Upload className="size-5" />
            Choose an image
            <span className="text-xs text-muted-foreground/80">PNG, JPG, GIF</span>
          </button>
          <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadAvatar} />
        </TabsContent>
      </Tabs>

      <Field>
        <FieldLabel htmlFor="agent-accent-color">Accent color</FieldLabel>
        <div className="agent-accent-picker flex min-w-0 flex-wrap items-center gap-2">
          {AGENT_ACCENT_CHOICES.map(choice => (
            <button
              key={choice}
              type="button"
              className={cn(
                'agent-accent-swatch size-8 rounded-lg border transition',
                validAgentAccentColor(accentColor) === choice && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
              )}
              style={{ backgroundColor: choice }}
              onClick={() => onAccentColorChange(choice)}
              aria-label={`Use accent ${choice}`}
              title={choice}
            />
          ))}
          <input
            id="agent-accent-color"
            type="color"
            value={validAgentAccentColor(accentColor)}
            onChange={event => onAccentColorChange(event.target.value)}
            className="agent-accent-color-input h-8 w-10 cursor-pointer rounded-lg border border-input bg-transparent p-1"
            aria-label="Custom accent color"
          />
        </div>
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-description">Description</FieldLabel>
        <Input
          id="agent-description"
          value={description}
          onChange={e => onDescriptionChange(e.target.value)}
          placeholder="Short description"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-system-prompt">System Prompt</FieldLabel>
        <Textarea
          id="agent-system-prompt"
          value={systemPrompt}
          onChange={e => onSystemPromptChange(e.target.value)}
          placeholder="Optional system prompt"
          rows={4}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-soul">Soul</FieldLabel>
        <Input
          id="agent-soul"
          value={soul}
          onChange={e => onSoulChange(e.target.value)}
          placeholder="Tone, taste, and decision style"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
        <Textarea
          id="agent-instructions"
          value={instructions}
          onChange={e => onInstructionsChange(e.target.value)}
          placeholder="Operational instructions, constraints, and handoff rules"
          rows={3}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-tools">Tools</FieldLabel>
        <Input
          id="agent-tools"
          value={tools}
          onChange={e => onToolsChange(e.target.value)}
          placeholder="claude, codex, opencode"
        />
        {capabilities && (
          <div className="flex flex-wrap gap-1">
            {capabilities.clis.filter(cli => cli.available).slice(0, 10).map(cli => (
              <Button key={cli.id} type="button" variant="outline" size="xs" onClick={() => onToolsChange(addToken(tools, cli.id))}>
                {cli.label}
              </Button>
            ))}
          </div>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-skills">Skills</FieldLabel>
        {/* Chips, not a comma-separated string the human has to punctuate. The
            row of quick-pick buttons this replaces offered only the backend
            host's skill libraries; the menu below the field offers those AND
            every skill the workspace's agents actually carry, and still accepts
            a name nothing has heard of — this field is how a new one arrives. */}
        <SkillChipsInput
          id="agent-skills"
          value={skills}
          onChange={onSkillsChange}
          suggestions={skillSuggestions}
        />
      </Field>

      {extraSections}

      {/* Unreachable from the runtime picker, which now offers Built-in and
          Remote only — kept because an agent row saved as `sandbox` before the
          option was removed must still show and round-trip its settings. */}
      {runMode === 'sandbox' && (
        <details className="rounded-lg border bg-card/40 px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">Advanced</summary>
          <div className="mt-2 flex flex-col gap-2">
            <Field>
              <label className="text-xs text-muted-foreground">Sandbox provider</label>
              <NativeSelect value={sandboxProvider} onChange={e => onSandboxProviderChange(e.target.value)} size="sm" aria-label="Sandbox provider">
                <NativeSelectOption value="e2b">e2b (default)</NativeSelectOption>
                <NativeSelectOption value="vercel" disabled>Vercel Sandbox (coming soon)</NativeSelectOption>
                <NativeSelectOption value="daytona" disabled>Daytona (coming soon)</NativeSelectOption>
                <NativeSelectOption value="morph" disabled>Morph (coming soon)</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <label className="text-xs text-muted-foreground">Config (JSON)</label>
              <Textarea value={sandboxConfig} onChange={e => onSandboxConfigChange(e.target.value)} rows={3} placeholder='{"repoUrl":"https://github.com/you/repo.git","template":"base"}' className="font-mono text-xs" />
            </Field>
          </div>
        </details>
      )}
      <AgentFormActionBar {...actionBarProps} barRef={bottomBarRef} placement="bottom" dormant />
    </FieldGroup>
    </div>
  );
}

function AgentDetailPane({
  agent,
  isEditing,
  confirmDelete,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onToggleEnabled,
  capabilities,
  runtimeChoices,
  skillSuggestions,
  webhooks,
  connections,
  roster,
  workspaceId,
  onUpdateAgent,
  onConnect,
  onDisconnect,
  onToggleWebhook,
  onClose,
  backButtonClass,
  onSaveAsTemplate,
  templateSaved,
}: {
  agent: WorkspaceAgent | null;
  isEditing: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Partial<WorkspaceAgent>) => void;
  onDelete: () => void;
  /** Save this agent's PROSE as a reusable template. Carries no authority. */
  onSaveAsTemplate: () => void;
  /** True briefly after a successful save, so the click has a visible result. */
  templateSaved: boolean;
  onToggleEnabled: () => void;
  capabilities: SystemCapabilities | null;
  runtimeChoices: AgentRuntimeChoice[];
  /** Passed straight through to the Skills field; built once for both forms. */
  skillSuggestions: SkillSuggestion[];
  webhooks: AgentWebhook[];
  connections: AgentConnection[];
  /**
   * Every agent in the workspace, so the voice preview plays exactly what a
   * huddle would play. Voice assignment is COORDINATED across the roster (two
   * agents never share a voice while the device has a spare), so resolving this
   * agent on its own would preview a voice it may not actually get.
   */
  roster: WorkspaceAgent[];
  /** Needed by the Access section: revoking a permanent grant is a manage-gated route, not a table write. */
  workspaceId: string | null;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onConnect: () => void;
  onDisconnect: () => Promise<unknown>;
  onToggleWebhook: (webhook: AgentWebhook, enabled: boolean) => Promise<AgentWebhook | null>;
  /** Deselects the agent — the split view's close control. */
  onClose?: () => void;
  /**
   * Classes for the back affordance, shown only when the detail has replaced
   * the list (the narrow fallback) — same contract as InboxDetail's.
   */
  backButtonClass?: string;
}) {
  const [editName, setEditName] = useState('');
  const [editAvatar, setEditAvatar] = useState(DEFAULT_AGENT_AVATAR);
  const [editOpenPetAvatarId, setEditOpenPetAvatarId] = useState('');
  const [editAccentColor, setEditAccentColor] = useState(DEFAULT_AGENT_ACCENT);
  const [editHandle, setEditHandle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSystemPrompt, setEditSystemPrompt] = useState('');
  const [editSoul, setEditSoul] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editTools, setEditTools] = useState('');
  const [editSkills, setEditSkills] = useState('');
  const [editModel, setEditModel] = useState('auto');
  const [editRunMode, setEditRunMode] = useState<'builtin' | 'daemon' | 'sandbox'>('builtin');
  const [editRuntime, setEditRuntime] = useState<AgentExecutionRuntime>('claude');
  const [editRuntimeSelectionDirty, setEditRuntimeSelectionDirty] = useState(false);
  const [editSandboxProvider, setEditSandboxProvider] = useState('e2b');
  const [editSandboxConfig, setEditSandboxConfig] = useState('{}');
  // The voice DRAFT for the edit form. The voice controls used to live in the
  // read-only detail view and persisted on every change; they now render only
  // while editing, and this draft is committed by Save like any other field.
  const [editVoice, setEditVoice] = useState<AgentVoicePreference>({});
  const [disconnecting, setDisconnecting] = useState(false);
  // What the form was seeded from, normalized exactly like a save. handleSave
  // diffs against this so it submits ONLY the fields the human changed in THIS
  // edit session: an untouched identity field sent along for the ride would be
  // recorded as a human choice (identity.human_set, shared/agentIdentity.cjs)
  // and lock the field at its current — possibly empty — value forever.
  const editBaseline = useRef<Partial<WorkspaceAgent>>({});
  const voiceBaseline = useRef<AgentVoicePreference>({});

  useEffect(() => {
    if (!agent) return;
    const seed = {
      name: agent.name,
      avatar: agent.avatar || DEFAULT_AGENT_AVATAR,
      openPetAvatarId: agent.openpet_avatar_id || '',
      accentColor: agentAccentColor(agent),
      handle: agent.handle || agentHandle(agent.name),
      description: agent.description || '',
      systemPrompt: agent.system_prompt || '',
      soul: agent.soul || '',
      instructions: agent.instructions || '',
      tools: joinList(agent.tools),
      skills: joinList(agent.skills),
      model: agent.model || 'auto',
      runMode: (agent.run_mode === 'daemon' ? 'daemon' : agent.run_mode === 'sandbox' ? 'sandbox' : 'builtin') as 'builtin' | 'daemon' | 'sandbox',
      runtime: agentExecutionRuntime(agent),
      metadata: { ...(agent.metadata || {}) },
      sandboxProvider: agent.sandbox_provider || 'e2b',
      sandboxConfig: JSON.stringify(agent.sandbox_config || {}, null, 2),
    };
    setEditName(seed.name);
    setEditAvatar(seed.avatar);
    setEditOpenPetAvatarId(seed.openPetAvatarId);
    setEditAccentColor(seed.accentColor);
    setEditHandle(seed.handle);
    setEditDescription(seed.description);
    setEditSystemPrompt(seed.systemPrompt);
    setEditSoul(seed.soul);
    setEditInstructions(seed.instructions);
    setEditTools(seed.tools);
    setEditSkills(seed.skills);
    setEditModel(seed.model);
    setEditRunMode(seed.runMode);
    setEditRuntime(seed.runtime);
    setEditRuntimeSelectionDirty(false);
    setEditSandboxProvider(seed.sandboxProvider);
    setEditSandboxConfig(seed.sandboxConfig);
    const seedVoice = readAgentVoice(agent);
    setEditVoice(seedVoice);
    voiceBaseline.current = seedVoice;
    setDisconnecting(false);
    editBaseline.current = agentFormUpdates(seed);
  }, [agent?.id]);

  if (!agent) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>Select an agent</EmptyTitle>
          <EmptyDescription>Choose an agent from the list to view details or edit its setup.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const activeConnections = connections.filter(connection => connection.status !== 'offline');
  const ampAgent = isAmpAgent(agent);
  const ampRuntime = activeConnections.map(connection => connection.capabilities?.runtimes?.amp).find(Boolean);
  const tools = normalizeList(agent.tools);
  const skills = normalizeList(agent.skills);
  const agentActive = isAgentActive(agent);
  const isConnected = activeConnections.length > 0;

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSave = () => {
    // A SPARSE diff against the seed baseline, not the full form. Submitting an
    // untouched field would (a) human-lock identity fields the human never
    // chose — permanently, and at '' when they were empty — and (b) overwrite
    // a concurrent edit with the stale value this form was opened on.
    const candidate = agentFormUpdates({
      name: editName,
      avatar: editAvatar,
      openPetAvatarId: editOpenPetAvatarId,
      accentColor: editAccentColor,
      handle: editHandle,
      description: editDescription,
      systemPrompt: editSystemPrompt,
      soul: editSoul,
      instructions: editInstructions,
      tools: editTools,
      skills: editSkills,
      model: editModel,
      runMode: editRunMode,
      runtime: editRuntime,
      metadata: { ...(agent.metadata || {}) },
      sandboxProvider: editSandboxProvider,
      sandboxConfig: editSandboxConfig,
    });
    const baseline = editBaseline.current as Record<string, unknown>;
    const updates: Partial<WorkspaceAgent> = {};
    for (const key of Object.keys(candidate) as (keyof WorkspaceAgent)[]) {
      const next = (candidate as Record<string, unknown>)[key];
      if (JSON.stringify(next) !== JSON.stringify(baseline[key])) {
        (updates as Record<string, unknown>)[key] = next;
      }
    }
    // Runtime/location are an execution boundary. Realtime can change them
    // while this form is open; an unrelated description/avatar save must not
    // write the stale draft back over that newer choice. Metadata has no other
    // editable fields in this form, so omit both sparse fields unless the human
    // actually touched one of the two execution selectors.
    if (!editRuntimeSelectionDirty) {
      delete updates.run_mode;
      delete updates.metadata;
    }
    // The voice draft rides the same rule: only a CHANGED voice is sent, as
    // `identity.voice` — the one identity key a client may write. The server
    // grafts it onto the stored column and records the human's choice.
    if (JSON.stringify(editVoice) !== JSON.stringify(voiceBaseline.current)) {
      updates.identity = { voice: editVoice };
    }
    if (Object.keys(updates).length === 0) {
      // Nothing changed — closing the editor without a write is the whole point.
      onCancelEdit();
      return;
    }
    onSave(updates);
  };

  if (isEditing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" style={agentAccentStyle(agent)}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <Pencil className="size-4 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">Edit {agent.name}</span>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onCancelEdit} aria-label="Close editor">
            <X />
          </Button>
        </div>
          <AgentForm
            name={editName}
            avatar={editAvatar}
            openPetAvatarId={editOpenPetAvatarId}
            accentColor={editAccentColor}
            handle={editHandle}
            description={editDescription}
            systemPrompt={editSystemPrompt}
            soul={editSoul}
            instructions={editInstructions}
            tools={editTools}
            skills={editSkills}
            model={editModel}
            runMode={editRunMode}
            runtime={editRuntime}
            runtimeChoices={runtimeChoices}
            capabilities={capabilities}
            skillSuggestions={skillSuggestions}
            onNameChange={setEditName}
            onAvatarChange={(value) => {
              setEditAvatar(value);
              setEditOpenPetAvatarId('');
            }}
            onOpenPetAvatarChange={(pet) => {
              setEditAvatar(openPetAvatarSrc(pet));
              setEditOpenPetAvatarId(pet.id);
            }}
            onAccentColorChange={setEditAccentColor}
            onHandleChange={setEditHandle}
            onDescriptionChange={setEditDescription}
            onSystemPromptChange={setEditSystemPrompt}
            onSoulChange={setEditSoul}
            onInstructionsChange={setEditInstructions}
            onToolsChange={setEditTools}
            onSkillsChange={setEditSkills}
            onModelChange={setEditModel}
            onRunModeChange={(value) => {
              setEditRunMode(value);
              setEditRuntimeSelectionDirty(true);
            }}
            onRuntimeChange={(value) => {
              setEditRuntime(value);
              setEditRuntimeSelectionDirty(true);
            }}
            sandboxProvider={editSandboxProvider}
            sandboxConfig={editSandboxConfig}
            onSandboxProviderChange={setEditSandboxProvider}
            onSandboxConfigChange={setEditSandboxConfig}
            onCancel={onCancelEdit}
            onSubmit={handleSave}
            submitLabel="Save"
            submitIcon={<Save data-icon="inline-start" />}
            extraSections={(
              <VoiceSection
                agent={agent}
                roster={roster}
                mode="edit"
                draft={editVoice}
                onDraftChange={setEditVoice}
              />
            )}
          />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={agentAccentStyle(agent)}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {onClose && backButtonClass && (
          <Button type="button" variant="ghost" size="icon-xs" className={cn('shrink-0', backButtonClass)} onClick={onClose} aria-label="Back to all agents">
            <ArrowLeft />
          </Button>
        )}
        <Bot className="size-4 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">Agent details</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onEdit} aria-label={`Edit ${agent.name}`}>
          <Pencil />
        </Button>
        {onClose && (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close agent details">
            <X />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="agent-detail-summary flex min-w-0 items-stretch gap-3 rounded-lg border bg-muted/25 p-3">
          <div className="agent-detail-avatar grid min-h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted text-lg font-semibold sm:w-28">
            <AgentAvatarPreview value={agent.avatar || DEFAULT_AGENT_AVATAR} className="size-full" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{agent.name}</div>
            <div className="text-sm text-muted-foreground">@{agent.handle || agentHandle(agent.name)}</div>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{agent.description || 'No description'}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge variant={agent.run_mode === 'daemon' ? 'default' : 'outline'}>
                {agentTransportLabel(agent.run_mode)}
              </Badge>
              {agent.run_mode === 'daemon' && <Badge variant="outline">{agentExecutionRuntime(agent)}</Badge>}
              <Badge variant="outline">{displayModel(agent.model)}</Badge>
              <ConnectionDot count={activeConnections.length} busy={activeConnections.some(c => c.status === 'busy')} />
              {!agentActive && <Badge variant="secondary">deactivated</Badge>}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant={agentActive ? 'secondary' : 'outline'}
            size="sm"
            onClick={onToggleEnabled}
            disabled={isConnected}
            title={isConnected ? 'Disconnect before deactivating' : undefined}
          >
            <Power data-icon="inline-start" />
            {agentActive ? 'Deactivate' : 'Activate'}
          </Button>
          {isConnected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              <Unplug data-icon="inline-start" />
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onConnect}
              disabled={!agentActive}
            >
              <Plug data-icon="inline-start" />
              Connect
            </Button>
          )}
          {/* Copies this agent's PROSE only. permission_mode, metadata
              (host_folders, sandbox_skills) and the connect token are not
              fields of a template — the table has no column for them. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSaveAsTemplate}
            disabled={templateSaved}
            title="Save this agent's prompt, tools and skills as a reusable template. Its permissions, folder access and connect token are not copied."
          >
            {templateSaved ? <Check data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
            {templateSaved ? 'Saved as template' : 'Save as template'}
          </Button>
          <Button
            type="button"
            variant={confirmDelete ? 'destructive' : 'ghost'}
            size="sm"
            onClick={onDelete}
            disabled={isConnected || agentActive}
            title={isConnected || agentActive ? 'Disconnect and deactivate before deleting' : undefined}
          >
            <Trash2 data-icon="inline-start" />
            {confirmDelete ? 'Confirm delete' : 'Delete'}
          </Button>
        </div>

        <div className="mt-3 grid gap-3">
          <AgentDetailSection title="Runtime">
            <AgentDetailField label="Location" value={agentTransportLabel(agent.run_mode)} />
            {agent.run_mode === 'daemon' && <AgentDetailField label="Runtime" value={agentExecutionRuntime(agent) === 'amp' ? 'Amp (managed orb)' : agentExecutionRuntime(agent)} />}
            <AgentDetailField label="Model" value={displayModel(agent.model)} />
            <AgentDetailField label="Updated" value={formatAgentDate(agent.updated_at)} />
            {ampAgent && !isConnected && <div className="text-xs text-muted-foreground">Connect this agent to a machine running agensis-agent and Amp.</div>}
            {ampAgent && isConnected && !ampRuntime && <div className="text-xs text-amber-600 dark:text-amber-400">Amp status is unavailable. Update agensis-agent on the connected machine.</div>}
            {ampAgent && ampRuntime?.available && (
              <div className="text-xs text-emerald-600 dark:text-emerald-400">
                Amp ready{ampRuntime.project?.name ? ` · ${ampRuntime.project.name}` : ''}{ampRuntime.version ? ` · ${ampRuntime.version}` : ''}
              </div>
            )}
            {ampAgent && ampRuntime && !ampRuntime.available && (
              <div className="text-xs text-amber-600 dark:text-amber-400">{ampRuntimeStatusText(ampRuntime.reason)}</div>
            )}
          </AgentDetailSection>

          <VoiceSection agent={agent} roster={roster} mode="view" />

          {agent.run_mode === 'daemon' && (
            <HostFoldersSection agent={agent} onUpdateAgent={onUpdateAgent} />
          )}

          {agent.run_mode === 'daemon' && (
            <AccessSection agent={agent} workspaceId={workspaceId} onUpdateAgent={onUpdateAgent} />
          )}

          {activeConnections.length > 0 && (
            <AgentDetailSection title="Connections">
              <div className="space-y-1.5">
                {activeConnections.map(connection => {
                  // A freshly-connected daemon can arrive with `capabilities` present but its
                  // skills/clis/mcpServers arrays not yet populated (the capability payload lands on
                  // a later heartbeat). Coerce every field to an array before reading `.length` so a
                  // single in-flight connection row can never white-screen the whole workspace.
                  const caps = connection.capabilities;
                  const capSkills = Array.isArray(caps?.skills) ? caps.skills : [];
                  const capClis = Array.isArray(caps?.clis) ? caps.clis : [];
                  const capMcpServers = Array.isArray(caps?.mcpServers) ? caps.mcpServers : [];
                  const capSharedModels = Array.isArray(caps?.sharedModels) ? caps.sharedModels : [];
                  const capAmp = caps?.runtimes?.amp;
                  const hasCapabilities = capSkills.length > 0 || capClis.length > 0 || capMcpServers.length > 0 || capSharedModels.length > 0 || Boolean(capAmp);
                  return (
                    <div key={connection.id} className="rounded-md border bg-muted/35 px-2 py-1.5 text-xs">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Monitor className="size-3 shrink-0" />
                        <span className="font-medium text-foreground">{connection.status}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{connection.host || connection.cwd || 'remote'}</span>
                        {connection.last_seen_at && (
                          <span className="shrink-0 text-muted-foreground/70" title={`Last heartbeat: ${formatAgentDate(connection.last_seen_at)}`}>
                            HB {formatRelativeTime(connection.last_seen_at)}
                          </span>
                        )}
                      </div>
                      {connection.cwd && <div className="mt-1 truncate text-muted-foreground" title={connection.cwd}>{connection.cwd}</div>}
                      {hasCapabilities && (
                        <div className="mt-1.5 space-y-1">
                          {capAmp && (
                            <div className={capAmp.available ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                              Amp: {capAmp.available ? `ready${capAmp.project?.name ? ` · ${capAmp.project.name}` : ''}` : ampRuntimeStatusText(capAmp.reason)}
                            </div>
                          )}
                          {capSkills.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">Skills:</span>
                              {capSkills.slice(0, 8).map(s => (
                                <span key={s} className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{s}</span>
                              ))}
                              {capSkills.length > 8 && <span className="text-muted-foreground/60">+{capSkills.length - 8}</span>}
                            </div>
                          )}
                          {capClis.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">CLIs:</span>
                              {capClis.map(c => (
                                <span key={c} className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono text-muted-foreground">{c}</span>
                              ))}
                            </div>
                          )}
                          {capMcpServers.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">MCP:</span>
                              {capMcpServers.slice(0, 6).map(m => (
                                <span key={m} className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{m}</span>
                              ))}
                              {capMcpServers.length > 6 && <span className="text-muted-foreground/60">+{capMcpServers.length - 6}</span>}
                            </div>
                          )}
                          {capSharedModels.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="shrink-0 text-muted-foreground/60">Shared models:</span>
                              {capSharedModels.slice(0, 6).map(model => (
                                <span key={model.id} className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{model.name || model.id}</span>
                              ))}
                              {capSharedModels.length > 6 && <span className="text-muted-foreground/60">+{capSharedModels.length - 6}</span>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </AgentDetailSection>
          )}

          <AgentDetailTokenSection title="Tools" items={tools} empty="No tools configured" />
          <AgentDetailTokenSection title="Skills" items={skills} empty="No skills configured" />

          {/* These three fields ARE markdown documents — soul especially, which
              the daemon mirrors to disk as soul.md — and they were rendered as
              raw pre-wrapped text, so headings, lists and emphasis showed as
              literal #, - and **. Rendered through the app's own markdown
              component (the one chat and the memory browser use, which builds
              elements itself and never injects HTML — soul is agent-authored,
              so that matters). Compact, because this is a narrow side pane and
              not a message body. */}
          {agent.system_prompt && (
            <AgentDetailSection title="System prompt">
              <div className="min-w-0 max-h-36 overflow-auto text-sm leading-relaxed">
                <MarkdownContent content={agent.system_prompt} compact />
              </div>
            </AgentDetailSection>
          )}
          {agent.instructions && (
            <AgentDetailSection title="Instructions">
              <div className="min-w-0 max-h-36 overflow-auto text-sm leading-relaxed">
                <MarkdownContent content={agent.instructions} compact />
              </div>
            </AgentDetailSection>
          )}
          {agent.soul && (
            <AgentDetailSection title="Soul">
              {/* No height cap: a soul is the one field a human reads in full,
                  and the pane already scrolls. min-w-0 + overflow-x matter
                  because .chat-markdown is a GRID, whose children default to
                  min-width:auto — a fenced code block would otherwise widen
                  this fixed-width pane instead of scrolling inside it. */}
              <div className="min-w-0 overflow-x-auto text-sm leading-relaxed">
                <MarkdownContent content={agent.soul} compact />
              </div>
            </AgentDetailSection>
          )}

          {webhooks.length > 0 && (
            <AgentDetailSection title="Webhooks">
              <div className="space-y-1.5">
                {webhooks.map(webhook => {
                  const url = webhookUrl(webhook.token);
                  return (
                    <div key={webhook.id} className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/35 px-2 py-1 text-xs">
                      <Link2 className="size-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate" title={url}>{webhook.name}</span>
                      <Button type="button" variant="ghost" size="icon-xs" onClick={() => void navigator.clipboard?.writeText(url)} aria-label={`Copy webhook for ${agent.name}`}>
                        <Copy />
                      </Button>
                      <Button
                        type="button"
                        variant={webhook.enabled ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        onClick={() => onToggleWebhook(webhook, !webhook.enabled)}
                        aria-label={webhook.enabled ? `Disable webhook for ${agent.name}` : `Enable webhook for ${agent.name}`}
                        title={webhook.enabled ? 'Enabled' : 'Disabled'}
                      >
                        <Power />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </AgentDetailSection>
          )}
        </div>
      </div>
    </div>
  );
}

interface SkillManifest {
  mcp: { endpoint: string; transport: string; tokenPlaceholder: string; configTemplate: unknown };
  install: { skillUrl: string; curlSkill: string; claudeMcpAdd: string };
  prompt: string;
  tools: Array<{ name: string; description: string }>;
}

type ConnectTab = 'cli' | 'mcp' | 'webhook';

// A short benefit line + a caveat, shown at the top of each Connect tab so the
// human picks the right connection method without guessing.
function ConnectExplainer({ benefit, note }: { benefit: string; note: string }) {
  return (
    <div className="rounded-lg border bg-muted/25 p-3 text-xs">
      <p className="text-foreground">{benefit}</p>
      <p className="mt-1.5 flex items-start gap-1.5 text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3 shrink-0" />
        <span>{note}</span>
      </p>
    </div>
  );
}

// One unified per-agent Connect dialog: CLI (local daemon), MCP client, or Webhook.
// Every tab is auto-scoped to `agent`, so there is no picker — you open it from the
// agent you want to connect. Replaces the old scattered Connect / Configure MCP /
// Webhook buttons and the workspace ConfigureMcpDialog.
function AgentConnectDialog({
  agent,
  open,
  onOpenChange,
  runtimeChoices,
  webhooks,
  onCreateWebhook,
  onToggleWebhook,
}: {
  agent: WorkspaceAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runtimeChoices: AgentRuntimeChoice[];
  webhooks: AgentWebhook[];
  onCreateWebhook: () => Promise<AgentWebhook | null>;
  onToggleWebhook: (webhook: AgentWebhook, enabled: boolean) => Promise<AgentWebhook | null>;
}) {
  const [tab, setTab] = useState<ConnectTab>('cli');

  // CLI (local daemon)
  const [cliCommand, setCliCommand] = useState('');
  const [cliError, setCliError] = useState('');
  const [cliBusy, setCliBusy] = useState(false);

  // MCP client
  const [manifest, setManifest] = useState<SkillManifest | null>(null);
  const [loadError, setLoadError] = useState('');
  const [token, setToken] = useState('');
  const [generating, setGenerating] = useState(false);
  const [tokenError, setTokenError] = useState('');

  // Webhook
  const [creatingWebhook, setCreatingWebhook] = useState(false);

  const handle = agent ? (agent.handle || agentHandle(agent.name)) : '';

  // Reset everything per-open: never carry a command/token across opens.
  useEffect(() => {
    if (!open) return;
    setTab('cli');
    setCliCommand('');
    setCliError('');
    setManifest(null);
    setLoadError('');
    setToken('');
    setTokenError('');
  }, [open, agent?.id]);

  // Load the MCP skill manifest once the dialog is open for an agent.
  useEffect(() => {
    if (!open || !agent) return;
    let cancelled = false;
    const params = new URLSearchParams({ name: agent.name, handle });
    fetch(apiUrl(`/backend/skill?${params.toString()}`), { headers: { ...apiAuthHeaders() } })
      .then(async (res) => {
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !payload?.data) {
          setLoadError('Could not load the MCP skill manifest from the backend.');
          return;
        }
        setManifest(payload.data as SkillManifest);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not reach the backend to load MCP details.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, agent?.id, agent?.name, handle]);

  if (!agent) return null;

  const placeholder = manifest?.mcp.tokenPlaceholder || 'aga_YOUR_AGENT_TOKEN';
  const withToken = (text: string) => (token ? text.split(placeholder).join(token) : text);
  const configJson = manifest ? withToken(JSON.stringify(manifest.mcp.configTemplate, null, 2)) : '';
  const claudeMcpAdd = manifest ? withToken(manifest.install.claudeMcpAdd) : '';

  const handleGenerateCli = async () => {
    setCliBusy(true);
    setCliError('');
    try {
      const response = await fetch(apiUrl(`/backend/agents/${agent.id}/connection-command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ handle, baseUrl: apiBaseUrl() }),
      });
      const payload = await response.json().catch(() => null);
      const command = payload?.data?.portableCommand || payload?.data?.command || payload?.data?.localCommand || '';
      if (!response.ok || !command) {
        setCliError(payload?.error?.message || 'Daemon websocket backend is not available.');
        return;
      }
      setCliCommand(command);
      void navigator.clipboard?.writeText(command);
    } catch {
      setCliError('Could not create a daemon connection command.');
    } finally {
      setCliBusy(false);
    }
  };

  const handleGenerateToken = async () => {
    setGenerating(true);
    setTokenError('');
    try {
      const response = await fetch(apiUrl(`/backend/agents/${agent.id}/connection-command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ handle, baseUrl: apiBaseUrl() }),
      });
      const payload = await response.json().catch(() => null);
      const newToken = payload?.data?.token || '';
      if (!response.ok || !newToken) {
        setTokenError(payload?.error?.message || 'Could not mint an agent token.');
        return;
      }
      setToken(newToken);
    } catch {
      setTokenError('Could not reach the backend to mint a token.');
    } finally {
      setGenerating(false);
    }
  };

  const handleCreateWebhook = async () => {
    setCreatingWebhook(true);
    try {
      await onCreateWebhook();
    } finally {
      setCreatingWebhook(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Plug className="size-4 text-primary" />
            Connect {agent.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Choose how something connects to @{handle} — a local CLI daemon, an MCP client, or an HTTP webhook.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as ConnectTab)} className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-4 pt-3">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="cli" className="gap-1.5"><Terminal className="size-3.5" />CLI</TabsTrigger>
              <TabsTrigger value="mcp" className="gap-1.5"><Plug className="size-3.5" />MCP</TabsTrigger>
              <TabsTrigger value="webhook" className="gap-1.5"><Link2 className="size-3.5" />Webhook</TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* CLI — local daemon */}
            <TabsContent value="cli" className="mt-0 space-y-4">
              <ConnectExplainer
                benefit={`Full power. Runs @${handle} on your machine with real tools — edit files, run shells, local MCP. Best for coding agents.`}
                note="Needs the agensis CLI installed, and the agent only runs while your daemon is up."
              />
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">Supported coding agents your daemon can run</p>
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
                  {runtimeChoices.map(runtime => (
                    <div
                      key={runtime.id}
                      className={cn(
                        'flex flex-col gap-1 rounded-lg border p-2.5',
                        agentExecutionRuntime(agent) === runtime.id ? 'border-primary/60 bg-primary/10' : 'border-border bg-card/50',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-xs font-semibold">{runtime.label}</span>
                        {agentExecutionRuntime(agent) === runtime.id && <Badge variant="outline" className="ml-auto text-[9px]">Selected</Badge>}
                      </div>
                      <span className={cn('text-[10px]', runtime.available ? 'text-emerald-500' : 'text-muted-foreground')}>
                        {runtimeChoiceNote(runtime)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <McpDialogSection icon={Terminal} title="Daemon connect command">
                <p className="text-xs text-muted-foreground">
                  Generate a one-line command, then run it where the daemon should execute. It&apos;s copied to your clipboard.
                </p>
                <Button type="button" size="sm" className="mt-2" onClick={handleGenerateCli} disabled={cliBusy}>
                  <RefreshCw data-icon="inline-start" className={cliBusy ? 'animate-spin' : undefined} />
                  {cliCommand ? 'Regenerate command' : 'Generate connect command'}
                </Button>
                {cliCommand && <CopyBlock value={cliCommand} className="mt-2" />}
                {cliError && <div className="mt-2 text-xs text-destructive">{cliError}</div>}
              </McpDialogSection>
            </TabsContent>

            {/* MCP client */}
            <TabsContent value="mcp" className="mt-0 space-y-4">
              <ConnectExplainer
                benefit={`Plug any MCP client (Claude Code, Cursor, Codex) into @${handle} with one token — no daemon required.`}
                note="The token authenticates as this agent; generating a new one replaces the old token."
              />
              {loadError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {loadError}
                </div>
              )}

              {/* Token */}
              <McpDialogSection icon={KeyRound} title="1. API key (agent token)">
                <p className="text-xs text-muted-foreground">
                  The token authenticates the agent as @{handle}. Tokens are stored hashed and shown
                  once — copy it now.
                </p>
                <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>Generating a token replaces the agent&apos;s previous one. If a daemon is
                    running for this agent, update it with the new token too.</span>
                </div>
                {token ? (
                  <CopyField value={token} label="Agent token" mono />
                ) : (
                  <div className="mt-2 text-xs text-muted-foreground">
                    No token generated yet — the config below uses a <code>{placeholder}</code> placeholder.
                  </div>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={token ? 'outline' : 'default'}
                  className="mt-2"
                  onClick={handleGenerateToken}
                  disabled={generating}
                >
                  <RefreshCw data-icon="inline-start" className={generating ? 'animate-spin' : undefined} />
                  {token ? 'Regenerate token' : 'Generate token'}
                </Button>
                {tokenError && <div className="mt-2 text-xs text-destructive">{tokenError}</div>}
              </McpDialogSection>

              {/* Endpoint + config */}
              <McpDialogSection icon={Globe} title="2. MCP endpoint & config">
                {manifest && <CopyField value={manifest.mcp.endpoint} label="Endpoint" mono />}
                <p className="mt-3 mb-1 text-xs text-muted-foreground">
                  Claude Code one-liner:
                </p>
                {manifest && <CopyBlock value={claudeMcpAdd} />}
                <p className="mt-3 mb-1 text-xs text-muted-foreground">
                  Or paste into your MCP client config (Claude Code <code>.mcp.json</code>, Codex
                  <code> ~/.codex/config.toml</code>, etc.):
                </p>
                {manifest && <CopyBlock value={configJson} />}
              </McpDialogSection>

              {/* Prompt */}
              <McpDialogSection icon={Sparkles} title="3. Agent prompt (optional)">
                <p className="text-xs text-muted-foreground">
                  Paste this into the agent so it knows it&apos;s now an agensis teammate and how to behave.
                </p>
                {manifest && <CopyBlock value={manifest.prompt} className="mt-2 max-h-44" />}
              </McpDialogSection>

              {/* Skill / marketplace */}
              <McpDialogSection icon={Wrench} title="4. Install as a skill (agentskills.io)">
                <p className="text-xs text-muted-foreground">
                  Give the agent durable know-how via the open Agent Skills format. Drop the skill into
                  any compatible client:
                </p>
                {manifest && <CopyBlock value={manifest.install.curlSkill} className="mt-2" />}
                <p className="mt-2 text-xs text-muted-foreground">
                  Claude Code plugin marketplace (git-hosted): add this repo, then install the
                  <code> agensis</code> plugin:
                </p>
                <CopyBlock
                  value={'/plugin marketplace add <your-org>/agensis\n/plugin install agensis@agensis'}
                  className="mt-2"
                />
              </McpDialogSection>
            </TabsContent>

            {/* Webhook */}
            <TabsContent value="webhook" className="mt-0 space-y-4">
              <ConnectExplainer
                benefit={`Wake @${handle} from an external event — CI failing, an issue opening, a monitor firing.`}
                note="The URL contains its credential. Treat it as a secret and create a replacement webhook if it is exposed."
              />
              <McpDialogSection icon={Link2} title="Webhook URLs">
                {webhooks.length > 0 ? (
                  <div className="space-y-1.5">
                    {webhooks.map(webhook => {
                      const url = webhookUrl(webhook.token);
                      return (
                        <div key={webhook.id} className="space-y-1.5 rounded-md border bg-background px-2 py-1.5">
                          <div className="flex min-w-0 items-center gap-1.5 text-xs">
                            <Link2 className="size-3 shrink-0" />
                            <span className="min-w-0 flex-1 truncate" title={url}>{webhook.name}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => void navigator.clipboard?.writeText(url)}
                              aria-label={`Copy webhook for ${agent.name}`}
                            >
                              <Copy />
                            </Button>
                            <Button
                              type="button"
                              variant={webhook.enabled ? 'secondary' : 'ghost'}
                              size="icon-xs"
                              onClick={() => onToggleWebhook(webhook, !webhook.enabled)}
                              aria-label={webhook.enabled ? `Disable webhook for ${agent.name}` : `Enable webhook for ${agent.name}`}
                              title={webhook.enabled ? 'Enabled' : 'Disabled'}
                            >
                              <Power />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No webhooks yet. Create one to get a signed URL.</p>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={webhooks.length ? 'outline' : 'default'}
                  className="mt-2"
                  onClick={handleCreateWebhook}
                  disabled={creatingWebhook}
                >
                  <Plus data-icon="inline-start" />
                  {creatingWebhook ? 'Creating…' : 'Create webhook'}
                </Button>
              </McpDialogSection>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function McpDialogSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-muted/25 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </div>
      {children}
    </section>
  );
}

function CopyField({ value, label, mono }: { value: string; label: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <code className={cn('min-w-0 flex-1 truncate', mono && 'font-mono')} title={value}>{value}</code>
      <Button type="button" variant="ghost" size="icon-xs" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function CopyBlock({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    // flex + min-h-0 so a max-h-* passed via className actually caps the pre and
    // scrolls it — the pre's former max-h-full resolved to `none` because
    // percentage max-heights need a definite parent height, so long content
    // painted straight past the border onto the sections below.
    <div className={cn('relative flex flex-col overflow-hidden rounded-md border bg-background', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1 z-10"
        onClick={copy}
        aria-label="Copy"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-2 pr-8 text-xs leading-relaxed">{value}</pre>
    </div>
  );
}

function ConnectionDot({ count, busy = false, title }: { count: number; busy?: boolean; title?: string }) {
  const connected = count > 0;
  // Match the three-tier presence palette used by the sidebar dots and the
  // notifications bell: online = emerald, busy = amber (pulsing), offline = grey.
  const tone = !connected ? 'bg-muted-foreground/40' : busy ? 'bg-amber-500' : 'bg-emerald-500';
  const baseLabel = !connected
    ? 'Not connected'
    : busy
      ? `${count} daemon ${count === 1 ? 'connection' : 'connections'} · working`
      : `${count} daemon ${count === 1 ? 'connection' : 'connections'}`;
  // `title` carries the agent's self-declared status note when present, appended so the
  // hover tooltip shows both the connection state and what the agent is doing.
  const label = title ? `${baseLabel} — ${title}` : baseLabel;
  return (
    <Badge variant="outline" className="gap-1 px-1.5" title={label} aria-label={label}>
      <span className={cn('size-1.5 rounded-full', tone, busy && 'animate-pulse')} aria-hidden />
      {connected && count > 1 ? count : null}
    </Badge>
  );
}


// Exported only so tests/unit/agentVoicePanel.test.ts can mount it on its own —
// the surrounding detail pane needs a dozen props this section does not care
// about, and "does the voice section actually render" is the question worth
// asking.
export function VoiceSection({
  agent,
  roster,
  mode = 'view',
  draft,
  onDraftChange,
}: {
  agent: WorkspaceAgent;
  roster: WorkspaceAgent[];
  /**
   * 'view' renders what a huddle will actually play — the resolved voice's
   * name and a preview button, nothing editable. Live-persisting pickers on
   * the read-only detail screen were a real complaint ("why is it allowing
   * editing of voice when VIEWING the agent"): every other field there is
   * display-only, and this one silently wrote to the row. 'edit' renders the
   * full picker, but into `draft` via onDraftChange — NOTHING persists until
   * the surrounding form's Save, which sends identity.voice only if it
   * actually changed (the same sparse-diff rule as every other field).
   */
  mode?: 'view' | 'edit';
  draft?: AgentVoicePreference;
  onDraftChange?: (voice: AgentVoicePreference) => void;
}) {
  const editable = mode === 'edit';
  const { voices, loading, configured } = useCartesiaVoices();
  const [query, setQuery] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // What the controls edit and the preview speaks: the DRAFT in edit mode (so
  // the preview plays what Save would keep), the stored row in view mode.
  const preference = useMemo(
    () => (editable ? (draft ?? {}) : readAgentVoice(agent)),
    [agent, draft, editable],
  );

  // Resolved ACROSS THE WHOLE ROSTER, exactly as the pipeline will. Resolving
  // this agent alone would be simpler and would sometimes lie: a derived
  // default steps aside when another agent already holds that voice, so a
  // preview that ignored its teammates could play a voice it never gets. In
  // edit mode the draft is substituted for this agent's stored preference.
  const resolved = useMemo(() => {
    const self: WorkspaceAgent = editable
      ? { ...agent, identity: { ...(agent.identity || {}), voice: preference } }
      : agent;
    const pool = roster.length > 0 ? roster.map(entry => (entry.id === agent.id ? self : entry)) : [self];
    return assignAgentVoices(pool, englishVoiceIds(voices)).get(agent.id)
      ?? resolveAgentVoice(self, englishVoiceIds(voices));
  }, [agent, editable, preference, roster, voices]);

  const chosen = voices.find(voice => voice.id === resolved.voiceId) || null;
  const matches = useMemo(() => filterVoices(voices, query), [voices, query]);

  const setVoice = (voice: AgentVoicePreference) => {
    onDraftChange?.(voice);
  };

  // Pins the derived default as an explicit choice, which is the only way to
  // stop it moving if Cartesia's catalogue changes under it.
  const pinDefault = () => {
    if (resolved.voiceId) setVoice({ ...preference, cartesia_voice_id: resolved.voiceId });
  };

  const stopPreview = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    // Revoking is what actually frees the decoded blob; pausing alone leaks one
    // per press.
    if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audioRef.current = null;
  }, []);

  const speakPreview = async () => {
    if (!resolved.voiceId) return;
    stopPreview();
    setPreviewError('');
    setPreviewing(true);
    try {
      const response = await fetch(apiUrl('/backend/tts/preview'), {
        method: 'POST',
        headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartesia_voice_id: resolved.voiceId,
          speed: resolved.speed,
          emotion: resolved.emotion,
        }),
      });
      if (!response.ok) throw new Error(`Preview failed (${response.status})`);
      const audio = new Audio(URL.createObjectURL(await response.blob()));
      audioRef.current = audio;
      audio.onended = () => { stopPreview(); setPreviewing(false); };
      audio.onerror = () => { stopPreview(); setPreviewing(false); setPreviewError('Could not play the preview.'); };
      await audio.play();
    } catch (error) {
      setPreviewing(false);
      setPreviewError(error instanceof Error ? error.message : 'Preview failed.');
    }
  };

  // Closing the panel mid-sentence must not leave audio playing.
  useEffect(() => stopPreview, [stopPreview]);

  return (
    <AgentDetailSection title="Voice">
      <p className="mb-2 text-xs text-muted-foreground">
        How this agent sounds when a huddle reads its replies aloud. Leave it unset and
        it gets a distinct voice of its own, derived from its id — two agents never share
        one by accident.
      </p>

      {!configured ? (
        <div className="text-sm text-muted-foreground">
          Speech is not configured on this workspace's backend, so voices cannot be listed
          or previewed.
        </div>
      ) : (
        <>
          {editable && (
            <FieldGroup className="gap-2">
              <Field>
                <FieldLabel htmlFor={`voice-search-${agent.id}`}>Find a voice</FieldLabel>
                <Input
                  id={`voice-search-${agent.id}`}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={loading ? 'Loading voices…' : 'Name, accent or description'}
                  className="h-8 text-xs"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={`voice-id-${agent.id}`}>Voice</FieldLabel>
                <NativeSelect
                  id={`voice-id-${agent.id}`}
                  value={preference.cartesia_voice_id || ''}
                  onChange={event => setVoice({ ...preference, cartesia_voice_id: event.target.value })}
                  className="h-8 text-xs"
                  disabled={loading}
                >
                  <NativeSelectOption value="">
                    {resolved.voiceId && chosen
                      ? `Automatic — ${describeVoice(chosen)}`
                      : 'Automatic'}
                  </NativeSelectOption>
                  {/* Capped: 418 English voices in one select is a scroll nobody
                      finishes, so the search box above is the real control and
                      this shows the top of whatever it matched. */}
                  {matches.slice(0, VOICE_OPTION_LIMIT).map(voice => (
                    <NativeSelectOption key={voice.id} value={voice.id}>{describeVoice(voice)}</NativeSelectOption>
                  ))}
                </NativeSelect>
                {matches.length > VOICE_OPTION_LIMIT && (
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    Showing {VOICE_OPTION_LIMIT} of {matches.length} — narrow the search to see more.
                  </p>
                )}
              </Field>

              <Field>
                <FieldLabel htmlFor={`voice-emotion-${agent.id}`}>Delivery</FieldLabel>
                <NativeSelect
                  id={`voice-emotion-${agent.id}`}
                  value={resolved.emotion}
                  onChange={event => setVoice({ ...preference, emotion: event.target.value })}
                  className="h-8 text-xs"
                >
                  {VOICE_EMOTIONS.map(emotion => (
                    <NativeSelectOption key={emotion} value={emotion}>
                      {emotion.charAt(0).toUpperCase() + emotion.slice(1)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Changes how a line is delivered, not what the agent says. For persona, edit Soul.
                </p>
              </Field>

              <VoiceSpeedField
                id={`voice-speed-${agent.id}`}
                value={resolved.speed}
                onChange={value => setVoice({ ...preference, speed: value })}
              />
            </FieldGroup>
          )}

          <div className={cn('flex flex-wrap items-center gap-2', editable && 'mt-2')}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={speakPreview}
              disabled={previewing || loading || !resolved.voiceId}
            >
              <Volume2 data-icon="inline-start" />
              {previewing ? 'Speaking' : 'Preview'}
            </Button>
            {editable && resolved.isDefault && resolved.voiceId && (
              <Button type="button" variant="ghost" size="sm" onClick={pinDefault}>
                Keep this one
              </Button>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={resolved.voiceId}>
              {previewError
                ? previewError
                : loading
                  ? 'Loading voices…'
                  : chosen
                    ? `${describeVoice(chosen)}${resolved.isDefault ? ' (automatic)' : ''}`
                    : 'No voice available.'}
            </span>
          </div>
        </>
      )}
    </AgentDetailSection>
  );
}

function VoiceSpeedField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
}) {
  // The thumb has to track the pointer, but the WRITE happens on release —
  // binding onValueChange straight to onUpdateAgent would fire one round trip
  // per pixel of drag. Hence a local draft, re-synced whenever the saved value
  // changes underneath (a realtime update, or the agent re-declaring).
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        Speed <span className="ml-1 tabular-nums font-normal text-muted-foreground">{draft.toFixed(2)}</span>
      </FieldLabel>
      <Slider
        id={id}
        value={[draft]}
        min={MIN_SPEED}
        max={MAX_SPEED}
        step={0.05}
        onValueChange={next => setDraft(Number(next[0]))}
        onValueCommit={next => onChange(Number(next[0]))}
      />
    </Field>
  );
}

function HostFoldersSection({
  agent,
  onUpdateAgent,
}: {
  agent: WorkspaceAgent;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
}) {
  const stored = normalizeList((agent.metadata as Record<string, unknown> | null)?.host_folders);
  const [draft, setDraft] = useState('');
  const persist = (folders: string[]) => {
    const metadata = { ...(agent.metadata || {}), host_folders: folders };
    onUpdateAgent(agent.id, { metadata });
  };
  const addFolder = () => {
    const folder = draft.trim();
    if (!folder || stored.includes(folder)) { setDraft(''); return; }
    persist([...stored, folder]);
    setDraft('');
  };
  const removeFolder = (folder: string) => persist(stored.filter(f => f !== folder));
  return (
    <AgentDetailSection title="Host folders">
      <p className="mb-2 text-xs text-muted-foreground">
        Extra folders this silo's coding CLI may read and write beyond its working directory
        (passed as <code>--add-dir</code> on the next job).
      </p>
      {stored.length > 0 ? (
        <div className="mb-2 space-y-1.5">
          {stored.map(folder => (
            <div key={folder} className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1 text-sm">
              <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={folder}>{folder}</span>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeFolder(folder)} aria-label={`Remove ${folder}`}>
                <X />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground/70">No host folders configured.</p>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addFolder(); } }}
          placeholder="/Users/name/Documents/GitHub/project"
          className="h-8 font-mono text-xs"
        />
        <Button type="button" variant="secondary" size="sm" onClick={addFolder} disabled={!draft.trim()}>
          <Plus data-icon="inline-start" /> Add
        </Button>
      </div>
    </AgentDetailSection>
  );
}

// Ordered by how much they give away, least first. `permission_mode` had NO UI
// at all before this — it was settable only through the connect command or the
// API, which is why the practical answer to "the agent is blocked" had become
// "run it in yolo".
const PERMISSION_MODE_OPTIONS: { value: AgentPermissionMode; label: string; hint: string }[] = [
  {
    value: 'default',
    label: 'Ask',
    hint: 'Stops at anything not already granted and asks in the conversation. Recommended.',
  },
  {
    value: 'accept_edits',
    label: 'Auto-accept edits',
    hint: 'File edits run without asking. Commands and everything else still ask.',
  },
  {
    value: 'yolo',
    label: 'Full access',
    hint: 'Never asks. Unrestricted shell on the daemon host — only for a machine you would hand over anyway.',
  },
];

function AccessSection({
  agent,
  workspaceId,
  onUpdateAgent,
}: {
  agent: WorkspaceAgent;
  workspaceId: string | null;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
}) {
  const mode: AgentPermissionMode = agent.permission_mode || 'default';
  const rules = normalizeList((agent.metadata as Record<string, unknown> | null)?.permission_rules);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Through a dedicated route, NOT onUpdateAgent. `permission_mode` is in
  // PRIVILEGED_DB_COLUMNS_BY_TABLE, so the generic /backend/db/update path
  // deletes it silently — the radios moved, the optimistic state made it look
  // saved, and a reload showed the old value. The strip is right: without it a
  // member holding only `write` could flip an agent to Full access and hand
  // themselves unrestricted shell on the daemon host. So the write goes through
  // a manage-gated route instead.
  const setMode = async (next: AgentPermissionMode) => {
    if (!workspaceId || next === mode) return;
    setError('');
    setSaving(true);
    try {
      const response = await fetch(
        apiUrl(`/backend/workspaces/${workspaceId}/agents/${agent.id}/permission-mode`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({ permission_mode: next }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) {
        setError(String(payload.error || 'Could not change this agent’s access'));
        return;
      }
      // Only after the server confirms. Updating first is what made the broken
      // version look like it worked.
      onUpdateAgent(agent.id, { permission_mode: payload.data?.permission_mode ?? next });
    } finally {
      setSaving(false);
    }
  };

  // Through the dedicated route, not a metadata write: `metadata` is MANAGE_ONLY
  // in the column rules, and routing this here keeps granting and revoking a
  // permanent rule behind exactly the same capability.
  const revoke = async (rule: string) => {
    if (!workspaceId) return;
    setError('');
    const response = await fetch(
      apiUrl(`/backend/workspaces/${workspaceId}/agents/${agent.id}/permission-rules`),
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ rule }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      setError(String(payload.error || 'Could not revoke that rule'));
      return;
    }
    const metadata = { ...(agent.metadata || {}), permission_rules: payload.data?.rules ?? [] };
    onUpdateAgent(agent.id, { metadata });
  };

  return (
    <AgentDetailSection title="Access">
      <p className="mb-2 text-xs text-muted-foreground">
        What this agent may do without asking. Note that a folder outside its working
        directory needs a <strong>host folder</strong> above — no permission mode or grant
        can reach one.
      </p>
      <div className="mb-3 grid gap-1.5">
        {PERMISSION_MODE_OPTIONS.map(option => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors',
              mode === option.value ? 'border-ring bg-muted/50' : 'border-border hover:bg-muted/30',
            )}
          >
            <input
              type="radio"
              className="mt-1"
              name={`permission-mode-${agent.id}`}
              checked={mode === option.value}
              disabled={saving}
              onChange={() => void setMode(option.value)}
            />
            <span className="min-w-0">
              <span className="block font-semibold">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        Always allowed
      </div>
      {rules.length > 0 ? (
        <div className="space-y-1.5">
          {rules.map(rule => (
            <div key={rule} className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1 text-sm">
              <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={rule}>{rule}</span>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => void revoke(rule)} aria-label={`Revoke ${rule}`}>
                <X />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground/70">
          Nothing granted permanently. Rules land here when someone answers an approval request
          with &ldquo;Always allow&rdquo;.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </AgentDetailSection>
  );
}

function AgentDetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="agent-detail-section rounded-lg border bg-muted/25 p-3">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

function AgentDetailField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/60 py-1.5 first:pt-0 last:border-b-0 last:pb-0">
      <span className="shrink-0 text-sm font-semibold text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium" title={value}>{value}</span>
    </div>
  );
}

function AgentDetailTokenSection({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <AgentDetailSection title={title}>
      {items.length > 0 ? (
        <div className="agent-token-row flex flex-wrap gap-1.5">
          {items.map(item => <Badge key={item} variant="outline" className="agent-token-chip" title={item}>{item}</Badge>)}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{empty}</div>
      )}
    </AgentDetailSection>
  );
}

function formatAgentDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Compact "time since last heartbeat" for the profile panel — "3s" / "5m" / "2h" / "4d".
function formatRelativeTime(value?: string | null) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Moved to src/lib/runtimeModels.ts so the per-runtime catalog and the
// "does this model survive a runtime change" rule are testable without
// mounting this window. See modelOptionsForRuntime.

function AgentAvatarPreview({ value, className }: { value?: string | null; className?: string }) {
  const avatar = value || DEFAULT_AGENT_AVATAR;
  const iconChoice = getAgentIconChoice(avatar);
  if (isPetSpritesheetAvatar(avatar)) {
    return (
      <span className={cn('animated-pet-avatar-shell', className)}>
        <span className="animated-pet-avatar" style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }} />
      </span>
    );
  }
  if (isImageAvatar(avatar)) {
    return <img src={renderablePetAssetUrl(avatar)} alt="" className={cn('size-full object-contain', className)} loading="lazy" draggable={false} />;
  }
  if (iconChoice) {
    const Icon = iconChoice.icon;
    return (
      <span className={cn('grid size-full place-items-center text-muted-foreground', className)}>
        <Icon className="size-5" />
      </span>
    );
  }
  return (
    <span className={cn('grid size-full place-items-center text-sm font-semibold', className)}>
      {avatar.slice(0, 2).toUpperCase()}
    </span>
  );
}

function getAgentIconChoice(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase();
  return AGENT_ICON_CHOICES.find(choice => choice.value === normalized) || null;
}

function displayModel(model?: string | null) {
  const option = AI_MODELS.find(entry => entry.id === model);
  return option?.label || model || 'Auto';
}

function splitList(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeList(value: unknown): string[] {
  const out: string[] = [];

  const objectToken = (input: Record<string, unknown>) => {
    for (const key of ['label', 'name', 'id', 'type']) {
      const token = input[key];
      if (typeof token === 'string' && token.trim()) return token.trim();
    }
    return '';
  };

  const visit = (input: unknown, depth: number) => {
    if (input == null) return;
    if (Array.isArray(input)) {
      input.forEach(item => visit(item, depth));
      return;
    }
    if (typeof input === 'object') {
      const token = objectToken(input as Record<string, unknown>);
      if (token) visit(token, depth);
      return;
    }

    const str = String(input).trim();
    if (!str) return;

    // Unwrap values that have been JSON-stringified one or more times
    // (e.g. `["[\"[]\"]"]`), which would otherwise leak through as literal tokens.
    if (depth < 8 && (str.startsWith('[') || str.startsWith('{') || str.startsWith('"'))) {
      try {
        const parsed = JSON.parse(str);
        if (typeof parsed !== 'string' || parsed !== str) {
          visit(parsed, depth + 1);
          return;
        }
      } catch {
        // Not JSON — fall through and treat as a plain token.
      }
    }

    for (const part of str.includes(',') ? str.split(',') : [str]) {
      const token = part.trim();
      if (token && token !== '[]' && token !== '{}' && token !== '""') out.push(token);
    }
  };

  visit(value, 0);
  return Array.from(new Set(out));
}

function joinList(value: unknown) {
  return normalizeList(value).join(', ');
}

function addToken(value: string, token: string) {
  const next = new Set(splitList(value));
  next.add(token);
  return Array.from(next).join(', ');
}

function normalizeAgentKey(value?: string | null) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function agentMatchesKey(agent: WorkspaceAgent, key: string) {
  if (!key) return false;
  return [
    agent.id,
    agent.handle,
    agent.name,
    agentHandle(agent.name),
  ].some(value => normalizeAgentKey(value) === key);
}

function isAgentActive(agent: Pick<WorkspaceAgent, 'enabled'>) {
  return agent.enabled !== false;
}

type AgentPresence = 'busy' | 'idle' | 'disconnected' | 'inactive';

// One mutually-exclusive presence per agent, derived from the enabled flag and
// live daemon connections. Every agent lands in exactly one bucket.
function agentPresenceStatus(agent: WorkspaceAgent, connections: AgentConnection[]): AgentPresence {
  if (!isAgentActive(agent)) return 'inactive';
  const live = connections.filter(connection => connection.status !== 'offline');
  if (live.length === 0) return 'disconnected';
  return live.some(connection => connection.status === 'busy') ? 'busy' : 'idle';
}

const AGENT_PRESENCE_FILTERS: Array<{ key: AgentPresence; label: string; tone: string }> = [
  { key: 'busy', label: 'Busy', tone: 'bg-amber-500' },
  { key: 'idle', label: 'Idle', tone: 'bg-emerald-500' },
  { key: 'disconnected', label: 'Disconnected', tone: 'bg-muted-foreground/40' },
  { key: 'inactive', label: 'Inactive', tone: 'bg-rose-500' },
];

function agentHandle(value: string) {
  return String(value || 'agent')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

function webhookUrl(token: string) {
  const relative = apiUrl(`/backend/webhooks/${token}`);
  if (typeof window === 'undefined') return relative;
  return new URL(relative, window.location.origin).toString();
}
