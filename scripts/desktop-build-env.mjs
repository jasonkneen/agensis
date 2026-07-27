import path from 'node:path';

export function resolveZigGlobalCacheDir(desktopDir, env = process.env) {
  return env.ZIG_GLOBAL_CACHE_DIR || path.join(desktopDir, '.zig-cache', 'global');
}
