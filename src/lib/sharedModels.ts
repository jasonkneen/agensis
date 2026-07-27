import { AI_MODELS, type AIModel, type AgentConnection, type GatewayConfig } from '../types';

export function workspaceChatModels(workspaceId: string | null | undefined, connections: AgentConnection[], gateways: GatewayConfig[] = []): AIModel[] {
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

  const gatewayOptions: AIModel[] = [];
  for (const gateway of gateways) {
    if (gateway.workspace_id !== workspaceId) continue;
    const id = `gateway:${gateway.id}`;
    if (models.has(id)) continue;
    const option = {
      id,
      label: `${gateway.name} · gateway`,
      description: `${gateway.model || 'model'} via ${gateway.base_url || 'custom endpoint'}`,
    };
    models.set(id, option);
    gatewayOptions.push(option);
  }

  const builtins = AI_MODELS.map(model => models.get(model.id) as AIModel);
  return [
    ...builtins,
    ...gatewayOptions.sort((left, right) => left.label.localeCompare(right.label)),
    ...shared.sort((left, right) => left.label.localeCompare(right.label)),
  ];
}

export function availableChatModelId(modelId: string, models: AIModel[]): string {
  return models.some(model => model.id === modelId) ? modelId : 'auto';
}
