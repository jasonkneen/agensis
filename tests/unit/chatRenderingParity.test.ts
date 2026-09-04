import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '../../src/components/chat/MarkdownContent';
import { chatShikiThemesFor } from '../../src/lib/chatCodeTheme';
import { languageForLocation, normalizeFenceLanguages } from '../../src/lib/chatFenceLanguage';

describe('Legion-style streamed markdown in Agensis channels', () => {
  it('repairs an incomplete emphasis token while a reply is streaming', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: 'Still **working',
      streaming: true,
    }));
    expect(html).toContain('<strong>working</strong>');
    expect(html).not.toContain('**working');
  });

  it('keeps profile mentions interactive without transforming code', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: 'Ask @scout, tell @channel, and keep `@literal` as code.',
      onMentionClick: () => undefined,
    }));
    expect(html).toContain('class="chat-mention-link">@scout</button>');
    expect(html).toContain('class="chat-mention-link chat-mention-everyone">@channel</span>');
    expect(html).toContain('<code>@literal</code>');
  });

  it('preserves deliberate single line breaks in chat prose', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: 'first line\nsecond line',
    }));
    expect(html).toMatch(/first line<br\/>\s*second line/);
  });

  it('normalizes file-location fences and preserves the location as metadata', () => {
    expect(languageForLocation('448:454:src/lib/chat/approvals.server.ts')).toBe('typescript');
    expect(normalizeFenceLanguages('```448:454:src/lib/chat/approvals.server.ts\nconst ok = true;\n```'))
      .toBe('```typescript 448:454:src/lib/chat/approvals.server.ts\nconst ok = true;\n```');
  });

  it('pairs developer themes with matching light and dark syntax palettes', () => {
    expect(chatShikiThemesFor('catppuccin')).toEqual(['catppuccin-latte', 'catppuccin-mocha']);
    expect(chatShikiThemesFor('kanagawa')).toEqual(['kanagawa-lotus', 'kanagawa-wave']);
    expect(chatShikiThemesFor('unknown-theme')).toEqual(['github-light', 'github-dark']);
  });
});

describe('channel equality is encoded in the app message boundary', () => {
  const files = [
    'src/components/windows/ChatWindowContent.tsx',
    'src/components/chat/ChatThreadPanel.tsx',
    'src/components/chat/SubThreadPanel.tsx',
  ];

  for (const file of files) {
    it(`${file} fixes every participant to the shared start alignment`, () => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toMatch(/<UiMessage\s+align="start"/);
      expect(source).not.toMatch(/<UiMessage[^>]+align=(?:"end"|\{[^}]*role[^}]*\})/);
    });
  }
});
