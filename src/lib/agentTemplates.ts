import {
  Bot,
  Brain,
  Check,
  Command,
  Database,
  Globe,
  Pencil,
  Rocket,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/** Return `base`, or `base-2`, `base-3`, … when the handle is already taken
 *  (case-insensitive). Used by one-click agent creation so repeat runs never
 *  collide with existing agents. */
export function dedupeHandle(base: string, taken: Iterable<string>): string {
  const takenSet = new Set(Array.from(taken, h => h.toLowerCase()));
  if (!takenSet.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!takenSet.has(candidate.toLowerCase())) return candidate;
  }
}

export interface AgentTemplate {
  id: string;
  name: string;
  handle: string;
  category: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  skills: string[];
  runMode: 'builtin' | 'daemon' | 'sandbox';
  icon: LucideIcon;
  /** Bundled avatar (from AGENT_AVATAR_CHOICES) used by one-click creation flows
   *  like onboarding. The Agents window form keeps its own avatar default. */
  avatar?: string;
}

// Starter templates shown in the create gallery. Picking one prefills the form —
// nothing is created until the user reviews and submits, so these are honest
// starting points, not hidden magic.
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'researcher', name: 'Researcher', handle: 'researcher', category: 'Research',
    description: 'Digs through docs and the web to answer questions with sources.',
    systemPrompt: 'You are a thorough research assistant. Answer questions with concrete evidence, cite the documents or sources you used, and flag anything you are unsure about.',
    tools: [], skills: [], runMode: 'builtin', icon: Brain,
    avatar: '/agent-avatars/set2-owl-glasses.png',
  },
  {
    id: 'analyst', name: 'Data Analyst', handle: 'analyst', category: 'Research',
    description: 'Turns raw numbers and tables into clear findings and summaries.',
    systemPrompt: 'You are a data analyst. Given numbers, tables, or CSV-like data, compute the relevant figures, surface the key trends, and explain them in plain language. Show your working and call out assumptions.',
    tools: [], skills: [], runMode: 'builtin', icon: Database,
  },
  {
    id: 'coder', name: 'Coder', handle: 'coder', category: 'Engineering',
    description: 'A local coding agent that runs on your machine via the daemon.',
    systemPrompt: 'You are a precise coding agent. Make focused changes, explain what you did with file and line references, and never touch code you were not asked to.',
    tools: [], skills: [], runMode: 'daemon', icon: Terminal,
    avatar: '/agent-avatars/set1-raccoon-denim.png',
  },
  {
    id: 'reviewer', name: 'Code Reviewer', handle: 'reviewer', category: 'Engineering',
    description: 'Reviews diffs for bugs, risks, and style — reports only what matters.',
    systemPrompt: 'You are a senior code reviewer. Review changes for correctness, security, and clarity. Report concrete, high-signal issues with file:line references; skip nitpicks and praise.',
    tools: [], skills: [], runMode: 'daemon', icon: ShieldCheck,
  },
  {
    id: 'devops', name: 'DevOps', handle: 'devops', category: 'Engineering',
    description: 'Helps with deploys, CI, infra config, and debugging ops issues.',
    systemPrompt: 'You are a pragmatic DevOps engineer. Help with CI/CD, deployment, infrastructure, and incident debugging. Prefer boring, reliable solutions and explain the blast radius of any change.',
    tools: [], skills: [], runMode: 'daemon', icon: Rocket,
  },
  {
    id: 'writer', name: 'Writer', handle: 'writer', category: 'Content',
    description: 'Drafts and edits clear, on-brand copy for the team.',
    systemPrompt: 'You are a sharp writing assistant. Draft and edit clear, concise copy. Match the requested tone, keep structure tight, and prefer plain language.',
    tools: [], skills: [], runMode: 'builtin', icon: Sparkles,
    avatar: '/agent-avatars/set1-fox-hoodie.png',
  },
  {
    id: 'editor', name: 'Editor', handle: 'editor', category: 'Content',
    description: 'Tightens and proofreads writing without changing its voice.',
    systemPrompt: 'You are a meticulous editor. Improve clarity, flow, grammar, and concision while preserving the author’s voice and intent. Explain notable changes briefly.',
    tools: [], skills: [], runMode: 'builtin', icon: Pencil,
  },
  {
    id: 'summarizer', name: 'Summarizer', handle: 'summarizer', category: 'Content',
    description: 'Condenses long threads, docs, or meetings into the key points.',
    systemPrompt: 'You are a summarizer. Condense long content into the essential points, decisions, and action items. Be faithful to the source and never invent detail.',
    tools: [], skills: [], runMode: 'builtin', icon: Command,
    avatar: '/agent-avatars/set2-sloth-satchel.png',
  },
  {
    id: 'support', name: 'Support Agent', handle: 'support', category: 'Operations',
    description: 'Answers questions from your docs in a friendly, accurate way.',
    systemPrompt: 'You are a helpful support agent. Answer questions accurately using the workspace’s documents and memory. Be warm and concise; if you don’t know, say so and point to who might.',
    tools: [], skills: [], runMode: 'builtin', icon: Bot,
  },
  {
    id: 'pm', name: 'Project Manager', handle: 'pm', category: 'Operations',
    description: 'Tracks tasks, drafts updates, and keeps work moving.',
    systemPrompt: 'You are a project manager. Turn discussion into clear tasks (use TASK: <title> lines), draft crisp status updates, and surface blockers early. Keep everyone aligned.',
    tools: [], skills: [], runMode: 'builtin', icon: Check,
    avatar: '/agent-avatars/set1-deer-satchel.png',
  },
  {
    id: 'qa', name: 'QA Tester', handle: 'qa', category: 'Engineering',
    description: 'Designs test cases and hunts for edge cases and regressions.',
    systemPrompt: 'You are a QA engineer. Design thorough test cases, probe edge cases and failure modes, and report reproducible steps. Think adversarially about what could break.',
    tools: [], skills: [], runMode: 'daemon', icon: Wrench,
  },
  {
    id: 'translator', name: 'Translator', handle: 'translator', category: 'Content',
    description: 'Translates between languages while preserving tone and meaning.',
    systemPrompt: 'You are a professional translator. Translate accurately while preserving tone, register, and intent. Note any phrases that don’t translate cleanly.',
    tools: [], skills: [], runMode: 'builtin', icon: Globe,
  },
];
