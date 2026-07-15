import React from 'react';
import { MermaidDiagram } from './MermaidDiagram';
import { parseBlocks, parseFrontmatter, closeOpenMarkers, type Block, type FrontmatterValue } from '../../lib/markdownBlocks';

interface MarkdownContentProps {
  content: string;
  compact?: boolean;
  /** While true, the content is an in-progress stream: close dangling inline
   *  markers on the tail so partial `**`/`` ` `` don't flash as raw markdown. */
  streaming?: boolean;
  onMentionClick?: (mention: string) => void;
}

export const MarkdownContent = React.memo(function MarkdownContent({ content, compact = false, streaming = false, onMentionClick }: MarkdownContentProps) {
  // Only resolve frontmatter once the message has settled — mid-stream content
  // may still be growing the `---` block itself and would flicker as it parses.
  const { frontmatter, blocks } = React.useMemo(() => {
    const fm = streaming ? null : parseFrontmatter(content);
    const body = fm ? fm.body : content;
    return { frontmatter: fm, blocks: parseBlocks(streaming ? closeOpenMarkers(body) : body) };
  }, [content, streaming]);
  return (
    <div className={compact ? 'chat-markdown chat-markdown-compact' : 'chat-markdown'}>
      {frontmatter && <FrontmatterHeader meta={frontmatter.meta} />}
      {blocks.map((block, index) => renderBlock(block, index, onMentionClick, streaming))}
    </div>
  );
});

function FrontmatterHeader({ meta }: { meta: Record<string, FrontmatterValue> }) {
  const name = typeof meta.name === 'string' ? meta.name : '';
  const description = typeof meta.description === 'string' ? meta.description : '';
  const metadata = (typeof meta.metadata === 'object' && meta.metadata ? meta.metadata : {}) as Record<string, string>;
  const title = name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const badges = Object.entries(metadata).filter(([key]) => key !== 'originSessionId');

  if (!title && !description && badges.length === 0) return null;

  return (
    <div className="chat-markdown-frontmatter">
      {title && <div className="chat-markdown-frontmatter-title">{title}</div>}
      {description && <p className="chat-markdown-frontmatter-desc">{description}</p>}
      {badges.length > 0 && (
        <div className="chat-markdown-frontmatter-meta">
          {badges.map(([key, value]) => (
            <span key={key} className="chat-markdown-frontmatter-badge">{value}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// Render a block's text with single newlines as hard breaks. The block parser joins
// soft-wrapped lines with "\n"; without this they collapse to spaces (CommonMark soft
// break) and fuse separate sentences into one running paragraph.
function renderInlineLines(text: string, onMentionClick?: (mention: string) => void): React.ReactNode[] {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`br-${idx}`} />);
    out.push(<React.Fragment key={`ln-${idx}`}>{renderInline(line, onMentionClick)}</React.Fragment>);
  });
  return out;
}

function renderBlock(block: Block, index: number, onMentionClick?: (mention: string) => void, streaming = false) {
  switch (block.type) {
    case 'code':
      // Render mermaid fences as diagrams — but only once the block is complete.
      // While streaming, the fence body is still arriving and would fail to parse,
      // so show it as a plain code block until the message settles.
      if (block.language === 'mermaid' && !streaming) {
        return <MermaidDiagram key={index} code={block.content} />;
      }
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
      return <blockquote key={index}>{renderInlineLines(block.content, onMentionClick)}</blockquote>;
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
      return <p key={index}>{renderInlineLines(block.content, onMentionClick)}</p>;
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
