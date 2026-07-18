import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Document, WorkspaceAgent } from '../types';
import { agentHandle } from '../lib/agentAccent';
import { getSlashCommands } from '../lib/backendClient';
import { matchSlashItems, slashInsertText, type SlashItem } from '../lib/slashCommands';

// Shared `/` + `@` composer behaviour for the message inputs that aren't the
// full chat composer (home screen, thread + sub-thread panels).
//
//   @  → picker of agents (become @handle chips) + documents (become doc chips);
//        the @token is stripped from the draft. Typing "@handle " auto-commits an
//        exact match to a chip.
//   /  → picker of daemon-enumerated commands/skills + each enabled agent's
//        advertised skills (fallback); inserts the /token as text.
//
// Agent chips are reconstructed into @handle tokens by buildContent() so the
// backend mention router (which parses @[a-z0-9_.-]+ from the text) still routes
// them. Docs are returned for the caller to pass along as its docs payload.

export interface ComposerMentions {
  input: string;
  setInput: (v: string) => void;
  mentionedAgents: WorkspaceAgent[];
  linkedDocs: Document[];
  removeAgent: (id: string) => void;
  removeDoc: (id: string) => void;
  clear: () => void;
  picker: 'mention' | 'slash' | null;
  filteredAgents: WorkspaceAgent[];
  filteredDocs: Document[];
  filteredSlash: SlashItem[];
  onInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  selectAgent: (agent: WorkspaceAgent) => void;
  selectDoc: (doc: Document) => void;
  selectSlash: (item: SlashItem) => void;
  /** True while a picker is open — the caller should intercept Enter/Tab/Escape. */
  handleNavKey: (key: string) => boolean;
  /** Prepend @handle tokens (from agent chips) to the trimmed draft. */
  buildContent: () => string;
  closePicker: () => void;
}

export function useComposerMentions(opts: {
  agents?: WorkspaceAgent[];
  documents?: Document[];
  workspaceId?: string | null;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}): ComposerMentions {
  const { agents = [], documents = [], workspaceId, inputRef } = opts;
  const [input, setInput] = useState('');
  const [mentionedAgents, setMentionedAgents] = useState<WorkspaceAgent[]>([]);
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [picker, setPicker] = useState<'mention' | 'slash' | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [tokenStartPos, setTokenStartPos] = useState(-1);
  const [remoteSlashItems, setRemoteSlashItems] = useState<SlashItem[]>([]);

  useEffect(() => {
    if (!workspaceId) { setRemoteSlashItems([]); return; }
    let cancelled = false;
    getSlashCommands(workspaceId)
      .then(items => { if (!cancelled) setRemoteSlashItems(items); })
      .catch(() => { if (!cancelled) setRemoteSlashItems([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const filteredAgents = useMemo(() => {
    if (picker !== 'mention') return [];
    const q = pickerQuery.toLowerCase();
    return agents.filter(a => a.enabled !== false && (a.name.toLowerCase().includes(q) || agentHandle(a).includes(q))).slice(0, 6);
  }, [picker, agents, pickerQuery]);

  const filteredDocs = useMemo(
    () => (picker === 'mention' ? documents.filter(d => d.title.toLowerCase().includes(pickerQuery.toLowerCase())).slice(0, 6) : []),
    [picker, documents, pickerQuery],
  );

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

  const closePicker = useCallback(() => {
    setPicker(null);
    setPickerQuery('');
    setTokenStartPos(-1);
  }, []);

  const stripToken = useCallback(() => {
    // No active @/ token (e.g. a chip added from a "+" popover, not from typing)
    // — nothing in the draft to remove, so leave the input untouched.
    if (tokenStartPos < 0) return;
    const before = input.slice(0, tokenStartPos);
    const after = input.slice(inputRef.current?.selectionStart ?? input.length);
    setInput(before + after);
  }, [input, tokenStartPos, inputRef]);

  const selectAgent = useCallback((agent: WorkspaceAgent) => {
    setMentionedAgents(prev => (prev.some(a => a.id === agent.id) ? prev : [...prev, agent]));
    stripToken();
    closePicker();
    inputRef.current?.focus();
  }, [stripToken, closePicker, inputRef]);

  const selectDoc = useCallback((doc: Document) => {
    setLinkedDocs(prev => (prev.some(d => d.id === doc.id) ? prev : [...prev, doc]));
    stripToken();
    closePicker();
    inputRef.current?.focus();
  }, [stripToken, closePicker, inputRef]);

  const selectSlash = useCallback((item: SlashItem) => {
    const token = slashInsertText(item);
    const before = input.slice(0, Math.max(0, tokenStartPos));
    const after = input.slice(inputRef.current?.selectionStart ?? input.length);
    const needsSpace = after.length === 0 || !/^\s/.test(after);
    setInput(`${before}${token}${needsSpace ? ' ' : ''}${after}`);
    closePicker();
    inputRef.current?.focus();
  }, [input, tokenStartPos, closePicker, inputRef]);

  const onInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const cursor = e.target.selectionStart || 0;

    if (picker && tokenStartPos >= 0) {
      const afterToken = val.slice(tokenStartPos + 1, cursor);
      if (/\s/.test(afterToken) || cursor <= tokenStartPos) {
        if (picker === 'mention') {
          const q = afterToken.trim().toLowerCase();
          const agentHit = q ? agents.find(a => a.enabled !== false && (agentHandle(a).toLowerCase() === q || a.name.toLowerCase() === q)) : undefined;
          const docHit = q && !agentHit ? documents.find(d => d.title.toLowerCase() === q) : undefined;
          if (agentHit) {
            setMentionedAgents(prev => (prev.some(a => a.id === agentHit.id) ? prev : [...prev, agentHit]));
            setInput(val.slice(0, tokenStartPos) + val.slice(cursor));
            closePicker();
            return;
          }
          if (docHit) {
            setLinkedDocs(prev => (prev.some(d => d.id === docHit.id) ? prev : [...prev, docHit]));
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

    const prev = val[cursor - 1];
    const beforePrev = cursor >= 2 ? val[cursor - 2] : '';
    const atBoundary = cursor === 1 || /\s/.test(beforePrev);
    if (atBoundary && prev === '@') {
      setPicker('mention'); setPickerQuery(''); setTokenStartPos(cursor - 1);
    } else if (atBoundary && prev === '/') {
      setPicker('slash'); setPickerQuery(''); setTokenStartPos(cursor - 1);
    }
  }, [picker, tokenStartPos, agents, documents, closePicker]);

  // Returns true if the key was consumed by an open picker.
  const handleNavKey = useCallback((key: string): boolean => {
    if (!picker) return false;
    if (key === 'Escape') { closePicker(); return true; }
    if (key === 'Enter' || key === 'Tab') {
      if (picker === 'mention' && filteredAgents.length > 0) { selectAgent(filteredAgents[0]); return true; }
      if (picker === 'mention' && filteredDocs.length > 0) { selectDoc(filteredDocs[0]); return true; }
      if (picker === 'slash' && filteredSlash.length > 0) { selectSlash(filteredSlash[0]); return true; }
    }
    return false;
  }, [picker, filteredAgents, filteredDocs, filteredSlash, closePicker, selectAgent, selectDoc, selectSlash]);

  const buildContent = useCallback(() => {
    const mentionPrefix = mentionedAgents.map(a => `@${agentHandle(a)}`).join(' ');
    const body = input.trim();
    return [mentionPrefix, body].filter(Boolean).join(' ').trim();
  }, [mentionedAgents, input]);

  const clear = useCallback(() => {
    setInput('');
    setMentionedAgents([]);
    setLinkedDocs([]);
    closePicker();
  }, [closePicker]);

  return {
    input, setInput,
    mentionedAgents, linkedDocs,
    removeAgent: id => setMentionedAgents(prev => prev.filter(a => a.id !== id)),
    removeDoc: id => setLinkedDocs(prev => prev.filter(d => d.id !== id)),
    clear,
    picker, filteredAgents, filteredDocs, filteredSlash,
    onInputChange, selectAgent, selectDoc, selectSlash,
    handleNavKey, buildContent, closePicker,
  };
}
