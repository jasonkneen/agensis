import type { ReactNode } from 'react';

/**
 * Shared layout primitives for the component showcase. Showcase section files
 * (src/showcase/sections/*.tsx) import these so every section looks consistent.
 * Uses shadcn theme utility classes (bg-card, text-foreground, …) so the
 * showcase visibly reflects the active theme.
 */
export function SectionShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={title.toLowerCase().replace(/\s+/g, '-')} className="scroll-mt-20 space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="grid gap-5 rounded-xl border border-border bg-card p-6 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </section>
  );
}

export function Example({
  label,
  children,
  full = false,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-3 ${full ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
