import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  KeyRound,
  Palette,
  Settings as SettingsIcon,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import { AI_MODELS, type Workspace } from '../../types';
import { getSettings, setSetting } from '../../lib/settings';
import { apiAuthHeaders, apiUrl, getSystemCapabilities, type SystemCapabilities } from '../../lib/backendClient';
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
}

type TabId = 'general' | 'appearance' | 'ai' | 'tools' | 'secrets' | 'about';

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <SettingsIcon /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette /> },
  { id: 'ai', label: 'AI', icon: <Sparkles /> },
  { id: 'tools', label: 'Tools', icon: <Wrench /> },
  { id: 'secrets', label: 'Secret keys', icon: <KeyRound /> },
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
}: SettingsDialogProps) {
  const [tab, setTab] = useState<TabId>('general');
  const activeTab = TABS.find(item => item.id === tab);

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
      <DialogContent className="grid max-h-[calc(100svh-2rem)] overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border p-4 pr-12">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>{activeTab?.label}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[12rem_1fr]">
          <nav className="flex flex-col gap-1 border-r border-border bg-muted/40 p-3">
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
          <ScrollArea className="h-[28rem] min-w-0">
            <div className="p-4">
              {tab === 'general' && (
                <GeneralPanel
                  workspace={workspace}
                  workspaceName={workspaceName}
                  userEmail={userEmail}
                  onUpdateWorkspace={onUpdateWorkspace}
                />
              )}
              {tab === 'appearance' && (
                <AppearancePanel
                  workspace={workspace}
                  onUpdateWorkspace={onUpdateWorkspace}
                  themeMode={themeMode}
                  onThemeChange={onThemeChange}
                />
              )}
              {tab === 'ai' && <AIPanel />}
              {tab === 'tools' && <ToolsPanel workspace={workspace} />}
              {tab === 'secrets' && <SecretsPanel workspace={workspace} />}
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
            <InputGroupButton size="xs" onClick={inspectAndSave} disabled={!workspace || !pathDraft.trim() || inspecting}>
              {inspecting ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
              Link
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>
          {pathStatus || workspace?.git_root || workspace?.local_path || 'Associate this workspace with a local folder or Git repository.'}
        </FieldDescription>
      </Field>
    </FieldGroup>
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
  const [backgroundOpacity, setBackgroundOpacity] = useState(() => Math.round((workspace?.background_opacity ?? 0.42) * 100));
  const modes: Array<{ id: ThemeMode; label: string }> = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
    { id: 'tinyworld-light', label: 'TinyWorld Light' },
    { id: 'tinyworld-dark', label: 'TinyWorld Dark' },
    { id: 'neo-light', label: 'Neo Light' },
    { id: 'neo-dark', label: 'Neo Dark' },
  ];

  useEffect(() => {
    setBackgroundOpacity(Math.round((workspace?.background_opacity ?? 0.42) * 100));
  }, [workspace?.id, workspace?.background_opacity]);

  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Theme</FieldLabel>
        <ToggleGroup
          type="single"
          value={themeMode}
          onValueChange={value => {
            if (value) onThemeChange(value as ThemeMode);
          }}
          variant="outline"
          className="grid w-full grid-cols-2 sm:grid-cols-3"
        >
          {modes.map(mode => (
            <ToggleGroupItem key={mode.id} value={mode.id}>
              {mode.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>System follows your OS setting. TinyWorld and Neo provide separate light and dark control palettes.</FieldDescription>
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Workspace background opacity</FieldLabel>
          <Badge variant="secondary">{backgroundOpacity}%</Badge>
        </div>
        <Slider
          value={[backgroundOpacity]}
          min={10}
          max={80}
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

function AIPanel() {
  const [model, setModel] = useState(getSettings().ai_default_model);
  const [useCtx, setUseCtx] = useState(getSettings().ai_use_workspace_context);

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
          {AI_MODELS.map(item => (
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

interface SecretKeyInfo {
  key: string;
  configured: boolean;
  preview: string;
  scope?: 'workspace' | 'app' | 'unset';
}

function SecretsPanel({ workspace }: { workspace: Workspace | null }) {
  const [keys, setKeys] = useState<SecretKeyInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  const load = useCallback(async () => {
    if (!workspace?.id) {
      setKeys([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/backend/settings/secrets?workspaceId=${encodeURIComponent(workspace.id)}`), { headers: apiAuthHeaders() });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      setKeys(json.data?.keys || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [workspace?.id]);

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
        body: JSON.stringify({ workspaceId: workspace?.id, ...payload }),
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
    </FieldGroup>
  );
}

function AboutPanel() {
  return (
    <FieldGroup>
      <ReadOnlyValue label="Hatch" value="AI-powered workspace for documents, chat, and memory" />
      <ReadOnlyValue label="Backend" value="Neon Postgres, local server on :3142" />
    </FieldGroup>
  );
}
