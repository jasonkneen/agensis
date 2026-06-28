import { useCallback } from 'react';
import type { SystemCapabilities } from '../lib/backendClient';
import type { Document, MemoryFact, Task, CanvasObject, WorkspaceAgent, AgentWebhook } from '../types';

export interface WorkspaceContextSnapshot {
  workspace: string;
  memory: string | null;
  documents: string | null;
  tasks: string | null;
  canvas: string | null;
  agents: string | null;
  skills: string | null;
  commands: string | null;
  tools: string | null;
  webhooks: string | null;
}

export interface WorkspaceContextSources {
  workspaceName: string;
  documents: Document[];
  memoryFacts: MemoryFact[];
  tasks: Task[];
  canvasObjects: CanvasObject[];
  agents: WorkspaceAgent[];
  agentWebhooks: AgentWebhook[];
  capabilities: SystemCapabilities | null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

function uniqueList(values: unknown[]) {
  return Array.from(new Set(values.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean)));
}

function formatVersion(version?: string | null) {
  return version ? ` (${version})` : '';
}

/**
 * Aggregates workspace knowledge (docs, memory, tasks, canvas) into a
 * structured snapshot for injection into the AI chat system prompt.
 */
export function useWorkspaceContext(sources: WorkspaceContextSources) {
  const { workspaceName, documents, memoryFacts, tasks, canvasObjects, agents, agentWebhooks, capabilities } = sources;

  const buildSnapshot = useCallback((): WorkspaceContextSnapshot => {
    // Memory: all facts (capped for safety)
    const memory = memoryFacts.length > 0
      ? memoryFacts.slice(0, 40).map(f => `[${f.category || 'general'}] ${f.fact}`).join('\n')
      : null;

    // Documents: favorites first, then most recent, up to 6 docs, 600 chars each
    const favDocs = documents.filter(d => d.is_favorite);
    const otherDocs = documents.filter(d => !d.is_favorite).slice(0, 6 - favDocs.length);
    const picked = [...favDocs.slice(0, 6), ...otherDocs].slice(0, 6);
    const docContext = picked.length > 0
      ? picked.map(d => {
          const text = truncate(stripHtml(d.content || ''), 600);
          const marker = d.is_favorite ? '★' : '•';
          return `${marker} ${d.title}\n${text || '(empty)'}`;
        }).join('\n\n')
      : null;

    // Tasks: open tasks only, up to 20
    const openTasks = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').slice(0, 20);
    const taskContext = openTasks.length > 0
      ? openTasks.map(t => {
          const parts = [`[${t.status}] ${t.title}`];
          if (t.priority && t.priority !== 'normal') parts.push(`(${t.priority})`);
          if (t.due_date) parts.push(`due ${new Date(t.due_date).toLocaleDateString()}`);
          return parts.join(' ');
        }).join('\n')
      : null;

    // Canvas: text + sticky_note objects only, up to 15
    const canvasText = canvasObjects
      .filter(o => (o.type === 'text' || o.type === 'sticky_note') && o.text_content)
      .slice(0, 15)
      .map(o => `- ${truncate(o.text_content, 200)}`)
      .join('\n');
    const canvasContext = canvasText || null;

    const agentContext = agents.length > 0
      ? agents.slice(0, 12).map(agent => {
          const details = [
            agent.description ? truncate(agent.description, 180) : null,
            agent.model ? `model: ${agent.model}` : null,
            agent.tools?.length ? `tools: ${agent.tools.join(', ')}` : null,
            agent.skills?.length ? `skills: ${agent.skills.join(', ')}` : null,
          ].filter(Boolean);
          return `- ${agent.name}${details.length ? ` - ${details.join('; ')}` : ''}`;
        }).join('\n')
      : null;

    const agentSkillNames = uniqueList(agents.flatMap(agent => agent.skills || []));
    const detectedSkillLibraries = capabilities?.skills
      .filter(skill => skill.available && (skill.type === 'skills' || skill.type === 'agents'))
      .map(skill => `- ${skill.label}: ${skill.count} entries at ${skill.path}`) || [];
    const skillContext = [...detectedSkillLibraries, ...agentSkillNames.map(skill => `- Selected by agents: ${skill}`)].join('\n') || null;

    const availableClis = capabilities?.clis
      .filter(cli => cli.available)
      .map(cli => `- ${cli.label}: ${cli.command}${formatVersion(cli.version)}${cli.path ? ` at ${cli.path}` : ''}`) || [];
    const commandLibraries = capabilities?.skills
      .filter(skill => skill.available && skill.type === 'commands')
      .map(skill => `- ${skill.label}: ${skill.count} commands at ${skill.path}`) || [];
    const commandContext = [...availableClis, ...commandLibraries].join('\n') || null;

    const agentToolNames = uniqueList(agents.flatMap(agent => agent.tools || []));
    const availablePackages = capabilities?.packages
      .filter(pkg => pkg.available)
      .map(pkg => `- ${pkg.name}${formatVersion(pkg.version)}${pkg.path ? ` at ${pkg.path}` : ''}`) || [];
    const codexAppServer = capabilities?.codexAppServer.available
      ? [`- Codex app server: ${capabilities.codexAppServer.command} via ${capabilities.codexAppServer.transports.join(', ')}`]
      : [];
    const toolContext = [
      ...availablePackages,
      ...codexAppServer,
      ...agentToolNames.map(tool => `- Selected by agents: ${tool}`),
    ].join('\n') || null;

    const webhookContext = agentWebhooks.length > 0
      ? agentWebhooks.slice(0, 12).map(webhook => {
          const agent = webhook.agent_id ? agents.find(item => item.id === webhook.agent_id) : null;
          const status = webhook.enabled ? 'enabled' : 'disabled';
          return `- ${webhook.name} (${status})${agent ? ` -> ${agent.name}` : ''}`;
        }).join('\n')
      : null;

    return {
      workspace: workspaceName,
      memory,
      documents: docContext,
      tasks: taskContext,
      canvas: canvasContext,
      agents: agentContext,
      skills: skillContext,
      commands: commandContext,
      tools: toolContext,
      webhooks: webhookContext,
    };
  }, [workspaceName, documents, memoryFacts, tasks, canvasObjects, agents, agentWebhooks, capabilities]);

  return { buildSnapshot };
}
