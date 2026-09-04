import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const railSource = readFileSync(resolve(process.cwd(), 'src/components/layout/WorkspaceRail.tsx'), 'utf8');
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

describe('workspace rail loading states', () => {
  it('does not render an unlabeled blank rail while workspaces settle', () => {
    expect(railSource).toContain('aria-busy={showLoading ? \'true\' : undefined}');
    expect(railSource).toContain('Loading workspaces…');
    expect(railSource).toContain('loadError');
    expect(railSource).toContain('onRetry');
    // 'pending' is the pre-session state: no user id yet, so no fetch has been
    // attempted. It must read as loading here — it used to fall through to the
    // 'unavailable' branch and paint a connection error over a healthy account
    // on cold load.
    expect(appSource).toContain("workspaceReadiness.status === 'pending'");
    expect(appSource).toContain("workspaceReadiness.status === 'missing'");
    expect(appSource).toContain("workspaceReadiness.status === 'preparing'");
    expect(appSource).toContain("loadError={workspaceReadiness.status === 'unavailable'");
  });
});
