import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei';
import * as THREE from 'three';
import { agentAccentColor } from '../../lib/agentAccent';
import { KIND_META, STATUS_META, type NetworkModel, type AgentNode } from './agentNetworkModel';

// 3D view: a real three.js/WebGL scene of the same hub -> agents -> providers
// graph. Nodes reflect live status (busy/idle/disconnected/inactive): busy
// spheres breathe and stream light particles down their spoke; disconnected are
// dimmed; inactive are ghosted. Glow is hand-rolled with additive sprite halos
// so no postprocessing dependency is needed. Auto-rotates; drag to orbit.
const R_AGENT = 3.3;
const R_PROVIDER = 6.0;

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

function AgentMesh({ node, tex, onSelect }: { node: AgentNode; tex: THREE.Texture; onSelect?: (id: string) => void }) {
  const accent = agentAccentColor(node.agent);
  const meta = STATUS_META[node.status];
  const busy = meta.flow;
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current && busy) {
      ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 4) * 0.09);
    }
  });
  return (
    <group position={ringPos(node.angle, R_AGENT)}>
      <Halo tex={tex} color={meta.color} size={busy ? 3.2 : 2.4} opacity={0.22 * meta.dim} />
      <mesh
        ref={ref}
        onClick={onSelect ? () => onSelect(node.agent.id) : undefined}
        onPointerOver={onSelect ? e => { e.stopPropagation(); document.body.style.cursor = 'pointer'; } : undefined}
        onPointerOut={onSelect ? () => { document.body.style.cursor = 'auto'; } : undefined}
      >
        <sphereGeometry args={[0.62, 40, 40]} />
        <meshStandardMaterial color={accent} emissive={accent}
          emissiveIntensity={(busy ? 0.9 : 0.4) * meta.dim} roughness={0.3} metalness={0.5}
          transparent opacity={node.status === 'inactive' ? 0.5 : 1} />
      </mesh>
      <Billboard position={[0, 1.05, 0]}>
        <Text fontSize={0.3} color="#e4e4e7" anchorX="center" anchorY="middle"
          outlineWidth={0.015} outlineColor="#000000" maxWidth={4}>
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

function Scene({ model, enabledCount, onSelectAgent, prefersReduced }: Diagram3DProps & { prefersReduced: boolean }) {
  const tex = useHaloTexture();

  // Provider angle = circular mean of its agents' angles (same as 2D model).
  const provPos = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    for (const [label] of model.providerNodes) {
      const angs = model.agentNodes.filter(n => n.provider === label).map(n => n.angle);
      const sx = angs.reduce((s, a) => s + Math.cos(a), 0);
      const sy = angs.reduce((s, a) => s + Math.sin(a), 0);
      map.set(label, ringPos(Math.atan2(sy, sx), R_PROVIDER));
    }
    return map;
  }, [model]);

  return (
    <>
      <color attach="background" args={['#08080a']} />
      <fog attach="fog" args={['#08080a', 15, 32]} />
      <ambientLight intensity={0.5} />
      <pointLight position={[0, 8, 4]} intensity={80} />
      <pointLight position={[-6, -4, -6]} intensity={30} color="#6366f1" />

      {/* Ground grid for depth. */}
      <gridHelper args={[40, 40, '#2a2a35', '#16161c']} position={[0, -1.6, 0]} />

      {/* Level-1 spokes: hub -> agent. */}
      {model.agentNodes.map(node => {
        const meta = STATUS_META[node.status];
        return (
          <Line
            key={`l3-a-${node.agent.id}`}
            points={[[0, 0, 0], ringPos(node.angle, R_AGENT)]}
            color={meta.color}
            lineWidth={node.status === 'busy' ? 2.5 : 1.8}
            transparent
            opacity={0.5 * meta.dim}
          />
        );
      })}
      {/* Level-2 spokes: agent -> provider. */}
      {model.agentNodes.map(node => (
        <Line
          key={`l3-p-${node.agent.id}`}
          points={[ringPos(node.angle, R_AGENT), provPos.get(node.provider)!]}
          color={KIND_META[node.kind].color}
          lineWidth={1}
          dashed
          dashScale={4}
          transparent
          opacity={0.25 * STATUS_META[node.status].dim}
        />
      ))}
      {/* Flow particles on busy spokes. */}
      {!prefersReduced && model.agentNodes.filter(n => n.status === 'busy').map(node => (
        <FlowParticle key={`fp-${node.agent.id}`} target={ringPos(node.angle, R_AGENT)} color={STATUS_META.busy.color} />
      ))}

      {/* Hub. */}
      <group position={[0, 0, 0]}>
        <Halo tex={tex} color="#6366f1" size={4.5} opacity={0.3} />
        <mesh>
          <sphereGeometry args={[1.05, 48, 48]} />
          <meshStandardMaterial color="#18181b" emissive="#6366f1" emissiveIntensity={0.5} roughness={0.3} metalness={0.6} />
        </mesh>
      </group>
      <Billboard position={[0, 0, 0]}>
        <Text fontSize={0.5} color="#ffffff" anchorX="center" anchorY="middle" outlineWidth={0.02} outlineColor="#000000">
          agensis
        </Text>
        <Text position={[0, -0.55, 0]} fontSize={0.26} color="#a1a1aa" anchorX="center" anchorY="middle">
          {model.busyCount > 0
            ? `${enabledCount} agents · ${model.busyCount} working`
            : `${enabledCount} agent${enabledCount === 1 ? '' : 's'}`}
        </Text>
      </Billboard>

      {/* Provider nodes. */}
      {[...model.providerNodes.values()].map(prov => {
        const pos = provPos.get(prov.label)!;
        const color = KIND_META[prov.kind].color;
        return (
          <group key={`n3-prov-${prov.label}`} position={pos}>
            <Halo tex={tex} color={color} size={1.6} opacity={0.18} />
            <mesh>
              <boxGeometry args={[0.5, 0.5, 0.5]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} roughness={0.4} metalness={0.5} />
            </mesh>
            <Billboard position={[0, 0.9, 0]}>
              <Text fontSize={0.32} color={color} anchorX="center" anchorY="middle" outlineWidth={0.015} outlineColor="#000000">
                {prov.label}
              </Text>
            </Billboard>
          </group>
        );
      })}

      {/* Agent nodes. */}
      {model.agentNodes.map(node => (
        <AgentMesh key={`n3-${node.agent.id}`} node={node} tex={tex} onSelect={onSelectAgent} />
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

  return (
    <Canvas camera={{ position: [0, 9, 15], fov: 42 }} className="size-full" dpr={[1, 2]}>
      <Scene model={model} enabledCount={enabledCount} onSelectAgent={onSelectAgent} prefersReduced={prefersReduced} />
    </Canvas>
  );
}
