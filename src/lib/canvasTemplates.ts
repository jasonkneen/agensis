import type { CanvasObjectType } from '../types';

export interface CanvasTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  objects: Array<{
    type: CanvasObjectType;
    overrides: Record<string, unknown>;
  }>;
}

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  {
    id: 'brainstorm',
    name: 'Brainstorm',
    description: 'Six colored sticky notes in a grid with space for your ideas',
    icon: '\u{1F4A1}',
    objects: [
      {
        type: 'text',
        overrides: {
          x: 30,
          y: 8,
          width: 300,
          height: 50,
          text_content: 'Brainstorm',
          font_size: 32,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 10,
          y: 22,
          width: 180,
          height: 140,
          fill: '#fef08a',
          text_content: 'Idea 1',
          font_size: 16,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 38,
          y: 22,
          width: 180,
          height: 140,
          fill: '#bbf7d0',
          text_content: 'Idea 2',
          font_size: 16,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 66,
          y: 22,
          width: 180,
          height: 140,
          fill: '#bfdbfe',
          text_content: 'Idea 3',
          font_size: 16,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 10,
          y: 52,
          width: 180,
          height: 140,
          fill: '#fecaca',
          text_content: 'Idea 4',
          font_size: 16,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 38,
          y: 52,
          width: 180,
          height: 140,
          fill: '#e9d5ff',
          text_content: 'Idea 5',
          font_size: 16,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 66,
          y: 52,
          width: 180,
          height: 140,
          fill: '#fed7aa',
          text_content: 'Idea 6',
          font_size: 16,
        },
      },
    ],
  },
  {
    id: 'retro-board',
    name: 'Retro Board',
    description: 'Three columns for sprint retrospectives with sticky notes',
    icon: '\u{1F504}',
    objects: [
      // Column headers
      {
        type: 'text',
        overrides: {
          x: 8,
          y: 8,
          width: 220,
          height: 40,
          text_content: 'What went well',
          font_size: 22,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      {
        type: 'text',
        overrides: {
          x: 36,
          y: 8,
          width: 220,
          height: 40,
          text_content: "What didn't",
          font_size: 22,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      {
        type: 'text',
        overrides: {
          x: 64,
          y: 8,
          width: 220,
          height: 40,
          text_content: 'Action items',
          font_size: 22,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Sticky notes under "What went well"
      {
        type: 'sticky_note',
        overrides: {
          x: 8,
          y: 20,
          width: 200,
          height: 120,
          fill: '#bbf7d0',
          text_content: '',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 8,
          y: 42,
          width: 200,
          height: 120,
          fill: '#bbf7d0',
          text_content: '',
          font_size: 14,
        },
      },
      // Sticky notes under "What didn't"
      {
        type: 'sticky_note',
        overrides: {
          x: 36,
          y: 20,
          width: 200,
          height: 120,
          fill: '#fecaca',
          text_content: '',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 36,
          y: 42,
          width: 200,
          height: 120,
          fill: '#fecaca',
          text_content: '',
          font_size: 14,
        },
      },
      // Sticky notes under "Action items"
      {
        type: 'sticky_note',
        overrides: {
          x: 64,
          y: 20,
          width: 200,
          height: 120,
          fill: '#bfdbfe',
          text_content: '',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 64,
          y: 42,
          width: 200,
          height: 120,
          fill: '#bfdbfe',
          text_content: '',
          font_size: 14,
        },
      },
    ],
  },
  {
    id: 'kanban',
    name: 'Kanban',
    description: 'Four-column task board with colored lanes and sample cards',
    icon: '\u{1F4CB}',
    objects: [
      // Column backgrounds
      {
        type: 'rect',
        overrides: {
          x: 5,
          y: 6,
          width: 190,
          height: 500,
          fill: '#f0f9ff',
          stroke: '#bae6fd',
          stroke_width: 1,
        },
      },
      {
        type: 'rect',
        overrides: {
          x: 28,
          y: 6,
          width: 190,
          height: 500,
          fill: '#fefce8',
          stroke: '#fde68a',
          stroke_width: 1,
        },
      },
      {
        type: 'rect',
        overrides: {
          x: 51,
          y: 6,
          width: 190,
          height: 500,
          fill: '#faf5ff',
          stroke: '#d8b4fe',
          stroke_width: 1,
        },
      },
      {
        type: 'rect',
        overrides: {
          x: 74,
          y: 6,
          width: 190,
          height: 500,
          fill: '#f0fdf4',
          stroke: '#86efac',
          stroke_width: 1,
        },
      },
      // Column headers
      {
        type: 'text',
        overrides: {
          x: 7,
          y: 8,
          width: 160,
          height: 36,
          text_content: 'Backlog',
          font_size: 20,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      {
        type: 'text',
        overrides: {
          x: 30,
          y: 8,
          width: 160,
          height: 36,
          text_content: 'In Progress',
          font_size: 20,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      {
        type: 'text',
        overrides: {
          x: 53,
          y: 8,
          width: 160,
          height: 36,
          text_content: 'Review',
          font_size: 20,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      {
        type: 'text',
        overrides: {
          x: 76,
          y: 8,
          width: 160,
          height: 36,
          text_content: 'Done',
          font_size: 20,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Sample sticky notes
      {
        type: 'sticky_note',
        overrides: {
          x: 7,
          y: 18,
          width: 170,
          height: 100,
          fill: '#bfdbfe',
          text_content: 'Task 1',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 7,
          y: 36,
          width: 170,
          height: 100,
          fill: '#bfdbfe',
          text_content: 'Task 2',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 30,
          y: 18,
          width: 170,
          height: 100,
          fill: '#fef08a',
          text_content: 'Task 3',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 53,
          y: 18,
          width: 170,
          height: 100,
          fill: '#e9d5ff',
          text_content: 'Task 4',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 76,
          y: 18,
          width: 170,
          height: 100,
          fill: '#bbf7d0',
          text_content: 'Task 5',
          font_size: 14,
        },
      },
    ],
  },
  {
    id: 'user-journey',
    name: 'User Journey',
    description: 'A horizontal flow mapping five stages of the user experience',
    icon: '\u{1F5FA}\u{FE0F}',
    objects: [
      // Stage 1: Discover
      {
        type: 'diamond',
        overrides: {
          x: 8,
          y: 30,
          width: 120,
          height: 120,
          fill: '#bfdbfe',
          stroke: '#3b82f6',
          stroke_width: 2,
        },
      },
      {
        type: 'text',
        overrides: {
          x: 8,
          y: 52,
          width: 120,
          height: 30,
          text_content: 'Discover',
          font_size: 14,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Arrow 1->2
      {
        type: 'arrow',
        overrides: {
          x: 20,
          y: 40,
          width: 60,
          height: 2,
          stroke: '#6b7280',
          stroke_width: 2,
          points: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
          ],
        },
      },
      // Stage 2: Consider
      {
        type: 'rect',
        overrides: {
          x: 26,
          y: 32,
          width: 130,
          height: 80,
          fill: '#bbf7d0',
          stroke: '#22c55e',
          stroke_width: 2,
        },
      },
      {
        type: 'text',
        overrides: {
          x: 26,
          y: 42,
          width: 130,
          height: 30,
          text_content: 'Consider',
          font_size: 14,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Arrow 2->3
      {
        type: 'arrow',
        overrides: {
          x: 38,
          y: 40,
          width: 60,
          height: 2,
          stroke: '#6b7280',
          stroke_width: 2,
          points: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
          ],
        },
      },
      // Stage 3: Purchase
      {
        type: 'diamond',
        overrides: {
          x: 44,
          y: 30,
          width: 120,
          height: 120,
          fill: '#fef08a',
          stroke: '#eab308',
          stroke_width: 2,
        },
      },
      {
        type: 'text',
        overrides: {
          x: 44,
          y: 52,
          width: 120,
          height: 30,
          text_content: 'Purchase',
          font_size: 14,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Arrow 3->4
      {
        type: 'arrow',
        overrides: {
          x: 56,
          y: 40,
          width: 60,
          height: 2,
          stroke: '#6b7280',
          stroke_width: 2,
          points: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
          ],
        },
      },
      // Stage 4: Use
      {
        type: 'rect',
        overrides: {
          x: 62,
          y: 32,
          width: 130,
          height: 80,
          fill: '#fed7aa',
          stroke: '#f97316',
          stroke_width: 2,
        },
      },
      {
        type: 'text',
        overrides: {
          x: 62,
          y: 42,
          width: 130,
          height: 30,
          text_content: 'Use',
          font_size: 14,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Arrow 4->5
      {
        type: 'arrow',
        overrides: {
          x: 74,
          y: 40,
          width: 60,
          height: 2,
          stroke: '#6b7280',
          stroke_width: 2,
          points: [
            { x: 0, y: 0 },
            { x: 60, y: 0 },
          ],
        },
      },
      // Stage 5: Advocate
      {
        type: 'diamond',
        overrides: {
          x: 80,
          y: 30,
          width: 120,
          height: 120,
          fill: '#e9d5ff',
          stroke: '#a855f7',
          stroke_width: 2,
        },
      },
      {
        type: 'text',
        overrides: {
          x: 80,
          y: 52,
          width: 120,
          height: 30,
          text_content: 'Advocate',
          font_size: 14,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
    ],
  },
  {
    id: 'pros-cons',
    name: 'Pros & Cons',
    description: 'Two-column layout to weigh pros against cons',
    icon: '\u{2696}\u{FE0F}',
    objects: [
      // Pros background
      {
        type: 'rect',
        overrides: {
          x: 8,
          y: 6,
          width: 340,
          height: 480,
          fill: '#f0fdf4',
          stroke: '#86efac',
          stroke_width: 1,
        },
      },
      // Cons background
      {
        type: 'rect',
        overrides: {
          x: 52,
          y: 6,
          width: 340,
          height: 480,
          fill: '#fef2f2',
          stroke: '#fca5a5',
          stroke_width: 1,
        },
      },
      // Pros header
      {
        type: 'text',
        overrides: {
          x: 14,
          y: 8,
          width: 200,
          height: 44,
          text_content: 'Pros',
          font_size: 26,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Cons header
      {
        type: 'text',
        overrides: {
          x: 58,
          y: 8,
          width: 200,
          height: 44,
          text_content: 'Cons',
          font_size: 26,
          fill: 'transparent',
          stroke: 'transparent',
        },
      },
      // Pros sticky notes
      {
        type: 'sticky_note',
        overrides: {
          x: 12,
          y: 20,
          width: 260,
          height: 100,
          fill: '#bbf7d0',
          text_content: '',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 12,
          y: 38,
          width: 260,
          height: 100,
          fill: '#bbf7d0',
          text_content: '',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 12,
          y: 56,
          width: 260,
          height: 100,
          fill: '#bbf7d0',
          text_content: '',
          font_size: 14,
        },
      },
      // Cons sticky notes
      {
        type: 'sticky_note',
        overrides: {
          x: 56,
          y: 20,
          width: 260,
          height: 100,
          fill: '#fecaca',
          text_content: '',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 56,
          y: 38,
          width: 260,
          height: 100,
          fill: '#fecaca',
          text_content: '',
          font_size: 14,
        },
      },
      {
        type: 'sticky_note',
        overrides: {
          x: 56,
          y: 56,
          width: 260,
          height: 100,
          fill: '#fecaca',
          text_content: '',
          font_size: 14,
        },
      },
    ],
  },
];
