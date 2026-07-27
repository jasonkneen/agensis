import { useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  applySkillFieldInput,
  applySkillFieldKey,
  parseSkillTokens,
  removeSkillTokenAt,
  serializeSkillTokens,
  skillMenuOptions,
  type SkillFieldState,
  type SkillSuggestion,
} from '../../lib/skillTokens';

// ---------------------------------------------------------------------------
// The Skills field on an agent: chips with an x, and a menu that narrows as you
// type. It is a CONTROLLED string field — the same comma-joined `value` the
// plain <Input> took, in and out — so the form's save path, its baseline, and
// the sparse diff that decides what gets written are all untouched. Every
// decision it makes (parse, dedupe, rank, what a key does) lives in
// lib/skillTokens.ts where a test can hold it still; this file is the drawing.
//
// The x is a lucide icon, never a glyph: a literal cross renders in the
// platform's emoji font. Same house rule as everywhere else.
// ---------------------------------------------------------------------------

export function SkillChipsInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder = 'Type a skill, or pick one below',
}: {
  id?: string;
  /** Comma-joined, exactly as the form holds it. */
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly SkillSuggestion[];
  placeholder?: string;
}) {
  const tokens = useMemo(() => parseSkillTokens(value), [value]);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = useMemo(
    () => skillMenuOptions(suggestions, draft, tokens),
    [suggestions, draft, tokens],
  );
  const state: SkillFieldState = { tokens, draft, activeIndex, open };

  // One place the field's state lands. Tokens are compared by REFERENCE because
  // the pure helpers return the same array when a change was a no-op (a
  // duplicate, an empty token) — so a no-op never fires onChange, and an
  // untouched field never appears in the save patch.
  const commit = (next: SkillFieldState) => {
    setDraft(next.draft);
    setOpen(next.open);
    setActiveIndex(next.activeIndex);
    if (next.tokens !== tokens) onChange(serializeSkillTokens(next.tokens));
  };

  const removeAt = (index: number) => {
    const next = removeSkillTokenAt(tokens, index);
    if (next !== tokens) onChange(serializeSkillTokens(next));
    inputRef.current?.focus();
  };

  const pick = (optionValue: string) => {
    commit(applySkillFieldKey({ ...state, open: false, activeIndex: -1 }, 'Enter', [
      { kind: 'custom', value: optionValue, label: optionValue, detail: '' },
    ]).state);
    inputRef.current?.focus();
  };

  const activeOptionId = open && activeIndex >= 0 && activeIndex < options.length
    ? `${listId}-option-${activeIndex}`
    : undefined;

  return (
    <div
      className="relative"
      onBlur={event => {
        // Only close when focus actually leaves the field — moving between the
        // input and a menu row must not tear the menu down mid-click.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOpen(false);
        setActiveIndex(-1);
      }}
    >
      <div
        className={cn(
          'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 text-base transition-colors md:text-sm dark:bg-input/30',
          'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        )}
        onMouseDown={event => {
          // Clicking the padding focuses the input, like a real text field —
          // but a click on a chip's x is that button's, not ours.
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          inputRef.current?.focus();
          setOpen(true);
        }}
      >
        {tokens.map((token, index) => (
          <span
            key={`${token}:${index}`}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/60 py-0.5 pl-2 pr-1 text-xs font-medium text-foreground"
          >
            <span className="truncate">{token}</span>
            <button
              type="button"
              onClick={() => removeAt(index)}
              aria-label={`Remove ${token}`}
              className="grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          value={draft}
          placeholder={tokens.length === 0 ? placeholder : ''}
          onChange={event => commit(applySkillFieldInput(state, event.target.value))}
          onFocus={() => setOpen(true)}
          onKeyDown={event => {
            const result = applySkillFieldKey(state, event.key, options);
            if (!result.handled) return;
            event.preventDefault();
            commit(result.state);
          }}
          className="h-6 min-w-24 flex-1 border-0 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
        />
      </div>

      {open && options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
        >
          {options.map((option, index) => (
            <li key={`${option.kind}:${option.value}`}>
              <button
                type="button"
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // mousedown, not click: the input's blur would otherwise close
                // the menu before the click ever lands.
                onMouseDown={event => {
                  event.preventDefault();
                  pick(option.value);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
                  index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {option.kind === 'custom' ? `Add "${option.label}"` : option.label}
                </span>
                {option.detail && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{option.detail}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
