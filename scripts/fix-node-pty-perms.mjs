// node-pty's macOS prebuilds launch every shell through a small `spawn-helper`
// binary that must be EXECUTABLE. Some installers (bun, pnpm, tarball copies)
// drop the mode bit, and then every terminal spawn throws "posix_spawnp
// failed." — which the desktop Terminal window showed as a terminal that never
// finished loading. Restore the bit after every install. Missing package or
// non-macOS: nothing to do, never fail the install.
import { chmodSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(root, arch, 'spawn-helper');
  try {
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755);
  } catch (error) {
    console.warn(`[fix-node-pty-perms] ${helper}:`, error instanceof Error ? error.message : error);
  }
}
