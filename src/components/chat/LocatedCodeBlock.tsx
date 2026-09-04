import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  type BundledLanguage,
  type CustomRendererProps,
} from 'streamdown';

export function LocatedCodeBlock({ code, isIncomplete, language, meta }: CustomRendererProps) {
  const lang = language as BundledLanguage;
  const location = (meta ?? '').trim().split(/\s+/)[0] ?? '';
  const located = location.includes('/') || location.includes(':');

  const block = (
    <CodeBlock code={code} language={lang} isIncomplete={isIncomplete} lineNumbers={false}>
      <CodeBlockDownloadButton code={code} language={lang} />
      <CodeBlockCopyButton code={code} />
    </CodeBlock>
  );

  if (!located) return block;

  return (
    <div data-located-block className="relative">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-8 items-center px-4">
        <span className="truncate font-mono text-xs text-muted-foreground" title={location}>
          {location}
        </span>
      </div>
      {block}
    </div>
  );
}
