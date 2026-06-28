import {
  ArrowRight,
  Circle,
  Diamond,
  Eraser,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  StickyNote,
  Type,
} from 'lucide-react';
import type { CanvasTool } from '../../types';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

const TOOLS: Array<{ id: CanvasTool; icon: typeof MousePointer2; label: string }> = [
  { id: 'select', icon: MousePointer2, label: 'Select' },
  { id: 'pen', icon: Pencil, label: 'Pen' },
  { id: 'rect', icon: Square, label: 'Rectangle' },
  { id: 'ellipse', icon: Circle, label: 'Ellipse' },
  { id: 'diamond', icon: Diamond, label: 'Diamond' },
  { id: 'line', icon: Minus, label: 'Line' },
  { id: 'arrow', icon: ArrowRight, label: 'Arrow' },
  { id: 'text', icon: Type, label: 'Text' },
  { id: 'sticky_note', icon: StickyNote, label: 'Sticky Note' },
  { id: 'eraser', icon: Eraser, label: 'Eraser' },
];

const PALETTE = [
  { value: '#1e293b', className: 'bg-slate-800' },
  { value: '#ef4444', className: 'bg-red-500' },
  { value: '#f97316', className: 'bg-orange-500' },
  { value: '#eab308', className: 'bg-yellow-500' },
  { value: '#22c55e', className: 'bg-green-500' },
  { value: '#06b6d4', className: 'bg-cyan-500' },
  { value: '#3b82f6', className: 'bg-blue-500' },
  { value: '#ec4899', className: 'bg-pink-500' },
  { value: '#8b5cf6', className: 'bg-violet-500' },
  { value: '#ffffff', className: 'bg-white' },
];

const STROKE_WIDTHS = [
  { value: 2, className: 'h-0.5 w-3' },
  { value: 4, className: 'h-1 w-4' },
  { value: 8, className: 'h-2 w-6' },
];

interface CanvasToolbarProps {
  activeTool: CanvasTool;
  activeColor: string;
  strokeWidth: number;
  onToolChange: (tool: CanvasTool) => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (w: number) => void;
}

export function CanvasToolbar({
  activeTool,
  activeColor,
  strokeWidth,
  onToolChange,
  onColorChange,
  onStrokeWidthChange,
}: CanvasToolbarProps) {
  return (
    <div className="canvas-toolbar absolute bottom-4 left-1/2 z-[600] flex -translate-x-1/2 items-center gap-1.5 rounded-xl border bg-popover/95 px-2.5 py-1.5 text-popover-foreground shadow-lg backdrop-blur">
      <ToggleGroup
        type="single"
        value={activeTool}
        onValueChange={value => {
          if (value) onToolChange(value as CanvasTool);
        }}
        size="sm"
        spacing={1}
        aria-label="Canvas tool"
      >
        {TOOLS.map(tool => {
          const Icon = tool.icon;
          return (
            <ToggleGroupItem key={tool.id} value={tool.id} title={tool.label} aria-label={tool.label} className="min-w-8 px-0">
              <Icon data-icon="inline-start" className="size-4" />
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <div className="flex items-center gap-1" aria-label="Stroke color">
        {PALETTE.map(color => (
          <Button
            key={color.value}
            type="button"
            variant="ghost"
            size="icon-xs"
            title={color.value}
            aria-label={color.value}
            onClick={() => onColorChange(color.value)}
            className={cn(
              'rounded-full p-0 ring-offset-background',
              activeColor === color.value && 'scale-110 ring-2 ring-primary ring-offset-2',
            )}
          >
            <span className={cn('size-4 rounded-full border border-border', color.className)} />
          </Button>
        ))}
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <ToggleGroup
        type="single"
        value={String(strokeWidth)}
        onValueChange={value => {
          if (value) onStrokeWidthChange(Number(value));
        }}
        size="sm"
        spacing={1}
        aria-label="Stroke width"
      >
        {STROKE_WIDTHS.map(width => (
          <ToggleGroupItem key={width.value} value={String(width.value)} title={`${width.value}px`} aria-label={`${width.value}px`} className="min-w-8 px-0">
            <span
              className={cn(
                'rounded-full',
                width.className,
                strokeWidth === width.value ? 'bg-primary' : 'bg-muted-foreground',
              )}
            />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
