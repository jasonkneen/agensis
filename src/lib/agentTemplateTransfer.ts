import type { StoredAgentTemplate } from './agentTemplates';

// ---------------------------------------------------------------------------
// Exporting a persona template to a file, and reading one back.
//
// WHAT MAKES THIS SAFE IS NOT IN THIS FILE. `workspace_agent_templates` has no
// column for permission_mode, sandbox config, connect tokens or identity, so a
// template carries prose, requests and descriptive intent, never authority —
// and a file built from one cannot carry what the row could not hold. There is
// nothing here to strip because there is nothing there to strip.
//
// The consequence for this file is a rule, not a filter: BUILD THE BODY FROM
// EXPORT_FIELDS, never by spreading the stored row. The row carries `id`,
// `workspace_id` and `created_by`; a spread would put one workspace's
// identifiers into a file meant to travel between workspaces.
//
// And do NOT add a privilege-bearing field to make the file "complete". The
// incompleteness is the point.
//
// The envelope is validated on the SERVER (readTemplateExport in
// shared/agentTemplates.cjs) — this file's parse is for the message shown
// before a request is made, not a security boundary. The import route runs the
// same validator whatever the client sends.
// ---------------------------------------------------------------------------

/**
 * The fields a file carries. MUST equal CARRIED_FIELDS in
 * shared/agentTemplates.cjs — pinned by a test that loads that module and
 * compares, so a field added server-side cannot be silently dropped from every
 * export.
 */
export const EXPORT_FIELDS = [
  'slug', 'name', 'category', 'description', 'handleHint',
  'systemPrompt', 'soul', 'instructions', 'avatar', 'accentColor', 'model',
  'tools', 'skills', 'runMode', 'runtime', 'purpose', 'resourceFacets',
] as const;

export const TEMPLATE_EXPORT_FORMAT = 'agensis.agent-template';
export const TEMPLATE_EXPORT_VERSION = 1;

export interface TemplateExportEnvelope {
  format: string;
  formatVersion: number;
  exportedAt: string;
  template: Record<string, unknown>;
}

/** The file's body. Rebuilt field by field; never a spread of the stored row. */
export function buildTemplateExport(
  template: StoredAgentTemplate,
  now: Date = new Date(),
): TemplateExportEnvelope {
  const source = template as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const field of EXPORT_FIELDS) {
    const value = source[field];
    body[field] = Array.isArray(value)
      ? [...value]
      : (field === 'tools' || field === 'skills' || field === 'resourceFacets' ? [] : (value ?? ''));
  }
  return {
    format: TEMPLATE_EXPORT_FORMAT,
    formatVersion: TEMPLATE_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    template: body,
  };
}

/** A filename a person can recognise in their downloads folder. */
export function templateExportFilename(template: Pick<StoredAgentTemplate, 'slug' | 'name'>): string {
  const base = String(template.slug || template.name || 'agent-template')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'agent-template'}.agent.json`;
}

/**
 * Read a dropped or pasted file well enough to say something useful about it
 * BEFORE a request is made.
 *
 * Deliberately shallow. It checks that the text is JSON and that it looks like
 * one of ours; it does not re-implement the validator, because two validators
 * drift and only one of them is the one that runs. Everything that decides
 * whether the template is acceptable happens server-side.
 */
export function parseTemplateExport(text: string): { ok: true; envelope: unknown } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'That file does not contain an agent template.' };
  }
  const record = parsed as Record<string, unknown>;
  const hasEnvelope = 'format' in record || 'template' in record;
  if (hasEnvelope && String(record.format || '') !== TEMPLATE_EXPORT_FORMAT) {
    return { ok: false, error: 'That file is not an agensis agent template.' };
  }
  return { ok: true, envelope: parsed };
}

/**
 * What a file can and cannot bring with it, said where someone is about to
 * import one.
 *
 * The reassurance is the load-bearing half. A file from outside the workspace
 * reasonably provokes "what is this about to give it access to", and the honest
 * answer is nothing — but only the SECOND sentence is a warning, and it is the
 * one people actually need: the prose is unread text that an agent here will
 * speak as its own instructions.
 */
export const TEMPLATE_IMPORT_NOTE =
  'A template file carries wording, requested tools and skills, and a descriptive '
  + 'collaborator or resource label. It cannot carry a permission mode, a sandbox '
  + 'setting, a token or an identity, because a template has nowhere to keep them. '
  + 'Read the prompt before you use it: it becomes the instructions an agent here follows.';
