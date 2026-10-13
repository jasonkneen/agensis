import { projectColor, projectIcon } from './projectIconMap';

/** The project's icon on a tinted tile in its colour. */
export function ProjectIconTile({
  icon,
  color,
  size = 'md',
}: {
  icon: string | null | undefined;
  color: string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
}) {
  const Icon = projectIcon(icon);
  const hex = projectColor(color);
  const box = size === 'lg' ? 'size-12 rounded-xl' : size === 'sm' ? 'size-6 rounded-md' : 'size-9 rounded-lg';
  const glyph = size === 'lg' ? 'size-6' : size === 'sm' ? 'size-3.5' : 'size-[1.125rem]';
  return (
    <span
      className={`grid shrink-0 place-items-center ${box}`}
      style={{ backgroundColor: `${hex}33`, color: hex }}
      aria-hidden
    >
      <Icon className={glyph} />
    </span>
  );
}
