import { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { appletThemeExtensions, editorSchemeFrom } from '@/lib/appletEditorConfig';

// The applet code editor: CodeMirror 6 over the plain <textarea> it replaces.
//
// Loaded lazily (React.lazy in AppletDocWindowContent) so the editor and its
// grammars stay out of the main bundle — this app's service-worker precache
// size is a known sore point, and most sessions never open an applet's code.
//
// Default export, because React.lazy only understands default exports.

interface AppletCodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}

export default function AppletCodeEditor({ value, onChange, ariaLabel }: AppletCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  // onChange identity can shift per render (it closes over autosave state);
  // routing through a ref keeps the EditorView from being rebuilt on every
  // keystroke's re-render, which would drop cursor, scroll and undo history.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [scheme, setScheme] = useState(() =>
    editorSchemeFrom(typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme')));

  // Follow live theme switches. The app writes data-theme on the root
  // (useTheme.applyTheme); observing it is decoupled from any context so this
  // component works wherever it is mounted.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setScheme(editorSchemeFrom(document.documentElement.getAttribute('data-theme')));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          // Markdown with fence-aware nesting: the ```html block inside an
          // applet gets real html/css/js highlighting AND tag/attribute
          // completion from the nested language, not flat-markdown treatment.
          markdown({ codeLanguages: languages }),
          autocompletion(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          themeCompartment.current.of(appletThemeExtensions(scheme)),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once per host. `value` is seeded here and synced below; scheme
    // swaps through the compartment rather than a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (the doc body arriving from its on-demand fetch)
  // are applied without clobbering an editor that already holds the same text
  // — replacing the doc mid-typing would reset cursor and undo.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(appletThemeExtensions(scheme)),
    });
  }, [scheme]);

  return (
    <div
      ref={hostRef}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      className="h-full w-full overflow-hidden rounded-md border border-border bg-muted/20 [&_.cm-editor]:h-full"
    />
  );
}
