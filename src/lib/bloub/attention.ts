import type { Look } from "./engine";
import { clamp } from "./math";

export type AttentionKind = "cursor" | "camera" | "peer" | "wander";

export type Personality = {
  /** 0–1. Higher hops more often and tracks the cursor harder. */
  energy: number;
  /** Seconds to ease toward the pointer. Lazy bots trail. */
  followTau: number;
  followMix: number;
  lookMorph: number;
  lifeOffset: number;
  hops: boolean;
  hopGap: number;
  hopFor: number;
};

export function mulberry(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x45d9f3b) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

export function personalityFromSeed(seed: number): Personality {
  const r = mulberry(seed);
  const energy = 0.12 + r() * 0.88;
  return {
    energy,
    followTau: 0.035 + r() * 0.22,
    followMix: 0.52 + r() * 0.48,
    lookMorph: 0.1 + r() * 0.32,
    lifeOffset: 4 + r() * 86,
    hops: energy > 0.32,
    hopGap: 5.5 + r() * 12 - energy * 3,
    hopFor: 0.45 + r() * 1.1,
  };
}

/**
 * Weighted pick. `roll` is 0–1 so a test can pin the outcome.
 * Cursor weight jumps when the pointer just moved, but never to 1 — some
 * bots keep looking at a neighbour or the user even while you wave.
 */
export function pickAttentionKind(
  roll: number,
  opts: { pointer: boolean; pointerFresh: boolean; peerCount: number },
): AttentionKind {
  const cursor = !opts.pointer ? 0 : opts.pointerFresh ? 0.5 : 0.26;
  const peer = opts.peerCount > 0 ? 0.22 : 0;
  const camera = 0.2;
  const wander = Math.max(0.08, 1 - cursor - peer - camera);
  const items: { kind: AttentionKind; w: number }[] = [
    { kind: "cursor", w: cursor },
    { kind: "camera", w: camera },
    { kind: "peer", w: peer },
    { kind: "wander", w: wander },
  ];
  const total = items.reduce((sum, item) => sum + item.w, 0);
  let x = clamp(roll, 0, 0.999999) * total;
  for (const item of items) {
    x -= item.w;
    if (x < 0) return item.kind;
  }
  return "wander";
}

export function holdFor(kind: AttentionKind, roll: number): number {
  switch (kind) {
    case "cursor":
      return 0.55 + roll * 1.6;
    case "peer":
      return 0.7 + roll * 2.2;
    case "camera":
      return 0.8 + roll * 2.4;
    case "wander":
      return 0.9 + roll * 3.1;
  }
}

const YAW_MAX = 16;
const PITCH_MAX = 13;
const PITCH = 8;

export function lookAtPoint(from: DOMRect, x: number, y: number, mix: number): Look {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  const halfW = Math.max(1, (typeof window === "undefined" ? 800 : window.innerWidth) / 2);
  const halfH = Math.max(1, (typeof window === "undefined" ? 600 : window.innerHeight) / 2);
  const nx = clamp((x - cx) / halfW, -1, 1);
  const ny = clamp((y - cy) / halfH, -1, 1);
  if (!Number.isFinite(nx + ny)) {
    return { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 };
  }
  return {
    yaw: nx * YAW_MAX,
    pitch: PITCH - ny * PITCH_MAX,
    mix,
    spin: 0,
    wander: 0.06,
  };
}

export function lookAtCamera(mix: number): Look {
  return { yaw: 0, pitch: 9, mix, spin: 0, wander: 0.14 };
}

export const WANDER_LOOK: Look = { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 };

export type HopKind = "bounce" | "nod" | "wave";

export function pickHop(roll: number, energy: number): HopKind {
  if (energy < 0.5) return roll < 0.65 ? "nod" : "wave";
  if (roll < 0.45) return "bounce";
  if (roll < 0.75) return "nod";
  return "wave";
}
