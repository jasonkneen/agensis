import { useState } from 'react';
import { Brain, Check, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import type { MemoryFact } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';

interface MemorySectionProps {
  facts: MemoryFact[];
  categories: string[];
  onAdd: (fact: string, category: string) => void;
  onUpdate: (id: string, fact: string, category: string) => void;
  onDelete: (id: string) => void;
}

export function MemorySection({ facts, categories, onAdd, onUpdate, onDelete }: MemorySectionProps) {
  const [newFact, setNewFact] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFact, setEditFact] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  const allCategories = [...new Set(['general', 'about me', 'preferences', 'work', 'goals', 'notes', ...categories])];
  const categoriesInUse = allCategories.filter(category => facts.some(fact => fact.category === category));
  const filteredFacts = filterCategory ? facts.filter(fact => fact.category === filterCategory) : facts;

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
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="shrink-0 border-b border-border bg-card p-4">
        <div className="flex items-start gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Brain className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Memory</h2>
            <p className="text-sm text-muted-foreground">
              {facts.length} persistent fact{facts.length === 1 ? '' : 's'} stored
            </p>
          </div>
          <Button type="button" size="sm" onClick={() => setAddingNew(true)}>
            <Plus data-icon="inline-start" />
            Add Memory
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Badge asChild variant={!filterCategory ? 'default' : 'outline'} className="memory-filter-chip cursor-pointer">
            <button type="button" onClick={() => setFilterCategory(null)}>
              All
            </button>
          </Badge>
          {categoriesInUse.map(category => (
            <Badge
              key={category}
              asChild
              variant={filterCategory === category ? 'default' : 'outline'}
              className="memory-filter-chip cursor-pointer"
            >
              <button
                type="button"
                onClick={() => setFilterCategory(filterCategory === category ? null : category)}
              >
                <Tag data-icon="inline-start" />
                {category}
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-4">
          {addingNew && (
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
          )}

          {filteredFacts.length === 0 ? (
            <Empty className="min-h-80 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Brain />
                </EmptyMedia>
                <EmptyTitle>
                  {filterCategory ? `No facts in "${filterCategory}"` : 'No memories stored yet'}
                </EmptyTitle>
                <EmptyDescription>
                  {filterCategory ? 'Choose another category or add a new fact.' : 'Add a memory to keep durable workspace context.'}
                </EmptyDescription>
              </EmptyHeader>
              {!filterCategory && (
                <Button type="button" variant="outline" size="sm" onClick={() => setAddingNew(true)}>
                  <Plus data-icon="inline-start" />
                  Add Memory
                </Button>
              )}
            </Empty>
          ) : (
            <ItemGroup className="gap-2">
              {filteredFacts.map(fact => (
                editingId === fact.id ? (
                  <Item key={fact.id} variant="outline" className="items-stretch">
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
                  <Item key={fact.id} variant="outline">
                    <ItemMedia variant="icon" className="size-9 rounded-xl bg-muted [&_svg]:size-5">
                      <Brain />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="max-w-full whitespace-normal">{fact.fact}</ItemTitle>
                      <ItemDescription>
                        {new Date(fact.updated_at).toLocaleDateString()}
                      </ItemDescription>
                    </ItemContent>
                    <Badge variant="outline">{fact.category}</Badge>
                    <ItemActions>
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
