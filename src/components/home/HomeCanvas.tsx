import React, { useMemo, useRef, useState } from 'react';
import { FileText, Mic, Plus, Send, X } from 'lucide-react';
import type { Document, MemoryFact } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { WORKSPACE_BACKGROUND_IMAGES } from '@/lib/backgrounds';

interface HomeCanvasProps {
  documents: Document[];
  memoryFacts: MemoryFact[];
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void;
  onOpenNewDocument: () => void;
  workspaceName: string;
  backgroundOpacity?: number;
  backgroundImage?: string | null;
}

const suggestions = [
  'Summarize my documents',
  'Help me brainstorm',
  'Write a draft',
  'Explain a concept',
];

export function HomeCanvas({
  documents,
  memoryFacts,
  onSendMessage,
  workspaceName,
  backgroundOpacity = 0.42,
  backgroundImage,
}: HomeCanvasProps) {
  const [input, setInput] = useState('');
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [docPickerQuery, setDocPickerQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  const filteredDocs = documents.filter(d => d.title.toLowerCase().includes(docPickerQuery.toLowerCase()));
  const canSend = input.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    onSendMessage(input.trim(), 'auto', memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
    setInput('');
    setLinkedDocs([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showDocPicker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowDocPicker(false);
        return;
      }
      if (e.key === 'Enter' && filteredDocs.length > 0) {
        e.preventDefault();
        handleDocSelect(filteredDocs[0]);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDocSelect = (doc: Document) => {
    if (!linkedDocs.find(d => d.id === doc.id)) {
      setLinkedDocs(prev => [...prev, doc]);
    }
    const before = input.slice(0, atStartPos);
    const after = input.slice(inputRef.current?.selectionStart || input.length);
    setInput(before + after);
    setShowDocPicker(false);
    setDocPickerQuery('');
    setAtStartPos(-1);
    inputRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    if (showDocPicker && atStartPos >= 0) {
      const afterAt = val.slice(atStartPos + 1);
      const spaceIdx = afterAt.indexOf(' ');
      if (spaceIdx === -1) {
        setDocPickerQuery(afterAt);
      } else {
        setShowDocPicker(false);
        setDocPickerQuery('');
        setAtStartPos(-1);
      }
    }

    const cursor = e.target.selectionStart || 0;
    if (val[cursor - 1] === '@' && !showDocPicker) {
      setShowDocPicker(true);
      setDocPickerQuery('');
      setAtStartPos(cursor - 1);
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
        style={{ background: 'var(--home-bg-vignette, radial-gradient(135% 105% at 50% 42%, transparent 40%, rgba(0,0,0,0.20) 74%, rgba(0,0,0,0.42) 100%))' }}
      />


      <div className="pointer-events-auto relative z-10 flex w-full max-w-3xl flex-col items-center gap-5">
        <h1 className="text-center text-3xl font-semibold leading-tight text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.55),0_1px_3px_rgba(0,0,0,0.65)]">What's on your mind?</h1>

        <div className="relative w-full">
          {showDocPicker && filteredDocs.length > 0 && (
            <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-64 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
              <CommandList className="max-h-52">
                <CommandGroup heading="Link a document">
                  {filteredDocs.map(doc => (
                    <CommandItem key={doc.id} value={doc.title} onSelect={() => handleDocSelect(doc)}>
                      <FileText data-icon="inline-start" className="size-3.5 text-muted-foreground" />
                      <span className="truncate">{doc.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          )}

          {linkedDocs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
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
                disabled={!canSend}
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
              className={cn('home-suggestion-pill rounded-full bg-card/90 text-muted-foreground backdrop-blur')}
              onClick={() => {
                setInput(suggestion);
                inputRef.current?.focus();
              }}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
