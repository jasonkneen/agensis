import { SHAPES, type ShapeId } from "./skins";

export function avatarSeed(modelId: string, name: string): string {
  return `${modelId}:${name}`;
}

/** Use each character once before repeating, in the saved roster's order. */
export function assignAvatarShapes(agents: readonly { modelId: string; name: string }[]): Map<string, ShapeId> {
  const assigned = new Map<string, ShapeId>();
  for (const agent of agents) {
    const seed = avatarSeed(agent.modelId, agent.name);
    if (!assigned.has(seed)) assigned.set(seed, SHAPES[assigned.size % SHAPES.length]!.id);
  }
  return assigned;
}
