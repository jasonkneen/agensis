import React from 'react';

// Renders a fenced ```mermaid code block as an SVG diagram.
//
// Content here is untrusted (multi-agent / multi-participant chat), so:
//  - mermaid runs with securityLevel 'strict' (no click handlers, labels sanitized);
//  - the library is lazy-loaded via dynamic import so it never bloats the initial bundle;
//  - a parse/render failure falls back to the raw code block instead of throwing and
//    taking the surrounding chat down with it.
//
// Theme tracks the app: [data-theme] on <html> maps to mermaid's built-in dark/default,
// and a MutationObserver re-renders the diagram when the human toggles the theme.

interface MermaidDiagramProps {
  code: string;
}

function readMermaidTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'default';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const rawId = React.useId();
  // mermaid uses the id in getElementById/CSS selectors; React's useId contains ':'
  // which is invalid in a selector, so strip to alphanumerics.
  const renderId = React.useMemo(() => `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`, [rawId]);

  const [theme, setTheme] = React.useState<'dark' | 'default'>(() => readMermaidTheme());
  const [svg, setSvg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Re-theme a mounted diagram when the app theme flips.
  React.useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      const next = readMermaidTheme();
      setTheme(prev => (prev === next ? prev : next));
    });
    observer.observe(target, { attributes: true, attributeFilter: ['data-theme', 'data-ui-theme'] });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          fontFamily: 'inherit',
        });
        // parse first so a syntax error is caught before render mutates the DOM.
        await mermaid.parse(code);
        const { svg: out } = await mermaid.render(renderId, code);
        if (cancelled) return;
        setSvg(out);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, theme, renderId]);

  if (error) {
    return (
      <pre className="chat-markdown-code chat-mermaid-error">
        <span className="chat-markdown-code-lang">mermaid — could not render</span>
        <code>{code}</code>
      </pre>
    );
  }

  if (svg) {
    return <div className="chat-mermaid" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
  }

  // Pre-render placeholder: show the source so there's no blank flash / layout jump.
  return (
    <pre className="chat-markdown-code chat-mermaid-loading">
      <span className="chat-markdown-code-lang">mermaid</span>
      <code>{code}</code>
    </pre>
  );
}
