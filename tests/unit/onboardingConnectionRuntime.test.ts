import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/onboarding/OnboardingTour.tsx'),
  'utf8',
);

describe('onboarding CLI connection runtime', () => {
  it('persists daemon transport and the selected execution runtime before minting a command', () => {
    expect(source).toContain("const runtime: AgentExecutionRuntime = cliId === 'codex' ? 'codex' : 'claude';");
    expect(source).toContain("run_mode: 'daemon'");
    expect(source).toContain("metadata: agentMetadataWithRuntime({}, runtime, 'daemon')");
  });

  it('does not create the CLI agent as a built-in agent', () => {
    const handleConnect = source.slice(
      source.indexOf('const handleConnect = async'),
      source.indexOf('const copyCommand ='),
    );
    expect(handleConnect).not.toContain("run_mode: 'builtin'");
  });
});
