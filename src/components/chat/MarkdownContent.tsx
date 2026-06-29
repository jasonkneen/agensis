import React from 'react';

type Block =
  | { type: 'code'; language: string; content: string }
  | { type: 'heading'; level: 1 | 2 | 3; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; content: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'paragraph'; content: string };

interface MarkdownContentProps {
  content: string;
  compact?: boolean;
  onMentionClick?: (mention: string) => void;
}

export function MarkdownContent({ content, compact = false, onMentionClick }: MarkdownContentProps) {
  const blocks = parseBlocks(content);
  return (
    <div className={compact ? 'chat-markdown chat-markdown-compact' : 'chat-markdown'}>
      {blocks.map((block, index) => renderBlock(block, index, onMentionClick))}
    </div>
  );
}

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const language = fence[1] || '';
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', language, content: code.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        content: heading[2],
      });
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', content: quote.join('\n') });
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        items.push(item[3]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]+\s*$/.test(lines[i + 1])) {
      const rows: string[][] = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      if (/^```/.test(lines[i]) || /^(#{1,3})\s+/.test(lines[i]) || /^(\s*)([-*]|\d+\.)\s+/.test(lines[i])) break;
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', content: paragraph.join('\n') });
  }

  return blocks;
}

function splitTableRow(row: string) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function renderBlock(block: Block, index: number, onMentionClick?: (mention: string) => void) {
  switch (block.type) {
    case 'code':
      return (
        <pre key={index} className="chat-markdown-code">
          {block.language && <span className="chat-markdown-code-lang">{block.language}</span>}
          <code>{block.content}</code>
        </pre>
      );
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3';
      return <Tag key={index}>{renderInline(block.content, onMentionClick)}</Tag>;
    }
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, onMentionClick)}</li>
          ))}
        </Tag>
      );
    }
    case 'blockquote':
      return <blockquote key={index}>{renderInline(block.content, onMentionClick)}</blockquote>;
    case 'table':
      return (
        <div key={index} className="chat-markdown-table-wrap">
          <table>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    const Cell = rowIndex === 0 ? 'th' : 'td';
                    return <Cell key={cellIndex}>{renderInline(cell, onMentionClick)}</Cell>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'paragraph':
      return <p key={index}>{renderInline(block.content, onMentionClick)}</p>;
    default:
      return null;
  }
}

function renderInline(text: string, onMentionClick?: (mention: string) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(...renderPlainText(text.slice(lastIndex, match.index), parts.length, onMentionClick));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={parts.length}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={parts.length}>{renderInline(token.slice(2, -2), onMentionClick)}</strong>);
    } else if (token.startsWith('*')) {
      parts.push(<em key={parts.length}>{renderInline(token.slice(1, -1), onMentionClick)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link?.[2] || '';
      const safeHref = /^https?:\/\//i.test(href) ? href : undefined;
      parts.push(safeHref
        ? <a key={parts.length} href={safeHref} target="_blank" rel="noreferrer">{link?.[1]}</a>
        : <span key={parts.length}>{link?.[1] || token}</span>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(...renderPlainText(text.slice(lastIndex), parts.length, onMentionClick));
  }
  return parts;
}

function renderPlainText(text: string, keyOffset: number, onMentionClick?: (mention: string) => void): React.ReactNode[] {
  if (!onMentionClick) return [text];
  const parts: React.ReactNode[] = [];
  const pattern = /(^|[^\w])@([a-zA-Z0-9_.-]{1,64})\b/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const prefix = match[1] || '';
    const handle = match[2];
    const mentionStart = match.index + prefix.length;
    if (mentionStart > lastIndex) parts.push(text.slice(lastIndex, mentionStart));
    parts.push(
      <button
        key={`${keyOffset}-${parts.length}-${handle}`}
        type="button"
        className="chat-mention-link"
        onClick={() => onMentionClick(handle)}
      >
        @{handle}
      </button>,
    );
    lastIndex = mentionStart + handle.length + 1;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
