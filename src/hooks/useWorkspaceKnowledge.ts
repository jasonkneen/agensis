import { useMemo } from 'react';
import type { SystemCapabilities } from '../lib/backendClient';
import type { AgentWebhook, CanvasObject, Document, MemoryFact, Task, WorkspaceAgent } from '../types';
import { useWorkspaceContext, type WorkspaceContextSnapshot } from './useWorkspaceContext';

export type WorkspaceContextCounts = {
  docs: number;
  facts: number;
  tasks: number;
  agents: number;
  skills: number;
  commands: number;
  tools: number;
  webhooks: number;
};

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function uniqueTokens(values: unknown[]) {
  return new Set(values.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean));
}

function buildContextCounts(
  documents: Document[],
  facts: MemoryFact[],
  tasks: Task[],
  agents: WorkspaceAgent[],
  agentWebhooks: AgentWebhook[],
  capabilities: SystemCapabilities | null,
): WorkspaceContextCounts {
  const openTaskCount = tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled').length;
  const availableLibraries = capabilities?.skills.filter(skill => skill.available) || [];
  const detectedSkillCount = availableLibraries
    .filter(skill => skill.type === 'skills' || skill.type === 'agents')
    .reduce((total, skill) => total + skill.count, 0);
  const commandLibraryCount = availableLibraries
    .filter(skill => skill.type === 'commands')
    .reduce((total, skill) => total + skill.count, 0);
  const selectedAgentSkills = uniqueTokens(agents.flatMap(agent => agent.skills || []));
  const selectedAgentTools = uniqueTokens(agents.flatMap(agent => agent.tools || []));
  const availableCommandCount = capabilities?.clis.filter(cli => cli.available).length || 0;
  const availablePackageCount = capabilities?.packages.filter(pkg => pkg.available).length || 0;
  const codexAppServerCount = capabilities?.codexAppServer.available ? 1 : 0;

  return {
    docs: documents.length,
    facts: facts.length,
    tasks: openTaskCount,
    agents: agents.length,
    skills: detectedSkillCount + selectedAgentSkills.size,
    commands: availableCommandCount + commandLibraryCount,
    tools: availablePackageCount + codexAppServerCount + selectedAgentTools.size,
    webhooks: agentWebhooks.filter(webhook => webhook.enabled).length,
  };
}

function formatContextTitle(counts: WorkspaceContextCounts) {
  return [
    countLabel(counts.docs, 'document'),
    countLabel(counts.facts, 'memory fact'),
    countLabel(counts.tasks, 'open task'),
    countLabel(counts.agents, 'agent'),
    countLabel(counts.skills, 'skill'),
    countLabel(counts.commands, 'command'),
    countLabel(counts.tools, 'tool'),
    countLabel(counts.webhooks, 'enabled webhook'),
  ].join(', ');
}

interface WorkspaceKnowledgeInputs {
  workspaceName: string;
  documents: Document[];
  facts: MemoryFact[];
  tasks: Task[];
  canvasObjects: CanvasObject[];
  agents: WorkspaceAgent[];
  agentWebhooks: AgentWebhook[];
  capabilities: SystemCapabilities | null;
}

export function useWorkspaceKnowledge({
  workspaceName,
  documents,
  facts,
  tasks,
  canvasObjects,
  agents,
  agentWebhooks,
  capabilities,
}: WorkspaceKnowledgeInputs): {
  contextCounts: WorkspaceContextCounts;
  contextCountsTitle: string;
  buildWorkspaceContext: () => WorkspaceContextSnapshot;
} {
  const contextCounts = useMemo(
    () => buildContextCounts(documents, facts, tasks, agents, agentWebhooks, capabilities),
    [documents, facts, tasks, agents, agentWebhooks, capabilities],
  );
  const contextCountsTitle = useMemo(() => formatContextTitle(contextCounts), [contextCounts]);

  const { buildSnapshot: buildWorkspaceContext } = useWorkspaceContext({
    workspaceName,
    documents,
    memoryFacts: facts,
    tasks,
    canvasObjects,
    agents,
    agentWebhooks,
    capabilities,
  });

  return { contextCounts, contextCountsTitle, buildWorkspaceContext };
}
