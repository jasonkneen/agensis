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
    expect(appSource).toContain('loading={wsLoading || workspaceReadiness.status === \'missing\' || workspaceReadiness.status === \'preparing\'}');
  });
});
