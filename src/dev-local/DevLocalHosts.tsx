import { lazy, Suspense, type ComponentType } from 'react';

// Machine-local dev overlays. Any `*.host.tsx` dropped in this folder is mounted
// once at the app root during `vite dev`. The folder's other files are
// gitignored, so a clean checkout matches nothing here and ships nothing.
const hosts: Array<ComponentType> = import.meta.env.DEV
  ? Object.values(import.meta.glob<{ default: ComponentType }>('./*.host.tsx')).map(load => lazy(load))
  : [];

export function DevLocalHosts() {
  if (hosts.length === 0) return null;
  return (
    <Suspense fallback={null}>
      {hosts.map((Host, index) => <Host key={index} />)}
    </Suspense>
  );
}
