import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The Skills window asks for a body when a row is opened. These render the real
// component and assert the two outcomes a user actually sees: the skill's text,
// or a specific explanation of why there isn't any. The fetch layer is stubbed
// so this stays a test of the pane, not of the network.
const fetchSkillContent = vi.fn();
const fetchSkillLibrary = vi.fn();
const fetchSkillLibraryEntry = vi.fn();

vi.mock('../../src/lib/skillContent', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/skillContent')>('../../src/lib/skillContent');
  return { ...actual, fetchSkillContent, fetchSkillLibrary, fetchSkillLibraryEntry };
});

const { SkillsWindowContent } = await import('../../src/components/windows/SkillsWindowContent');

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The window measures itself to choose split vs full-width detail. jsdom has
  // no ResizeObserver, and without one the component would never observe at all.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  fetchSkillContent.mockReset();
  fetchSkillLibrary.mockReset().mockResolvedValue({ entries: [], available: true });
  fetchSkillLibraryEntry.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const agents = [{ id: 'a1', name: 'Coder', handle: 'coder', run_mode: 'daemon', skills: [], enabled: true }] as never;
const connections = [{ agent_id: 'a1', handle: 'coder', capabilities: { skills: ['deploy-targets'] } }] as never;

function render() {
  act(() => {
    root.render(createElement(SkillsWindowContent, {
      agents,
      agentConnections: connections,
      systemCapabilities: null,
      workspaceId: 'w1',
    }));
  });
}

function openSkill(name: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(name));
  expect(button, `expected a row for ${name}`).toBeTruthy();
  act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('SkillsWindowContent shows the body', () => {
  it('renders the skill text once it arrives', async () => {
    fetchSkillContent.mockResolvedValue({
      available: true,
      source: 'daemon',
      markdown: '# Deploy targets\n\nFly before Netlify.',
      path: '/home/j/.claude/skills/deploy-targets/SKILL.md',
      byteSize: 120,
      truncated: false,
      agentName: 'Coder',
    });

    render();
    openSkill('deploy-targets');
    await act(async () => { await Promise.resolve(); });

    expect(fetchSkillContent).toHaveBeenCalledWith('w1', 'deploy-targets');
    expect(container.textContent).toContain('Fly before Netlify.');
    // Provenance, not decoration: it is the difference between a file from a
    // machine and agensis's own description of a skill.
    expect(container.textContent).toContain("Mirrored from Coder's machine.");
    expect(container.textContent).toContain('/home/j/.claude/skills/deploy-targets/SKILL.md');
  });

  it('explains a skill whose file never came up, instead of showing a blank', async () => {
    fetchSkillContent.mockResolvedValue({ available: false, reason: 'not-synced' });

    render();
    openSkill('deploy-targets');
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('The file is on the machine, not here');
    expect(container.textContent).toMatch(/nothing is missing on your side/i);
  });

  it('shows an agent chip with initials, never an emoji or an icon', () => {
    render();
    const chip = [...container.querySelectorAll('[role="button"]')]
      .find(el => el.textContent?.includes('Coder'));
    expect(chip, 'expected a chip for Coder on the deploy-targets row').toBeTruthy();
    // Initials on the agent's own accent colour, the house identity pattern.
    const disc = chip!.querySelector('span[style*="background"]');
    expect(disc?.textContent).toBe('CO');
    // No emoji anywhere in the chip — absolute house rule.
    expect(chip!.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('distinguishes an advertised chip from a configured one', () => {
    act(() => {
      root.render(createElement(SkillsWindowContent, {
        agents: [
          { id: 'a1', name: 'Coder', handle: 'coder', run_mode: 'daemon', skills: [], enabled: true },
          { id: 'a2', name: 'Scout', handle: 'scout', run_mode: 'daemon', skills: ['deploy-targets'], enabled: true },
        ] as never,
        agentConnections: connections,
        systemCapabilities: null,
        workspaceId: 'w1',
      }));
    });
    const chips = [...container.querySelectorAll('[role="button"]')]
      .filter(el => /Coder|Scout/.test(el.textContent || ''));
    expect(chips).toHaveLength(2);
    // The title is the accessible form of the fill-vs-outline treatment, and it
    // is the answer to "which agents CAN use this".
    expect(chips.find(c => c.textContent?.includes('Coder'))!.getAttribute('title'))
      .toMatch(/advertises this skill from a connected machine/);
    expect(chips.find(c => c.textContent?.includes('Scout'))!.getAttribute('title'))
      .toMatch(/nothing is connected to confirm it/);
  });

  it('does not ask the backend for anything until a row is opened', () => {
    // The list needs no bodies to render, and most are never looked at.
    render();
    expect(fetchSkillContent).not.toHaveBeenCalled();
  });

  it('asks for nothing when there is no workspace yet', async () => {
    act(() => {
      root.render(createElement(SkillsWindowContent, {
        agents,
        agentConnections: connections,
        systemCapabilities: null,
        workspaceId: '',
      }));
    });
    openSkill('deploy-targets');
    await act(async () => { await Promise.resolve(); });
    expect(fetchSkillContent).not.toHaveBeenCalled();
  });
});
