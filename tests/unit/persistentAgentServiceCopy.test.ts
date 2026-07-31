import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('persistent local agent service guidance', () => {
  it('offers the profile-scoped service after a daemon command is generated', () => {
    const agents = read('src/components/windows/AgentsWindowContent.tsx');
    const onboarding = read('src/components/onboarding/OnboardingTour.tsx');
    const readme = read('README.md');

    for (const source of [agents, onboarding, readme]) {
      expect(source).toContain('agensis service install --profile');
    }
    expect(agents).toContain('it never contains the token');
    expect(onboarding).toContain('never the token');
    expect(readme).toContain('RunAtLoad');
    expect(readme).toContain('Restart=always');
  });
});
