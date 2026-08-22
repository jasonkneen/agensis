// Reasoning effort levels for agent inference.
//
// These are normalized across providers:
//  - 'auto'  — provider chooses (default, works everywhere)
//  - 'low'   — minimal thinking/reasoning, fast response
//  - 'medium' — balanced reasoning and speed
//  - 'high'  — deep reasoning, slower but more thorough
//  - 'xhigh' — extended reasoning (e.g. Claude's extended thinking)
//  - 'max'   — maximum effort (provider-dependent ceiling)
//
// Providers map these to their own parameters at runtime:
//  - Claude: extended thinking budget/mode
//  - Codex: inference timeout/compute budget
//  - Others: gracefully ignore if not supported

export interface EffortLevel {
  id: string;
  label: string;
  description: string;
}

export const EFFORT_LEVELS: EffortLevel[] = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Provider chooses',
  },
  {
    id: 'low',
    label: 'Low',
    description: 'Minimal reasoning, fast',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Balanced reasoning and speed',
  },
  {
    id: 'high',
    label: 'High',
    description: 'Deep reasoning, slower',
  },
  {
    id: 'xhigh',
    label: 'Extra High',
    description: 'Extended reasoning',
  },
  {
    id: 'max',
    label: 'Max',
    description: 'Maximum effort',
  },
];
