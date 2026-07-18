/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/client" />

// Build identity injected by Vite `define` (see vite.config.ts). Absent under
// vitest (which doesn't apply the app's define), so always read it through a
// `typeof __BUILD_ID__ !== 'undefined'` guard — never bare.
declare const __BUILD_ID__: string;
/** package.json version, injected by Vite `define`; guard with `typeof`. */
declare const __APP_VERSION__: string;

/** Native SDK JS bridge (desktop shell). Absent in the browser / PWA. */
interface NativeZeroBridge {
  invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
}

interface Window {
  /** @deprecated Electron shell removed; use `zero` (Native SDK). */
  electronAPI?: {
    pickFolder: () => Promise<string | null>;
  };
  zero?: NativeZeroBridge;
}
