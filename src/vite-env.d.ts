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

interface LocalAgentCapabilities {
  checkedAt: string;
  workspacePath: string;
  source?: string;
  clis: Array<{
    id: string;
    label: string;
    command: string;
    available: boolean;
    path: string | null;
    version: string | null;
  }>;
  packages: Array<{ name: string; available: boolean; version: string | null; path: string | null }>;
  skills: Array<{
    id: string;
    label: string;
    type: string;
    path: string;
    available: boolean;
    count: number;
  }>;
  codexAppServer: { available: boolean; command: string; transports: string[] };
}

interface Window {
  /** Electron desktop shell bridge (pty, folder picker, local agents, ACP host). */
  electronAPI?: {
    pickFolder: () => Promise<string | null>;
    /** Probe THIS machine for claude/codex/amp/grok/… (not the remote backend). */
    discoverLocalAgents?: (options?: {
      workspacePath?: string;
      refresh?: boolean;
    }) => Promise<{ ok: true; data: LocalAgentCapabilities } | { ok: false; error: string }>;
    acp?: {
      listHarnesses: () => Promise<{
        ok: true;
        data: Array<{
          id: string;
          label: string;
          available: boolean;
          path: string | null;
          command: string | null;
          installHint: string | null;
        }>;
      } | { ok: false; error: string }>;
      status: (agentId: string) => Promise<{
        ok: true;
        data: {
          session: {
            agentId: string;
            harnessId: string;
            label: string;
            path: string;
            cwd: string;
            sessionId: string | null;
            pid: number | undefined;
            startedAt: string;
            running: boolean;
          } | null;
          bridge: { agentId: string; connected: boolean; harnessId: string } | null;
          running: unknown[];
        };
      } | { ok: false; error: string }>;
      start: (options: {
        agentId: string;
        harnessId: string;
        cwd?: string;
        autoApprove?: boolean;
        /** Agent ACCESS: default=Ask, accept_edits, yolo=Full access (acceptEdits legacy alias ok) */
        permissionMode?: 'default' | 'accept_edits' | 'acceptEdits' | 'yolo';
        token?: string;
        baseUrl?: string;
        workspaceId?: string;
        handle?: string;
        name?: string;
        model?: string;
        /** agent.metadata.runtime when pinned to claude|codex|amp */
        requiredRuntime?: string;
      }) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
      stop: (agentId: string) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
      prompt: (
        agentId: string,
        text: string,
      ) => Promise<{ ok: true; data: { text: string; stopReason: string } } | { ok: false; error: string }>;
      onUpdate: (agentId: string, callback: (params: unknown) => void) => () => void;
      onChunk: (agentId: string, callback: (chunk: string) => void) => () => void;
      onLog: (agentId: string, callback: (line: string) => void) => () => void;
    };
    pty?: {
      spawn: (options?: { cols?: number; rows?: number; cwd?: string }) => Promise<
        { ok: true; id: string; shell: string } | { ok: false; error: string }
      >;
      write: (id: string, data: string) => void;
      resize: (id: string, cols: number, rows: number) => void;
      kill: (id: string) => void;
      onData: (id: string, callback: (chunk: string) => void) => () => void;
      onExit: (id: string, callback: (code: number) => void) => () => void;
    };
  };
  zero?: NativeZeroBridge;
}
