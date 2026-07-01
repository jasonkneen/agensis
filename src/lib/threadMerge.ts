import { messageText } from './chatStream';
import type { Message } from '../types';

// Identity of a top-level message for split/merge divergence. splitSession copies
// a message into the fork preserving created_at, role, and content, so these three
// fields uniquely tie a copy back to its original.
function messageIdentity(m: Message): string {
  return `${m.created_at}|${m.role}|${messageText(m.content)}`;
}

/**
 * Given both branches' top-level messages, return each branch's post-split
 * divergence by set-difference of the shared (copied) history.
 *
 * This deliberately does NOT compare against split_at: split_at is a browser
 * wall-clock value while created_at is the server clock, so a timestamp
 * comparison dropped real fork work whenever the browser clock ran ahead (M7,
 * 2026-07 review). A message is "diverged" iff no copy of it exists in the other
 * branch — which is clock-independent.
 */
export function computeThreadDivergence(
  parentTop: Message[],
  forkTop: Message[],
): { parentDiverged: Message[]; forkDiverged: Message[] } {
  const parentKeys = new Set(parentTop.map(messageIdentity));
  const forkKeys = new Set(forkTop.map(messageIdentity));
  return {
    parentDiverged: parentTop.filter(m => !forkKeys.has(messageIdentity(m))),
    forkDiverged: forkTop.filter(m => !parentKeys.has(messageIdentity(m))),
  };
}
