// ---------------------------------------------------------------------------
// Workspace-authored skills, frontend side.
//
// The TYPES and the pure form logic for the app-side skill store. The
// authoritative rules live in shared/workspaceSkills.cjs, which the server runs
// on every write; everything here is a MIRROR whose only job is to tell the user
// what will happen BEFORE they press save. The server is still the one that
// decides — a check here that disagreed with the validator would produce a form
// that refuses something the store would have accepted, which is the worse of
// the two failure directions.
//
// Kept in .ts rather than importing the .cjs because the frontend bundle must
// not pull a CommonJS server module in; tests/unit/workspaceSkillsForm.test.ts
// asserts the mirrored constants still match their source.
// ---------------------------------------------------------------------------

/** A stored workspace skill, as the routes project it. */
export interface WorkspaceSkill {
  id: string;
  workspace_id: string;
  /** The lookup key: lowercase, digits, single hyphens. Never editable. */
  name: string;
  title: string;
  summary: string;
  body: string;
  revision: number;
  /** 'authored' | 'suggested' | 'imported'. Provenance, set by the server. */
  source: string;
  origin: Record<string, unknown>;
  created_by: string | null;
  created_at?: string;
  updated_at?: string;
}

/** What an authoring form sends. Deliberately the carried fields and no more. */
export interface WorkspaceSkillDraft {
  name?: string;
  title: string;
  summary: string;
  body: string;
}

/** Mirrors MAX_NAME in shared/workspaceSkills.cjs. */
export const SKILL_NAME_MAX = 64;
/** Mirrors MAX_TITLE. */
export const SKILL_TITLE_MAX = 120;
/** Mirrors MAX_SUMMARY, and the daemon's own MAX_SUMMARY_CHARS. */
export const SKILL_SUMMARY_MAX = 2000;
/** Mirrors MAX_BODY_BYTES, and SKILL_CONTENT_MAX_BYTES in server/skill-content.cjs. */
export const SKILL_BODY_MAX_BYTES = 64 * 1024;

/**
 * The same slugifier as the server's, so the name preview under the title field
 * is the name the row will actually get.
 *
 * Divergence here is not cosmetic: the preview is a PROMISE about a lookup key
 * that a template's `skills` array and every `read_skill` call will later use.
 */
export function slugifySkillName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/g, '');
}

/** UTF-8 byte length, because the body cap is in bytes and `.length` is not. */
export function skillBodyBytes(body: string): number {
  if (typeof TextEncoder === 'undefined') return String(body || '').length;
  return new TextEncoder().encode(String(body || '')).length;
}

export interface SkillFormProblem {
  field: 'title' | 'body' | 'summary';
  message: string;
}

/**
 * What is wrong with a draft, in the order a person would fix it.
 *
 * Returns [] when the server would accept it. This is the MIRROR described in
 * the header: it never refuses something the validator allows, and where it is
 * unsure it stays silent and lets the server answer.
 */
export function validateSkillDraft(draft: WorkspaceSkillDraft, existingNames: readonly string[] = []): SkillFormProblem[] {
  const problems: SkillFormProblem[] = [];
  const title = String(draft.title || '').trim();
  if (!title) {
    problems.push({ field: 'title', message: 'Give the skill a title.' });
  } else if (!slugifySkillName(title) && !slugifySkillName(draft.name || '')) {
    // A title of nothing but punctuation slugifies to '' and the server would
    // refuse it with "name could not be derived from the title". Said here in
    // words a person can act on.
    problems.push({ field: 'title', message: 'The title needs at least one letter or digit.' });
  }

  const name = slugifySkillName(draft.name || title);
  if (name && existingNames.some(existing => existing.toLowerCase() === name.toLowerCase())) {
    problems.push({ field: 'title', message: `A skill named "${name}" already exists here.` });
  }

  const body = String(draft.body || '');
  if (!body.trim()) {
    // The point of the store, restated at the point of authoring: a name with no
    // procedure is the exact thing `workspace_agents.skills` already does badly.
    problems.push({ field: 'body', message: 'Write the procedure. A skill with no body is just a name.' });
  } else if (skillBodyBytes(body) > SKILL_BODY_MAX_BYTES) {
    problems.push({ field: 'body', message: 'This is over 64 KB. The store would cut it short.' });
  }

  if (String(draft.summary || '').length > SKILL_SUMMARY_MAX) {
    problems.push({ field: 'summary', message: `Summaries are capped at ${SKILL_SUMMARY_MAX} characters.` });
  }
  return problems;
}

/** The first problem for one field, so an input can sit next to its own message. */
export function problemFor(problems: readonly SkillFormProblem[], field: SkillFormProblem['field']): string {
  return problems.find(problem => problem.field === field)?.message || '';
}

/** An empty draft. Named so "new skill" and "cancel" cannot drift apart. */
export function emptySkillDraft(): WorkspaceSkillDraft {
  return { title: '', summary: '', body: '' };
}

/** The draft that edits an existing skill. Never carries `name` — it is fixed. */
export function skillToDraft(skill: WorkspaceSkill): WorkspaceSkillDraft {
  return {
    title: skill.title || '',
    summary: skill.summary || '',
    body: skill.body || '',
  };
}

/** Human label for provenance. A closed map: an unknown source reads as authored. */
export function describeSkillProvenance(source: string): string {
  if (source === 'suggested') return 'Accepted from a conversation';
  if (source === 'imported') return 'Imported from another workspace';
  return 'Written here';
}
