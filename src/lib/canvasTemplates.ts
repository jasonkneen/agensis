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

// NOTE: The canvas uses a percentage coordinate system. x, y, width and height
// are all 0-100 percentages of the visible canvas (see CanvasObjectRenderer:
// `px = obj.x / 100 * canvasWidth`). Only font_size is in raw pixels.
// Text color comes from `fill`; arrow/line color also comes from `fill`.
// Each template is laid out centered within the 0-100 space.
const TEXT_COLOR = '#1e293b';

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
          x: 16,
          y: 21,
          width: 68,
          height: 8,
          text_content: 'Brainstorm',
          font_size: 30,
          fill: TEXT_COLOR,
          stroke: 'transparent',
        },
      },
      {
        type: 'sticky_note',
        overrides: { x: 16, y: 33, width: 20, height: 20, fill: '#fef08a', text_content: 'Idea 1', font_size: 16 },
      },
      {
        type: 'sticky_note',
        overrides: { x: 40, y: 33, width: 20, height: 20, fill: '#bbf7d0', text_content: 'Idea 2', font_size: 16 },
      },
      {
        type: 'sticky_note',
        overrides: { x: 64, y: 33, width: 20, height: 20, fill: '#bfdbfe', text_content: 'Idea 3', font_size: 16 },
      },
      {
        type: 'sticky_note',
        overrides: { x: 16, y: 58, width: 20, height: 20, fill: '#fecaca', text_content: 'Idea 4', font_size: 16 },
      },
      {
        type: 'sticky_note',
        overrides: { x: 40, y: 58, width: 20, height: 20, fill: '#e9d5ff', text_content: 'Idea 5', font_size: 16 },
      },
      {
        type: 'sticky_note',
        overrides: { x: 64, y: 58, width: 20, height: 20, fill: '#fed7aa', text_content: 'Idea 6', font_size: 16 },
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
        overrides: { x: 5, y: 12, width: 28, height: 6, text_content: 'What went well', font_size: 18, fill: TEXT_COLOR, stroke: 'transparent' },
      },
      {
        type: 'text',
        overrides: { x: 36, y: 12, width: 28, height: 6, text_content: "What didn't", font_size: 18, fill: TEXT_COLOR, stroke: 'transparent' },
      },
      {
        type: 'text',
        overrides: { x: 67, y: 12, width: 28, height: 6, text_content: 'Action items', font_size: 18, fill: TEXT_COLOR, stroke: 'transparent' },
      },
      // "What went well"
      { type: 'sticky_note', overrides: { x: 5, y: 22, width: 28, height: 24, fill: '#bbf7d0', text_content: '', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 5, y: 49, width: 28, height: 24, fill: '#bbf7d0', text_content: '', font_size: 14 } },
      // "What didn't"
      { type: 'sticky_note', overrides: { x: 36, y: 22, width: 28, height: 24, fill: '#fecaca', text_content: '', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 36, y: 49, width: 28, height: 24, fill: '#fecaca', text_content: '', font_size: 14 } },
      // "Action items"
      { type: 'sticky_note', overrides: { x: 67, y: 22, width: 28, height: 24, fill: '#bfdbfe', text_content: '', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 67, y: 49, width: 28, height: 24, fill: '#bfdbfe', text_content: '', font_size: 14 } },
    ],
  },
  {
    id: 'kanban',
    name: 'Kanban',
    description: 'Four-column task board with colored lanes and sample cards',
    icon: '\u{1F4CB}',
    objects: [
      // Column backgrounds
      { type: 'rect', overrides: { x: 3, y: 8, width: 22, height: 84, fill: '#f0f9ff', stroke: '#bae6fd', stroke_width: 1 } },
      { type: 'rect', overrides: { x: 27, y: 8, width: 22, height: 84, fill: '#fefce8', stroke: '#fde68a', stroke_width: 1 } },
      { type: 'rect', overrides: { x: 51, y: 8, width: 22, height: 84, fill: '#faf5ff', stroke: '#d8b4fe', stroke_width: 1 } },
      { type: 'rect', overrides: { x: 75, y: 8, width: 22, height: 84, fill: '#f0fdf4', stroke: '#86efac', stroke_width: 1 } },
      // Column headers
      { type: 'text', overrides: { x: 5, y: 11, width: 18, height: 5, text_content: 'Backlog', font_size: 16, fill: TEXT_COLOR, stroke: 'transparent' } },
      { type: 'text', overrides: { x: 29, y: 11, width: 18, height: 5, text_content: 'In Progress', font_size: 16, fill: TEXT_COLOR, stroke: 'transparent' } },
      { type: 'text', overrides: { x: 53, y: 11, width: 18, height: 5, text_content: 'Review', font_size: 16, fill: TEXT_COLOR, stroke: 'transparent' } },
      { type: 'text', overrides: { x: 77, y: 11, width: 18, height: 5, text_content: 'Done', font_size: 16, fill: TEXT_COLOR, stroke: 'transparent' } },
      // Sample cards
      { type: 'sticky_note', overrides: { x: 5, y: 19, width: 18, height: 12, fill: '#bfdbfe', text_content: 'Task 1', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 5, y: 33, width: 18, height: 12, fill: '#bfdbfe', text_content: 'Task 2', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 29, y: 19, width: 18, height: 12, fill: '#fef08a', text_content: 'Task 3', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 53, y: 19, width: 18, height: 12, fill: '#e9d5ff', text_content: 'Task 4', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 77, y: 19, width: 18, height: 12, fill: '#bbf7d0', text_content: 'Task 5', font_size: 14 } },
    ],
  },
  {
    id: 'user-journey',
    name: 'User Journey',
    description: 'A horizontal flow mapping five stages of the user experience',
    icon: '\u{1F5FA}\u{FE0F}',
    objects: [
      // Stage 1: Discover
      { type: 'diamond', overrides: { x: 7, y: 41, width: 13, height: 18, fill: '#bfdbfe', stroke: '#3b82f6', stroke_width: 2 } },
      { type: 'text', overrides: { x: 7, y: 48, width: 13, height: 5, text_content: 'Discover', font_size: 13, fill: TEXT_COLOR, stroke: 'transparent' } },
      // Arrow 1->2 (color comes from fill; no points = horizontal arrow across width)
      { type: 'arrow', overrides: { x: 20, y: 49, width: 5, height: 2, fill: '#6b7280', stroke_width: 2 } },
      // Stage 2: Consider
      { type: 'rect', overrides: { x: 25, y: 41, width: 13, height: 18, fill: '#bbf7d0', stroke: '#22c55e', stroke_width: 2 } },
      { type: 'text', overrides: { x: 25, y: 48, width: 13, height: 5, text_content: 'Consider', font_size: 13, fill: TEXT_COLOR, stroke: 'transparent' } },
      // Arrow 2->3
      { type: 'arrow', overrides: { x: 38, y: 49, width: 5, height: 2, fill: '#6b7280', stroke_width: 2 } },
      // Stage 3: Purchase
      { type: 'diamond', overrides: { x: 43, y: 41, width: 13, height: 18, fill: '#fef08a', stroke: '#eab308', stroke_width: 2 } },
      { type: 'text', overrides: { x: 43, y: 48, width: 13, height: 5, text_content: 'Purchase', font_size: 13, fill: TEXT_COLOR, stroke: 'transparent' } },
      // Arrow 3->4
      { type: 'arrow', overrides: { x: 56, y: 49, width: 5, height: 2, fill: '#6b7280', stroke_width: 2 } },
      // Stage 4: Use
      { type: 'rect', overrides: { x: 61, y: 41, width: 13, height: 18, fill: '#fed7aa', stroke: '#f97316', stroke_width: 2 } },
      { type: 'text', overrides: { x: 61, y: 48, width: 13, height: 5, text_content: 'Use', font_size: 13, fill: TEXT_COLOR, stroke: 'transparent' } },
      // Arrow 4->5
      { type: 'arrow', overrides: { x: 74, y: 49, width: 5, height: 2, fill: '#6b7280', stroke_width: 2 } },
      // Stage 5: Advocate
      { type: 'diamond', overrides: { x: 79, y: 41, width: 13, height: 18, fill: '#e9d5ff', stroke: '#a855f7', stroke_width: 2 } },
      { type: 'text', overrides: { x: 79, y: 48, width: 13, height: 5, text_content: 'Advocate', font_size: 13, fill: TEXT_COLOR, stroke: 'transparent' } },
    ],
  },
  {
    id: 'pros-cons',
    name: 'Pros & Cons',
    description: 'Two-column layout to weigh pros against cons',
    icon: '\u{2696}\u{FE0F}',
    objects: [
      // Panel backgrounds
      { type: 'rect', overrides: { x: 6, y: 8, width: 42, height: 84, fill: '#f0fdf4', stroke: '#86efac', stroke_width: 1 } },
      { type: 'rect', overrides: { x: 52, y: 8, width: 42, height: 84, fill: '#fef2f2', stroke: '#fca5a5', stroke_width: 1 } },
      // Headers
      { type: 'text', overrides: { x: 8, y: 11, width: 38, height: 8, text_content: 'Pros', font_size: 24, fill: TEXT_COLOR, stroke: 'transparent' } },
      { type: 'text', overrides: { x: 54, y: 11, width: 38, height: 8, text_content: 'Cons', font_size: 24, fill: TEXT_COLOR, stroke: 'transparent' } },
      // Pros notes
      { type: 'sticky_note', overrides: { x: 8, y: 22, width: 38, height: 16, fill: '#bbf7d0', text_content: '', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 8, y: 42, width: 38, height: 16, fill: '#bbf7d0', text_content: '', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 8, y: 62, width: 38, height: 16, fill: '#bbf7d0', text_content: '', font_size: 14 } },
      // Cons notes
      { type: 'sticky_note', overrides: { x: 54, y: 22, width: 38, height: 16, fill: '#fecaca', text_content: '', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 54, y: 42, width: 38, height: 16, fill: '#fecaca', text_content: '', font_size: 14 } },
      { type: 'sticky_note', overrides: { x: 54, y: 62, width: 38, height: 16, fill: '#fecaca', text_content: '', font_size: 14 } },
    ],
  },
];
