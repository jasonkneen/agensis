import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei';
import * as THREE from 'three';
// Real font file so troika renders mono instrument labels (matches the 2D view).
import monoFont from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff';
import { agentAccentColor } from '../../lib/agentAccent';
import { KIND_META, STATUS_META, type NetworkModel, type AgentNode } from './agentNetworkModel';

// 3D view: a real three.js/WebGL scene of the same hub -> agents -> providers
// graph, matched to the 2D telemetry treatment. Glow is *semantic* — only the
// hub and busy agents carry a halo (a depth cue where it's earned), never idle
// or endpoint nodes. Labels and scene chrome track the active app theme; the
// ground stays dark so the glowing graph reads regardless of a light/sepia UI.
// Busy spheres breathe and stream light particles down their spoke; disconnected
// are dimmed; inactive are ghosted. Auto-rotates; drag to orbit.
const R_AGENT = 3.3;
const R_PROVIDER = 6.0;

// Resolved theme palette handed into the WebGL scene (WebGL can't read CSS vars).
interface SceneTheme {
  stage: string; // dark ground / background / fog
  foreground: string; // primary labels
  muted: string; // sublabels
  border: string; // grid lines
  card: string; // hub body fill
  primary: string; // hub accent / emissive
}

// Deep neutral used as the ground on light/sepia themes so glow stays legible.
const DARK_STAGE = 'rgb(11, 12, 16)';
const FALLBACK_THEME: SceneTheme = {
  stage: DARK_STAGE,
  foreground: 'rgb(228, 228, 231)',
  muted: 'rgb(161, 161, 170)',
  border: 'rgb(38, 42, 51)',
  card: 'rgb(26, 28, 34)',
  primary: 'rgb(174, 182, 198)',
};

// Relative luminance (0–1) of an `rgb(...)` string.
function luminance(rgb: string): number {
  const m = rgb.match(/[\d.]+/g);
  if (!m || m.length < 3) return 0;
  const [r, g, b] = m.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Resolve the app's CSS custom properties to concrete rgb() strings by reading
// them back off a probe element — the browser flattens oklch()/hsl()/hex for us.
function readSceneTheme(): SceneTheme {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;opacity:0;pointer-events:none';
  document.body.appendChild(probe);
  const read = (v: string, fallback: string) => {
    probe.style.color = '';
    probe.style.color = `var(${v})`;
    const c = getComputedStyle(probe).color;
    return c || fallback;
  };
  const bg = read('--background', 'rgb(10, 10, 12)');
  const theme: SceneTheme = {
    // Keep a dark ground so the glowing graph stays legible: on dark themes use
    // the real background; on light/sepia clamp to a deep neutral stage.
    stage: luminance(bg) < 0.35 ? bg : DARK_STAGE,
    foreground: read('--foreground', FALLBACK_THEME.foreground),
    muted: read('--muted-foreground', FALLBACK_THEME.muted),
    border: read('--border', FALLBACK_THEME.border),
    card: read('--card', FALLBACK_THEME.card),
    primary: read('--primary', FALLBACK_THEME.primary),
  };
  document.body.removeChild(probe);
  return theme;
}

// Track the resolved theme, re-reading when the app switches theme mid-view.
function useSceneTheme(): SceneTheme {
  const [theme, setTheme] = useState<SceneTheme>(FALLBACK_THEME);
  useEffect(() => {
    const update = () => setTheme(readSceneTheme());
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => obs.disconnect();
  }, []);
  return theme;
}

function ringPos(angle: number, radius: number): [number, number, number] {
  // Map the 2D layout angle onto the XZ ground plane (y = 0).
  return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
}

// A soft radial texture reused by every halo sprite (built once).
function useHaloTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }, []);
}

function Halo({ tex, color, size, opacity = 0.5 }: { tex: THREE.Texture; color: string; size: number; opacity?: number }) {
  return (
    <sprite scale={[size, size, size]}>
      <spriteMaterial map={tex} color={color} transparent opacity={opacity}
        blending={THREE.AdditiveBlending} depthWrite={false} />
    </sprite>
  );
}

function AgentMesh({ node, tex, radius, theme, onSelect }: { node: AgentNode; tex: THREE.Texture; radius: number; theme: SceneTheme; onSelect?: (id: string) => void }) {
  const accent = agentAccentColor(node.agent);
  const meta = STATUS_META[node.status];
  const busy = meta.flow;
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current && busy) {
      ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 4) * 0.09);
    }
  });
  // De-emphasise dimmed (disconnected/inactive) labels with the muted token.
  const labelColor = meta.dim < 1 ? theme.muted : theme.foreground;
  return (
    <group position={ringPos(node.angle, radius)}>
      {/* Semantic glow: only busy agents earn a halo. */}
      {busy && <Halo tex={tex} color={meta.color} size={3.2} opacity={0.28} />}
      <mesh
        ref={ref}
        onClick={onSelect ? () => onSelect(node.agent.id) : undefined}
        onPointerOver={onSelect ? e => { e.stopPropagation(); document.body.style.cursor = 'pointer'; } : undefined}
        onPointerOut={onSelect ? () => { document.body.style.cursor = 'auto'; } : undefined}
      >
        <sphereGeometry args={[0.62, 40, 40]} />
        <meshStandardMaterial color={accent} emissive={accent}
          emissiveIntensity={(busy ? 0.85 : 0.32) * meta.dim} roughness={0.3} metalness={0.5}
          transparent opacity={node.status === 'inactive' ? 0.5 : 1} />
      </mesh>
      <Billboard position={[0, 1.05, 0]}>
        <Text font={monoFont} fontSize={0.28} letterSpacing={0.02} color={labelColor}
          anchorX="center" anchorY="middle" outlineWidth={0.012} outlineColor={theme.stage} maxWidth={4}>
          {node.agent.name}
        </Text>
      </Billboard>
    </group>
  );
}

// Light particle traveling hub -> busy agent along its spoke.
function FlowParticle({ target, color }: { target: [number, number, number]; color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = (clock.elapsedTime * 0.7) % 1;
    ref.current.position.set(target[0] * t, target[1] * t, target[2] * t);
    if (mat.current) mat.current.opacity = Math.sin(t * Math.PI);
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.09, 12, 12]} />
      <meshBasicMaterial ref={mat} color={color} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
    </mesh>
  );
}

interface Diagram3DProps {
  model: NetworkModel;
  enabledCount: number;
  onSelectAgent?: (id: string) => void;
}

function Scene({ model, enabledCount, onSelectAgent, prefersReduced, theme }: Diagram3DProps & { prefersReduced: boolean; theme: SceneTheme }) {
  const tex = useHaloTexture();

  // Breathe the rings outward when crowded so nodes never overlap (mirrors 2D).
  const spread = 1 + Math.max(0, model.agentNodes.length - 10) * 0.045;
  const rAgent = R_AGENT * spread;
  const rProvider = R_PROVIDER * spread;

  // Provider angle = circular mean of its agents' angles (same as 2D model).
  const provPos = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    for (const [label] of model.providerNodes) {
      const angs = model.agentNodes.filter(n => n.provider === label).map(n => n.angle);
      const sx = angs.reduce((s, a) => s + Math.cos(a), 0);
      const sy = angs.reduce((s, a) => s + Math.sin(a), 0);
      map.set(label, ringPos(Math.atan2(sy, sx), rProvider));
    }
    return map;
  }, [model, rProvider]);

  return (
    <>
      <color attach="background" args={[theme.stage]} />
      <fog attach="fog" args={[theme.stage, 16, 34]} />
      <ambientLight intensity={0.45} />
      <pointLight position={[0, 9, 5]} intensity={75} />
      {/* Cool rim light for depth — steel, not the cliché AI indigo. */}
      <pointLight position={[-7, -4, -6]} intensity={22} color="#5b7089" />

      {/* Hairline ground grid for depth — themed, faded by fog at distance. */}
      <gridHelper args={[44, 44, theme.border, theme.border]} position={[0, -1.6, 0]} />

      {/* Level-1 spokes: hub -> agent. */}
      {model.agentNodes.map(node => {
        const meta = STATUS_META[node.status];
        return (
          <Line
            key={`l3-a-${node.agent.id}`}
            points={[[0, 0, 0], ringPos(node.angle, rAgent)]}
            color={meta.color}
            lineWidth={node.status === 'busy' ? 2.2 : 1.4}
            transparent
            opacity={0.45 * meta.dim}
          />
        );
      })}
      {/* Level-2 spokes: agent -> provider. */}
      {model.agentNodes.map(node => (
        <Line
          key={`l3-p-${node.agent.id}`}
          points={[ringPos(node.angle, rAgent), provPos.get(node.provider)!]}
          color={KIND_META[node.kind].color}
          lineWidth={1}
          dashed
          dashScale={5}
          transparent
          opacity={0.22 * STATUS_META[node.status].dim}
        />
      ))}
      {/* Flow particles on busy spokes. */}
      {!prefersReduced && model.agentNodes.filter(n => n.status === 'busy').map(node => (
        <FlowParticle key={`fp-${node.agent.id}`} target={ringPos(node.angle, rAgent)} color={STATUS_META.busy.color} />
      ))}

      {/* Hub — instrument node; keeps a halo as the scene's one anchor glow. */}
      <group position={[0, 0, 0]}>
        <Halo tex={tex} color={theme.primary} size={4.0} opacity={0.2} />
        <mesh>
          <sphereGeometry args={[1.05, 48, 48]} />
          <meshStandardMaterial color={theme.card} emissive={theme.primary} emissiveIntensity={0.3} roughness={0.35} metalness={0.55} />
        </mesh>
      </group>
      <Billboard position={[0, 0, 0]}>
        <Text font={monoFont} fontSize={0.5} letterSpacing={0.08} color={theme.foreground} anchorX="center" anchorY="middle" outlineWidth={0.02} outlineColor={theme.stage}>
          agensis
        </Text>
        <Text font={monoFont} position={[0, -0.55, 0]} fontSize={0.24} letterSpacing={0.04} color={theme.muted} anchorX="center" anchorY="middle">
          {model.busyCount > 0
            ? `${enabledCount} agents · ${model.busyCount} working`
            : `${enabledCount} agent${enabledCount === 1 ? '' : 's'}`}
        </Text>
      </Billboard>

      {/* Provider nodes — kind-colored marker box + mono foreground label (no glow). */}
      {[...model.providerNodes.values()].map(prov => {
        const pos = provPos.get(prov.label)!;
        const color = KIND_META[prov.kind].color;
        return (
          <group key={`n3-prov-${prov.label}`} position={pos}>
            <mesh rotation={[0, Math.PI / 4, 0]}>
              <boxGeometry args={[0.46, 0.46, 0.46]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.22} roughness={0.5} metalness={0.4} />
            </mesh>
            <Billboard position={[0, 0.85, 0]}>
              <Text font={monoFont} fontSize={0.3} letterSpacing={0.02} color={theme.foreground} anchorX="center" anchorY="middle" outlineWidth={0.012} outlineColor={theme.stage}>
                {prov.label}
              </Text>
            </Billboard>
          </group>
        );
      })}

      {/* Agent nodes. */}
      {model.agentNodes.map(node => (
        <AgentMesh key={`n3-${node.agent.id}`} node={node} tex={tex} radius={rAgent} theme={theme} onSelect={onSelectAgent} />
      ))}

      <OrbitControls
        enablePan={false}
        autoRotate={!prefersReduced}
        autoRotateSpeed={0.8}
        target={[0, 0.4, 0]}
        minDistance={8}
        maxDistance={22}
        minPolarAngle={Math.PI / 6}
        maxPolarAngle={Math.PI / 2.1}
      />
    </>
  );
}

export default function AgentNetworkDiagram3D({ model, enabledCount, onSelectAgent }: Diagram3DProps) {
  const prefersReduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const theme = useSceneTheme();

  return (
    <Canvas camera={{ position: [0, 9, 15], fov: 42 }} className="size-full" dpr={[1, 2]}>
      <Scene model={model} enabledCount={enabledCount} onSelectAgent={onSelectAgent} prefersReduced={prefersReduced} theme={theme} />
    </Canvas>
  );
}
