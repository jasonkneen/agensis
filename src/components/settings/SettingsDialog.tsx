import { useCallback, useEffect, useRef, useState } from 'react';
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
  Trash2,
  Settings as SettingsIcon,
  Sparkles,
  Upload,
  Wrench,
} from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import { AI_MODELS, type Workspace } from '../../types';
import { applyUiAppearanceSettings, getSettings, setSetting, type AppSettings, type NotificationLevel, type UiFontFamily } from '../../lib/settings';
import { THEME_PRESETS, applyThemePreset } from '../../showcase/themePresets';
import { NEO_THEMES, NEO_GROUPS, applyNeoTheme, resolveNeoStyle } from '../../showcase/neoThemes';
import { NORMAL_THEMES, NORMAL_GROUPS, applyNormalTheme, clearNormalTheme, getStoredNormalTheme } from '../../showcase/normalThemes';
import { TW_WORLDS, applyTwTheme, getStoredTwTheme } from '../../showcase/twThemes';
import { apiAuthHeaders, apiUrl, getSystemCapabilities, type SystemCapabilities } from '../../lib/backendClient';
import { generateMcpToken, setMcpAutoApprove, type McpConnectInfo } from '../../lib/mcpConnect';
import { WORKSPACE_UNAVAILABLE, describeWriteFailure } from '../../lib/writeFeedback';
import { useWorkspaceVault } from '../../hooks/useWorkspaceVault';
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
  // Which tab to show when the dialog opens (defaults to General). Lets callers
  // deep-link — e.g. the Agents window "Connect a client" button opens Connections.
  initialTab?: SettingsTabId;
}

export type SettingsTabId = 'general' | 'notifications' | 'appearance' | 'ai' | 'tools' | 'connections' | 'secrets' | 'usage' | 'about';
type TabId = SettingsTabId;

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <SettingsIcon /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette /> },
  { id: 'ai', label: 'AI', icon: <Sparkles /> },
  { id: 'tools', label: 'Tools', icon: <Wrench /> },
  { id: 'connections', label: 'Connections', icon: <Plug /> },
  { id: 'secrets', label: 'Secret keys', icon: <KeyRound /> },
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
              {tab === 'connections' && <ConnectionsPanel workspaceId={secretsWorkspaceId} />}
              {tab === 'secrets' && <SecretsPanel workspaceId={secretsWorkspaceId} />}
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
      <ReadOnlyValue label="Active workspace" value={workspaceName || 'None'} />
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

  return (
    <div className="settings-panel-stack">
      <SettingsPanelHeader title="Notifications" description="Choose what pulls your attention." />
      <div className="settings-card-grid">
        <SettingsChoiceCard
          title="All new messages"
          description="Every message in your channels and DMs."
          selected={level === 'all'}
          onClick={() => setNotificationLevel('all')}
        />
        <SettingsChoiceCard
          title="Direct messages & mentions"
          description="DMs, @mentions, and agent broadcasts only."
          selected={level === 'mentions'}
          onClick={() => setNotificationLevel('mentions')}
        />
        <SettingsChoiceCard
          title="Nothing"
          description="No notifications — catch up in the app."
          selected={level === 'none'}
          onClick={() => setNotificationLevel('none')}
        />
      </div>
      <div className="settings-toggle-list">
        <SettingsToggleRow title="Play a sound" description="A soft chime when a notification arrives." checked={sound} onCheckedChange={checked => toggle('notifications_sound', checked)} />
        <SettingsToggleRow title="Desktop notifications" description="Show OS notifications when agensis is in the background." checked={desktop} onCheckedChange={checked => toggle('notifications_desktop', checked)} />
        <SettingsToggleRow title="Agent events" description="Notify when remote agents connect, finish, or need attention." checked={agentEvents} onCheckedChange={checked => toggle('notifications_agent_events', checked)} />
        <SettingsToggleRow title="Task reminders" description="Notify when assigned tasks are due soon." checked={taskReminders} onCheckedChange={checked => toggle('notifications_task_reminders', checked)} />
      </div>
    </div>
  );
}

function SettingsPanelHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="settings-panel-header">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function SettingsChoiceCard({ title, description, selected, onClick }: { title: string; description: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" className="settings-choice-card" data-selected={selected ? 'true' : undefined} onClick={onClick}>
      <span className="settings-choice-radio" />
      <span className="settings-choice-copy">
        <span>{title}</span>
        <small>{description}</small>
      </span>
    </button>
  );
}

function SettingsToggleRow({ title, description, checked, onCheckedChange }: { title: string; description: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="settings-toggle-row">
      <div>
        <div className="settings-toggle-title">{title}</div>
        <div className="settings-toggle-description">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
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
  const [backgroundOpacity, setBackgroundOpacity] = useState(() => Math.round((workspace?.background_opacity ?? 0.42) * 100));
  const [fontFamily, setFontFamily] = useState<UiFontFamily>(initialSettings.ui_font_family);
  const [baseFontSize, setBaseFontSize] = useState(initialSettings.ui_base_font_size);
  const [themePreset, setThemePreset] = useState(initialSettings.ui_theme_preset);
  const [neoTheme, setNeoTheme] = useState(initialSettings.ui_neo_theme);
  const [normalTheme, setNormalTheme] = useState(() => getStoredNormalTheme());
  const [twTheme, setTwTheme] = useState(() => getStoredTwTheme());
  const isNeoFamily = themeMode === 'neo-light' || themeMode === 'neo-dark';
  const isNormalFamily = themeMode === 'normal-light' || themeMode === 'normal-dark';
  const isTinyWorld = themeMode === 'tinyworld-light' || themeMode === 'tinyworld-dark';
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
    { id: 'tinyworld-light', label: 'TW Light' },
    { id: 'tinyworld-dark', label: 'TW Dark' },
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
    setBackgroundOpacity(Math.round((workspace?.background_opacity ?? 0.42) * 100));
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

            {/* TinyWorld world grid — repaints the paper; composes with the
                accent preset above (world paper + your picked accent). */}
            {isTinyWorld && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">TinyWorld</div>
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
                  Repaints TinyWorld’s paper. Your accent (above) stays on top — pick a world for the mood, an accent for the highlight.
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
          <FieldLabel>Workspace background</FieldLabel>
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
        <FieldDescription>Pick a bundled workspace image or upload a local image for this workspace.</FieldDescription>
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Workspace background opacity</FieldLabel>
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
        <FieldDescription>Stored on this workspace so every device opens it with the same background strength.</FieldDescription>
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
        Route a chat through an external OpenAI-compatible endpoint. The API key is stored
        encrypted and never shown again. Select a gateway from the model picker in any chat.
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
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => void deleteGateway(gateway.id)} aria-label={`Delete ${gateway.name}`}>
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
  const [model, setModel] = useState(getSettings().ai_default_model);
  const [useCtx, setUseCtx] = useState(getSettings().ai_use_workspace_context);
  const [models, setModels] = useState(AI_MODELS);

  useEffect(() => {
    if (!workspaceId) {
      setModels(AI_MODELS);
      return;
    }
    let cancelled = false;
    fetch(apiUrl(`/backend/inference/v1/models?workspaceId=${encodeURIComponent(workspaceId)}`), { headers: apiAuthHeaders() })
      .then(async response => response.ok ? response.json() : Promise.reject(new Error('Shared models unavailable')))
      .then(payload => {
        if (cancelled) return;
        const shared = (Array.isArray(payload?.data) ? payload.data : []).map((entry: { id: string; farm?: { modelId?: string; host?: string; provider?: string } }) => ({
          id: entry.id,
          label: `${entry.farm?.modelId || entry.id} · ${entry.farm?.host || 'Agensis agent'}`,
          description: `${entry.farm?.provider || 'local'} workspace model`,
        }));
        const next = [...AI_MODELS, ...shared];
        if (model && !next.some(item => item.id === model)) next.unshift({ id: model, label: model, description: 'Saved model (currently unavailable)' });
        setModels(next);
      })
      .catch(() => setModels(model && !AI_MODELS.some(item => item.id === model)
        ? [{ id: model, label: model, description: 'Saved model (currently unavailable)' }, ...AI_MODELS]
        : AI_MODELS));
    return () => { cancelled = true; };
  }, [workspaceId, model]);

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="default-ai-model">Default model</FieldLabel>
        <NativeSelect
          id="default-ai-model"
          value={model}
          onChange={e => {
            setModel(e.target.value);
            setSetting('ai_default_model', e.target.value);
          }}
          className="w-full"
        >
          {models.map(item => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.label} - {item.description}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>The model new chats start with. You can still switch per chat.</FieldDescription>
      </Field>

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

  const load = useCallback(async () => {
    setLoading(true);
    const next = await getSystemCapabilities(workspace?.local_path || workspace?.git_root || '');
    setCapabilities(next);
    setLoading(false);
  }, [workspace?.local_path, workspace?.git_root]);

  useEffect(() => { load(); }, [load]);

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
        Detected from PATH, local packages, and known agent config/skill folders.
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
          {capabilities.clis.map(cli => (
            <Item key={cli.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>{cli.label}</ItemTitle>
                <ItemDescription>{cli.available ? `${cli.command}${cli.version ? ` - ${cli.version}` : ''}` : cli.command}</ItemDescription>
              </ItemContent>
              <Badge variant={cli.available ? 'default' : 'secondary'}>{cli.available ? 'Found' : 'Missing'}</Badge>
            </Item>
          ))}
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

      <Button type="button" variant="outline" size="sm" onClick={load}>
        <Wrench data-icon="inline-start" />
        Rescan
      </Button>
    </FieldGroup>
  );
}

// Workspace connections — mint the ONE workspace MCP token, show the paste-able
// config, and toggle auto-approve. Any client that pastes this token can
// register_agent and join the whole workspace; this is intentionally NOT scoped
// to a single agent (that confusion is why it lives here, not the Agents window).
function ConnectionsPanel({ workspaceId }: { workspaceId: string | null }) {
  const [info, setInfo] = useState<McpConnectInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flowsOpen, setFlowsOpen] = useState(false);

  const generate = async () => {
    // No workspace id means the workspace list never loaded. The button used to
    // be silently `disabled` in that state, so clicking it did nothing at all
    // and nothing said why. Say why instead.
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    setBusy(true); setErr(null);
    try {
      const next = await generateMcpToken(workspaceId);
      setInfo(next);
      setAuto(next.autoApprove);
    } catch (e) {
      setErr(describeWriteFailure('generate a connection token', e).description);
    } finally { setBusy(false); }
  };

  const toggleAuto = async (next: boolean) => {
    if (!workspaceId) { setErr(WORKSPACE_UNAVAILABLE.reason); return; }
    setAuto(next);
    setErr(null);
    try {
      await setMcpAutoApprove(workspaceId, next);
    } catch (e) {
      // The switch snapping back on its own is not an explanation.
      setAuto(!next);
      setErr(describeWriteFailure('change auto-approve', e).description);
    }
  };

  const copy = async (key: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

  return (
    <FieldGroup>
      <FieldDescription>
        Hand out one key that lets an MCP client — Claude Code, Cursor, Codex — join <strong>this whole workspace</strong> as an agent.
        It is not tied to a single agent: any client that pastes this token can register itself, which you approve with a popup
        (or instantly when auto-approve is on).
      </FieldDescription>

      {!info ? (
        <Button type="button" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate connection token'}</Button>
      ) : (
        <div className="space-y-3 overflow-hidden">
          <ConnectionRow label="claude mcp add" value={info.claudeMcpAdd} copied={copied === 'cmd'} onCopy={() => copy('cmd', info.claudeMcpAdd)} />
          <ConnectionRow label="Endpoint" value={info.endpoint} copied={copied === 'ep'} onCopy={() => copy('ep', info.endpoint)} />
          <ConnectionRow label="Bearer token" value={info.token} secret copied={copied === 'tok'} onCopy={() => copy('tok', info.token)} />
          <div className="flex items-center justify-between rounded-md border bg-card/50 px-3 py-2">
            <div>
              <div className="text-sm">Auto-approve new agents</div>
              <div className="text-xs text-muted-foreground">Skip the popup — a registering client is approved instantly.</div>
            </div>
            <Switch checked={auto} onCheckedChange={toggleAuto} aria-label="Auto-approve new agents" />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={generate} disabled={busy}>Regenerate token</Button>
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}

      <div className="border-t border-border pt-4">
        <div className="mb-2 text-sm font-medium">Connect Flows</div>
        <p className="mb-3 text-xs text-muted-foreground">
          Create a workspace-scoped MCP connection with an optional signed event webhook.
        </p>
        <Button type="button" variant="outline" onClick={() => setFlowsOpen(true)} disabled={!workspaceId}>
          Connect Flows workspace
        </Button>
      </div>
      <ConnectFlowsDialog workspaceId={workspaceId} channelId={null} open={flowsOpen} onOpenChange={setFlowsOpen} />
    </FieldGroup>
  );
}

function ConnectionRow({ label, value, secret, copied, onCopy }: { label: string; value: string; secret?: boolean; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{secret ? `${value.slice(0, 10)}…${value.slice(-4)}` : value}</code>
      <Button type="button" size="sm" variant="ghost" onClick={onCopy} aria-label={`Copy ${label}`}>{copied ? <Check /> : <Copy />}</Button>
    </div>
  );
}

interface SecretKeyInfo {
  key: string;
  configured: boolean;
  preview: string;
  scope?: 'workspace' | 'app' | 'unset';
}

function SecretsPanel({ workspaceId }: { workspaceId: string | null }) {
  const [keys, setKeys] = useState<SecretKeyInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

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
        Owner/admin only. Keys are stored for this workspace and never in the browser. Leave a field blank to keep the current value.
      </FieldDescription>

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
            {item.configured ? `${scopeLabel(item.scope)} - ${item.preview}` : scopeLabel(item.scope)}
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

      <SharedSecretsSection workspaceId={workspaceId} />
    </FieldGroup>
  );
}

// User-defined shared secrets (arbitrary keys), encrypted at rest server-side.
// Values are write-only: the list shows a masked preview, never the full value.
function SharedSecretsSection({ workspaceId }: { workspaceId: string | null }) {
  const { secrets, setSecret, deleteSecret } = useWorkspaceVault(workspaceId);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    const key = newKey.trim();
    if (!key || !newValue) return;
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) { setErr('Key: letters, digits, _ . - only (max 128)'); return; }
    setBusy(true); setErr(null);
    try {
      const ok = await setSecret(key, newValue, newDesc.trim() || undefined);
      if (!ok) { setErr('Failed to save — owner/admin only'); return; }
      setNewKey(''); setNewValue(''); setNewDesc('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-1 text-sm font-semibold">Shared secrets</div>
      <FieldDescription className="mb-3">
        Store API keys, tokens, and credentials your agents can use. Encrypted at rest; values are never shown again after saving.
      </FieldDescription>

      {secrets.length > 0 && (
        <div className="mb-3 flex flex-col gap-1.5">
          {secrets.map(secret => (
            <div key={secret.key} className="flex items-center gap-2 rounded-md border bg-card/50 px-2.5 py-1.5">
              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{secret.key}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {secret.preview}{secret.description ? ` · ${secret.description}` : ''}
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Delete ${secret.key}`} onClick={() => void deleteSecret(secret.key)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

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
