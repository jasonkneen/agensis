import { DEFAULT_BACKGROUND_OPACITY } from '../../lib/wallpaperDefaults';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Check,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  Image as ImageIcon,
  Info,
  Gauge,
  KeyRound,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
  Settings as SettingsIcon,
  Sparkles,
  Upload,
  Wrench,
} from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import type { Workspace } from '../../types';
import { applyUiAppearanceSettings, getSettings, setSetting, type AppSettings, type NotificationLevel, type UiFontFamily } from '../../lib/settings';
import { THEME_PRESETS, applyThemePreset } from '../../showcase/themePresets';
import { NEO_THEMES, NEO_GROUPS, applyNeoTheme, resolveNeoStyle } from '../../showcase/neoThemes';
import { NORMAL_THEMES, NORMAL_GROUPS, applyNormalTheme, clearNormalTheme, getStoredNormalTheme } from '../../showcase/normalThemes';
import { TW_WORLDS, applyTwTheme, getStoredTwTheme } from '../../showcase/twThemes';
import { apiAuthHeaders, apiUrl, getSystemCapabilities, type SystemCapabilities } from '../../lib/backendClient';
import {
  createMcpOauthClient,
  generateMcpToken,
  getMcpConnection,
  getMcpOauthCatalog,
  setMcpAutoApprove,
  type McpConnectInfo,
  type McpOauthCatalog,
  type McpOauthClientMinted,
} from '../../lib/mcpConnect';
import { getBackendBaseUrl } from '../../lib/backendClient';
import { WORKSPACE_UNAVAILABLE, describeWriteFailure } from '../../lib/writeFeedback';
import { useWorkspaceVault } from '../../hooks/useWorkspaceVault';
import { useAgentConnections } from '../../hooks/useAgentConnections';
import { useAgentRegistrations } from '../../hooks/useAgentRegistrations';
import type { AgentConnection } from '../../types';
import { AuditLogPanel } from './AuditLogPanel';
import { useGateways } from '../../hooks/useGateways';
import { ConnectFlowsDialog } from '../integrations/ConnectFlowsDialog';
import { WORKSPACE_BACKGROUNDS } from '../../lib/backgrounds';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Input } from '@/components/ui/input';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
  userEmail: string;
  workspace: Workspace | null;
  onUpdateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  // Real workspace UUID for workspace-scoped settings (secrets). The `workspace`
  // prop above is a layer-flavored view whose id is the canvas layer id (e.g.
  // 'base'), which is NOT a uuid and must never reach a workspace_id column.
  secretsWorkspaceId: string | null;
  /** Workspace control credentials are owner-only, not merely manage-gated. */
  isWorkspaceOwner: boolean;
  // Which tab to show when the dialog opens (defaults to General). Lets callers
  // deep-link — e.g. the Agents window "Connect a client" button opens Connections.
  initialTab?: SettingsTabId;
}

export type SettingsTabId = 'general' | 'notifications' | 'appearance' | 'ai' | 'tools' | 'connections' | 'secrets' | 'audit' | 'usage' | 'about';
type TabId = SettingsTabId;

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <SettingsIcon /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette /> },
  { id: 'ai', label: 'AI', icon: <Sparkles /> },
  { id: 'tools', label: 'Tools', icon: <Wrench /> },
  { id: 'connections', label: 'Connections', icon: <Plug /> },
  { id: 'secrets', label: 'Vault', icon: <KeyRound /> },
  // Next to the Vault: same manage gate, same sensitivity. The route behind it
  // returns 403 to anyone below manage, so a non-manager who opens this tab sees
  // that message rather than an empty table they would read as "nothing has
  // happened".
  { id: 'audit', label: 'Audit log', icon: <ScrollText /> },
  { id: 'usage', label: 'Usage', icon: <Gauge /> },
  { id: 'about', label: 'About', icon: <Info /> },
];

export function SettingsDialog({
  open,
  onClose,
  workspace,
  onUpdateWorkspace,
  workspaceName,
  userEmail,
  themeMode,
  onThemeChange,
  secretsWorkspaceId,
  isWorkspaceOwner,
  initialTab,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<TabId>(initialTab ?? 'general');
  const activeTab = TABS.find(item => item.id === tab);

  // Jump to the requested tab each time the dialog is (re)opened.
  useEffect(() => {
    if (open) setTab(initialTab ?? 'general');
  }, [open, initialTab]);

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
      <DialogContent className="settings-dialog grid max-h-[calc(100svh-1.5rem)] overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="settings-dialog-header border-b border-border p-4 pr-12">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>{activeTab?.label}</DialogDescription>
        </DialogHeader>
        <div className="settings-dialog-body grid min-h-0 grid-cols-[12rem_1fr]">
          <nav className="settings-dialog-nav flex flex-col gap-1 border-r border-border p-3">
            {TABS.map(item => (
              <Button
                key={item.id}
                type="button"
                variant={tab === item.id ? 'secondary' : 'ghost'}
                className="settings-nav-row justify-start"
                onClick={() => setTab(item.id)}
              >
                {item.icon}
                {item.label}
              </Button>
            ))}
          </nav>
          <ScrollArea className="settings-dialog-scroll h-[34rem] min-w-0">
            <div className="settings-dialog-content p-4">
              {tab === 'general' && (
                <GeneralPanel
                  workspace={workspace}
                  workspaceName={workspaceName}
                  userEmail={userEmail}
                  onUpdateWorkspace={onUpdateWorkspace}
                />
              )}
              {tab === 'notifications' && <NotificationsPanel />}
              {tab === 'appearance' && (
                <AppearancePanel
                  workspace={workspace}
                  onUpdateWorkspace={onUpdateWorkspace}
                  themeMode={themeMode}
                  onThemeChange={onThemeChange}
                />
              )}
              {tab === 'ai' && <AIPanel workspaceId={secretsWorkspaceId} />}
              {tab === 'tools' && <ToolsPanel workspace={workspace} />}
              {tab === 'connections' && (
                <ConnectionsPanel
                  workspaceId={secretsWorkspaceId}
                  isWorkspaceOwner={isWorkspaceOwner}
                />
              )}
              {tab === 'secrets' && <SecretsPanel workspaceId={secretsWorkspaceId} />}
              {tab === 'audit' && <AuditLogPanel workspaceId={secretsWorkspaceId} />}
              {tab === 'usage' && <UsagePanel workspaceId={secretsWorkspaceId} workspaceName={workspaceName} />}
              {tab === 'about' && <AboutPanel />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>{value}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

function GeneralPanel({
  workspace,
  workspaceName,
  userEmail,
  onUpdateWorkspace,
}: {
  workspace: Workspace | null;
  workspaceName: string;
  userEmail: string;
  onUpdateWorkspace: (id: string, updates: Partial<Workspace>) => void;
}) {
  const [pathDraft, setPathDraft] = useState(workspace?.local_path || '');
  const [inspecting, setInspecting] = useState(false);
  const [pathStatus, setPathStatus] = useState<string | null>(null);

  useEffect(() => {
    setPathDraft(workspace?.local_path || '');
    setPathStatus(null);
  }, [workspace?.id, workspace?.local_path]);

  const isNativeDesktop = Boolean(window.zero?.invoke);
  const isElectron = Boolean(window.electronAPI);
  const isDesktopShell = isNativeDesktop || isElectron;
  const hasDirectoryPicker = !isDesktopShell && 'showDirectoryPicker' in window;
  const canBrowse = isDesktopShell || hasDirectoryPicker;

  const browsePath = async () => {
    // Native SDK desktop shell (replaces Electron pick-folder IPC).
    if (isNativeDesktop) {
      try {
        const picked = await window.zero!.invoke('native-sdk.dialog.openFile', {
          title: 'Select project folder',
          allowDirectories: true,
          allowMultiple: false,
        });
        const path =
          Array.isArray(picked) && typeof picked[0] === 'string'
            ? picked[0]
            : null;
        if (path) {
          setPathDraft(path);
          setPathStatus(null);
        }
      } catch {
        // user cancelled or bridge denied
      }
      return;
    }
    if (isElectron) {
      const picked = await window.electronAPI!.pickFolder();
      if (picked) {
        setPathDraft(picked);
        setPathStatus(null);
      }
      return;
    }
    if (hasDirectoryPicker) {
      try {
        // Web mode: browser can't return the full system path, so we confirm the
        // folder name and ask the user to type the full path.
        const handle = await (window as unknown as {
          showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>;
        }).showDirectoryPicker({ mode: 'read' });
        setPathStatus(`Selected "${handle.name}" — paste the full system path above, then click Link.`);
      } catch {
        // user cancelled
      }
    }
  };

  const inspectAndSave = async () => {
    if (!workspace || !pathDraft.trim()) return;
    setInspecting(true);
    setPathStatus(null);
    try {
      const response = await fetch(apiUrl('/backend/system/inspect-path'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ path: pathDraft.trim() }),
      });
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message);
      const inspected = payload.data || {};
      onUpdateWorkspace(workspace.id, {
        local_path: inspected.path || pathDraft.trim(),
        project_kind: inspected.projectKind || '',
        git_root: inspected.gitRoot || '',
        git_remote: inspected.gitRemote || '',
      });
      setPathStatus(inspected.exists ? (inspected.gitRoot ? 'Git repository linked' : 'Folder linked') : 'Path saved but not found');
    } catch (error) {
      setPathStatus(error instanceof Error ? error.message : 'Failed to inspect path');
    } finally {
      setInspecting(false);
    }
  };

  return (
    <FieldGroup>
      <ReadOnlyValue label="Account" value={userEmail || 'Not signed in'} />
      <ReadOnlyValue label="Active desktop" value={workspaceName || 'None'} />
      <Field>
        <FieldLabel htmlFor="workspace-local-path">Project folder</FieldLabel>
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <FolderOpen data-icon="inline-start" className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            id="workspace-local-path"
            value={pathDraft}
            onChange={event => setPathDraft(event.target.value)}
            placeholder="/Users/name/Documents/GitHub/project"
          />
          <InputGroupAddon align="inline-end">
            {canBrowse && (
              <InputGroupButton size="xs" variant="ghost" onClick={browsePath} disabled={!workspace}>
                Browse
              </InputGroupButton>
            )}
            <InputGroupButton size="xs" onClick={inspectAndSave} disabled={!workspace || !pathDraft.trim() || inspecting}>
              {inspecting ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              Link
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>
          {pathStatus || workspace?.git_root || workspace?.local_path || (
            isDesktopShell
              ? 'Click Browse or type the path, then Link.'
              : 'Web mode — type the full system path (e.g. /Users/name/projects/repo), then click Link.'
          )}
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}

const NOTIFICATION_LEVELS: Array<{
  id: NotificationLevel;
  title: string;
  description: string;
}> = [
  {
    id: 'all',
    title: 'All new messages',
    description: 'Every message in your channels and DMs.',
  },
  {
    id: 'mentions',
    title: 'Direct messages & mentions',
    description: 'DMs, @mentions, and agent broadcasts only.',
  },
  {
    id: 'none',
    title: 'Nothing',
    description: 'No notifications — catch up in the app.',
  },
];

function NotificationsPanel() {
  const settings = getSettings();
  const [level, setLevel] = useState<NotificationLevel>(settings.notifications_level);
  const [sound, setSound] = useState(settings.notifications_sound);
  const [desktop, setDesktop] = useState(settings.notifications_desktop);
  const [agentEvents, setAgentEvents] = useState(settings.notifications_agent_events);
  const [taskReminders, setTaskReminders] = useState(settings.notifications_task_reminders);

  const setNotificationLevel = (next: NotificationLevel) => {
    setLevel(next);
    setSetting('notifications_level', next);
  };

  const toggle = (key: 'notifications_sound' | 'notifications_desktop' | 'notifications_agent_events' | 'notifications_task_reminders', value: boolean) => {
    setSetting(key, value);
    if (key === 'notifications_sound') setSound(value);
    if (key === 'notifications_desktop') setDesktop(value);
    if (key === 'notifications_agent_events') setAgentEvents(value);
    if (key === 'notifications_task_reminders') setTaskReminders(value);
  };

  // Same FieldGroup / text-sm / text-xs rhythm as General, Connections, Appearance —
  // not the older settings-panel-* CSS that used heavier titles and mixed rem sizes.
  return (
    <FieldGroup>
      <div>
        <div className="mb-1 text-sm font-medium">When to notify</div>
        <FieldDescription>Choose what pulls your attention.</FieldDescription>
      </div>

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Notification level">
        {NOTIFICATION_LEVELS.map(option => {
          const selected = level === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setNotificationLevel(option.id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card/50 hover:bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2',
                  selected ? 'border-primary' : 'border-muted-foreground/40',
                )}
                aria-hidden
              >
                {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-sm font-medium leading-snug">{option.title}</span>
                <span className="block text-xs leading-normal text-muted-foreground">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-border pt-4 space-y-0 divide-y divide-border">
        <SettingsToggleRow
          title="Play a sound"
          description="A soft chime when a notification arrives."
          checked={sound}
          onCheckedChange={checked => toggle('notifications_sound', checked)}
        />
        <SettingsToggleRow
          title="Desktop notifications"
          description="Show OS notifications when agensis is in the background."
          checked={desktop}
          onCheckedChange={checked => toggle('notifications_desktop', checked)}
        />
        <SettingsToggleRow
          title="Agent events"
          description="Notify when Relay or Connector agents connect, finish, or need attention."
          checked={agentEvents}
          onCheckedChange={checked => toggle('notifications_agent_events', checked)}
        />
        <SettingsToggleRow
          title="Task reminders"
          description="Notify when assigned tasks are due soon."
          checked={taskReminders}
          onCheckedChange={checked => toggle('notifications_task_reminders', checked)}
        />
      </div>
    </FieldGroup>
  );
}

function SettingsToggleRow({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium leading-snug">{title}</div>
        <div className="text-xs leading-normal text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
    </div>
  );
}

function AppearancePanel({
  workspace,
  onUpdateWorkspace,
  themeMode,
  onThemeChange,
}: {
  workspace: Workspace | null;
  onUpdateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}) {
  const initialSettings = getSettings();
  const [backgroundOpacity, setBackgroundOpacity] = useState(() => Math.round((workspace?.background_opacity ?? DEFAULT_BACKGROUND_OPACITY) * 100));
  const [fontFamily, setFontFamily] = useState<UiFontFamily>(initialSettings.ui_font_family);
  const [baseFontSize, setBaseFontSize] = useState(initialSettings.ui_base_font_size);
  const [themePreset, setThemePreset] = useState(initialSettings.ui_theme_preset);
  const [neoTheme, setNeoTheme] = useState(initialSettings.ui_neo_theme);
  const [normalTheme, setNormalTheme] = useState(() => getStoredNormalTheme());
  const [twTheme, setTwTheme] = useState(() => getStoredTwTheme());
  const isNeoFamily = themeMode === 'neo-light' || themeMode === 'neo-dark';
  const isNormalFamily = themeMode === 'normal-light' || themeMode === 'normal-dark';
  const isPaper = themeMode === 'paper-light' || themeMode === 'paper-dark';
  // Derive which style tab is active from the current mode
  const themeStyleTab: 'normal' | 'brutal' = isNeoFamily ? 'brutal' : 'normal';
  const [panelTranslucency, setPanelTranslucency] = useState(initialSettings.ui_panel_translucency);
  const [sidebarTranslucency, setSidebarTranslucency] = useState(initialSettings.ui_sidebar_translucency);
  const [glassBlur, setGlassBlur] = useState(initialSettings.ui_glass_blur);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const backgroundImage = workspace?.background_image || '';
  // Scheme toggles per tab
  const normalSchemeModes: Array<{ id: ThemeMode; label: string }> = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
    { id: 'paper-light', label: 'Paper Light' },
    { id: 'paper-dark', label: 'Paper Dark' },
  ];
  // Active scheme value for normal tab: map normal-* back to plain light/dark
  const normalSchemeValue: ThemeMode = themeMode === 'normal-light' ? 'light' : themeMode === 'normal-dark' ? 'dark' : themeMode;
  const fontOptions: Array<{ id: UiFontFamily; label: string }> = [
    { id: 'geist', label: 'Geist' },
    { id: 'inter', label: 'Inter' },
    { id: 'space-grotesk', label: 'Space Grotesk' },
    { id: 'manrope', label: 'Manrope' },
    { id: 'dm-sans', label: 'DM Sans' },
    { id: 'work-sans', label: 'Work Sans' },
    { id: 'plus-jakarta', label: 'Plus Jakarta Sans' },
    { id: 'outfit', label: 'Outfit' },
    { id: 'sora', label: 'Sora' },
    { id: 'lexend', label: 'Lexend' },
    { id: 'albert-sans', label: 'Albert Sans' },
    { id: 'bricolage', label: 'Bricolage Grotesque' },
    { id: 'schibsted', label: 'Schibsted Grotesk' },
    { id: 'hanken', label: 'Hanken Grotesk' },
    { id: 'figtree', label: 'Figtree' },
    { id: 'system', label: 'System' },
    { id: 'mono', label: 'Mono' },
    { id: 'jetbrains-mono', label: 'JetBrains Mono' },
  ];

  useEffect(() => {
    setBackgroundOpacity(Math.round((workspace?.background_opacity ?? DEFAULT_BACKGROUND_OPACITY) * 100));
  }, [workspace?.id, workspace?.background_opacity]);

  const updateAppearanceSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSetting(key, value);
    applyUiAppearanceSettings(getSettings());
  };

  const updateBackgroundImage = (nextImage: string) => {
    if (!workspace) return;
    onUpdateWorkspace(workspace.id, { background_image: nextImage });
  };

  const handleUploadBackground = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file || !workspace) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        onUpdateWorkspace(workspace.id, { background_image: reader.result });
      }
    });
    reader.readAsDataURL(file);
  };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Theme</FieldLabel>

        {/* Normal | Brutal tab bar */}
        <div className="flex gap-1 rounded-lg border border-border bg-muted p-1">
          <button
            type="button"
            onClick={() => {
              if (isNeoFamily) {
                const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                onThemeChange(isNormalFamily ? (dark ? 'normal-dark' : 'normal-light') : (dark ? 'dark' : 'light'));
              }
            }}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${themeStyleTab === 'normal' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Normal
          </button>
          <button
            type="button"
            onClick={() => {
              if (!isNeoFamily) {
                const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                onThemeChange(dark ? 'neo-dark' : 'neo-light');
              }
            }}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${themeStyleTab === 'brutal' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Brutal
          </button>
        </div>

        {/* Normal tab content */}
        {themeStyleTab === 'normal' && (
          <div className="space-y-4">
            {/* Scheme sub-toggle */}
            <ToggleGroup
              type="single"
              value={normalSchemeValue}
              onValueChange={value => {
                if (!value) return;
                const next = value as ThemeMode;
                // If a normal theme is active, keep it active while switching scheme
                if (isNormalFamily && (next === 'light' || next === 'dark')) {
                  onThemeChange(next === 'light' ? 'normal-light' : 'normal-dark');
                } else {
                  onThemeChange(next);
                }
              }}
              variant="outline"
              className="grid w-full grid-cols-3 sm:grid-cols-5"
            >
              {normalSchemeModes.map(mode => (
                <ToggleGroupItem key={mode.id} value={mode.id}>
                  {mode.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {/* Accent color (only when no custom normal theme) */}
            {!isNormalFamily && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Accent color</div>
                <ToggleGroup
                  type="single"
                  value={themePreset}
                  onValueChange={value => {
                    if (!value) return;
                    setThemePreset(value);
                    setSetting('ui_theme_preset', value);
                    applyThemePreset(value);
                  }}
                  variant="outline"
                  className="grid w-full grid-cols-2 sm:grid-cols-3"
                >
                  {THEME_PRESETS.map(preset => (
                    <ToggleGroupItem key={preset.id} value={preset.id} className="gap-2">
                      <span className="size-3 rounded-sm border border-border" style={{ background: preset.swatch }} />
                      {preset.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            )}

            {/* Paper world grid — repaints the paper; composes with the
                accent preset above (world paper + your picked accent). */}
            {isPaper && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Paper</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {TW_WORLDS.map(w => {
                    const active = twTheme === w.id;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => {
                          setTwTheme(w.id);
                          setSetting('ui_tw_theme', w.id);
                          applyTwTheme(w.id);
                        }}
                        aria-pressed={active}
                        title={w.label}
                        className={`relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition ${active ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'border-border hover:bg-accent'}`}
                      >
                        <span className="flex shrink-0 overflow-hidden rounded-sm border border-border">
                          {w.swatch.map((c, i) => (
                            <span key={i} className="size-3.5" style={{ background: c }} />
                          ))}
                        </span>
                        <span className="truncate font-medium">{w.label}</span>
                        {active && (
                          <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="size-3" strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <FieldDescription>
                  Repaints the Paper theme’s surfaces. Your accent (above) stays on top — pick a world for the mood, an accent for the highlight.
                </FieldDescription>
              </div>
            )}

            {/* Normal theme grid */}
            <div className="space-y-3">
              {NORMAL_GROUPS.map(group => (
                <div key={group} className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {NORMAL_THEMES.filter(t => t.group === group).map(t => {
                      const active = normalTheme === t.id && isNormalFamily;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            if (active) {
                              // Deselect: go back to plain scheme
                              setNormalTheme('');
                              setSetting('ui_normal_theme', '');
                              clearNormalTheme();
                              const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                              onThemeChange(dark ? 'dark' : 'light');
                            } else {
                              setNormalTheme(t.id);
                              setSetting('ui_normal_theme', t.id);
                              applyNormalTheme(t.id);
                              const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                              onThemeChange(dark ? 'normal-dark' : 'normal-light');
                            }
                          }}
                          aria-pressed={active}
                          title={t.label}
                          className={`relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition ${active ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'border-border hover:bg-accent'}`}
                        >
                          <span className="flex shrink-0 overflow-hidden rounded-sm border border-border">
                            {t.swatch.map((c, i) => (
                              <span key={i} className="size-3.5" style={{ background: c }} />
                            ))}
                          </span>
                          <span className="truncate font-medium">{t.label}</span>
                          {active && (
                            <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-3" strokeWidth={3} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <FieldDescription>
              {isNormalFamily
                ? 'Click the active theme to deselect and return to the default look.'
                : 'Pick a theme to repaint the app. Toggle Light / Dark above to switch scheme.'}
            </FieldDescription>
          </div>
        )}

        {/* Brutal tab content */}
        {themeStyleTab === 'brutal' && (
          <div className="space-y-4">
            {/* Neo scheme sub-toggle */}
            <ToggleGroup
              type="single"
              value={themeMode}
              onValueChange={value => {
                if (value) onThemeChange(value as ThemeMode);
              }}
              variant="outline"
              className="grid w-full grid-cols-2"
            >
              <ToggleGroupItem value="neo-light">Neo Light</ToggleGroupItem>
              <ToggleGroupItem value="neo-dark">Neo Dark</ToggleGroupItem>
            </ToggleGroup>

            {/* Neo theme grid */}
            <div className="space-y-3">
              {NEO_GROUPS.map(group => (
                <div key={group} className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {NEO_THEMES.filter(t => t.group === group).map(t => {
                      const active = neoTheme === t.id;
                      const profile = resolveNeoStyle(t);
                      const swatchRadius = profile.radius === 'sharp' ? '0px' : profile.radius === 'soft' ? '9999px' : '4px';
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setNeoTheme(t.id);
                            setSetting('ui_neo_theme', t.id);
                            applyNeoTheme(t.id);
                            if (!isNeoFamily) {
                              const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                              onThemeChange(dark ? 'neo-dark' : 'neo-light');
                            }
                          }}
                          aria-pressed={active}
                          title={t.label}
                          className={`relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition ${active ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'border-border hover:bg-accent'}`}
                        >
                          <span className="flex shrink-0 overflow-hidden border border-border" style={{ borderRadius: swatchRadius }}>
                            {t.swatch.map((c, i) => (
                              <span key={i} className="size-3.5" style={{ background: c }} />
                            ))}
                          </span>
                          <span
                            className="truncate font-medium"
                            style={{ fontFamily: profile.display, fontWeight: profile.weight, letterSpacing: profile.spacing, textTransform: profile.transform as 'uppercase' | 'none' | 'capitalize' | 'lowercase' }}
                          >{t.label}</span>
                          {active && (
                            <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-3" strokeWidth={3} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <FieldDescription>
              {isNeoFamily
                ? 'Repaints the whole app with brutal chrome. Each theme has matching light and dark variants.'
                : 'Picking a theme switches you into the Brutal family.'}
            </FieldDescription>
          </div>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor="ui-font-family">Font</FieldLabel>
        <NativeSelect
          id="ui-font-family"
          value={fontFamily}
          onChange={event => {
            const next = event.target.value as UiFontFamily;
            setFontFamily(next);
            updateAppearanceSetting('ui_font_family', next);
          }}
        >
          {fontOptions.map(option => (
            <NativeSelectOption key={option.id} value={option.id}>{option.label}</NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Base font size</FieldLabel>
          <Badge variant="secondary">{baseFontSize}px</Badge>
        </div>
        <Slider
          value={[baseFontSize]}
          min={12}
          max={18}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? baseFontSize;
            setBaseFontSize(next);
            updateAppearanceSetting('ui_base_font_size', next);
          }}
        />
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Panel translucency</FieldLabel>
          <Badge variant="secondary">{panelTranslucency}%</Badge>
        </div>
        <Slider
          value={[panelTranslucency]}
          min={35}
          max={95}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? panelTranslucency;
            setPanelTranslucency(next);
            updateAppearanceSetting('ui_panel_translucency', next);
          }}
        />
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Sidebar translucency</FieldLabel>
          <Badge variant="secondary">{sidebarTranslucency}%</Badge>
        </div>
        <Slider
          value={[sidebarTranslucency]}
          min={35}
          max={95}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? sidebarTranslucency;
            setSidebarTranslucency(next);
            updateAppearanceSetting('ui_sidebar_translucency', next);
          }}
        />
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Glass blur</FieldLabel>
          <Badge variant="secondary">{glassBlur}px</Badge>
        </div>
        <Slider
          value={[glassBlur]}
          min={0}
          max={32}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? glassBlur;
            setGlassBlur(next);
            updateAppearanceSetting('ui_glass_blur', next);
          }}
        />
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Desktop background</FieldLabel>
          <Button type="button" variant="outline" size="sm" onClick={() => updateBackgroundImage('')} disabled={!workspace || !backgroundImage}>
            Auto
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {WORKSPACE_BACKGROUNDS.map(background => {
            const selected = backgroundImage === background.src;
            return (
              <button
                key={background.id}
                type="button"
                className={`group relative overflow-hidden rounded-md border p-1 text-left transition-colors ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-muted/50'
                  }`}
                onClick={() => updateBackgroundImage(background.src)}
                disabled={!workspace}
              >
                <img src={background.src} alt="" className="h-20 w-full rounded object-cover" />
                <span className="mt-1 flex items-center justify-between gap-2 px-1 text-xs font-medium">
                  <span className="truncate">{background.label}</span>
                  {selected && <Check className="size-3.5 text-primary" />}
                </span>
              </button>
            );
          })}
        </div>
        {backgroundImage && !WORKSPACE_BACKGROUNDS.some(background => background.src === backgroundImage) && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm">
            <ImageIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Custom upload selected</span>
            <Check className="size-4 text-primary" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => uploadInputRef.current?.click()} disabled={!workspace}>
            <Upload data-icon="inline-start" />
            Upload
          </Button>
          <input
            ref={uploadInputRef}
            className="hidden"
            type="file"
            accept="image/*"
            onChange={handleUploadBackground}
          />
        </div>
        <FieldDescription>Pick a bundled image or upload a local one. Wallpaper belongs to this desktop, not to the whole workspace.</FieldDescription>
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Desktop background opacity</FieldLabel>
          <Badge variant="secondary">{backgroundOpacity}%</Badge>
        </div>
        <Slider
          value={[backgroundOpacity]}
          min={10}
          max={100}
          step={1}
          onValueChange={value => setBackgroundOpacity(value[0] ?? backgroundOpacity)}
          onValueCommit={value => {
            if (!workspace) return;
            onUpdateWorkspace(workspace.id, { background_opacity: (value[0] ?? backgroundOpacity) / 100 });
          }}
        />
        <FieldDescription>Stored on this desktop so every device opens it with the same background strength.</FieldDescription>
      </Field>
    </FieldGroup>
  );
}

function GatewaysManager({ workspaceId }: { workspaceId: string | null }) {
  const { gateways, createGateway, updateGateway, deleteGateway } = useGateways(workspaceId);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [gwModel, setGwModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim() || !baseUrl.trim() || busy) return;
    setBusy(true);
    try {
      const created = await createGateway({ name: name.trim(), base_url: baseUrl.trim(), model: gwModel.trim(), api_key: apiKey });
      if (created) { setName(''); setBaseUrl(''); setGwModel(''); setApiKey(''); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field>
      <FieldLabel>Inference gateways</FieldLabel>
      <FieldDescription>
        Store an external OpenAI-compatible endpoint for provider integrations. The API key is
        encrypted and never shown again. Chat composers route through configured agents and do
        not choose models directly.
      </FieldDescription>
      {gateways.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {gateways.map(gateway => (
            <div key={gateway.id} className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{gateway.name}</div>
                <div className="truncate text-xs text-muted-foreground" title={gateway.base_url}>
                  {gateway.model || 'no model'} · {gateway.base_url}{gateway.has_key ? '' : ' · no key'}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => { const key = window.prompt(`New API key for ${gateway.name} (leave blank to keep current):`); if (key) void updateGateway(gateway.id, { api_key: key }); }}
                aria-label={`Rotate key for ${gateway.name}`}
                title="Rotate API key"
              >
                <KeyRound />
              </Button>
              <Button
                type="button"
                variant={confirmDeleteId === gateway.id ? 'destructive' : 'ghost'}
                size="icon-xs"
                onClick={() => {
                  if (confirmDeleteId !== gateway.id) {
                    setConfirmDeleteId(gateway.id);
                    return;
                  }
                  setConfirmDeleteId(null);
                  void deleteGateway(gateway.id);
                }}
                aria-label={confirmDeleteId === gateway.id ? `Confirm delete ${gateway.name}` : `Delete ${gateway.name}`}
                title={confirmDeleteId === gateway.id ? 'Click again to confirm delete' : `Delete ${gateway.name}`}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 grid gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. OpenRouter)" className="h-8" />
        <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="Base URL (e.g. https://openrouter.ai/api/v1)" className="h-8 font-mono text-xs" />
        <Input value={gwModel} onChange={e => setGwModel(e.target.value)} placeholder="Model id (e.g. openai/gpt-4o-mini)" className="h-8 font-mono text-xs" />
        <div className="flex items-center gap-2">
          <Input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password" placeholder="API key" className="h-8 flex-1 font-mono text-xs" />
          <Button type="button" variant="secondary" size="sm" onClick={add} disabled={busy || !name.trim() || !baseUrl.trim()}>
            <Plus data-icon="inline-start" /> Add
          </Button>
        </div>
      </div>
    </Field>
  );
}

function AIPanel({ workspaceId }: { workspaceId: string | null }) {
  const [useCtx, setUseCtx] = useState(getSettings().ai_use_workspace_context);

  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <Switch
          checked={useCtx}
          onCheckedChange={checked => {
            const next = Boolean(checked);
            setUseCtx(next);
            setSetting('ai_use_workspace_context', next);
          }}
        />
        <div>
          <FieldLabel>Workspace knowledge</FieldLabel>
          <FieldDescription>
            New chats can see your documents, tasks, memory, and canvas notes by default.
          </FieldDescription>
        </div>
      </Field>

      <GatewaysManager workspaceId={workspaceId} />
    </FieldGroup>
  );
}

function ToolsPanel({ workspace }: { workspace: Workspace | null }) {
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const isDesktopLocal = Boolean(window.electronAPI?.discoverLocalAgents);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    const next = await getSystemCapabilities(
      workspace?.local_path || workspace?.git_root || '',
      { refresh },
    );
    setCapabilities(next);
    setLoading(false);
  }, [workspace?.local_path, workspace?.git_root]);

  useEffect(() => { void load(false); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Scanning tools
      </div>
    );
  }

  if (!capabilities) {
    return <FieldDescription>Tool detection is unavailable.</FieldDescription>;
  }

  return (
    <FieldGroup>
      <FieldDescription>
        {isDesktopLocal || capabilities.source === 'local-desktop'
          ? 'Detected on this machine from PATH, Homebrew, nvm, and known install folders — Claude, Codex, Amp, Grok, Hermes, Goose, Cursor, OpenCode, OpenClaw, and other local agent CLIs.'
          : 'Detected from PATH, local packages, and known agent config/skill folders.'}
      </FieldDescription>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Codex app-server</ItemTitle>
          <ItemDescription>{capabilities.codexAppServer.available ? capabilities.codexAppServer.command : 'Codex CLI not found'}</ItemDescription>
        </ItemContent>
        <Badge variant={capabilities.codexAppServer.available ? 'default' : 'secondary'}>
          {capabilities.codexAppServer.available ? 'Available' : 'Missing'}
        </Badge>
      </Item>

      <Field>
        <FieldLabel>CLIs</FieldLabel>
        <div className="grid gap-1">
          {capabilities.clis.map(cli => {
            const detail = (() => {
              if (!cli.available) return cli.command;
              const bits = [`${cli.command}${cli.version ? ` · ${cli.version}` : ''}`];
              if (cli.adapter?.path) bits.push(`adapter ${cli.adapter.command}`);
              else if (cli.adapter && !cli.adapter.path && cli.underlying?.available) bits.push(`adapter missing (${cli.adapter.command})`);
              if (cli.path) bits.push(cli.path);
              return bits.join(' · ');
            })();
            return (
              <Item key={cli.id} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle>{cli.label}</ItemTitle>
                  <ItemDescription className="truncate" title={detail}>{detail}</ItemDescription>
                </ItemContent>
                <Badge variant={cli.available ? 'default' : 'secondary'}>{cli.available ? 'Found' : 'Missing'}</Badge>
              </Item>
            );
          })}
        </div>
      </Field>

      <Field>
        <FieldLabel>SDK packages</FieldLabel>
        <div className="grid gap-1">
          {capabilities.packages.map(pkg => (
            <Item key={pkg.name} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>{pkg.name}</ItemTitle>
                <ItemDescription>{pkg.version || pkg.path || 'Not installed in this app'}</ItemDescription>
              </ItemContent>
              <Badge variant={pkg.available ? 'default' : 'secondary'}>{pkg.available ? 'Installed' : 'Missing'}</Badge>
            </Item>
          ))}
        </div>
      </Field>

      <Field>
        <FieldLabel>Skill and config libraries</FieldLabel>
        <div className="grid gap-1">
          {capabilities.skills.map(skill => (
            <Item key={skill.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>{skill.label}</ItemTitle>
                <ItemDescription>{skill.path}</ItemDescription>
              </ItemContent>
              <Badge variant={skill.available ? 'default' : 'secondary'}>{skill.count}</Badge>
            </Item>
          ))}
        </div>
      </Field>

      <Button type="button" variant="outline" size="sm" onClick={() => void load(true)}>
        <Wrench data-icon="inline-start" />
        Rescan
      </Button>
    </FieldGroup>
  );
}

function formatSeenAt(value?: string | null): string {
  if (!value) return 'never';
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return 'unknown';
  const deltaSec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (deltaSec < 15) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return new Date(at).toLocaleString();
}

function connectionStatusLabel(status: AgentConnection['status']): string {
  if (status === 'online') return 'Online';
  if (status === 'busy') return 'Busy';
  return 'Offline';
}

// Workspace MCP connection — owner-only control credential for clients
// (Grok, Claude Code, Cursor, Codex, …). Status + endpoint load immediately;
// the live bearer is only available right after mint/rotate (hash at rest).
// Connected clients (agent sockets + pending MCP registrations) are listed for
// anyone who can open this tab.
function ConnectionsPanel({
  workspaceId,
  isWorkspaceOwner,
}: {
  workspaceId: string | null;
  isWorkspaceOwner: boolean;
}) {
  const [info, setInfo] = useState<McpConnectInfo | null>(null);
  const [liveToken, setLiveToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [oauthCatalog, setOauthCatalog] = useState<McpOauthCatalog | null>(null);
  const [oauthMinted, setOauthMinted] = useState<McpOauthClientMinted | null>(null);
  const [showOauthSecret, setShowOauthSecret] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const workspaceRequestRef = useRef({ workspaceId, generation: 0 });
  const copiedTimeoutRef = useRef<number | null>(null);
  if (workspaceRequestRef.current.workspaceId !== workspaceId) {
    workspaceRequestRef.current = {
      workspaceId,
      generation: workspaceRequestRef.current.generation + 1,
    };
  }

  const { connections, loading: clientsLoading, refetch: refetchClients } = useAgentConnections(workspaceId);
  const { pending, approve, deny, refresh: refreshRegistrations } = useAgentRegistrations(
    isWorkspaceOwner ? workspaceId : null,
  );

  const liveClients = connections.filter(c => c.status === 'online' || c.status === 'busy');
  const recentClients = connections.filter(c => c.status === 'offline').slice(0, 8);

  // Always-visible MCP/OAuth URLs from the app's backend base (works even when
  // status APIs 404 on an older server build).
  const mcpFallback = useMemo(() => {
    const base = String(getBackendBaseUrl() || '').replace(/\/+$/, '')
      || 'https://agensis-backend.fly.dev';
    return {
      endpoint: `${base}/backend/mcp`,
      claudeMcpAdd: `claude mcp add --transport http agensis ${base}/backend/mcp --header "Authorization: Bearer aga_YOUR_AGENT_TOKEN"`,
      resource: `${base}/backend/mcp`,
      authorizationEndpoint: `${base}/backend/oauth/authorize`,
      tokenEndpoint: `${base}/backend/oauth/token`,
      registrationEndpoint: `${base}/backend/oauth/register`,
      scopes: ['mcp:tools'],
      tokenEndpointAuthMethods: ['none', 'client_secret_post', 'client_secret_basic'],
      clients: [] as McpOauthCatalog['clients'],
    };
  }, []);

  const loadStatus = useCallback(async () => {
    const request = workspaceRequestRef.current;
    const isCurrent = () => workspaceRequestRef.current === request;
    if (!workspaceId || !isWorkspaceOwner) {
      setInfo(null);
      setLiveToken(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    // Seed UI immediately so OAuth fields are never blank while/if status 404s.
    setInfo((prev) => prev || {
      configured: false,
      autoApprove: false,
      endpoint: mcpFallback.endpoint,
      claudeMcpAdd: mcpFallback.claudeMcpAdd,
      config: null,
    });
    setOauthCatalog((prev) => prev || {
      resource: mcpFallback.resource,
      authorizationEndpoint: mcpFallback.authorizationEndpoint,
      tokenEndpoint: mcpFallback.tokenEndpoint,
      registrationEndpoint: mcpFallback.registrationEndpoint,
      scopes: mcpFallback.scopes,
      tokenEndpointAuthMethods: mcpFallback.tokenEndpointAuthMethods,
      clients: [],
    });
    try {
      const next = await getMcpConnection(workspaceId);
      if (!isCurrent()) return;
      setInfo(next);
      setAuto(next.autoApprove);
      setLiveToken(null);
      setShowToken(false);
    } catch (e) {
      if (!isCurrent()) return;
      // Status GET may 404 on a backend that has not been redeployed yet.
      // Keep fallback endpoints visible; do not map that to "no longer exists".
      const msg = e instanceof Error ? e.message : String(e);
      if (!/404|not found|no longer exists/i.test(msg)) {
        setErr(describeWriteFailure('load MCP connection', e).description);
      }
    }
    try {
      const catalog = await getMcpOauthCatalog(workspaceId);
      if (!isCurrent()) return;
      setOauthCatalog(catalog);
    } catch {
      // keep fallback catalog
    }
    if (!isCurrent()) return;
    setOauthMinted(null);
    setShowOauthSecret(false);
    setLoading(false);
  }, [workspaceId, isWorkspaceOwner, mcpFallback]);

  useEffect(() => {
    if (copiedTimeoutRef.current !== null) {
      window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = null;
    }
    setInfo(null);
    setLiveToken(null);
    setShowToken(false);
    setCopied(null);
    setErr(null);
    setWebhookOpen(false);
    setAuto(false);
    setBusy(false);
    setOauthCatalog(null);
    setOauthMinted(null);
    setShowOauthSecret(false);
    setOauthBusy(false);
    void loadStatus();
  }, [workspaceId, isWorkspaceOwner, loadStatus]);

  const mintOauthClient = async () => {
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    const request = workspaceRequestRef.current;
    const isCurrent = () => workspaceRequestRef.current === request;
    setOauthBusy(true);
    setErr(null);
    try {
      const minted = await createMcpOauthClient(workspaceId, {
        name: 'MCP OAuth client',
        tokenEndpointAuthMethod: 'none',
      });
      if (!isCurrent()) return;
      setOauthMinted(minted);
      setShowOauthSecret(false);
      const catalog = await getMcpOauthCatalog(workspaceId);
      if (!isCurrent()) return;
      setOauthCatalog(catalog);
    } catch (e) {
      if (isCurrent()) setErr(describeWriteFailure('create OAuth client', e).description);
    } finally {
      if (isCurrent()) setOauthBusy(false);
    }
  };

  const mintOrRotate = async () => {
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    if (!isWorkspaceOwner) { setErr('Only the workspace owner can issue its control credential.'); return; }
    const request = workspaceRequestRef.current;
    const isCurrent = () => workspaceRequestRef.current === request;
    setBusy(true);
    setErr(null);
    try {
      const next = await generateMcpToken(workspaceId);
      if (!isCurrent()) return;
      setInfo(next);
      setAuto(next.autoApprove);
      setLiveToken(next.token || null);
      setShowToken(false);
    } catch (e) {
      if (isCurrent()) setErr(describeWriteFailure('issue MCP credential', e).description);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const toggleAuto = async (next: boolean) => {
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    if (!isWorkspaceOwner) { setErr('Only the workspace owner can change workspace credential policy.'); return; }
    const request = workspaceRequestRef.current;
    const isCurrent = () => workspaceRequestRef.current === request;
    setAuto(next);
    setErr(null);
    try {
      await setMcpAutoApprove(workspaceId, next);
    } catch (e) {
      if (!isCurrent()) return;
      setAuto(!next);
      setErr(describeWriteFailure('change auto-approve', e).description);
    }
  };

  const copy = async (key: string, value: string) => {
    const request = workspaceRequestRef.current;
    try {
      await navigator.clipboard.writeText(value);
      if (workspaceRequestRef.current !== request) return;
      setCopied(key);
      if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = window.setTimeout(() => {
        if (workspaceRequestRef.current === request) setCopied(null);
        copiedTimeoutRef.current = null;
      }, 1500);
    } catch { /* ignore */ }
  };

  return (
    <FieldGroup>
      {isWorkspaceOwner ? (
        <>
          <div>
            <div className="mb-1 text-sm font-medium">MCP connection</div>
            <FieldDescription>
              Point an MCP client at this workspace. The credential can register agents and create
              workspace-visible resources; it is not your login and cannot read private conversations.
            </FieldDescription>
          </div>

          {loading && !info ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading connection…
            </div>
          ) : null}

          {/* Always show MCP + OAuth for owners — do not hide behind a successful status GET. */}
          {(info || !loading) && (
            <div className="space-y-3 overflow-hidden">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={info?.configured || liveToken ? 'default' : 'secondary'}>
                  {info?.configured || liveToken ? 'Credential issued' : 'No credential yet'}
                </Badge>
                {liveToken && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    New token shown below — copy it now; it is not stored in plain text.
                  </span>
                )}
              </div>

              <ConnectionRow
                label="Endpoint"
                value={info?.endpoint || mcpFallback.endpoint}
                copied={copied === 'ep'}
                onCopy={() => copy('ep', info?.endpoint || mcpFallback.endpoint)}
              />
              <ConnectionRow
                label="claude mcp add"
                value={info?.claudeMcpAdd || mcpFallback.claudeMcpAdd}
                copied={copied === 'cmd'}
                onCopy={() => copy('cmd', info?.claudeMcpAdd || mcpFallback.claudeMcpAdd)}
              />
              <p className="pl-[7.5rem] text-xs text-muted-foreground">
                Replace <code className="rounded bg-muted px-1">aga_YOUR_AGENT_TOKEN</code> with the bearer token
                (or paste the token into your client&apos;s Authorization header).
              </p>

              {liveToken ? (
                <ConnectionRow
                  label="Bearer token"
                  value={liveToken}
                  secret
                  revealed={showToken}
                  onToggleReveal={() => setShowToken(v => !v)}
                  copied={copied === 'tok'}
                  onCopy={() => copy('tok', liveToken)}
                />
              ) : info?.configured ? (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">Bearer token</span>
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    Issued earlier and not re-displayed. Rotate to mint a new token (invalidates the old one).
                  </p>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">Bearer token</span>
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    Issue a credential to get a token you can paste into any MCP client.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between rounded-md border bg-card/50 px-3 py-2">
                <div>
                  <div className="text-sm">Auto-approve new agents</div>
                  <div className="text-xs text-muted-foreground">
                    Skip the popup — a registering client is approved instantly.
                  </div>
                </div>
                <Switch checked={auto} onCheckedChange={toggleAuto} aria-label="Auto-approve new agents" />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => void mintOrRotate()} disabled={busy}>
                  {busy ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      {info?.configured || liveToken ? 'Rotating…' : 'Issuing…'}
                    </>
                  ) : (
                    <>
                      <RefreshCw data-icon="inline-start" />
                      {info?.configured || liveToken ? 'Rotate credential' : 'Issue credential'}
                    </>
                  )}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => void loadStatus()} disabled={loading || busy}>
                  Refresh status
                </Button>
              </div>

              <div className="border-t border-border pt-4 space-y-3" data-testid="mcp-oauth-fields">
                <div>
                  <div className="mb-1 text-sm font-medium">OAuth 2.1 (MCP)</div>
                  <FieldDescription>
                    Authorization-code + PKCE for remote MCP clients. Server URL is the MCP resource;
                    use the endpoints below with client id (and optional secret).
                  </FieldDescription>
                </div>
                <div className="space-y-2 overflow-hidden">
                  <ConnectionRow
                    label="Server URL"
                    value={(oauthCatalog || mcpFallback).resource}
                    copied={copied === 'oauth-res'}
                    onCopy={() => copy('oauth-res', (oauthCatalog || mcpFallback).resource)}
                  />
                  <ConnectionRow
                    label="Authorize"
                    value={(oauthCatalog || mcpFallback).authorizationEndpoint}
                    copied={copied === 'oauth-auth'}
                    onCopy={() => copy('oauth-auth', (oauthCatalog || mcpFallback).authorizationEndpoint)}
                  />
                  <ConnectionRow
                    label="Token"
                    value={(oauthCatalog || mcpFallback).tokenEndpoint}
                    copied={copied === 'oauth-tok'}
                    onCopy={() => copy('oauth-tok', (oauthCatalog || mcpFallback).tokenEndpoint)}
                  />
                  <ConnectionRow
                    label="Register"
                    value={(oauthCatalog || mcpFallback).registrationEndpoint}
                    copied={copied === 'oauth-reg'}
                    onCopy={() => copy('oauth-reg', (oauthCatalog || mcpFallback).registrationEndpoint)}
                  />
                  <ConnectionRow
                    label="Scopes"
                    value={(oauthCatalog || mcpFallback).scopes.join(' ')}
                    copied={copied === 'oauth-scopes'}
                    onCopy={() => copy('oauth-scopes', (oauthCatalog || mcpFallback).scopes.join(' '))}
                  />
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-28 shrink-0 text-xs text-muted-foreground">Token auth</span>
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                      none (PKCE) · client_secret_post · client_secret_basic
                    </code>
                  </div>
                </div>
                {oauthMinted && (
                  <div className="space-y-2 rounded-md border border-border bg-card/50 p-3">
                    <ConnectionRow
                      label="Client ID"
                      value={oauthMinted.clientId}
                      copied={copied === 'oauth-cid'}
                      onCopy={() => copy('oauth-cid', oauthMinted.clientId)}
                    />
                    {oauthMinted.clientSecret && (
                      <ConnectionRow
                        label="Client secret"
                        value={oauthMinted.clientSecret}
                        secret
                        revealed={showOauthSecret}
                        onToggleReveal={() => setShowOauthSecret(v => !v)}
                        copied={copied === 'oauth-csec'}
                        onCopy={() => copy('oauth-csec', oauthMinted.clientSecret || '')}
                      />
                    )}
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Client secret is shown once. Token auth method: {oauthMinted.tokenEndpointAuthMethod}.
                    </p>
                  </div>
                )}
                {!oauthMinted && (oauthCatalog?.clients?.length || 0) > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {oauthCatalog!.clients.map(c => (
                      <li key={c.clientId} className="flex flex-wrap gap-2">
                        <code className="rounded bg-muted px-1">{c.clientId}</code>
                        <span>{c.tokenEndpointAuthMethod}</span>
                        {c.hasSecret ? <span>has secret</span> : <span>public (PKCE)</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <Button type="button" variant="outline" onClick={() => void mintOauthClient()} disabled={oauthBusy}>
                  {oauthBusy ? 'Creating OAuth client…' : 'Create OAuth client'}
                </Button>
              </div>
            </div>
          )}

          {err && <p className="text-xs text-destructive" role="alert">{err}</p>}
        </>
      ) : (
        <FieldDescription>
          MCP credentials are owner-only. Connected clients below are still visible for this workspace.
          Ask the owner for a join URL when you need an individual invite.
        </FieldDescription>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">Connected clients</div>
            <p className="text-xs text-muted-foreground">
              Live Relay / desktop / MCP agent sockets, and clients waiting for approval.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void refetchClients();
              void refreshRegistrations();
            }}
            disabled={!workspaceId}
          >
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>

        {isWorkspaceOwner && pending.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Waiting for approval</div>
            <ul className="space-y-2">
              {pending.map(reg => (
                <li
                  key={reg.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card/50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {reg.requested_name || reg.requested_handle || 'Unknown client'}
                      {reg.requested_handle ? (
                        <span className="ml-1 font-normal text-muted-foreground">@{reg.requested_handle}</span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {reg.client_label?.trim() || 'MCP client'}
                      {' · '}
                      {formatSeenAt(reg.created_at)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button type="button" size="sm" variant="outline" onClick={() => void deny(reg.id)}>
                      Deny
                    </Button>
                    <Button type="button" size="sm" onClick={() => void approve(reg.id)}>
                      Approve
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {clientsLoading && connections.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading clients…
          </div>
        ) : liveClients.length === 0 && recentClients.length === 0 && pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No clients connected in the last 24 hours. Connect a Relay agent or MCP client to see it here.
          </p>
        ) : (
          <div className="space-y-2">
            {liveClients.length > 0 && (
              <>
                <div className="text-xs font-medium text-muted-foreground">
                  Live now ({liveClients.length})
                </div>
                <ul className="space-y-2">
                  {liveClients.map(conn => (
                    <ConnectedClientRow key={conn.id} connection={conn} />
                  ))}
                </ul>
              </>
            )}
            {recentClients.length > 0 && (
              <>
                <div className="text-xs font-medium text-muted-foreground pt-1">
                  Recently seen
                </div>
                <ul className="space-y-2">
                  {recentClients.map(conn => (
                    <ConnectedClientRow key={conn.id} connection={conn} />
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {isWorkspaceOwner && (
        <>
          <div className="border-t border-border pt-4">
            <div className="mb-2 text-sm font-medium">Event webhooks</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Optional outbound signed deliveries when workspace events fire. Separate from the MCP credential above.
            </p>
            <Button type="button" variant="outline" onClick={() => setWebhookOpen(true)} disabled={!workspaceId}>
              Add event webhook
            </Button>
          </div>
          <ConnectFlowsDialog workspaceId={workspaceId} channelId={null} open={webhookOpen} onOpenChange={setWebhookOpen} />
        </>
      )}
    </FieldGroup>
  );
}

function ConnectedClientRow({ connection }: { connection: AgentConnection }) {
  const title = connection.name?.trim()
    || (connection.handle ? `@${connection.handle}` : null)
    || connection.host
    || 'Client';
  const handle = connection.handle?.trim() ? `@${connection.handle.replace(/^@/, '')}` : null;
  const hostLine = [connection.host, connection.cwd].filter(Boolean).join(' · ');
  const status = connection.status;
  const badgeVariant = status === 'online' ? 'default' : status === 'busy' ? 'secondary' : 'outline';

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card/50 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {title}
          {handle && title !== handle ? (
            <span className="ml-1 font-normal text-muted-foreground">{handle}</span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {hostLine || 'No host info'}
          {' · seen '}
          {formatSeenAt(connection.last_seen_at)}
        </div>
      </div>
      <Badge variant={badgeVariant} className="shrink-0">
        {connectionStatusLabel(status)}
      </Badge>
    </li>
  );
}

function ConnectionRow({
  label,
  value,
  secret,
  revealed,
  onToggleReveal,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  secret?: boolean;
  revealed?: boolean;
  onToggleReveal?: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  const display = secret && !revealed
    ? `${value.slice(0, 10)}…${value.slice(-4)}`
    : value;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{display}</code>
      {secret && onToggleReveal && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onToggleReveal}
          aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onCopy} aria-label={`Copy ${label}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

interface SecretKeyInfo {
  key: string;
  configured: boolean;
  scope?: 'workspace' | 'app' | 'unset';
  updated_at?: string | null;
}

// "Set 3 Jul" / "Never set". A vault entry gives up its STATE and nothing else, so
// this line and the badge are the whole story a reader gets about a stored value.
function describeLastSet(updatedAt: string | null | undefined): string {
  if (!updatedAt) return '';
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return '';
  return `Set ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function SecretsPanel({ workspaceId }: { workspaceId: string | null }) {
  const [keys, setKeys] = useState<SecretKeyInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    // Drafts are plaintext secrets. Keeping one after a workspace switch risks
    // writing workspace A's credential into workspace B under the same key.
    setDrafts({});
    setReveal({});
    setSavedAt(0);
    setError(null);
  }, [workspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setKeys([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/backend/settings/secrets?workspaceId=${encodeURIComponent(workspaceId)}`), { headers: apiAuthHeaders() });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      setKeys(json.data?.keys || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const payload: Record<string, string> = {};
    Object.entries(drafts).forEach(([key, value]) => {
      if (value !== undefined && value !== '') payload[key] = value;
    });
    if (Object.keys(payload).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/backend/settings/secrets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ workspaceId, ...payload }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      setKeys(json.data?.keys || []);
      setDrafts({});
      setReveal({});
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const labelFor = (key: string) => key === 'ANTHROPIC_API_KEY' ? 'Anthropic API key' : key;
  const scopeLabel = (scope?: string) => scope === 'workspace' ? 'Workspace key' : scope === 'app' ? 'Using app fallback' : 'Not configured';
  const hasDrafts = Object.values(drafts).some(value => value && value.length > 0);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading
      </div>
    );
  }

  return (
    <FieldGroup>
      <FieldDescription>
        Owner/admin only. Everything here is stored encrypted for this workspace and is never sent back
        to the browser — not even masked. Leave a field blank to keep the current value.
      </FieldDescription>

      <div className="text-sm font-semibold">Platform keys</div>
      {keys.map(item => (
        <Field key={item.key}>
          <FieldLabel htmlFor={`secret-${item.key}`}>{labelFor(item.key)}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={`secret-${item.key}`}
              type={reveal[item.key] ? 'text' : 'password'}
              value={drafts[item.key] ?? ''}
              onChange={e => setDrafts(draft => ({ ...draft, [item.key]: e.target.value }))}
              placeholder={item.configured ? 'Enter a new key to replace' : 'Paste your key'}
              autoComplete="off"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => setReveal(current => ({ ...current, [item.key]: !current[item.key] }))}
                aria-label={reveal[item.key] ? 'Hide key' : 'Show key'}
              >
                {reveal[item.key] ? <EyeOff /> : <Eye />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            {[scopeLabel(item.scope), describeLastSet(item.updated_at)].filter(Boolean).join(' · ')}
          </FieldDescription>
        </Field>
      ))}

      {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={!hasDrafts || saving}>
          {saving ? <Spinner data-icon="inline-start" /> : null}
          Save keys
        </Button>
        {savedAt > 0 && !hasDrafts && (
          <Badge variant="secondary">
            <Check />
            Saved
          </Badge>
        )}
      </div>

      <VaultSections workspaceId={workspaceId} />
    </FieldGroup>
  );
}

// ---------------------------------------------------------------------------
// The vault surface.
//
// Every credential the workspace holds, in one place, grouped so a namespaced
// entry reads as belonging to its provider rather than sitting loose in a flat
// list. Each entry is WRITE-ONLY: set it, replace it, delete it. There is
// no preview and no reveal, because the server has nothing to reveal — the list
// route neither decrypts nor selects the secret columns.
// ---------------------------------------------------------------------------

// One row: what it is, whether it is set, when it was last set, and the actions
// its write lane allows. Shared by all four groups so they read identically.
function VaultEntryRow({
  title,
  subtitle,
  configured,
  updatedAt,
  onSave,
  onDelete,
  placeholder,
  note,
}: {
  title: string;
  subtitle?: string;
  configured: boolean;
  updatedAt: string | null;
  onSave?: (value: string) => Promise<string | null>;
  onDelete?: () => Promise<void>;
  placeholder?: string;
  note?: string;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!onSave || !draft) return;
    setBusy(true);
    setErr(null);
    try {
      const failure = await onSave(draft);
      if (failure) setErr(failure);
      else setDraft('');
    } finally {
      setBusy(false);
    }
  };

  const state = configured
    ? [describeLastSet(updatedAt) || 'Configured'].filter(Boolean).join('')
    : 'Not set';

  return (
    <div className="rounded-md border bg-card/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          {subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <Badge variant={configured ? 'secondary' : 'outline'} className="shrink-0">
          {configured ? <Check /> : null}
          {state}
        </Badge>
        {onDelete && configured && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Delete ${title}`}
            onClick={() => void onDelete()}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>

      {onSave && (
        <div className="mt-2 flex gap-2">
          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            type="password"
            autoComplete="off"
            placeholder={placeholder ?? (configured ? 'Paste a new value to replace' : 'Paste the value')}
            className="text-xs"
          />
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !draft}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {configured ? 'Replace' : 'Save'}
          </Button>
        </div>
      )}
      {note && <div className="mt-1.5 text-xs text-muted-foreground">{note}</div>}
      {err && <div className="mt-1.5 text-xs text-destructive">{err}</div>}
    </div>
  );
}

// Exported for tests/unit/vaultPanelRender.test.ts: whether a value ever reaches
// the DOM is a claim only a mount can settle.
export function VaultSections({ workspaceId }: { workspaceId: string | null }) {
  const {
    sections,
    loading,
    error,
    setSharedSecret,
    deleteSharedSecret,
    setProviderCredential,
    deleteProviderCredential,
  } = useWorkspaceVault(workspaceId);

  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    const key = newKey.trim();
    if (!key || !newValue) return;
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) { setErr('Key: letters, digits, _ . - only (max 128)'); return; }
    setBusy(true);
    setErr(null);
    try {
      const failure = await setSharedSecret(key, newValue, newDesc.trim() || undefined);
      if (failure) { setErr(failure); return; }
      setNewKey(''); setNewValue(''); setNewDesc('');
    } finally {
      setBusy(false);
    }
  };

  // The managed section is rendered by SecretsPanel above (it has its own route and
  // its own app-fallback semantics), so it is skipped here.
  const rendered = sections.filter(section => section.group !== 'managed');

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading the vault
        </div>
      )}
      {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}

      {rendered.map(section => (
        <div key={section.group}>
          <div className="mb-1 text-sm font-semibold">{section.title}</div>
          <FieldDescription className="mb-2">
            {section.group === 'provider' && 'Credentials your agents spend through agensis. An agent never receives the value — it names an operation and the server attaches the key.'}
            {section.group === 'shared' && 'Loose secrets for this workspace.'}
            {section.group === 'unknown' && 'Entries whose key does not match any known namespace.'}
          </FieldDescription>

          <div className="flex flex-col gap-2">
            {section.owners.map(owner => (
              <div key={`${section.group}:${owner.owner}`} className="flex flex-col gap-1.5">
                {owner.ownerLabel && (
                  <div className="text-xs font-medium text-muted-foreground">{owner.ownerLabel}</div>
                )}
                {owner.entries.map(entry => (
                  <VaultEntryRow
                    key={entry.key}
                    title={entry.label}
                    subtitle={entry.key}
                    configured={entry.configured}
                    updatedAt={entry.updated_at}
                    note={[
                      entry.description,
                      entry.lane === 'none' ? 'This namespaced entry is no longer managed by an installed integration.' : '',
                      entry.env ? `Falls back to ${entry.env} when the server runs locally.` : '',
                      entry.legacy_plaintext ? 'Stored before encryption at rest — replace it to re-encrypt.' : '',
                    ].filter(Boolean).join(' ') || undefined}
                    onSave={entry.lane === 'provider'
                      ? (value: string) => setProviderCredential(entry.provider, entry.credential, value)
                      : entry.lane === 'shared'
                        ? (value: string) => setSharedSecret(entry.key, value, entry.description || undefined)
                        : undefined}
                    onDelete={entry.lane === 'provider'
                      ? () => deleteProviderCredential(entry.provider, entry.credential)
                      : entry.lane === 'shared'
                        ? () => deleteSharedSecret(entry.key)
                        : undefined}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div>
        <div className="mb-1 text-sm font-semibold">Add a shared secret</div>
        <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5">
          <div className="flex gap-2">
            <Input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="KEY_NAME" className="font-mono text-xs" />
            <Input value={newValue} onChange={e => setNewValue(e.target.value)} type="password" placeholder="value" autoComplete="off" />
          </div>
          <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Description (optional)" className="text-xs" />
          {err && <div className="text-xs text-destructive">{err}</div>}
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={() => void add()} disabled={busy || !newKey.trim() || !newValue}>
              <Plus data-icon="inline-start" />
              Add secret
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface WorkspaceUsage {
  uploadBytes: number;
  memoryBytes: number;
  totalBytes: number;
  counts: {
    files: number;
    memoryFiles: number;
    documents: number;
    tasks: number;
    agents: number;
    messages: number;
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[exponent]}`;
}

function UsagePanel({ workspaceId, workspaceName }: { workspaceId: string | null; workspaceName: string }) {
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setUsage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/backend/workspace/${encodeURIComponent(workspaceId)}/usage`), { headers: apiAuthHeaders() });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'Failed to load usage');
      setUsage(json.data as WorkspaceUsage);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  if (!workspaceId) {
    return (
      <FieldGroup>
        <FieldDescription>Select a workspace to see its usage.</FieldDescription>
      </FieldGroup>
    );
  }

  if (loading) {
    return (
      <FieldGroup>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading usage…
        </div>
      </FieldGroup>
    );
  }

  if (error) {
    return (
      <FieldGroup>
        <FieldDescription className="text-destructive">{error}</FieldDescription>
        <Button type="button" variant="outline" size="sm" onClick={load}>Retry</Button>
      </FieldGroup>
    );
  }

  const counts: Array<{ label: string; value: number }> = [
    { label: 'Documents', value: usage?.counts.documents ?? 0 },
    { label: 'Messages', value: usage?.counts.messages ?? 0 },
    { label: 'Tasks', value: usage?.counts.tasks ?? 0 },
    { label: 'Agents', value: usage?.counts.agents ?? 0 },
    { label: 'Uploaded files', value: usage?.counts.files ?? 0 },
    { label: 'Memory files', value: usage?.counts.memoryFiles ?? 0 },
  ];

  return (
    <FieldGroup>
      <FieldDescription>Storage and entity counts for {workspaceName || 'this workspace'}.</FieldDescription>
      <ReadOnlyValue label="Storage used" value={formatBytes(usage?.totalBytes ?? 0)} />
      <div className="grid grid-cols-2 gap-2">
        <ReadOnlyValue label="Uploads" value={formatBytes(usage?.uploadBytes ?? 0)} />
        <ReadOnlyValue label="Agent memory" value={formatBytes(usage?.memoryBytes ?? 0)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {counts.map(item => (
          <ReadOnlyValue key={item.label} label={item.label} value={item.value.toLocaleString()} />
        ))}
      </div>
    </FieldGroup>
  );
}

function AboutPanel() {
  return (
    <FieldGroup>
      <ReadOnlyValue label="agensis" value="A shared workspace where AI agents work with you, your team, and each other." />
      <ReadOnlyValue label="Backend" value="Neon Postgres, local server on :3142" />
    </FieldGroup>
  );
}
