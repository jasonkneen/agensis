import React, { type ComponentPropsWithoutRef } from 'react';
import { createCodePlugin } from '@streamdown/code';
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  defaultRemarkPlugins,
  Streamdown,
  type BundledLanguage,
  type Components,
  type CustomRenderer,
  type CustomRendererProps,
} from 'streamdown';
import { MermaidDiagram } from './MermaidDiagram';
import { LocatedCodeBlock } from './LocatedCodeBlock';
import { parseFrontmatter, type FrontmatterValue } from '../../lib/markdownBlocks';
import { slugMentionHandle, CHANNEL_MENTION_HANDLE } from '../../lib/channelMentions';
import { useChatShikiThemes } from '../../lib/chatCodeTheme';
import { normalizeFenceLanguages } from '../../lib/chatFenceLanguage';
import { trimUrlTail } from '../../lib/chatLinks';

interface MarkdownContentProps {
  content: string;
  compact?: boolean;
  /** Marks an in-progress model stream so Streamdown repairs incomplete markdown
   * and keeps its caret and code surfaces in their live state. */
  streaming?: boolean;
  onMentionClick?: (mention: string) => void;
}

const LOCATED_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'jsonc',
  'css',
  'scss',
  'html',
  'markdown',
  'mdx',
  'xml',
  'zig',
  'rust',
  'go',
  'python',
  'ruby',
  'php',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'bash',
  'fish',
  'sql',
  'yaml',
  'toml',
  'ini',
  'dotenv',
  'dockerfile',
  'makefile',
];

function MermaidCodeBlock({ code, isIncomplete, language }: CustomRendererProps) {
  if (!isIncomplete) return <MermaidDiagram code={code} />;
  const lang = language as BundledLanguage;
  return (
    <CodeBlock code={code} language={lang} isIncomplete lineNumbers={false}>
      <CodeBlockDownloadButton code={code} language={lang} />
      <CodeBlockCopyButton code={code} />
    </CodeBlock>
  );
}

// Module scope is intentional: Streamdown memoizes settled blocks and renderer
// identity must not change on each token of an active stream.
const CHAT_RENDERERS: CustomRenderer[] = [
  { language: ['mermaid'], component: MermaidCodeBlock },
  { language: LOCATED_LANGUAGES, component: LocatedCodeBlock },
];

const MENTION_HREF_PREFIX = '#agensis-mention=';

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const MENTION_SKIP_NODES = new Set(['code', 'inlineCode', 'definition', 'html', 'link', 'linkReference']);

function mentionNodes(value: string): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  const pattern = /(^|[^\w])@([a-zA-Z0-9_.-]{1,64})\b/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    const prefix = match[1] || '';
    const handle = match[2];
    const mentionStart = match.index + prefix.length;
    if (mentionStart > cursor) nodes.push({ type: 'text', value: value.slice(cursor, mentionStart) });
    nodes.push({
      type: 'link',
      url: `${MENTION_HREF_PREFIX}${encodeURIComponent(handle)}`,
      children: [{ type: 'text', value: `@${handle}` }],
    });
    cursor = mentionStart + handle.length + 1;
  }

  if (nodes.length === 0) return null;
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes;
}

/** Turn plain @handles into safe in-app links without touching code or URLs. */
function remarkAgensisMentions() {
  return (tree: MarkdownNode) => {
    const rewrite = (parent: MarkdownNode) => {
      if (MENTION_SKIP_NODES.has(parent.type) || !parent.children) return;
      const next: MarkdownNode[] = [];
      for (const child of parent.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          next.push(...(mentionNodes(child.value) ?? [child]));
        } else {
          rewrite(child);
          next.push(child);
        }
      }
      parent.children = next;
    };
    rewrite(tree);
  };
}

/** Preserve chat-authored single line breaks from the previous renderer. */
function remarkAgensisHardBreaks() {
  return (tree: MarkdownNode) => {
    const rewrite = (parent: MarkdownNode) => {
      if (MENTION_SKIP_NODES.has(parent.type) || !parent.children) return;
      const next: MarkdownNode[] = [];
      for (const child of parent.children) {
        if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
          const lines = child.value.split('\n');
          lines.forEach((line, index) => {
            if (index > 0) next.push({ type: 'break' });
            if (line) next.push({ type: 'text', value: line });
          });
        } else {
          rewrite(child);
          next.push(child);
        }
      }
      parent.children = next;
    };
    rewrite(tree);
  };
}

type LinkProps = ComponentPropsWithoutRef<'a'> & { node?: unknown };
type CodeProps = ComponentPropsWithoutRef<'code'> & { node?: unknown };

function InlineCodeLink({ children }: CodeProps) {
  const text = typeof children === 'string' ? children : '';
  const href = /^https?:\/\/[^\s<>`]+$/.test(text.trim()) ? trimUrlTail(text.trim()) : '';
  const code = <code>{children}</code>;
  return href ? (
    <a data-streamdown="link" href={href} target="_blank" rel="noreferrer noopener">
      {code}
    </a>
  ) : code;
}

function markdownComponents(onMentionClick?: (mention: string) => void): Components {
  const Link = ({ href, children, node: _node, ...props }: LinkProps) => {
    void _node;
    if (href?.startsWith(MENTION_HREF_PREFIX)) {
      const encoded = href.slice(MENTION_HREF_PREFIX.length);
      let handle = encoded;
      try { handle = decodeURIComponent(encoded); } catch { /* use the safe encoded value */ }
      if (slugMentionHandle(handle) === CHANNEL_MENTION_HANDLE) {
        return <span className="chat-mention-link chat-mention-everyone">{children}</span>;
      }
      return (
        <button type="button" className="chat-mention-link" onClick={() => onMentionClick?.(handle)}>
          {children}
        </button>
      );
    }

    const external = typeof href === 'string' && /^https?:\/\//i.test(href);
    const inPage = typeof href === 'string' && href.startsWith('#');
    if (!external && !inPage) return <span>{children}</span>;
    return (
      <a
        {...props}
        data-streamdown="link"
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {children}
      </a>
    );
  };
  const Strong = ({ children }: ComponentPropsWithoutRef<'strong'>) => <strong>{children}</strong>;
  const Emphasis = ({ children }: ComponentPropsWithoutRef<'em'>) => <em>{children}</em>;

  return {
    // Streamdown's renderer map narrows intrinsic component signatures through
    // its markdown AST generics; these implementations deliberately accept the
    // same runtime anchor/code props while discarding only the AST node value.
    a: Link as unknown as NonNullable<Components['a']>,
    inlineCode: InlineCodeLink as unknown as NonNullable<Components['inlineCode']>,
    strong: Strong as unknown as NonNullable<Components['strong']>,
    em: Emphasis as unknown as NonNullable<Components['em']>,
  };
}

export const MarkdownContent = React.memo(function MarkdownContent({
  content,
  compact = false,
  streaming = false,
  onMentionClick,
}: MarkdownContentProps) {
  const themes = useChatShikiThemes();
  const components = React.useMemo(() => markdownComponents(onMentionClick), [onMentionClick]);
  const plugins = React.useMemo(
    () => ({ code: createCodePlugin({ themes }), renderers: CHAT_RENDERERS }),
    [themes],
  );
  const remarkPlugins = React.useMemo(
    () => [
      ...Object.values(defaultRemarkPlugins),
      remarkAgensisHardBreaks,
      ...(onMentionClick ? [remarkAgensisMentions] : []),
    ],
    [onMentionClick],
  );

  // Frontmatter is intentionally held back until a stream settles: while its
  // closing fence is incomplete it remains ordinary streamed text and cannot
  // flicker between document metadata and prose.
  const { frontmatter, source } = React.useMemo(() => {
    const parsed = streaming ? null : parseFrontmatter(content);
    const body = parsed ? parsed.body : content;
    return { frontmatter: parsed, source: normalizeFenceLanguages(body) };
  }, [content, streaming]);

  return (
    <div className={compact ? 'chat-markdown chat-streamdown chat-markdown-compact' : 'chat-markdown chat-streamdown'}>
      {frontmatter && <FrontmatterHeader meta={frontmatter.meta} />}
      <Streamdown
        components={components}
        plugins={plugins}
        remarkPlugins={remarkPlugins}
        shikiTheme={themes}
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        caret={streaming ? 'block' : undefined}
        lineNumbers={false}
        skipHtml
        dir="auto"
      >
        {source}
      </Streamdown>
    </div>
  );
});

function FrontmatterHeader({ meta }: { meta: Record<string, FrontmatterValue> }) {
  const name = typeof meta.name === 'string' ? meta.name : '';
  const description = typeof meta.description === 'string' ? meta.description : '';
  const metadata = (typeof meta.metadata === 'object' && meta.metadata ? meta.metadata : {}) as Record<string, string>;
  const title = name.replace(/[-_]/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
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
