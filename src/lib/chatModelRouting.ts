export function isSharedModelRoute(model: string | null | undefined): boolean {
  return String(model || '').startsWith('agensis/');
}

export function directAiModel(model: string, agentModel?: string | null): string {
  return isSharedModelRoute(model) ? model : agentModel || model;
}
