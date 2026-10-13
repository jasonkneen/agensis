import { useState } from 'react';
import { X } from 'lucide-react';
import { Input } from '@agensis/ui/components/input';

// Labels and estimate for the task editor, from the approved task drawer mock.
// Labels are free-form tags; the label "milestone" also makes a task a milestone
// on the Timeline and the project page.

/** Chips for a task's labels, with an input to add one and a remove button on each. */
export function TaskLabelEditor({ labels, onChange }: { labels: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const label = draft.trim().toLowerCase();
    setDraft('');
    if (!label || labels.includes(label)) return;
    onChange([...labels, label]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Labels">
      {labels.map(label => (
        <span key={label} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {label}
          <button
            type="button"
            aria-label={`Remove label ${label}`}
            className="hover:text-foreground"
            onClick={() => onChange(labels.filter(item => item !== label))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={labels.length ? 'Add label' : 'Add a label, e.g. design'}
        aria-label="Add label"
        className="h-6 w-36 text-xs"
      />
    </div>
  );
}

/** A short free-text estimate such as "2d" or "4h". Saves on Enter or blur; empty clears it. */
export function TaskEstimateField({ value, onCommit }: { value: string | null | undefined; onCommit: (next: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? '');

  const commit = () => {
    const next = draft.trim();
    if (next === (value ?? '')) return;
    onCommit(next || null);
  };

  return (
    <Input
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      onBlur={commit}
      placeholder="Estimate, e.g. 2d"
      aria-label="Estimate"
      className="h-8 text-sm"
    />
  );
}
