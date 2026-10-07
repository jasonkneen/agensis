import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useFlock } from "./botFlockContext";
import {
  holdFor,
  lookAtCamera,
  lookAtPoint,
  personalityFromSeed,
  pickAttentionKind,
  pickHop,
  WANDER_LOOK,
  type AttentionKind,
  type Personality,
} from "@/lib/bloub/attention";
import type { BotFrame, Look } from "@/lib/bloub/engine";
import { BotEngine } from "@/lib/bloub/engine";
import { EXPRESSION_BY_ID, type ExpressionId } from "@/lib/bloub/expressions";
import { NOTIF_BLUE } from "@/lib/bloub/decor";
import { getPointer, pointerIsFresh } from "@/lib/bloub/pointer";
import { DEMI_VIEWBOX, RAYON } from "@/lib/bloub/repere";
import { COLOR_BY_ID, mixHex } from "@/lib/bloub/skins";
import { cn } from "@/lib/utils";
import { NimbusArtwork } from "./NimbusArtwork";
import { SHAPES } from "@/lib/bloub/skins";

const R = RAYON;

function avatarExpression(id: ExpressionId) {
  const expression = EXPRESSION_BY_ID.get(id);
  // Nimbus faces look forward at rest; the old spherical artwork's neutral
  // pose looked up and right, pushing eyes outside narrower character bodies.
  return id === "neutre" && expression
    ? { ...expression, gaze: { yaw: 0, pitch: 0, roll: 0 } }
    : expression;
}

const FACE_FOR: Record<AttentionKind, ExpressionId[]> = {
  cursor: ["excite", "surpris", "attentif", "heureux"],
  camera: ["attentif", "excite", "fier"],
  peer: ["curieux", "heureux", "mefiant"],
  wander: ["neutre", "blase", "somnolent"],
};

function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

function roll(): number {
  return Math.random();
}

/**
 * SVG bot from bloub-plus (`packages/core/src/bot`), rendered in React.
 *
 * Each instance gets its own clock offset, follow lag, and attention schedule
 * so a row of them does not hop or blink in unison. Live bots share the
 * window pointer and, inside a BotFlock, glance at their neighbours.
 */
export function BloubBot({
  size,
  seed,
  color = "bleu",
  shape = "cercle",
  expression = "neutre",
  animate = "hover",
  paper = "var(--color-bg-elevated)",
  className,
  style,
}: {
  size: number;
  seed: string;
  color?: string;
  shape?: string;
  expression?: ExpressionId;
  animate?: "hover" | "always" | "never";
  paper?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const uid = useId().replace(/:/g, "");
  const vb = size <= 28 ? 118 : DEMI_VIEWBOX;
  const ink = COLOR_BY_ID.get(color)?.hex ?? (/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#3b93f0");
  const radii = null;
  const restExpr = useMemo(() => avatarExpression(expression) ?? null, [expression]);
  const personality = useMemo(() => personalityFromSeed(hashSeed(seed)), [seed]);

  const engineRef = useRef<BotEngine | null>(null);
  if (!engineRef.current) engineRef.current = new BotEngine(R, "idle", radii, restExpr);
  const clockRef = useRef(0);
  const lastRef = useRef(0);
  const hostRef = useRef<HTMLSpanElement>(null);
  const followRef = useRef({ x: 0, y: 0, primed: false });
  const attentionRef = useRef<{ kind: AttentionKind; until: number; peer: DOMRect | null }>({
    kind: "wander",
    until: 0.4 + roll() * 1.2,
    peer: null,
  });
  const hopRef = useRef({ until: 0, next: personality.hopGap * (0.2 + roll()) });
  const [frame, setFrame] = useState<BotFrame>(() => engineRef.current!.sample(0, 0));
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const target = hostRef.current?.closest<HTMLElement>("button, a, [role=button], [tabindex]");
    if (!target) return;
    const update = () => setFocused(target.contains(document.activeElement) && Boolean(document.activeElement?.matches(":focus-visible")));
    target.addEventListener("focusin", update);
    target.addEventListener("focusout", update);
    update();
    return () => {
      target.removeEventListener("focusin", update);
      target.removeEventListener("focusout", update);
    };
  }, []);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    // Absent in non-browser hosts (and jsdom): treat as no preference.
    if (typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    const host = hostRef.current;
    const observer = typeof IntersectionObserver !== "undefined" && host
      ? new IntersectionObserver(entries => { const entry = entries[0]; if (entry) setVisible(entry.isIntersecting); })
      : null;
    if (host) observer?.observe(host);
    return () => { document.removeEventListener("visibilitychange", update); observer?.disconnect(); };
  }, []);
  const live = visible && pageVisible && !reducedMotion && (animate === "always" || (animate === "hover" && (hover || focused || pressed)));
  const flock = useFlock();

  useEffect(() => {
    if (!live) {
      engineRef.current = new BotEngine(R, "idle", radii, restExpr);
      clockRef.current = 0;
      attentionRef.current.until = 0;
      hopRef.current = { until: 0, next: personality.hopGap * 0.3 };
      setFrame(engineRef.current.sample(0, 0));
      return;
    }
    const engine = engineRef.current!;
    engine.setShape(radii, clockRef.current);
    engine.setExpression(restExpr, clockRef.current);
    setFrame(engine.sample(clockRef.current, personality.lifeOffset));
  }, [live, personality.hopGap, personality.lifeOffset, radii, restExpr]);

  useEffect(() => {
    if (!flock) return;
    const el = hostRef.current;
    if (!el) return;
    return flock.register(seed, el);
  }, [flock, seed]);

  useEffect(() => {
    if (!live) return;
    const engine = engineRef.current!;
    lastRef.current = 0;
    let raf = 0;
    let nextAt = 0;
    const interval = size <= 40 ? 1000 / 24 : 1000 / 30;
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      if (ms + 0.5 < nextAt) return;
      nextAt = ms + interval;
      const dt = lastRef.current ? Math.min((ms - lastRef.current) / 1000, 0.064) : 0;
      lastRef.current = ms;
      clockRef.current += dt;
      const now = clockRef.current;
      stepBot({
        engine,
        now,
        dt,
        personality,
        restExpr,
        host: hostRef.current,
        follow: followRef.current,
        attention: attentionRef.current,
        hop: hopRef.current,
        peers: flock?.others(seed) ?? [],
      });
      setFrame(engine.sample(now, personality.lifeOffset));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flock, live, personality, restExpr, seed, size]);

  return (
    <span
      ref={hostRef}
      className={cn("inline-flex overflow-visible", className)}
      style={style}
      onPointerEnter={event => setHover(event.pointerType !== "touch")}
      onPointerLeave={() => { setHover(false); setPressed(false); }}
      onPointerDown={() => { setPressed(true); setFocused(false); }}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
    >
      <svg width={size} height={size} viewBox={`${-vb} ${-vb} ${vb * 2} ${vb * 2}`} aria-hidden className="overflow-visible">
        <defs>
          {frame.arcs.map((arc) => (
            <linearGradient
              key={arc.id}
              id={`${uid}-${arc.id}`}
              gradientUnits="userSpaceOnUse"
              x1={arc.grad.x1}
              y1={arc.grad.y1}
              x2={arc.grad.x2}
              y2={arc.grad.y2}
            >
              {arc.grad.stops.map((stop, i) => (
                <stop
                  key={i}
                  offset={arc.grad.stops.length === 1 ? 0 : i / (arc.grad.stops.length - 1)}
                  stopColor={stop}
                />
              ))}
            </linearGradient>
          ))}
        </defs>

        <g fill="none" strokeLinecap="round">
          {frame.arcs.map((arc) => (
            <path
              key={`b${arc.id}`}
              d={arc.back}
              stroke={`url(#${uid}-${arc.id})`}
              strokeWidth={arc.width}
              opacity={arc.opacity}
            />
          ))}
        </g>

        {frame.dotsBehind ? <Dots frame={frame} ink={ink} paper={paper} /> : null}

        <NimbusArtwork index={Math.max(0, SHAPES.findIndex(entry => entry.id === shape))} frame={frame} ink={ink} uid={uid} size={size} live={live} expression={expression === "neutre" ? frame.expressionId ?? expression : expression} phase={personality.lifeOffset} />
        {!frame.dotsBehind ? <Dots frame={frame} ink={ink} paper={paper} /> : null}

        {frame.notif ? <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} /> : null}

        <g fill="none" strokeLinecap="round">
          {frame.arcs.map((arc) => (
            <path
              key={`f${arc.id}`}
              d={arc.front}
              stroke={`url(#${uid}-${arc.id})`}
              strokeWidth={arc.width}
              opacity={arc.opacity}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}

function stepBot({
  engine,
  now,
  dt,
  personality,
  restExpr,
  host,
  follow,
  attention,
  hop,
  peers,
}: {
  engine: BotEngine;
  now: number;
  dt: number;
  personality: Personality;
  restExpr: ReturnType<typeof EXPRESSION_BY_ID.get> | null;
  host: HTMLSpanElement | null;
  follow: { x: number; y: number; primed: boolean };
  attention: { kind: AttentionKind; until: number; peer: DOMRect | null };
  hop: { until: number; next: number };
  peers: DOMRect[];
}) {
  const pointer = getPointer();
  if (pointer.present) {
    if (!follow.primed) {
      follow.x = pointer.x;
      follow.y = pointer.y;
      follow.primed = true;
    } else {
      const k = 1 - Math.exp(-dt / Math.max(0.02, personality.followTau));
      follow.x += (pointer.x - follow.x) * k;
      follow.y += (pointer.y - follow.y) * k;
    }
  }

  if (personality.hops && now >= hop.next) {
    engine.setState(pickHop(roll(), personality.energy), now);
    hop.until = now + personality.hopFor * (0.7 + roll() * 0.6);
    hop.next = hop.until + personality.hopGap * (0.6 + roll() * 0.9);
  }
  if (hop.until && now >= hop.until) {
    engine.setState("idle", now);
    hop.until = 0;
  }

  if (now >= attention.until) {
    const kind = pickAttentionKind(roll(), {
      pointer: pointer.present,
      pointerFresh: pointerIsFresh(performance.now()),
      peerCount: peers.length,
    });
    attention.kind = kind;
    attention.until = now + holdFor(kind, roll());
    attention.peer = kind === "peer" && peers.length ? peers[Math.floor(roll() * peers.length)]! : null;
    const faces = FACE_FOR[kind];
    const id = faces[Math.floor(roll() * faces.length)]!;
    engine.setExpression(avatarExpression(id) ?? restExpr ?? null, now);
  }

  const box = host?.getBoundingClientRect();
  let look: Look = WANDER_LOOK;
  if (box && box.width > 0) {
    if (attention.kind === "cursor" && pointer.present && follow.primed) {
      look = lookAtPoint(box, follow.x, follow.y, personality.followMix);
    } else if (attention.kind === "camera") {
      look = lookAtCamera(0.72 + personality.energy * 0.2);
    } else if (attention.kind === "peer" && attention.peer) {
      look = lookAtPoint(
        box,
        attention.peer.left + attention.peer.width / 2,
        attention.peer.top + attention.peer.height / 2,
        0.7,
      );
    }
  }
  engine.setLook({ ...look, yaw: Math.max(-22, Math.min(22, look.yaw)), pitch: Math.max(-12, Math.min(12, look.pitch)) }, now, personality.lookMorph);
}

function Dots({ frame, ink, paper }: { frame: BotFrame; ink: string; paper: string }) {
  return (
    <g>
      {frame.dots.map((dot, i) => {
        const fill = dot.color ?? (dot.depth === undefined ? ink : mixHex(paper.startsWith("#") ? paper : "#111111", ink, dot.depth));
        if (dot.d) {
          return (
            <path
              key={i}
              d={dot.d}
              fill={fill}
              opacity={dot.opacity}
              transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${R})`}
            />
          );
        }
        return <circle key={i} cx={dot.x} cy={dot.y} r={dot.r} fill={fill} opacity={dot.opacity} />;
      })}
    </g>
  );
}
