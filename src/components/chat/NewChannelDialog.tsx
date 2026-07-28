import { useMemo, useState } from 'react';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  CHANNEL_TEMPLATES,
  CHANNEL_TEMPLATE_CATEGORIES,
  canCreateFromTemplate,
  channelDraftFromTemplate,
  filterChannelTemplates,
  type ChannelTemplate,
} from '@/lib/channelTemplates';

// ---------------------------------------------------------------------------
// The "+" beside Channels opens this instead of silently creating "New Channel".
//
// Deliberately the same shape as the agent create gallery (AgentsWindowContent's
// `createStep === 'choose'` branch): search, category tabs, a grid of cards,
// and picking one PREFILLS rather than creates. Matching that layout is the
// point — a second gallery that looked different would read as a different
// kind of thing.
//
// Bridge templates (Telegram, Signal, WhatsApp, OpenClaw) are shown but cannot
// be created: the transport does not exist yet. They open a setup PREVIEW that
// says so. A card that created a dead channel would be worse than no card.
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Create a channel from the template's prefilled fields. */
  onCreate: (draft: ReturnType<typeof channelDraftFromTemplate>) => void | Promise<void>;
}

export function NewChannelDialog({ open, onOpenChange, onCreate }: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [preview, setPreview] = useState<ChannelTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(
    () => filterChannelTemplates(CHANNEL_TEMPLATES, category, query),
    [category, query],
  );

  const reset = () => { setQuery(''); setCategory('All'); setPreview(null); setCreating(false); };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const pick = async (tpl: ChannelTemplate) => {
    // A bridge opens its setup preview instead of creating anything.
    if (!canCreateFromTemplate(tpl)) { setPreview(tpl); return; }
    setCreating(true);
    try {
      await onCreate(channelDraftFromTemplate(tpl));
      handleOpenChange(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* `sm:` matters: DialogContent's base is `sm:max-w-sm`, and tailwind-merge
          keeps an unprefixed `max-w-3xl` ALONGSIDE it rather than replacing it —
          so above 640px the base media query won and this dialog rendered at
          384px, collapsing the card grid to a single column. */}
      <DialogContent className="sm:max-w-3xl">
        {preview ? (
          <BridgePreview template={preview} onBack={() => setPreview(null)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New channel</DialogTitle>
              <DialogDescription>
                Pick a starting point. Nothing is created until you choose one, and
                everything a template sets can be changed afterwards in Edit channel.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-2">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search templates"
                aria-label="Search channel templates"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {CHANNEL_TEMPLATE_CATEGORIES.map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  aria-pressed={category === cat}
                  className={cn(
                    'control-outer-ring rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                    category === cat
                      ? 'border-primary/60 bg-primary/15 text-foreground'
                      : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No templates match that search.
              </div>
            ) : (
              <div className="grid max-h-[52vh] gap-3 overflow-y-auto pr-1 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                {filtered.map(tpl => {
                  const Icon = tpl.icon;
                  const usable = canCreateFromTemplate(tpl);
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      disabled={creating}
                      onClick={() => void pick(tpl)}
                      className={cn(
                        'group flex min-h-[132px] flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all duration-200',
                        'hover:-translate-y-0.5 hover:border-primary/60 hover:bg-card/80 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30',
                        usable ? 'border-border bg-card/40' : 'border-dashed border-border bg-card/20',
                      )}
                    >
                      <span className="grid size-9 place-items-center rounded-lg bg-muted">
                        <Icon className="size-5" />
                      </span>
                      <span className="text-sm font-semibold">{tpl.name}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{tpl.description}</span>
                      <span className="mt-auto text-[11px] text-muted-foreground opacity-70">
                        {usable ? tpl.category : 'Preview only'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What a bridge WOULD ask for. Nothing here submits — the transport does not
 * exist, and a form that accepted a bot token and did nothing with it would be
 * a worse lie than an empty screen. The fields are shown disabled so the shape
 * of the eventual setup is visible without pretending to work.
 */
function BridgePreview({ template, onBack }: { template: ChannelTemplate; onBack: () => void }) {
  const Icon = template.icon;
  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to templates">
            <ArrowLeft />
          </Button>
          <span className="grid size-7 place-items-center rounded-lg bg-muted">
            <Icon className="size-4" />
          </span>
          <DialogTitle>{template.name}</DialogTitle>
        </div>
        <DialogDescription>{template.description}</DialogDescription>
      </DialogHeader>

      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm">
        <div className="font-medium text-foreground">Not connected yet</div>
        <p className="mt-1 text-muted-foreground">
          {template.unavailableNote} Nothing on this screen sends or stores anything,
          and no channel is created — it shows what connecting will ask for.
        </p>
      </div>

      <div className="space-y-3 opacity-60">
        <FieldPreview label="Channel name" value={template.title} />
        <FieldPreview
          label={template.id === 'openclaw' ? 'Node endpoint' : 'Account'}
          value={template.id === 'openclaw' ? 'wss://node.example/openclaw' : 'Not connected'}
        />
        <FieldPreview
          label="Credential"
          value="Stored write-only in the workspace vault"
        />
        <FieldPreview label="House style" value={template.intent} multiline />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="button" size="sm" disabled title="This bridge is not built yet">
          <Plus data-icon="inline-start" />
          Connect
        </Button>
      </div>
    </>
  );
}

function FieldPreview({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          'rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground',
          multiline && 'min-h-[64px] whitespace-pre-wrap',
        )}
      >
        {value || '—'}
      </div>
    </div>
  );
}
