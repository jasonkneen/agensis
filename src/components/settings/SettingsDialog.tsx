import { useState, useEffect, useCallback } from 'react';
import {
  X, Settings as SettingsIcon, Palette, Sparkles, KeyRound, Info,
  Check, Eye, EyeOff, Loader2,
} from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import { AI_MODELS } from '../../types';
import { getSettings, setSetting } from '../../lib/settings';
import { apiUrl } from '../../lib/backendClient';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
  userEmail: string;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

type TabId = 'general' | 'appearance' | 'ai' | 'secrets' | 'about';

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={15} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} /> },
  { id: 'ai', label: 'AI', icon: <Sparkles size={15} /> },
  { id: 'secrets', label: 'Secret keys', icon: <KeyRound size={15} /> },
  { id: 'about', label: 'About', icon: <Info size={15} /> },
];

export function SettingsDialog({
  open,
  onClose,
  workspaceName,
  userEmail,
  themeMode,
  onThemeChange,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<TabId>('general');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 720, height: 520, margin: '0 16px',
        display: 'flex',
        backgroundColor: 'var(--canvas-elevated)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-xl)',
        overflow: 'hidden',
      }}>
        {/* Side tabs */}
        <div style={{
          width: 184, flexShrink: 0,
          borderRight: '1px solid var(--border-subtle)',
          background: 'var(--canvas-raised)',
          display: 'flex', flexDirection: 'column', padding: '14px 10px',
        }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
            padding: '4px 8px 12px',
          }}>
            Settings
          </div>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '8px 10px', marginBottom: 2,
                borderRadius: 'var(--radius-md)',
                border: 'none', cursor: 'pointer', textAlign: 'left',
                background: tab === t.id ? 'var(--accent-subtle)' : 'transparent',
                color: tab === t.id ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                transition: 'background var(--transition-fast)',
              }}
              onMouseEnter={e => { if (tab !== t.id) e.currentTarget.style.background = 'var(--canvas-overlay)'; }}
              onMouseLeave={e => { if (tab !== t.id) e.currentTarget.style.background = 'transparent'; }}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {TABS.find(t => t.id === tab)?.label}
            </span>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, border: 'none', borderRadius: 'var(--radius-sm)',
                background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
              }}
            >
              <X size={18} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '18px' }}>
            {tab === 'general' && <GeneralPanel workspaceName={workspaceName} userEmail={userEmail} />}
            {tab === 'appearance' && <AppearancePanel themeMode={themeMode} onThemeChange={onThemeChange} />}
            {tab === 'ai' && <AIPanel />}
            {tab === 'secrets' && <SecretsPanel />}
            {tab === 'about' && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

function ReadOnlyValue({ value }: { value: string }) {
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 'var(--radius-sm)',
      background: 'var(--canvas-raised)', border: '1px solid var(--border)',
      color: 'var(--text-secondary)', fontSize: 13,
    }}>
      {value}
    </div>
  );
}

function GeneralPanel({ workspaceName, userEmail }: { workspaceName: string; userEmail: string }) {
  return (
    <div>
      <Field label="Account"><ReadOnlyValue value={userEmail || 'Not signed in'} /></Field>
      <Field label="Active workspace"><ReadOnlyValue value={workspaceName || '—'} /></Field>
    </div>
  );
}

function AppearancePanel({ themeMode, onThemeChange }: { themeMode: ThemeMode; onThemeChange: (m: ThemeMode) => void }) {
  const modes: Array<{ id: ThemeMode; label: string }> = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
  ];
  return (
    <Field label="Theme" hint="Choose how Hatch looks. System follows your OS setting.">
      <div style={{ display: 'flex', gap: 8 }}>
        {modes.map(m => (
          <button
            key={m.id}
            onClick={() => onThemeChange(m.id)}
            style={{
              flex: 1, padding: '10px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
              border: themeMode === m.id ? '1px solid var(--accent-border)' : '1px solid var(--border)',
              background: themeMode === m.id ? 'var(--accent-subtle)' : 'var(--canvas-raised)',
              color: themeMode === m.id ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

function AIPanel() {
  const [model, setModel] = useState(getSettings().ai_default_model);
  const [useCtx, setUseCtx] = useState(getSettings().ai_use_workspace_context);

  return (
    <div>
      <Field label="Default model" hint="The model new chats start with. You can still switch per chat.">
        <select
          value={model}
          onChange={e => { setModel(e.target.value); setSetting('ai_default_model', e.target.value); }}
          style={{
            width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)',
            background: 'var(--canvas-raised)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer',
          }}
        >
          {AI_MODELS.map(m => (
            <option key={m.id} value={m.id}>{m.label} — {m.description}</option>
          ))}
        </select>
      </Field>
      <Field label="Workspace knowledge" hint="When on, new chats can see your documents, tasks, memory and canvas notes by default.">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={useCtx}
            onChange={e => { setUseCtx(e.target.checked); setSetting('ai_use_workspace_context', e.target.checked); }}
            style={{ cursor: 'pointer' }}
          />
          Use workspace knowledge by default
        </label>
      </Field>
    </div>
  );
}

interface SecretKeyInfo { key: string; configured: boolean; preview: string }

function SecretsPanel() {
  const [keys, setKeys] = useState<SecretKeyInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/backend/settings/secrets'));
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      setKeys(json.data?.keys || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const payload: Record<string, string> = {};
    Object.entries(drafts).forEach(([k, v]) => { if (v !== undefined && v !== '') payload[k] = v; });
    if (Object.keys(payload).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/backend/settings/secrets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

  const labelFor = (key: string) =>
    key === 'ANTHROPIC_API_KEY' ? 'Anthropic API key' : key;

  const hasDrafts = Object.values(drafts).some(v => v && v.length > 0);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
        <Loader2 size={14} className="spin" /> Loading…
      </div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
        Keys are stored on the server (in <code>.env</code>) and never kept in the browser. Leave a field blank to keep the current value.
      </p>
      {keys.map(k => (
        <Field
          key={k.key}
          label={labelFor(k.key)}
          hint={k.configured ? `Currently set · ${k.preview}` : 'Not configured'}
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type={reveal[k.key] ? 'text' : 'password'}
              value={drafts[k.key] ?? ''}
              onChange={e => setDrafts(d => ({ ...d, [k.key]: e.target.value }))}
              placeholder={k.configured ? 'Enter a new key to replace' : 'Paste your key'}
              autoComplete="off"
              style={{
                flex: 1, padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                background: 'var(--canvas-raised)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', fontSize: 13, outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={() => setReveal(r => ({ ...r, [k.key]: !r[k.key] }))}
              title={reveal[k.key] ? 'Hide' : 'Show'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 34, borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                background: 'var(--canvas-raised)', border: '1px solid var(--border)',
                color: 'var(--text-muted)',
              }}
            >
              {reveal[k.key] ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>
      ))}

      {error && (
        <div style={{ fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={save}
          disabled={!hasDrafts || saving}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 'var(--radius-md)', border: 'none',
            background: hasDrafts && !saving ? 'var(--accent)' : 'var(--canvas-overlay)',
            color: hasDrafts && !saving ? '#fff' : 'var(--text-muted)',
            fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
            cursor: hasDrafts && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? <Loader2 size={14} className="spin" /> : null}
          Save keys
        </button>
        {savedAt > 0 && !hasDrafts && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--accent)' }}>
            <Check size={13} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}

function AboutPanel() {
  return (
    <div>
      <Field label="Hatch"><ReadOnlyValue value="AI-powered workspace for documents, chat, and memory" /></Field>
      <Field label="Backend"><ReadOnlyValue value="Neon Postgres · local server on :3142" /></Field>
    </div>
  );
}
