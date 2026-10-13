// Project templates for the New project dialog: a name, an icon, and starter tasks.
//
// From gr8r-studio's project templates. The addition is `agent: true` on the
// tasks an agent can reasonably pick up; the dialog pre-assigns those to an agent
// when the workspace has one, and the user can change or clear each one. Agents
// are never attached to the project itself, only to its tasks.

export interface ProjectTemplateTask {
  title: string;
  /** Suited to an agent. The dialog pre-assigns it when an agent is available. */
  agent?: boolean;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  /** Lucide icon name, resolved by the dialog's icon map. */
  icon: string;
  description: string;
  tasks: ProjectTemplateTask[];
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: 'blank', name: 'Blank project', icon: 'file', description: 'Start from scratch', tasks: [] },
  {
    id: 'product',
    name: 'Product Development',
    icon: 'target',
    description: 'Discovery to launch',
    tasks: [
      { title: 'Define problem statement' },
      { title: 'User research plan' },
      { title: 'Write PRD', agent: true },
      { title: 'Design exploration' },
      { title: 'Build MVP' },
      { title: 'Beta launch' },
    ],
  },
  {
    id: 'web',
    name: 'Website',
    icon: 'globe',
    description: 'IA, design, build, launch',
    tasks: [
      { title: 'Sitemap and information architecture', agent: true },
      { title: 'Wireframes' },
      { title: 'Visual design' },
      { title: 'Build page templates', agent: true },
      { title: 'Content migration', agent: true },
      { title: 'QA and launch' },
    ],
  },
  {
    id: 'mkt',
    name: 'Marketing Campaign',
    icon: 'megaphone',
    description: 'Brief, assets, channels',
    tasks: [
      { title: 'Campaign brief', agent: true },
      { title: 'Audience research' },
      { title: 'Creative assets' },
      { title: 'Channel plan' },
      { title: 'Launch campaign' },
      { title: 'Performance report', agent: true },
    ],
  },
  {
    id: 'design',
    name: 'Design Project',
    icon: 'palette',
    description: 'Discovery to handoff',
    tasks: [
      { title: 'Discovery workshop' },
      { title: 'Moodboard' },
      { title: 'Concept directions' },
      { title: 'Refinement' },
      { title: 'Developer handoff' },
    ],
  },
  {
    id: 'software',
    name: 'Software Development',
    icon: 'code',
    description: 'Spec, build, ship',
    tasks: [
      { title: 'Technical spec', agent: true },
      { title: 'Set up repo and CI' },
      { title: 'Implement core API' },
      { title: 'Write tests', agent: true },
      { title: 'Code review' },
      { title: 'Deploy to staging' },
    ],
  },
  {
    id: 'personal',
    name: 'Personal Project',
    icon: 'heart',
    description: 'Plan your own goals',
    tasks: [
      { title: 'Brain dump ideas' },
      { title: 'Pick top 3 priorities' },
      { title: 'Schedule focus time' },
      { title: 'Weekly review' },
    ],
  },
];

/** The icons offered in the dialog, in order. Same set as gr8r-studio. */
export const PROJECT_ICONS = [
  'globe', 'smartphone', 'megaphone', 'rocket', 'component', 'building-2', 'layout-grid', 'palette',
  'code', 'briefcase', 'target', 'layers', 'zap', 'heart', 'folder', 'sparkles',
] as const;

/** The colours offered in the dialog. Same names and values as gr8r-studio. */
export const PROJECT_COLORS: Record<string, string> = {
  indigo: '#5A67D8',
  blue: '#3B82C4',
  violet: '#8662C9',
  teal: '#23918A',
  rose: '#C54B78',
  amber: '#C48A1E',
  green: '#3D8E5F',
  slate: '#6B7280',
};
