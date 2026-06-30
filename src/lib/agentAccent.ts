import type { CSSProperties } from 'react';
import type { WorkspaceAgent } from '../types';

export const DEFAULT_AGENT_ACCENT = '#00a95c';
export const AGENT_ACCENT_CHOICES = ['#00a95c', '#38bdf8', '#a78bfa', '#f59e0b', '#f472b6', '#ef4444'];

export function validAgentAccentColor(value?: string | null) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_AGENT_ACCENT;
}

export function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function agentAccentPaletteColor(index: number) {
  return AGENT_ACCENT_CHOICES[Math.abs(index) % AGENT_ACCENT_CHOICES.length] || DEFAULT_AGENT_ACCENT;
}

export function agentAccentColor(agent: Pick<WorkspaceAgent, 'id' | 'name' | 'handle' | 'accent_color'>) {
  const explicit = String(agent.accent_color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(explicit)) return explicit;
  return agentAccentPaletteColor(hashString(`${agent.id || ''}:${agent.handle || ''}:${agent.name || ''}`));
}

export function agentHandle(agent: Pick<WorkspaceAgent, 'handle' | 'name'>): string {
  return String(agent.handle || agent.name || 'agent')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'agent';
}

export type AgentAccentStyle = CSSProperties & { '--agent-accent'?: string };

export function agentAccentStyle(agent: Pick<WorkspaceAgent, 'id' | 'name' | 'handle' | 'accent_color'>): AgentAccentStyle {
  return { '--agent-accent': agentAccentColor(agent) };
}

