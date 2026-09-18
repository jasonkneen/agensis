import { useState } from 'react';
import { Brain, Check, FileText, Lightbulb, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Document, MemoryFact, WorkspaceAgent } from '../../types';
import { AgentMemoryBrowser } from './AgentMemoryBrowser';
import { SuggestionsPanel } from './SuggestionsPanel';
import { Badge } from '@agensis/ui/components/badge';
import { Button } from '@agensis/ui/components/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@agensis/ui/components/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@agensis/ui/components/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@agensis/ui/components/item';
import {
  NativeSelect,
  NativeSelectOption,
} from '@agensis/ui/components/native-select';
import { ScrollArea } from '@agensis/ui/components/scroll-area';
import { Textarea } from '@agensis/ui/components/textarea';
import { viewPreferenceKey, type PreferenceCodec } from '../../lib/viewPreferences';
import { usePersistedPreference } from '../../hooks/usePersistedPreference';
import { WINDOW_SHELL } from '@/components/common/presentation';

// The one filter here whose options are user-defined, so there is no closed set
// to validate against on read: anything non-empty parses, and `activeCategory`
// in the component does the "is this still a real category" check. An empty
// string is how "no filter" is stored, and readPreference already turns that
// back into the default.
const CATEGORY_FILTER_PREF: PreferenceCodec<string | null> = {
  parse: raw => (raw.trim() ? raw : null),
  serialize: value => value ?? '',
};

interface MemorySectionProps {
  facts: MemoryFact[];
  categories: string[];
  onAdd: (fact: string, category: string) => void;
  onUpdate: (id: string, fact: string, category: string) => void;
  onDelete: (id: string) => void;
  workspaceId: string;
  agents: WorkspaceAgent[];
  userId: string;
  userEmail: string;
  /** Only used to warn that a suggestion duplicates a page you already have. */
  documents: Document[];
}

export function MemorySection({ facts, categories, onAdd, onUpdate, onDelete, workspaceId, agents, userId, userEmail, documents }: MemorySectionProps) {
  // Suggestions live beside memory rather than in their own window: they are
  // proposals ABOUT what to remember, and accepting one writes into the list on
  // the first tab. Reviewing them a click away from what they would join is what
  // makes "do we already know this?" answerable.
  const [tab, setTab] = useState<'facts' | 'files' | 'suggestions'>('facts');
  const [newFact, setNewFact] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFact, setEditFact] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [filterCategory, setFilterCategory] = usePersistedPreference(
    viewPreferenceKey('memory.category-filter', workspaceId), CATEGORY_FILTER_PREF, null as string | null,
  );
  const [addingNew, setAddingNew] = useState(false);

  const allCategories = [...new Set(['general', 'about me', 'preferences', 'work', 'goals', 'notes', ...categories])];
  const categoriesInUse = allCategories.filter(category => facts.some(fact => fact.category === category));
  // Categories are user-defined, so unlike the app's other filters the stored
  // one cannot be validated on read — the valid set only exists once the facts
  // have loaded. Derived here instead: a remembered category that no longer has
  // any facts (renamed, or its last fact deleted) falls back to All rather than
  // opening the window on an empty list with no chip lit to explain it.
  const activeCategory = filterCategory && categoriesInUse.includes(filterCategory) ? filterCategory : null;
  const filteredFacts = activeCategory ? facts.filter(fact => fact.category === activeCategory) : facts;

  const handleAdd = () => {
    if (!newFact.trim()) return;
    onAdd(newFact.trim(), newCategory);
    setNewFact('');
    setNewCategory('general');
    setAddingNew(false);
  };

  const handleEdit = (fact: MemoryFact) => {
    setEditingId(fact.id);
    setEditFact(fact.fact);
    setEditCategory(fact.category);
  };

  const handleSaveEdit = () => {
    if (!editingId || !editFact.trim()) return;
    onUpdate(editingId, editFact.trim(), editCategory);
    setEditingId(null);
  };

  return (
    <div className={WINDOW_SHELL}>
      <div className="flex h-9 shrink-0 gap-1 border-b border-border bg-card px-2">
        <button
          type="button"
          onClick={() => setTab('facts')}
          className={`inline-flex items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium ${tab === 'facts' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          <Brain className="size-4" />
          Team facts
        </button>
        <button
          type="button"
          onClick={() => setTab('files')}
          className={`inline-flex items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium ${tab === 'files' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          <FileText className="size-4" />
          Agent files
        </button>
        <button
          type="button"
          onClick={() => setTab('suggestions')}
          className={`inline-flex items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium ${tab === 'suggestions' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          <Lightbulb className="size-4" />
          Suggestions
        </button>
      </div>

      {tab === 'suggestions' ? (
        <div className="min-h-0 flex-1">
          <SuggestionsPanel workspaceId={workspaceId} facts={facts} documents={documents} />
        </div>
      ) : tab === 'files' ? (
        <div className="min-h-0 flex-1">
          <AgentMemoryBrowser workspaceId={workspaceId} agents={agents} userId={userId} userEmail={userEmail} />
        </div>
      ) : (
      <>
      <div className="shrink-0 border-b border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="ui-panel-title">Memory</h2>
            <p className="ui-meta">
              {facts.length} persistent fact{facts.length === 1 ? '' : 's'} stored
            </p>
          </div>
          <Button type="button" size="xs" onClick={() => setAddingNew(true)}>
            <Plus data-icon="inline-start" />
            Add Memory
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          <Badge asChild variant={!activeCategory ? 'secondary' : 'ghost'} className="memory-filter-chip cursor-pointer">
            <button data-flat-control type="button" aria-pressed={!activeCategory} onClick={() => setFilterCategory(null)}>
              All
            </button>
          </Badge>
          {categoriesInUse.map(category => (
            <Badge
              key={category}
              asChild
              variant={activeCategory === category ? 'secondary' : 'ghost'}
              className="memory-filter-chip cursor-pointer"
            >
              <button
                data-flat-control
                type="button"
                aria-pressed={activeCategory === category}
                onClick={() => setFilterCategory(activeCategory === category ? null : category)}
              >
                {category}
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col">
          {addingNew && (
            <div className="border-b border-border/60 p-3">
              <MemoryForm
                fact={newFact}
                category={newCategory}
                categories={allCategories}
                onFactChange={setNewFact}
                onCategoryChange={setNewCategory}
                onCancel={() => setAddingNew(false)}
                onSubmit={handleAdd}
                submitLabel="Save"
              />
            </div>
          )}

          {filteredFacts.length === 0 ? (
            <Empty className="min-h-80 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Brain />
                </EmptyMedia>
                <EmptyTitle>
                  {activeCategory ? `No facts in "${activeCategory}"` : 'No memories stored yet'}
                </EmptyTitle>
                <EmptyDescription>
                  {activeCategory ? 'Choose another category or add a new fact.' : 'Add a memory to keep durable workspace context.'}
                </EmptyDescription>
              </EmptyHeader>
              {!activeCategory && (
                <Button type="button" variant="outline" size="sm" onClick={() => setAddingNew(true)}>
                  <Plus data-icon="inline-start" />
                  Add Memory
                </Button>
              )}
            </Empty>
          ) : (
            <ItemGroup className="gap-0 border-b border-border/60">
              {filteredFacts.map(fact => (
                editingId === fact.id ? (
                  <Item key={fact.id} data-flat-control variant="default" size="xs" className="memory-list-row items-stretch rounded-none border-x-0 border-t-0 border-b border-border/60 p-3">
                    <ItemContent>
                      <MemoryForm
                        fact={editFact}
                        category={editCategory}
                        categories={allCategories}
                        onFactChange={setEditFact}
                        onCategoryChange={setEditCategory}
                        onCancel={() => setEditingId(null)}
                        onSubmit={handleSaveEdit}
                        submitLabel="Update"
                      />
                    </ItemContent>
                  </Item>
                ) : (
                  <Item key={fact.id} data-flat-control variant="default" size="xs" className="memory-list-row rounded-none border-x-0 border-t-0 border-b border-border/60 px-3 py-2.5">
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full whitespace-normal text-sm font-normal leading-relaxed">{fact.fact}</ItemTitle>
                      <ItemDescription className="text-xs">
                        {new Date(fact.updated_at).toLocaleDateString()}
                      </ItemDescription>
                    </ItemContent>
                    <Badge data-flat-control variant="secondary" className="h-5 rounded-md px-1.5 text-xs font-medium normal-case tracking-normal shadow-none">{fact.category}</Badge>
                    <ItemActions className="gap-0.5 opacity-60 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100">
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => handleEdit(fact)} aria-label="Edit memory">
                        <Pencil className="size-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => onDelete(fact.id)} aria-label="Delete memory">
                        <Trash2 className="size-4" />
                      </Button>
                    </ItemActions>
                  </Item>
                )
              ))}
            </ItemGroup>
          )}
        </div>
      </ScrollArea>
      </>
      )}
    </div>
  );
}

function MemoryForm({
  fact,
  category,
  categories,
  onFactChange,
  onCategoryChange,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  fact: string;
  category: string;
  categories: string[];
  onFactChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <FieldGroup className="gap-3">
      <Field>
        <FieldLabel htmlFor="memory-fact">Fact</FieldLabel>
        <Textarea
          id="memory-fact"
          autoFocus
          placeholder="What should agensis remember?"
          value={fact}
          onChange={e => onFactChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={3}
        />
      </Field>
      <div className="flex items-center gap-2">
        <NativeSelect
          value={category}
          onChange={e => onCategoryChange(e.target.value)}
          size="sm"
          aria-label="Memory category"
        >
          {categories.map(item => (
            <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>
          ))}
        </NativeSelect>
        <div className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          <X data-icon="inline-start" />
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onSubmit} disabled={!fact.trim()}>
          <Check data-icon="inline-start" />
          {submitLabel}
        </Button>
      </div>
    </FieldGroup>
  );
}
