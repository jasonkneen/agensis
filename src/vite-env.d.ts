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
  /** Electron desktop shell bridge (pty, folder picker, local agents, local runtime). */
  electronAPI?: {
    pickFolder: () => Promise<string | null>;
    /** Probe THIS machine for claude/codex/amp/grok/… (not the remote backend). */
    discoverLocalAgents?: (options?: {
      workspacePath?: string;
      refresh?: boolean;
    }) => Promise<{ ok: true; data: LocalAgentCapabilities } | { ok: false; error: string }>;
    /**
     * Local Relay on this Mac — spawns `agensis connect --no-acp` so jobs use
     * Claude Agent SDK (warm connection) or Codex app-server.
     */
    localRuntime?: {
      listRuntimes: () => Promise<{
        ok: true;
        data: {
          daemon: {
            available: boolean;
            version: string | null;
            error: string | null;
            source: string | null;
            path: string | null;
          };
          runtimes: Array<{
            id: string;
            label: string;
            detail: string;
            available: boolean;
            path: string | null;
            installHint: string | null;
            mode?: string;
            acpHarness?: string | null;
            classicRuntime?: string | null;
          }>;
        };
      } | { ok: false; error: string }>;
      status: (agentId: string) => Promise<{
        ok: true;
        data: {
          session: {
            agentId: string;
            runtime: string;
            label: string;
            cwd: string;
            baseUrl: string;
            model: string;
            pid: number | undefined;
            startedAt: string;
            running: boolean;
            lastError: string | null;
            registeredHint: boolean;
            binarySource: string | null;
          } | null;
          running: unknown[];
          autostart?: Array<{ agentId: string; runtime: string; autoStart: boolean; savedAt?: string }>;
          openAtLogin?: boolean;
        };
      } | { ok: false; error: string }>;
      start: (options: {
        agentId: string;
        runtime?: string;
        cwd?: string;
        autoApprove?: boolean;
        permissionMode?: 'default' | 'accept_edits' | 'acceptEdits' | 'yolo';
        token?: string;
        baseUrl?: string;
        workspaceId?: string;
        handle?: string;
        name?: string;
        model?: string;
        requiredRuntime?: string;
        harnessId?: string;
        autoStart?: boolean;
      }) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
      stop: (agentId: string) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
      listAutostart: () => Promise<{
        ok: true;
        data: { agents: unknown[]; openAtLogin: boolean };
      } | { ok: false; error: string }>;
      onLog: (agentId: string, callback: (line: string) => void) => () => void;
      onExit: (callback: (payload: { agentId: string }) => void) => () => void;
      onRestoreComplete: (callback: (report: unknown) => void) => () => void;
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
