/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/client" />

// Build identity injected by Vite `define` (see vite.config.ts). Absent under
// vitest (which doesn't apply the app's define), so always read it through a
// `typeof __BUILD_ID__ !== 'undefined'` guard — never bare.
declare const __BUILD_ID__: string;

interface Window {
  electronAPI?: {
    pickFolder: () => Promise<string | null>;
  };
}
