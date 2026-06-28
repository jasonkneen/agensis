import { Code2, Eye } from 'lucide-react';
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
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background text-foreground">
      <div className="flex h-8 items-center gap-2 border-b border-border px-2">
        <Eye className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{artifact.title}</span>
        <Badge variant="secondary" className="text-xs">HTML</Badge>
      </div>
      <iframe
        title={artifact.title}
        srcDoc={artifact.html}
        sandbox="allow-forms allow-modals allow-popups allow-scripts"
        className="h-64 w-full bg-white"
      />
      <details className="border-t border-border">
        <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <Code2 className="size-3.5" />
          Source
        </summary>
        <pre className="max-h-52 overflow-auto border-t border-border bg-muted/40 p-2 text-xs leading-relaxed">
          <code>{artifact.html}</code>
        </pre>
      </details>
    </div>
  );
}
