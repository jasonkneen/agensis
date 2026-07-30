import { Bot, FileText, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { agentHandle } from '../../lib/agentAccent';
import type { ComposerMentions } from '../../hooks/useComposerMentions';

// Renders the picker dropdown (agents/docs on @, commands/skills on /) and the
// chip row for a composer driven by useComposerMentions. Kept UI-only so the
// home screen, thread panel, and sub-thread panel share one look + behaviour.
export function ComposerMentionPicker({ m }: { m: ComposerMentions }) {
  if (m.picker === 'mention' && (m.filteredAgents.length > 0 || m.filteredDocs.length > 0)) {
    return (
      <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-64 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
        <CommandList className="max-h-52">
          <CommandEmpty>No agents or documents match.</CommandEmpty>
          {m.filteredAgents.length > 0 && (
            <CommandGroup heading="Mention an agent">
              {m.filteredAgents.map(agent => (
                <CommandItem key={agent.id} value={`${agent.name} ${agentHandle(agent)}`} onSelect={() => m.selectAgent(agent)}>
                  <Bot data-icon="inline-start" className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{agent.name}</span>
                  <span className="ml-1 truncate text-xs text-muted-foreground">@{agentHandle(agent)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {m.filteredDocs.length > 0 && (
            <CommandGroup heading="Link a document">
              {m.filteredDocs.map(doc => (
                <CommandItem key={doc.id} value={doc.title} onSelect={() => m.selectDoc(doc)}>
                  <FileText data-icon="inline-start" className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{doc.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    );
  }
  if (m.picker === 'slash') {
    return (
      <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-64 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
        <CommandList className="max-h-52">
          <CommandEmpty>No commands or skills match.</CommandEmpty>
          {m.filteredSlash.length > 0 && (
            <CommandGroup heading="Commands & skills">
              {m.filteredSlash.map(item => (
                <CommandItem key={item.id} value={item.parent ? `${item.parent}:${item.name}` : item.name} onSelect={() => m.selectSlash(item)}>
                  <span className="font-mono text-xs text-muted-foreground">/{item.parent ? `${item.parent}:` : ''}{item.name}</span>
                  {item.detail && <span className="ml-1 truncate text-xs text-muted-foreground">{item.detail}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    );
  }

  return null;
}

export function ComposerMentionChips({ m }: { m: ComposerMentions }) {
  if (m.mentionedAgents.length === 0 && m.linkedDocs.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {m.mentionedAgents.map(agent => (
        <Badge key={agent.id} variant="secondary" className="gap-1">
          <Bot data-icon="inline-start" className="size-3" />
          <span className="max-w-48 truncate">@{agentHandle(agent)}</span>
          <Button type="button" variant="ghost" size="icon-xs" className="ml-0.5 size-4 rounded-full p-0" onClick={() => m.removeAgent(agent.id)} title="Remove mention">
            <X className="size-2.5" />
          </Button>
        </Badge>
      ))}
      {m.linkedDocs.map(doc => (
        <Badge key={doc.id} variant="secondary" className="gap-1">
          <FileText data-icon="inline-start" className="size-3" />
          <span className="max-w-48 truncate">{doc.title}</span>
          <Button type="button" variant="ghost" size="icon-xs" className="ml-0.5 size-4 rounded-full p-0" onClick={() => m.removeDoc(doc.id)} title="Remove document">
            <X className="size-2.5" />
          </Button>
        </Badge>
      ))}
    </div>
  );
}
