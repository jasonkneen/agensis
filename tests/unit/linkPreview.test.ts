import { describe, expect, it } from 'vitest';
import {
  LINK_PREVIEW_MAX_PER_MESSAGE,
  extractLinkUrls,
  hasCardContent,
  linkHostLabel,
  linkPreviewStateLabel,
  normalizeLinkUrl,
  type LinkPreview,
} from '../../src/lib/linkPreview';

// The client's extractor decides which links get a card. It is a MIRROR of
// server/link-preview.cjs (extractLinkUrls / normalizeUnfurlUrl), so these
// fixtures are deliberately the same ones tests/link-preview.test.cjs uses: if
// the two implementations drift, one of the two suites goes red.
//
// Drift here is a cosmetic bug, never a security one — the server re-validates
// every URL it is handed — but a card that appears on one side and not the other
// is exactly the sort of "works on my machine" the duplication invites.

const ok = (status: LinkPreview['status'], overrides: Partial<LinkPreview> = {}): LinkPreview => ({
  url: 'https://example.com/post',
  finalUrl: 'https://example.com/post',
  status,
  title: '',
  description: '',
  siteName: '',
  imagePath: '',
  detail: '',
  fetchedAt: null,
  ...overrides,
});

describe('extractLinkUrls', () => {
  it('finds a bare URL in ordinary prose', () => {
    expect(extractLinkUrls('Crazy how good these models are https://x.com/runzhuotao/status/2080746699988115897?s=20'))
      .toEqual(['https://x.com/runzhuotao/status/2080746699988115897?s=20']);
  });

  it('does not take the sentence\'s punctuation with it', () => {
    expect(extractLinkUrls('Look at https://example.com/post.')).toEqual(['https://example.com/post']);
    expect(extractLinkUrls('(see https://example.com/post)')).toEqual(['https://example.com/post']);
    expect(extractLinkUrls('"https://example.com/post",')).toEqual(['https://example.com/post']);
    expect(extractLinkUrls('(see https://example.com/post).')).toEqual(['https://example.com/post']);
  });

  it('keeps parentheses that belong to the URL itself', () => {
    // The obvious regex (excluding `)`) cuts this at `Sonic_(` and would unfurl
    // the wrong page. Balanced pairs are the URL's; a lone closer is the
    // sentence's. Mirrors the same case in tests/link-preview.test.cjs.
    expect(extractLinkUrls('https://en.wikipedia.org/wiki/Sonic_(hedgehog)'))
      .toEqual(['https://en.wikipedia.org/wiki/Sonic_(hedgehog)']);
    expect(extractLinkUrls('(from https://en.wikipedia.org/wiki/Sonic_(hedgehog))'))
      .toEqual(['https://en.wikipedia.org/wiki/Sonic_(hedgehog)']);
  });

  it('leaves URLs inside code alone — those are shown, not shared', () => {
    expect(extractLinkUrls('run `curl https://example.com/api`')).toEqual([]);
    expect(extractLinkUrls('```\nfetch("https://example.com/api")\n```')).toEqual([]);
    // A half-typed fence is the streaming case; a card must not flash out of it.
    expect(extractLinkUrls('```\nhttps://example.com/api')).toEqual([]);
  });

  it('takes a markdown link target — a link is a link', () => {
    expect(extractLinkUrls('[the thread](https://example.com/post)')).toEqual(['https://example.com/post']);
  });

  it('dedupes on the normalized URL and caps the count', () => {
    expect(extractLinkUrls('https://example.com/a https://example.com/a#frag')).toEqual(['https://example.com/a']);
    const many = 'https://a.example.com/1 https://b.example.com/2 https://c.example.com/3 https://d.example.com/4';
    expect(extractLinkUrls(many)).toHaveLength(LINK_PREVIEW_MAX_PER_MESSAGE);
    expect(extractLinkUrls(many, 3)).toHaveLength(3);
    expect(extractLinkUrls(many, 0)).toEqual([]);
  });

  it('handles empty and non-string input', () => {
    expect(extractLinkUrls('')).toEqual([]);
    expect(extractLinkUrls(null)).toEqual([]);
    expect(extractLinkUrls(undefined)).toEqual([]);
    expect(extractLinkUrls('no links here')).toEqual([]);
  });
});

describe('normalizeLinkUrl', () => {
  it('accepts http and https only', () => {
    expect(normalizeLinkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(normalizeLinkUrl('http://example.com/a')).toBe('http://example.com/a');
    for (const bad of ['ftp://example.com/x', 'mailto:a@b.com', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(normalizeLinkUrl(bad)).toBe('');
    }
  });

  it('drops the fragment so two spellings share one cache entry', () => {
    expect(normalizeLinkUrl('https://example.com/post?s=20#reply')).toBe('https://example.com/post?s=20');
    // Query params are kept — guessing which are tracking noise can change the page.
    expect(normalizeLinkUrl('https://example.com/post?s=20')).toBe('https://example.com/post?s=20');
  });

  it('refuses the things the server would refuse anyway', () => {
    // Not the security boundary (that is server-side), but queuing a card that
    // can only come back refused is a spinner nobody can resolve.
    for (const bad of [
      'http://localhost:3000/admin',
      'http://foo.localhost/x',
      'http://printer.local/x',
      'http://metadata.internal/x',
      'http://nas.lan/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/x',
      'http://10.0.0.5/x',
      'http://172.16.0.1/x',
      'http://172.31.255.255/x',
      'http://192.168.1.1/x',
      'http://100.64.0.1/x',
      'http://0.0.0.0/x',
      'http://224.0.0.1/x',
      'http://[::1]:9000/x',
      'https://user:pass@example.com/x',
      'https://user@example.com/x',
      '',
      'example.com/v1',
      '/relative',
    ]) {
      expect(normalizeLinkUrl(bad), bad).toBe('');
    }
  });

  it('lets public addresses through, including the near-miss ranges', () => {
    for (const good of ['http://172.15.255.255/x', 'http://172.32.0.1/x', 'http://192.167.255.255/x', 'https://1.1.1.1/x']) {
      expect(normalizeLinkUrl(good), good).not.toBe('');
    }
  });

  it('caps the URL length', () => {
    expect(normalizeLinkUrl(`https://example.com/${'a'.repeat(3000)}`)).toBe('');
  });
});

describe('the non-card states', () => {
  it('reads as a stated fact, one line, in the same shape every time', () => {
    expect(linkPreviewStateLabel({ url: 'https://www.example.com/a', state: 'pending', preview: null }))
      .toBe('example.com · loading preview');
    expect(linkPreviewStateLabel({ url: 'https://example.com/a', state: 'ready', preview: ok('empty') }))
      .toBe('example.com · no preview available');
    expect(linkPreviewStateLabel({ url: 'https://example.com/a', state: 'ready', preview: ok('failed') }))
      .toBe('example.com · preview unavailable');
    // A blocked URL is not told apart from a failed one in the UI on purpose:
    // "we refused to fetch this" is not the reader's problem to act on, and the
    // reason is in the title attribute for anyone debugging.
    expect(linkPreviewStateLabel({ url: 'https://example.com/a', state: 'ready', preview: ok('blocked') }))
      .toBe('example.com · preview unavailable');
    // An ok row draws the card instead, so it has no line.
    expect(linkPreviewStateLabel({ url: 'https://example.com/a', state: 'ready', preview: ok('ok', { title: 'T' }) }))
      .toBe('');
  });

  it('falls back to "link" when the URL will not parse', () => {
    expect(linkPreviewStateLabel({ url: 'nonsense', state: 'pending', preview: null })).toBe('link · loading preview');
    expect(linkHostLabel('nonsense')).toBe('');
  });
});

describe('hasCardContent', () => {
  it('needs an ok row with something to actually show', () => {
    expect(hasCardContent(null)).toBe(false);
    expect(hasCardContent(ok('ok'))).toBe(false);
    expect(hasCardContent(ok('ok', { title: 'A title' }))).toBe(true);
    expect(hasCardContent(ok('ok', { description: 'Some words' }))).toBe(true);
    expect(hasCardContent(ok('ok', { imagePath: '/backend/link-previews/x/image' }))).toBe(true);
    // A site name alone is not a preview — that is the 'empty' state's job.
    expect(hasCardContent(ok('ok', { siteName: 'Example' }))).toBe(false);
    expect(hasCardContent(ok('empty', { title: 'ignored' }))).toBe(false);
    expect(hasCardContent(ok('failed', { title: 'ignored' }))).toBe(false);
  });
});
