import { AI_MODELS, type AIModel, type AgentConnection } from '../types';

export function workspaceChatModels(workspaceId: string | null | undefined, connections: AgentConnection[]): AIModel[] {
  const models = new Map(AI_MODELS.map(model => [model.id, model]));
  if (!workspaceId) return [...models.values()];

  const shared: AIModel[] = [];
  for (const connection of connections) {
    if (connection.workspace_id !== workspaceId || !connection.agent_id) continue;
    if (!['online', 'busy'].includes(connection.status)) continue;
    for (const model of connection.capabilities?.sharedModels || []) {
      if (model.shared !== true || !model.id) continue;
      const id = `agensis/${workspaceId}/${connection.agent_id}/${encodeURIComponent(model.id)}`;
      if (models.has(id)) continue;
      const option = {
        id,
        label: `${model.name || model.id} · ${connection.name || connection.host || connection.handle}`,
        description: `${model.provider || 'local'} shared by @${connection.handle}`,
      };
      models.set(id, option);
      shared.push(option);
    }
  }

  const builtins = AI_MODELS.map(model => models.get(model.id) as AIModel);
  return [...builtins, ...shared.sort((left, right) => left.label.localeCompare(right.label))];
}

export function availableChatModelId(modelId: string, models: AIModel[]): string {
  return models.some(model => model.id === modelId) ? modelId : 'auto';
}
