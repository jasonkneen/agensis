import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_SUMMARY_MAX,
  SKILL_TITLE_MAX,
  emptySkillDraft,
  problemFor,
  skillBodyBytes,
  skillToDraft,
  slugifySkillName,
  validateSkillDraft,
  type WorkspaceSkill,
  type WorkspaceSkillDraft,
} from '../../lib/workspaceSkills';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

// ---------------------------------------------------------------------------
// Write a workspace skill.
//
// Four fields and no more, because the store carries four fields and no more —
// a form with a "base URL" or a "credential" box would be promising something
// `workspace_skills` has no column for. The absence is the feature (see the DDL
// comment): a skill carries prose, never authority.
//
// THE NAME IS SHOWN, NOT TYPED. It is derived from the title by the same
// slugifier the server uses, and shown live underneath, because it is the
// lookup key `read_skill` resolves and the value a template's `skills` array
// holds — so somebody typing "Security Review" should see `security-review`
// appear before they save, not discover it afterwards. On an EXISTING skill the
// name is fixed and stated as such: renaming would silently break every
// reference to it at once.
// ---------------------------------------------------------------------------

interface WorkspaceSkillEditorProps {
  /** The skill being edited, or null to author a new one. */
  skill: WorkspaceSkill | null;
  /** Names already taken, so a collision is caught before the round trip. */
  existingNames: readonly string[];
  onCancel: () => void;
  onSave: (draft: WorkspaceSkillDraft) => Promise<{ error: string }>;
}

export function WorkspaceSkillEditor({ skill, existingNames, onCancel, onSave }: WorkspaceSkillEditorProps) {
  const [draft, setDraft] = useState<WorkspaceSkillDraft>(() => (skill ? skillToDraft(skill) : emptySkillDraft()));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const [touched, setTouched] = useState(false);

  // Re-seed when the target changes: the same editor instance is reused for
  // "edit this one" and then "edit that one", and carrying the previous body
  // over would offer to save one skill's text onto another.
  useEffect(() => {
    setDraft(skill ? skillToDraft(skill) : emptySkillDraft());
    setServerError('');
    setTouched(false);
  }, [skill]);

  // An existing skill's own name must not count as a collision against itself.
  const takenNames = useMemo(
    () => existingNames.filter(name => !skill || name.toLowerCase() !== skill.name.toLowerCase()),
    [existingNames, skill],
  );

  const problems = useMemo(() => validateSkillDraft(draft, takenNames), [draft, takenNames]);
  const previewName = skill?.name || slugifySkillName(draft.title);
  const bodyBytes = skillBodyBytes(draft.body);

  const submit = async () => {
    setTouched(true);
    if (problems.length > 0 || saving) return;
    setSaving(true);
    setServerError('');
    const result = await onSave(draft);
    setSaving(false);
    // The server is the authority (see the header of lib/workspaceSkills.ts), so
    // its message is shown verbatim rather than replaced — it is the only place
    // the caller learns WHICH rule they hit.
    if (result.error) setServerError(result.error);
  };

  const show = (field: 'title' | 'body' | 'summary') => (touched ? problemFor(problems, field) : '');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <label htmlFor="skill-title" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Title
          </label>
          <Input
            id="skill-title"
            value={draft.title}
            maxLength={SKILL_TITLE_MAX}
            onChange={e => setDraft(prev => ({ ...prev, title: e.target.value }))}
            onBlur={() => setTouched(true)}
            placeholder="Security review"
            aria-invalid={show('title') ? true : undefined}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {skill
              ? <>Stored as <code className="font-mono">{previewName}</code>. The name is fixed — renaming would break every reference to it.</>
              : previewName
                ? <>Agents will call it <code className="font-mono">{previewName}</code>.</>
                : 'The name agents use is derived from the title.'}
          </p>
          {show('title') && <p className="mt-1 text-[11px] text-destructive">{show('title')}</p>}
        </div>

        <div>
          <label htmlFor="skill-summary" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Summary
          </label>
          <Input
            id="skill-summary"
            value={draft.summary}
            maxLength={SKILL_SUMMARY_MAX}
            onChange={e => setDraft(prev => ({ ...prev, summary: e.target.value }))}
            placeholder="When to reach for this, in one line."
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            One line. This is what an agent sees when it lists skills, so it decides whether the skill gets read at all.
          </p>
          {show('summary') && <p className="mt-1 text-[11px] text-destructive">{show('summary')}</p>}
        </div>

        <div className="flex min-h-0 flex-col">
          <label htmlFor="skill-body" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Procedure
          </label>
          <Textarea
            id="skill-body"
            value={draft.body}
            onChange={e => setDraft(prev => ({ ...prev, body: e.target.value }))}
            onBlur={() => setTouched(true)}
            placeholder={'## Steps\n\n1. …'}
            className="min-h-[16rem] font-mono text-xs"
            aria-invalid={show('body') ? true : undefined}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            {/* Stated plainly rather than implied by a fence icon: this text is
                handed to agents as untrusted reference data, and a person
                writing it should know it will not be obeyed as an order. */}
            <p className="text-[11px] text-muted-foreground">
              Markdown. Agents read this as reference material, not as instructions they must obey.
            </p>
            <p className={`shrink-0 text-[11px] ${bodyBytes > SKILL_BODY_MAX_BYTES ? 'text-destructive' : 'text-muted-foreground'}`}>
              {(bodyBytes / 1024).toFixed(1)} / 64 KB
            </p>
          </div>
          {show('body') && <p className="mt-1 text-[11px] text-destructive">{show('body')}</p>}
        </div>

        {serverError && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{serverError}</span>
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="button" size="sm" onClick={() => void submit()} disabled={saving}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {skill ? 'Save changes' : 'Create skill'}
        </Button>
      </div>
    </div>
  );
}
