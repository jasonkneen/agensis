import React, { useRef, useState } from 'react';
import { FileText, Mic, Plus, Send, X } from 'lucide-react';
import { ModelSelector } from '../chat/ModelSelector';
import { getSetting } from '../../lib/settings';
import type { Document, MemoryFact } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import bg1 from '../../../images/download-21.jpg';
import bg2 from '../../../images/download-22.jpg';
import bg3 from '../../../images/download-24.jpg';
import bg4 from '../../../images/download-25.jpg';
import bg5 from '../../../images/download-26.jpg';

interface HomeCanvasProps {
  documents: Document[];
  memoryFacts: MemoryFact[];
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void;
  onOpenNewDocument: () => void;
  onOpenNewChat: () => void;
  workspaceName: string;
}

const BACKGROUND_IMAGES = [bg1, bg2, bg3, bg4, bg5];

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
}: HomeCanvasProps) {
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState(() => getSetting('ai_default_model'));
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [docPickerQuery, setDocPickerQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [backgroundImage] = useState(() => BACKGROUND_IMAGES[Math.floor(Math.random() * BACKGROUND_IMAGES.length)]);

  const filteredDocs = documents.filter(d => d.title.toLowerCase().includes(docPickerQuery.toLowerCase()));
  const canSend = input.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    onSendMessage(input.trim(), selectedModel, memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
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
      <img
        src={backgroundImage}
        alt=""
        className="pointer-events-none absolute inset-0 size-full object-cover opacity-[var(--home-bg-image-opacity)]"
      />
      <div className="pointer-events-none absolute inset-0 bg-[var(--home-bg-overlay)]" />

      <div className="pointer-events-auto relative z-10 flex w-full max-w-3xl flex-col items-center gap-5">
        <h1 className="text-center text-3xl font-semibold leading-tight text-foreground">What's on your mind?</h1>

        <div className="relative w-full">
          {showDocPicker && filteredDocs.length > 0 && (
            <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-52 rounded-lg border bg-popover shadow-lg">
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
                    <X data-icon="inline-start" className="size-2.5" />
                  </Button>
                </Badge>
              ))}
            </div>
          )}

          <InputGroup className="h-auto flex-col items-stretch overflow-hidden bg-card shadow-md">
            <InputGroupTextarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Chat with AI..."
              rows={2}
              className="max-h-36 min-h-[4.5rem] px-4 py-3 text-sm leading-relaxed"
            />
            <InputGroupAddon align="block-end" className="min-h-9 justify-between gap-2 border-t px-2 py-1.5">
              <div className="flex shrink-0 items-center gap-1">
                <InputGroupButton title="Attach" size="icon-sm">
                  <Plus data-icon="inline-start" className="size-4" />
                </InputGroupButton>
                <InputGroupButton title="Voice" size="icon-sm">
                  <Mic data-icon="inline-start" className="size-4" />
                </InputGroupButton>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <ModelSelector value={selectedModel} onChange={setSelectedModel} />
                <InputGroupButton
                  onClick={handleSend}
                  disabled={!canSend}
                  title="Send"
                  size="icon-sm"
                  variant="default"
                  className="rounded-full"
                >
                  <Send data-icon="inline-start" className="size-4" />
                </InputGroupButton>
              </div>
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
