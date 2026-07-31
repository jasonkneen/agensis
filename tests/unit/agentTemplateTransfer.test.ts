// ============================================================================
// tests/unit/agentTemplateTransfer.test.ts
// ----------------------------------------------------------------------------
// The browser half of exporting a persona template.
//
// The load-bearing case is the FIRST one: EXPORT_FIELDS here and CARRIED_FIELDS
// in shared/agentTemplates.cjs are two hand-written lists of the same thing, in
// two languages, and nothing but this test connects them. Without it, a field
// added server-side is simply absent from every file the browser writes, and
// the loss is invisible — the export succeeds, the import succeeds, and the
// persona quietly reads differently on the other side.
//
// MUST live under tests/unit/**/*.test.ts or vitest never runs it.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  EXPORT_FIELDS,
  TEMPLATE_EXPORT_FORMAT,
  TEMPLATE_EXPORT_VERSION,
  TEMPLATE_IMPORT_NOTE,
  buildTemplateExport,
  parseTemplateExport,
  templateExportFilename,
} from '../../src/lib/agentTemplateTransfer';
import type { StoredAgentTemplate } from '../../src/lib/agentTemplates';

const require_ = createRequire(import.meta.url);
const shared = require_('../../shared/agentTemplates.cjs') as {
  CARRIED_FIELDS: string[];
  NEVER_CARRIED_FIELDS: string[];
  TEMPLATE_EXPORT_FORMAT: string;
  TEMPLATE_EXPORT_VERSION: number;
};

function stored(overrides: Partial<StoredAgentTemplate> = {}): StoredAgentTemplate {
  return {
    id: 'tpl-1',
    workspace_id: 'ws-1',
    slug: 'ops-runner',
    name: 'Ops Runner',
    category: 'Saved',
    description: 'Runs operational tasks.',
    handleHint: 'ops-runner',
    systemPrompt: 'You are an operations agent.',
    soul: 'Careful and terse.',
    instructions: 'Ask before destructive things.',
    tools: ['Bash'],
    skills: ['deploy'],
    purpose: 'collaborator',
    resourceFacets: [],
    model: 'auto',
    runMode: 'daemon',
    runtime: 'claude',
    avatar: '',
    accentColor: '#ffffff',
    revision: 4,
    source: 'derived',
    origin: {},
    created_by: 'user-1',
    ...overrides,
  };
}

describe('the two field lists cannot drift', () => {
  it('EXPORT_FIELDS equals the server CARRIED_FIELDS', () => {
    // MUTATION: remove any entry from EXPORT_FIELDS -> this fails, and so does
    // the round trip through the server's validator.
    expect([...EXPORT_FIELDS].sort()).toEqual([...shared.CARRIED_FIELDS].sort());
  });

  it('the envelope constants agree across the two languages', () => {
    expect(TEMPLATE_EXPORT_FORMAT).toBe(shared.TEMPLATE_EXPORT_FORMAT);
    expect(TEMPLATE_EXPORT_VERSION).toBe(shared.TEMPLATE_EXPORT_VERSION);
  });

  it('no never-carried field has crept into the export list', () => {
    for (const field of shared.NEVER_CARRIED_FIELDS) {
      expect(EXPORT_FIELDS as readonly string[]).not.toContain(field);
    }
  });
});

describe('buildTemplateExport', () => {
  it('rebuilds the body and leaves the row identifiers behind', () => {
    // A spread would put one workspace's id, and the author's user id, into a
    // file whose entire purpose is to travel to a different workspace.
    const file = buildTemplateExport(stored(), new Date('2026-07-30T00:00:00.000Z'));
    expect(Object.keys(file.template).sort()).toEqual([...EXPORT_FIELDS].sort());
    const text = JSON.stringify(file);
    expect(text).not.toContain('ws-1');
    expect(text).not.toContain('user-1');
    expect(text).not.toContain('tpl-1');
    expect(file.exportedAt).toBe('2026-07-30T00:00:00.000Z');
  });

  it('copies lists rather than aliasing them', () => {
    // The stored template stays in React state. A shared array reference would
    // let a later edit of the export mutate the gallery's copy.
    const source = stored();
    const file = buildTemplateExport(source);
    (file.template.tools as string[]).push('Write');
    (file.template.resourceFacets as string[]).push('code');
    expect(source.tools).toEqual(['Bash']);
    expect(source.resourceFacets).toEqual([]);
  });

  it('fills a missing field rather than emitting undefined', () => {
    // JSON.stringify DROPS an undefined value, so the field would be absent
    // from the file entirely and the reason would be invisible in the output.
    const file = buildTemplateExport(stored({ soul: undefined as never }));
    expect(file.template.soul).toBe('');
    expect(JSON.stringify(file)).toContain('"soul"');
    expect(buildTemplateExport(stored({ resourceFacets: undefined as never })).template.resourceFacets).toEqual([]);
  });
});

describe('templateExportFilename', () => {
  it('is recognisable in a downloads folder and safe as a filename', () => {
    expect(templateExportFilename({ slug: 'ops-runner', name: 'Ops Runner' })).toBe('ops-runner.agent.json');
    expect(templateExportFilename({ slug: '', name: 'Ops / Runner!' })).toBe('ops-runner.agent.json');
    // Nothing usable in either field still produces a valid name rather than
    // a file called ".agent.json", which is hidden on macOS and Linux.
    expect(templateExportFilename({ slug: '', name: '///' })).toBe('agent-template.agent.json');
  });
});

describe('parseTemplateExport', () => {
  it('names the two ways a file is wrong before any request is made', () => {
    expect(parseTemplateExport('not json')).toEqual({ ok: false, error: 'That file is not valid JSON.' });
    expect(parseTemplateExport('[]').ok).toBe(false);
    const foreign = parseTemplateExport(JSON.stringify({ format: 'someone-else.persona', template: {} }));
    expect(foreign).toEqual({ ok: false, error: 'That file is not an agensis agent template.' });
  });

  it('passes a well-formed envelope through UNCHANGED for the server to judge', () => {
    // This parse is a courtesy, not a boundary. It must not normalise, strip or
    // repair anything — the server runs the real validator on whatever arrives,
    // and a client that pre-cleaned the payload would hide the refusal that
    // names a privileged key.
    const envelope = {
      format: TEMPLATE_EXPORT_FORMAT,
      formatVersion: 1,
      template: { name: 'Ops', permissionMode: 'yolo' },
    };
    const result = parseTemplateExport(JSON.stringify(envelope));
    expect(result.ok).toBe(true);
    expect(result.ok && result.envelope).toEqual(envelope);
  });

  it('accepts a bare template object, because somebody will paste one', () => {
    const result = parseTemplateExport(JSON.stringify({ name: 'Ops', systemPrompt: 'hi' }));
    expect(result.ok).toBe(true);
  });
});

describe('the import copy', () => {
  it('says what a file cannot carry AND that the prose still needs reading', () => {
    // Both halves. The first answers "what is this about to let in" (nothing);
    // the second is the actual warning, and the one people need.
    expect(TEMPLATE_IMPORT_NOTE).toMatch(/cannot carry a permission mode/i);
    expect(TEMPLATE_IMPORT_NOTE).toMatch(/read the prompt/i);
  });
});
