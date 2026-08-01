/**
 * Clip to the last whole markdown block that fits, so a preview can never end
 * inside a table row or a code fence. Returns the full text when it already fits
 * (callers use length equality to decide whether "Show more" is needed).
 */
export function clipToBlockBoundary(text: string, budget: number) {
  if (text.length <= budget) return text;

  const blocks = text.split(/\n{2,}/);
  const kept: string[] = [];
  let used = 0;
  let insideFence = false;

  for (const block of blocks) {
    const fenceCount = (block.match(/```/g) || []).length;
    const opensFence = fenceCount % 2 === 1;
    if (kept.length === 0 && block.length > budget) {
      const clipped = text.slice(0, budget);
      const cutLeavesFenceOpen = ((clipped.match(/```/g) || []).length % 2) === 1;
      return cutLeavesFenceOpen ? `${clipped}\n\`\`\`\n…` : `${clipped}…`;
    }
    if (used + block.length > budget && kept.length > 0 && !insideFence) break;
    kept.push(block);
    used += block.length + 2;
    if (opensFence) insideFence = !insideFence;
    if (used >= budget && !insideFence) break;
  }

  if (kept.length === 0) return `${text.slice(0, budget)}…`;
  return kept.join('\n\n');
}
