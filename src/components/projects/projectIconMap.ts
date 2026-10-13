import {
  Briefcase,
  Building2,
  Code,
  Component,
  File,
  Folder,
  Globe,
  Heart,
  LayoutGrid,
  Layers,
  Megaphone,
  Palette,
  Rocket,
  Smartphone,
  Sparkles,
  Target,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { PROJECT_COLORS } from '../../lib/pm/projectTemplates';

// Icon names stored on a project, resolved to Lucide components. An explicit map
// instead of importing every Lucide icon, so the bundle only carries these.
const ICONS: Record<string, LucideIcon> = {
  globe: Globe,
  smartphone: Smartphone,
  megaphone: Megaphone,
  rocket: Rocket,
  component: Component,
  'building-2': Building2,
  'layout-grid': LayoutGrid,
  palette: Palette,
  code: Code,
  briefcase: Briefcase,
  target: Target,
  layers: Layers,
  zap: Zap,
  heart: Heart,
  folder: Folder,
  sparkles: Sparkles,
  file: File,
};

export function projectIcon(name: string | null | undefined): LucideIcon {
  return ICONS[name ?? ''] ?? Folder;
}

/** The hex value for a stored colour name, falling back to slate. */
export function projectColor(name: string | null | undefined): string {
  return PROJECT_COLORS[name ?? ''] ?? PROJECT_COLORS.slate;
}
