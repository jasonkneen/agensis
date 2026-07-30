import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

// CodeMirror configuration for the applet editor, kept out of the component so
// the choices are testable data rather than JSX side effects.
//
// An applet's source is markdown carrying a ```html fence (see
// extractHtmlFromDocContent in canvasApps.ts), so the language is MARKDOWN with
// fence-aware nesting — the html/css/js inside the fence gets real
// highlighting and tag/attribute autocomplete through @codemirror/language-data
// rather than the whole document being treated as one flat grammar.

export type EditorScheme = 'light' | 'dark';

/**
 * The editor scheme for a documentElement `data-theme` value.
 *
 * The app writes 'light' | 'dark' there (useTheme.applyTheme); anything else —
 * missing attribute, an experimental theme name — falls back to dark, which is
 * the app's default colour-scheme. Pure so the fallback rule is pinned by a
 * test instead of living in a MutationObserver callback.
 */
export function editorSchemeFrom(value: string | null | undefined): EditorScheme {
  return value === 'light' ? 'light' : 'dark';
}

// Chrome (gutters, caret, selection) uses the app's CSS variables so the editor
// follows theme switches without rebuilding. Token colours cannot: a
// HighlightStyle needs concrete values, so there is one per scheme and the
// component swaps extensions when data-theme changes.
const chrome = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    fontSize: '12.5px',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--foreground) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 22%, transparent) !important',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--card)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 24%, transparent)',
    color: 'var(--foreground)',
  },
});

// Token palettes tuned per scheme: fixed colours because HighlightStyle cannot
// read CSS variables, chosen to stay legible on the app's card surfaces.
const darkTokens = HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword], color: '#c792ea' },
  { tag: [tags.tagName, tags.angleBracket], color: '#f07178' },
  { tag: [tags.attributeName], color: '#ffcb6b' },
  { tag: [tags.string, tags.attributeValue], color: '#c3e88d' },
  { tag: [tags.number, tags.bool, tags.null], color: '#f78c6c' },
  { tag: [tags.comment], color: '#697098', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#82aaff' },
  { tag: [tags.propertyName], color: '#80cbc4' },
  { tag: [tags.heading], color: '#82aaff', fontWeight: '600' },
  { tag: [tags.monospace], color: '#c3e88d' },
  { tag: [tags.link, tags.url], color: '#89ddff' },
]);

const lightTokens = HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword], color: '#7c3aed' },
  { tag: [tags.tagName, tags.angleBracket], color: '#be123c' },
  { tag: [tags.attributeName], color: '#b45309' },
  { tag: [tags.string, tags.attributeValue], color: '#15803d' },
  { tag: [tags.number, tags.bool, tags.null], color: '#c2410c' },
  { tag: [tags.comment], color: '#64748b', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#1d4ed8' },
  { tag: [tags.propertyName], color: '#0f766e' },
  { tag: [tags.heading], color: '#1d4ed8', fontWeight: '600' },
  { tag: [tags.monospace], color: '#15803d' },
  { tag: [tags.link, tags.url], color: '#0369a1' },
]);

/** The scheme-dependent half of the setup, swapped when data-theme changes. */
export function appletThemeExtensions(scheme: EditorScheme): Extension[] {
  return [chrome, syntaxHighlighting(scheme === 'light' ? lightTokens : darkTokens)];
}
