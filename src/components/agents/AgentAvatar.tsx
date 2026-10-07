import {
  Bot,
  Brain,
  Code2,
  Command,
  Database,
  Globe,
  Monitor,
  Rocket,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { BLOBATAR_AVATAR_PREFIX, isBlobatarAvatar, resolveAgentAvatar } from '@/lib/agentAvatars';
import { BloubAgentFace } from './BloubAgentFace';
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from '@/lib/openpets';

export interface AgentAvatarProps {
  /** Empty and legacy `AI` values resolve to the automatic avatar. */
  avatar?: string | null;
  /** The stable name used to generate the automatic Blobatar. */
  name?: string | null;
  /** Fallback for an explicit non-image avatar key, or an unusual old value. */
  initials?: string;
  className?: string;
  fallbackClassName?: string;
  alt?: string;
}

function fallbackInitials(name: string | null | undefined) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

const EXPLICIT_AGENT_ICONS: Record<string, LucideIcon> = {
  'icon:bot': Bot,
  'icon:sparkles': Sparkles,
  'icon:brain': Brain,
  'icon:terminal': Terminal,
  'icon:code': Code2,
  'icon:command': Command,
  'icon:wrench': Wrench,
  'icon:database': Database,
  'icon:shield': ShieldCheck,
  'icon:rocket': Rocket,
  'icon:globe': Globe,
  'icon:monitor': Monitor,
};

/**
 * The common agent-avatar renderer for reduced agent references.
 *
 * Full agent cards can use their richer preview, but presence, skill, library,
 * member and huddle surfaces all carry a small agent reference. Keeping this
 * branch here prevents one of those surfaces silently falling back to initials
 * when the default avatar changes.
 */
export function AgentAvatar({
  avatar,
  name,
  initials,
  className,
  fallbackClassName,
  alt = '',
}: AgentAvatarProps) {
  const seed = name || initials || 'agent';
  // `resolveAgentAvatar` turns legacy/empty values into the compact marker and
  // preserves an existing marker, so renaming an agent does not silently
  // replace a previously generated identity.
  const resolved = resolveAgentAvatar(avatar, seed);

  // Automatic avatars are the animated characters. The marker's slug is the
  // stable seed, so renaming an agent does not change its face.
  if (isBlobatarAvatar(resolved)) {
    const markerSeed = resolved.slice(BLOBATAR_AVATAR_PREFIX.length).trim() || seed;
    return <BloubAgentFace seed={markerSeed} className={cn('grid size-full place-items-center', className)} />;
  }

  if (isPetSpritesheetAvatar(resolved)) {
    return (
      <span className={cn('animated-pet-avatar-shell', className)}>
        <span className="animated-pet-avatar size-full" style={{ backgroundImage: `url(${renderablePetAssetUrl(resolved)})` }} />
      </span>
    );
  }

  if (isImageAvatar(resolved)) {
    return <img src={renderablePetAssetUrl(resolved)} alt={alt} className={cn('size-full object-cover', className)} loading="lazy" draggable={false} />;
  }

  const Icon = EXPLICIT_AGENT_ICONS[resolved.toLowerCase()];
  if (Icon) {
    return (
      <span className={cn('grid size-full place-items-center', className, fallbackClassName)}>
        <Icon className="size-1/2" aria-hidden />
      </span>
    );
  }

  const textAvatar = resolved && !resolved.includes(':') && !resolved.includes('/') && resolved.length <= 2
    ? resolved.toUpperCase()
    : initials || fallbackInitials(name);

  return (
    <span className={cn('grid size-full place-items-center', className, fallbackClassName)}>
      {textAvatar}
    </span>
  );
}
