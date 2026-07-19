import { Canvas } from '@react-three/fiber';
import { OrbitControls, Billboard, Text, Line } from '@react-three/drei';
import { agentAccentColor } from '../../lib/agentAccent';
import { KIND_META, type NetworkModel } from './agentNetworkModel';

// 3D view: a real three.js/WebGL scene of the same hub -> agents -> providers
// graph. Agents orbit an inner ring, provider nodes an outer ring, all wired to
// the central agensis hub with emissive spokes. Auto-rotates; drag to orbit.
const R_AGENT = 3.3;
const R_PROVIDER = 6.0;

function ringPos(angle: number, radius: number): [number, number, number] {
  // Map the 2D layout angle onto the XZ ground plane (y = 0).
  return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
}

interface Diagram3DProps {
  model: NetworkModel;
  enabledCount: number;
  onSelectAgent?: (id: string) => void;
}

export default function AgentNetworkDiagram3D({ model, enabledCount, onSelectAgent }: Diagram3DProps) {
  const prefersReduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Provider angle = circular mean of its agents' angles (same as 2D model).
  const providerAngle = new Map<string, number>();
  for (const [label] of model.providerNodes) {
    const angs = model.agentNodes.filter(n => n.provider === label).map(n => n.angle);
    const sx = angs.reduce((s, a) => s + Math.cos(a), 0);
    const sy = angs.reduce((s, a) => s + Math.sin(a), 0);
    providerAngle.set(label, Math.atan2(sy, sx));
  }
  const provPos = new Map<string, [number, number, number]>();
  for (const [label] of model.providerNodes) {
    provPos.set(label, ringPos(providerAngle.get(label) ?? 0, R_PROVIDER));
  }

  return (
    <Canvas camera={{ position: [0, 7.5, 10], fov: 45 }} className="size-full">
      <color attach="background" args={['#0a0a0b']} />
      <ambientLight intensity={0.6} />
      <pointLight position={[0, 8, 4]} intensity={80} />
      <pointLight position={[-6, -4, -6]} intensity={30} color="#6366f1" />

      {/* Level-1 spokes: hub -> agent. */}
      {model.agentNodes.map(node => (
        <Line
          key={`l3-a-${node.agent.id}`}
          points={[[0, 0, 0], ringPos(node.angle, R_AGENT)]}
          color={KIND_META[node.kind].color}
          lineWidth={2}
          transparent
          opacity={0.55}
        />
      ))}
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
          opacity={0.3}
        />
      ))}

      {/* Hub. */}
      <mesh position={[0, 0, 0]}>
        <sphereGeometry args={[1.05, 48, 48]} />
        <meshStandardMaterial color="#18181b" emissive="#6366f1" emissiveIntensity={0.4} roughness={0.3} metalness={0.6} />
      </mesh>
      <Billboard position={[0, 0, 0]}>
        <Text fontSize={0.5} color="#ffffff" anchorX="center" anchorY="middle" outlineWidth={0.02} outlineColor="#000000">
          agensis
        </Text>
        <Text position={[0, -0.55, 0]} fontSize={0.28} color="#a1a1aa" anchorX="center" anchorY="middle">
          {`${enabledCount} agent${enabledCount === 1 ? '' : 's'}`}
        </Text>
      </Billboard>

      {/* Provider nodes. */}
      {[...model.providerNodes.values()].map(prov => {
        const pos = provPos.get(prov.label)!;
        const color = KIND_META[prov.kind].color;
        return (
          <group key={`n3-prov-${prov.label}`} position={pos}>
            <mesh>
              <boxGeometry args={[0.5, 0.5, 0.5]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} roughness={0.4} metalness={0.5} />
            </mesh>
            <Billboard position={[0, 0.85, 0]}>
              <Text fontSize={0.34} color={color} anchorX="center" anchorY="middle" outlineWidth={0.015} outlineColor="#000000">
                {prov.label}
              </Text>
            </Billboard>
          </group>
        );
      })}

      {/* Agent nodes. */}
      {model.agentNodes.map(node => {
        const pos = ringPos(node.angle, R_AGENT);
        const accent = agentAccentColor(node.agent);
        return (
          <group key={`n3-${node.agent.id}`} position={pos}>
            <mesh
              onClick={onSelectAgent ? () => onSelectAgent(node.agent.id) : undefined}
              onPointerOver={onSelectAgent ? e => { e.stopPropagation(); document.body.style.cursor = 'pointer'; } : undefined}
              onPointerOut={onSelectAgent ? () => { document.body.style.cursor = 'auto'; } : undefined}
            >
              <sphereGeometry args={[0.62, 40, 40]} />
              <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.35} roughness={0.35} metalness={0.5} />
            </mesh>
            <Billboard position={[0, 1.0, 0]}>
              <Text fontSize={0.3} color="#e4e4e7" anchorX="center" anchorY="middle" outlineWidth={0.015} outlineColor="#000000" maxWidth={4}>
                {node.agent.name}
              </Text>
            </Billboard>
          </group>
        );
      })}

      <OrbitControls
        enablePan={false}
        autoRotate={!prefersReduced}
        autoRotateSpeed={0.8}
        minDistance={6}
        maxDistance={20}
        maxPolarAngle={Math.PI / 1.8}
      />
    </Canvas>
  );
}
