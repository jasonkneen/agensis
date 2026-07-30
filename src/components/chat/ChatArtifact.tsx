import { useState } from 'react';
import { Code2, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export interface HtmlArtifact {
  title: string;
  html: string;
  remainingText: string;
}

export function extractHtmlArtifact(content: string): HtmlArtifact | null {
  const fenced = content.match(/```html\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const html = fenced[1].trim();
    // Only treat as an artifact if the HTML is substantial (a real applet, not a snippet)
    if (html.length < 200) return null;
    return {
      title: titleFromHtml(html),
      html,
      remainingText: content.replace(fenced[0], '').trim(),
    };
  }

  const htmlStart = content.search(/<!doctype html|<html[\s>]/i);
  if (htmlStart >= 0) {
    const html = content.slice(htmlStart).trim();
    return {
      title: titleFromHtml(html),
      html,
      remainingText: content.slice(0, htmlStart).trim(),
    };
  }

  return null;
}

function titleFromHtml(html: string) {
  const match = html.match(/<title>(.*?)<\/title>/i);
  return match?.[1]?.trim() || 'HTML artifact';
}

export function ChatArtifact({ artifact }: { artifact: HtmlArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background text-foreground">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 px-2 hover:bg-muted/40"
        onClick={() => setExpanded(v => !v)}
      >
        <Eye className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">{artifact.title}</span>
        <Badge variant="secondary" className="text-xs">HTML</Badge>
        {expanded ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {expanded && (
        <>
          <iframe
            title={artifact.title}
            srcDoc={artifact.html}
            sandbox="allow-forms allow-modals allow-popups allow-scripts"
            className="h-64 w-full border-t border-border bg-white"
          />
          <div className="border-t border-border">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => setSourceOpen(v => !v)}
            >
              <Code2 className="size-3.5" />
              Source
              {sourceOpen ? <ChevronUp className="ml-auto size-3" /> : <ChevronDown className="ml-auto size-3" />}
            </button>
            {sourceOpen && (
              <pre className="max-h-52 overflow-auto border-t border-border bg-muted/40 p-2 text-xs leading-relaxed">
                <code>{artifact.html}</code>
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
