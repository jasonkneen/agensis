import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NewProjectDialog } from '../../src/components/projects/NewProjectDialog';

// The New project dialog: starter tasks, and the optional channel and brief. The create
// functions are stubs, so the test sees exactly what the dialog asks for and in what order.

const PROJECT = { id: 'p1', workspace_id: 'ws-1', name: 'Website Redesign', project_key: 'WEB', channel_id: null, brief_document_id: null };

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

type Props = Parameters<typeof NewProjectDialog>[0];

function setup(over: Partial<Props> = {}) {
  const calls = {
    project: [] as unknown[],
    tasks: [] as unknown[],
    updates: [] as Array<[string, unknown]>,
    created: [] as unknown[],
    open: [] as boolean[],
    channel: [] as Array<[string, string]>,
    brief: [] as Array<[string, string]>,
  };
  const props = {
    open: true,
    onOpenChange: (value: boolean) => calls.open.push(value),
    members: [],
    agents: [],
    currentUserId: 'u1',
    createProject: async (input: unknown) => {
      calls.project.push(input);
      return PROJECT;
    },
    createTask: (input: unknown) => {
      calls.tasks.push(input);
      return {};
    },
    updateProject: (id: string, updates: unknown) => {
      calls.updates.push([id, updates]);
    },
    onCreated: (project: unknown) => calls.created.push(project),
    ...over,
  } as unknown as Props;
  act(() => {
    root.render(createElement(NewProjectDialog, props));
  });
  return calls;
}

const q = <T extends Element>(selector: string) => document.body.querySelector(selector) as T | null;
const button = (text: string) => Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement;
const checkbox = (labelText: string) =>
  Array.from(document.body.querySelectorAll('label')).find(l => l.textContent?.includes(labelText))?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;

function fill(selector: string, value: string) {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

async function create() {
  await act(async () => {
    button('Create project').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('New project dialog extras', () => {
  it('creates a workspace project by default and a private one when ticked', async () => {
    const first = setup();
    fill('input[aria-label="Project name"]', 'Open one');
    await create();
    expect(first.project[0]).toMatchObject({ visibility: 'workspace' });

    const second = setup();
    fill('input[aria-label="Project name"]', 'Secret one');
    click(checkbox('Make this project private')!);
    await create();
    expect(second.project[0]).toMatchObject({ visibility: 'private' });
  });

  it('offers neither option when it cannot create them', () => {
    setup();
    expect(checkbox('Create a project channel')).toBeUndefined();
    expect(checkbox('Create a project brief document')).toBeUndefined();
    expect(document.body.textContent).not.toContain('Set up alongside');
  });

  it('offers both options when it can', () => {
    setup({ onCreateChannel: async () => 'ch1', onCreateBrief: async () => 'doc1' });
    expect(checkbox('Create a project channel')).toBeTruthy();
    expect(checkbox('Create a project brief document')).toBeTruthy();
  });

  it('does not call the creators when the options are left off', async () => {
    const calls = setup({
      onCreateChannel: async (n: string, d: string) => (calls.channel.push([n, d]), 'ch1'),
      onCreateBrief: async (t: string, c: string) => (calls.brief.push([t, c]), 'doc1'),
    } as Partial<Props>);
    fill('input[aria-label="Project name"]', 'Website Redesign');
    await create();
    expect(calls.channel).toEqual([]);
    expect(calls.brief).toEqual([]);
    expect(calls.updates).toEqual([]);
    expect(calls.open).toEqual([false]);
  });

  it('creates the channel and the brief, links them to the project, then closes', async () => {
    const calls = setup({
      onCreateChannel: async (n: string, d: string) => (calls.channel.push([n, d]), 'ch1'),
      onCreateBrief: async (t: string, c: string) => (calls.brief.push([t, c]), 'doc1'),
    } as Partial<Props>);
    fill('input[aria-label="Project name"]', 'Website Redesign');
    fill('textarea[aria-label="Description"]', 'A faster marketing site');
    click(checkbox('Create a project channel')!);
    click(checkbox('Create a project brief document')!);
    await create();
    expect(calls.channel).toEqual([['Website Redesign', 'A faster marketing site']]);
    expect(calls.brief).toEqual([['Website Redesign brief', 'A faster marketing site']]);
    expect(calls.updates).toEqual([['p1', { channel_id: 'ch1', brief_document_id: 'doc1' }]]);
    expect(calls.created[0]).toMatchObject({ id: 'p1', channel_id: 'ch1', brief_document_id: 'doc1' });
    expect(calls.open).toEqual([false]);
  });

  it('keeps the project and says what failed when the channel cannot be made', async () => {
    const calls = setup({
      onCreateChannel: async () => null,
      onCreateBrief: async () => 'doc1',
    });
    fill('input[aria-label="Project name"]', 'Website Redesign');
    click(checkbox('Create a project channel')!);
    click(checkbox('Create a project brief document')!);
    await create();
    expect(calls.project).toHaveLength(1);
    expect(q('[role="alert"]')!.textContent).toContain('The project was created, but the channel could not be made.');
    // The brief that did work is still linked, and the dialog stays open.
    expect(calls.updates).toEqual([['p1', { brief_document_id: 'doc1' }]]);
    expect(calls.open).toEqual([]);
    expect(button('Create project')).toBeUndefined();
    click(button('Open the project'));
    expect(calls.created[0]).toMatchObject({ id: 'p1', brief_document_id: 'doc1' });
    expect(calls.open).toEqual([false]);
  });

  it('treats a thrown error from a creator like a failure and still keeps the project', async () => {
    const calls = setup({
      onCreateBrief: async () => {
        throw new Error('boom');
      },
    });
    fill('input[aria-label="Project name"]', 'Website Redesign');
    click(checkbox('Create a project brief document')!);
    await create();
    expect(q('[role="alert"]')!.textContent).toContain('the brief document could not be made');
    expect(calls.project).toHaveLength(1);
  });
});

describe('New project dialog starter tasks', () => {
  it('creates the chosen template tasks inside the new project, skipping unticked ones', async () => {
    const calls = setup();
    fill('input[aria-label="Project name"]', 'Website Redesign');
    const website = Array.from(document.body.querySelectorAll('[role="radio"]')).find(b => b.textContent?.includes('Website') && b.textContent.includes('starter'))!;
    click(website);
    click(q<HTMLInputElement>('input[aria-label="Include Wireframes"]')!);
    await create();
    expect(calls.tasks).toHaveLength(5);
    expect(calls.tasks.every(task => (task as { project_id: string }).project_id === 'p1')).toBe(true);
    expect((calls.tasks as Array<{ title: string }>).map(t => t.title)).not.toContain('Wireframes');
  });

  it('does not create anything without a project name', () => {
    setup();
    expect(button('Create project').disabled).toBe(true);
  });
});
