import { DEFAULT_BACKGROUND_OPACITY } from '../../lib/wallpaperDefaults';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Clock, FileText, Mic, Plus, Send, Sparkles, X } from 'lucide-react';
import type { Document, MemoryFact, WorkspaceAgent } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { WORKSPACE_BACKGROUND_IMAGES } from '@/lib/backgrounds';
import { agentHandle } from '../../lib/agentAccent';
import { getSlashCommands } from '../../lib/backendClient';
import { matchSlashItems, slashInsertText, type SlashItem } from '../../lib/slashCommands';

interface HomeCanvasProps {
  documents: Document[];
  agents?: WorkspaceAgent[];
  workspaceId?: string;
  memoryFacts: MemoryFact[];
  /**
   * Resolves false when the channel could not be created, so the draft can be
   * put back. This composer has no transcript to fall back on: if the send
   * fails there is nowhere at all for the typed text to reappear.
   */
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void | Promise<boolean | void>;
  onOpenNewDocument: () => void;
  workspaceName: string;
  backgroundOpacity?: number;
  backgroundImage?: string | null;
  onOpenSchedules?: () => void;
}

const suggestions = [
  'Summarize my documents',
  'Help me brainstorm',
  'Write a draft',
  'Explain a concept',
];

export function HomeCanvas({
  documents,
  agents = [],
  workspaceId,
  memoryFacts,
  onSendMessage,
  workspaceName,
  backgroundOpacity = DEFAULT_BACKGROUND_OPACITY,
  backgroundImage,
  onOpenSchedules,
}: HomeCanvasProps) {
  const [input, setInput] = useState('');
  const [briefDismissed, setBriefDismissed] = useState(() => {
    try { return localStorage.getItem('agensis_daily_brief_dismissed') === '1'; } catch { return false; }
  });
  const dismissBrief = () => {
    try { localStorage.setItem('agensis_daily_brief_dismissed', '1'); } catch { /* ignore */ }
    setBriefDismissed(true);
  };
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [mentionedAgents, setMentionedAgents] = useState<WorkspaceAgent[]>([]);
  const [sending, setSending] = useState(false);
  // '@' opens the mention picker (agents + documents); '/' opens the command
  // picker (built-in actions + daemon-enumerated commands/skills).
  const [picker, setPicker] = useState<'mention' | 'slash' | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [tokenStartPos, setTokenStartPos] = useState(-1);
  const [remoteSlashItems, setRemoteSlashItems] = useState<SlashItem[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Daemon-enumerated commands/skills, same source the chat composer uses. The
  // home composer only inserts text (no client-side app actions exist here), so
  // built-ins are filtered to insert-kind + the remote commands/skills.
  useEffect(() => {
    if (!workspaceId) { setRemoteSlashItems([]); return; }
    let cancelled = false;
    getSlashCommands(workspaceId)
      .then(items => { if (!cancelled) setRemoteSlashItems(items); })
      .catch(() => { if (!cancelled) setRemoteSlashItems([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const fallbackBackgroundImage = useMemo(() => {
    let hash = 0;
    for (let index = 0; index < workspaceName.length; index++) {
      hash = ((hash << 5) - hash + workspaceName.charCodeAt(index)) | 0;
    }
    return WORKSPACE_BACKGROUND_IMAGES[Math.abs(hash) % WORKSPACE_BACKGROUND_IMAGES.length];
  }, [workspaceName]);
  const visibleBackgroundImage = backgroundImage === undefined ? fallbackBackgroundImage : backgroundImage;
  const clampedBackgroundOpacity = Math.min(1, Math.max(0, backgroundOpacity));
  const overlayOpacity = Math.max(0, 1 - clampedBackgroundOpacity);

  const filteredDocs = useMemo(
    () => (picker === 'mention' ? documents.filter(d => d.title.toLowerCase().includes(pickerQuery.toLowerCase())).slice(0, 6) : []),
    [picker, documents, pickerQuery],
  );
  const filteredAgents = useMemo(() => {
    if (picker !== 'mention') return [];
    const q = pickerQuery.toLowerCase();
    return agents.filter(a => a.enabled !== false && (a.name.toLowerCase().includes(q) || agentHandle(a).includes(q))).slice(0, 6);
  }, [picker, agents, pickerQuery]);
  // Daemon-enumerated commands/skills, plus each enabled agent's advertised
  // skills as a fallback (deduped by id) so `/` still surfaces skills when no
  // daemon is connected. Built-ins are all client actions the home composer
  // doesn't have, so only insert-kind items appear here.
  const slashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [];
    const seen = new Set<string>();
    for (const item of remoteSlashItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    for (const name of new Set(agents.flatMap(a => (a.enabled === false ? [] : a.skills ?? [])))) {
      const id = `skill:${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, name, kind: 'skill', run: 'insert', detail: 'Skill' });
    }
    return items;
  }, [remoteSlashItems, agents]);
  const filteredSlash = useMemo(
    () => (picker === 'slash' ? matchSlashItems(slashItems, pickerQuery).slice(0, 8) : []),
    [picker, slashItems, pickerQuery],
  );
  const canSend = input.trim().length > 0 || mentionedAgents.length > 0;

  const closePicker = () => {
    setPicker(null);
    setPickerQuery('');
    setTokenStartPos(-1);
  };

  // Strip the active @/ token (from its start to the caret) out of the draft.
  const stripToken = () => {
    const before = input.slice(0, Math.max(0, tokenStartPos));
    const after = input.slice(inputRef.current?.selectionStart ?? input.length);
    setInput(before + after);
  };

  const handleSend = async () => {
    if (!canSend || sending) return;
    // Rebuild @handle tokens from the agent chips so the backend (which routes
    // agents by parsing @mentions in the text) still notifies + runs them.
    const mentionPrefix = mentionedAgents.map(a => `@${agentHandle(a)}`).join(' ');
    const body = input.trim();
    const content = [mentionPrefix, body].filter(Boolean).join(' ').trim();
    if (!content) return;

    // Clear optimistically — this is the fast path and it is what makes the
    // composer feel instant — but hold on to everything so a failed send can put
    // it all back. Clearing and then losing it is the failure that costs the
    // user actual work.
    const draft = { input, linkedDocs, mentionedAgents };
    setInput('');
    setLinkedDocs([]);
    setMentionedAgents([]);
    setSending(true);
    try {
      const sent = await onSendMessage(content, 'auto', memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
      if (sent === false) {
        setInput(draft.input);
        setLinkedDocs(draft.linkedDocs);
        setMentionedAgents(draft.mentionedAgents);
        inputRef.current?.focus();
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (picker) {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (picker === 'mention' && filteredAgents.length > 0) { e.preventDefault(); handleAgentSelect(filteredAgents[0]); return; }
        if (picker === 'mention' && filteredDocs.length > 0) { e.preventDefault(); handleDocSelect(filteredDocs[0]); return; }
        if (picker === 'slash' && filteredSlash.length > 0) { e.preventDefault(); handleSlashSelect(filteredSlash[0]); return; }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAgentSelect = (agent: WorkspaceAgent) => {
    if (!mentionedAgents.some(a => a.id === agent.id)) setMentionedAgents(prev => [...prev, agent]);
    stripToken();
    closePicker();
    inputRef.current?.focus();
  };

  const handleDocSelect = (doc: Document) => {
    if (!linkedDocs.some(d => d.id === doc.id)) setLinkedDocs(prev => [...prev, doc]);
    stripToken();
    closePicker();
    inputRef.current?.focus();
  };

  const handleSlashSelect = (item: SlashItem) => {
    const token = slashInsertText(item);
    const before = input.slice(0, Math.max(0, tokenStartPos));
    const after = input.slice(inputRef.current?.selectionStart ?? input.length);
    const needsSpace = after.length === 0 || !/^\s/.test(after);
    setInput(`${before}${token}${needsSpace ? ' ' : ''}${after}`);
    closePicker();
    inputRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const cursor = e.target.selectionStart || 0;

    // Update the active picker as the token grows. When the token is broken by a
    // space we first try to auto-commit an exact @agent/@doc match to a chip
    // ("@handle " becomes a chip even without clicking the picker), then close.
    if (picker && tokenStartPos >= 0) {
      const afterToken = val.slice(tokenStartPos + 1, cursor);
      if (/\s/.test(afterToken) || cursor <= tokenStartPos) {
        if (picker === 'mention') {
          const q = afterToken.trim().toLowerCase();
          const agentHit = q ? agents.find(a => a.enabled !== false && (agentHandle(a).toLowerCase() === q || a.name.toLowerCase() === q)) : undefined;
          const docHit = q && !agentHit ? documents.find(d => d.title.toLowerCase() === q) : undefined;
          if (agentHit) {
            if (!mentionedAgents.some(a => a.id === agentHit.id)) setMentionedAgents(prev => [...prev, agentHit]);
            setInput(val.slice(0, tokenStartPos) + val.slice(cursor));
            closePicker();
            return;
          }
          if (docHit) {
            if (!linkedDocs.some(d => d.id === docHit.id)) setLinkedDocs(prev => [...prev, docHit]);
            setInput(val.slice(0, tokenStartPos) + val.slice(cursor));
            closePicker();
            return;
          }
        }
        closePicker();
      } else {
        setPickerQuery(afterToken);
        return;
      }
    }

    // Open a picker when @ or / is typed at the start or after whitespace.
    const prev = val[cursor - 1];
    const beforePrev = cursor >= 2 ? val[cursor - 2] : '';
    const atBoundary = cursor === 1 || /\s/.test(beforePrev);
    if (atBoundary && prev === '@') {
      setPicker('mention'); setPickerQuery(''); setTokenStartPos(cursor - 1);
    } else if (atBoundary && prev === '/') {
      setPicker('slash'); setPickerQuery(''); setTokenStartPos(cursor - 1);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center overflow-hidden px-6">
      {visibleBackgroundImage ? (
        <>
          <img
            src={visibleBackgroundImage}
            alt=""
            className="pointer-events-none absolute inset-0 size-full object-cover"
            style={{ opacity: clampedBackgroundOpacity }}
          />
          <div className="pointer-events-none absolute inset-0 bg-[var(--home-bg-overlay)]" style={{ opacity: overlayOpacity }} />
        </>
      ) : null}

      {/* Always-on radial vignette: darkens the edges and lifts the focal area
          near the composer, giving the flat backdrop perceptible depth
          regardless of the user's background-opacity setting. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'var(--home-bg-vignette, radial-gradient(135% 105% at 50% 42%, transparent 40%, rgba(0,0,0,0.20) 74%, rgba(0,0,0,DEFAULT_BACKGROUND_OPACITY) 100%))' }}
      />


      <div className="pointer-events-auto relative z-10 flex w-full max-w-3xl flex-col items-center gap-5">
        <h1 className="text-center text-3xl font-semibold leading-tight text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.55),0_1px_3px_rgba(0,0,0,0.65)]">What's on your mind?</h1>

        <div className="relative w-full">
          {picker === 'mention' && (filteredAgents.length > 0 || filteredDocs.length > 0) && (
            <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-64 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
              <CommandList className="max-h-52">
                <CommandEmpty>No agents or documents match.</CommandEmpty>
                {filteredAgents.length > 0 && (
                  <CommandGroup heading="Mention an agent">
                    {filteredAgents.map(agent => (
                      <CommandItem key={agent.id} value={`${agent.name} ${agentHandle(agent)}`} onSelect={() => handleAgentSelect(agent)}>
                        <Bot data-icon="inline-start" className="size-3.5 text-muted-foreground" />
                        <span className="truncate">{agent.name}</span>
                        <span className="ml-1 truncate text-xs text-muted-foreground">@{agentHandle(agent)}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {filteredDocs.length > 0 && (
                  <CommandGroup heading="Link a document">
                    {filteredDocs.map(doc => (
                      <CommandItem key={doc.id} value={doc.title} onSelect={() => handleDocSelect(doc)}>
                        <FileText data-icon="inline-start" className="size-3.5 text-muted-foreground" />
                        <span className="truncate">{doc.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          )}

          {picker === 'slash' && filteredSlash.length > 0 && (
            <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-64 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
              <CommandList className="max-h-52">
                <CommandGroup heading="Commands & skills">
                  {filteredSlash.map(item => (
                    <CommandItem key={item.id} value={item.parent ? `${item.parent}:${item.name}` : item.name} onSelect={() => handleSlashSelect(item)}>
                      <span className="font-mono text-xs text-muted-foreground">/{item.parent ? `${item.parent}:` : ''}{item.name}</span>
                      {item.detail && <span className="ml-1 truncate text-xs text-muted-foreground">{item.detail}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          )}

          {(mentionedAgents.length > 0 || linkedDocs.length > 0) && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {mentionedAgents.map(agent => (
                <Badge key={agent.id} variant="secondary" className="gap-1">
                  <Bot data-icon="inline-start" className="size-3" />
                  <span className="max-w-48 truncate">@{agentHandle(agent)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ml-0.5 size-4 rounded-full p-0"
                    onClick={() => setMentionedAgents(prev => prev.filter(a => a.id !== agent.id))}
                    title="Remove mention"
                  >
                    <X className="size-2.5" />
                  </Button>
                </Badge>
              ))}
              {linkedDocs.map(doc => (
                <Badge key={doc.id} variant="secondary" className="gap-1">
                  <FileText data-icon="inline-start" className="size-3" />
                  <span className="max-w-48 truncate">{doc.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ml-0.5 size-4 rounded-full p-0"
                    onClick={() => setLinkedDocs(prev => prev.filter(d => d.id !== doc.id))}
                    title="Remove document"
                  >
                    <X className="size-2.5" />
                  </Button>
                </Badge>
              ))}
            </div>
          )}

          <InputGroup className="home-workspace-composer h-auto flex-col items-stretch overflow-hidden border bg-card/95 shadow-xl has-disabled:opacity-100">
            <InputGroupTextarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Message the workspace..."
              rows={2}
              className="max-h-36 min-h-[4.5rem] px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/85"
            />
            <InputGroupAddon align="block-end" className="min-h-9 justify-between gap-2 border-t px-2 py-1.5">
              <div className="flex shrink-0 items-center gap-1">
                <InputGroupButton title="Attach" size="icon-sm">
                  <Plus className="size-4" />
                </InputGroupButton>
                <InputGroupButton title="Voice" size="icon-sm">
                  <Mic className="size-4" />
                </InputGroupButton>
              </div>
              <InputGroupButton
                onClick={handleSend}
                disabled={!canSend || sending}
                title="Send"
                size="icon-sm"
                variant="default"
                className="rounded-full"
              >
                <Send className="size-4" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {suggestions.map(suggestion => (
            <Button
              key={suggestion}
              type="button"
              variant="outline"
              size="sm"
              className={cn('home-suggestion-pill rounded-lg bg-card/90 text-muted-foreground backdrop-blur')}
              onClick={() => {
                setInput(suggestion);
                inputRef.current?.focus();
              }}
            >
              {suggestion}
            </Button>
          ))}
        </div>

        {onOpenSchedules && !briefDismissed && (
          <div className="pointer-events-auto relative flex w-full max-w-3xl items-center gap-3 rounded-xl border border-border bg-card/90 px-4 py-3 shadow-lg backdrop-blur">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
              <Clock className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                Set up your daily brief
                <Sparkles className="size-3.5 text-primary" />
              </div>
              <p className="text-xs text-muted-foreground">Have an agent run a task on a schedule — a morning summary, a status check, a recurring report.</p>
            </div>
            <Button type="button" size="sm" className="shrink-0" onClick={onOpenSchedules}>
              Set up
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label="Dismiss" onClick={dismissBrief}>
              <X className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
