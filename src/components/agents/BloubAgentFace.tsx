import { useLayoutEffect, useRef, useState } from 'react';
import { BloubBot } from '../bloub/BloubBot';
import { SHAPES } from '@/lib/bloub/skins';

// Warm-to-cool fills that read on both the light and dark themes.
const FILLS = ['rose', 'bleu', 'turquoise', 'orange', 'vert', 'violet', 'ambre'] as const;

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * An agent's automatic face: one of the animated characters, picked and
 * coloured from a stable seed so an agent keeps its face across renames.
 *
 * It fills whatever box the caller gives the avatar; the character is drawn at
 * the box's measured size so small chips get the compact artwork.
 */
export function BloubAgentFace({ seed, className }: { seed: string; className?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(28);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const next = Math.round(Math.min(width, height));
      if (next > 0) setSize(current => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const h = hash(seed);
  return (
    <span ref={hostRef} className={className ?? 'grid size-full place-items-center'}>
      <BloubBot
        seed={seed}
        size={size}
        color={FILLS[(h >>> 3) % FILLS.length]}
        shape={SHAPES[h % SHAPES.length]!.id}
        paper="var(--card)"
        animate="hover"
      />
    </span>
  );
}
