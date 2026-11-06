// The source pane of the text editor: CodeMirror 6, uncontrolled. The page
// talks to it through an imperative handle (read the text, replace it, run a
// toolbar command) so a keystroke never round-trips through React state, and
// so component tests can stand a plain textarea in for it - jsdom cannot lay
// CodeMirror out.
import { useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
  type DecorationSet, type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen,
} from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { formatMarkdown, type MdFormat } from "@/lib/md-format";
import { useDir } from "@/lib/i18n";
import { editorTheme, markdownHighlight } from "./editor-theme";

export interface EditorHandle {
  getText(): string;
  /** Replace the whole document, as one undoable edit. */
  setText(text: string): void;
  format(kind: MdFormat): void;
  focus(): void;
  /** The element that scrolls, for scroll sync. */
  scroller(): HTMLElement | null;
  /** Open the find panel (or move focus back into it), on the replace field if asked. */
  openSearch(opts?: { replace?: boolean }): void;
  /** Close the find panel. False when it was not open, so Escape can mean "leave". */
  closeSearch(): boolean;
  searchOpen(): boolean;
}

export interface CodeEditorProps {
  ref?: React.Ref<EditorHandle>;
  /** Read once, at mount. Later changes go through the handle. */
  initialText: string;
  markdown: boolean;
  /** Accessible name of the text area, e.g. the file name. */
  label: string;
  /**
   * CodeMirror's own UI strings (the find panel's labels), keyed by their
   * English text as CodeMirror names them. Follows locale changes live.
   */
  phrases?: Record<string, string>;
  onChange(text: string): void;
  onCursor(pos: { line: number; col: number }): void;
}

const autoDir = Decoration.line({ attributes: { dir: "auto" } });

/** dir="auto" on every rendered line, so perLineTextDirection reads each line's own direction. */
function buildLineDirs(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      builder.add(line.from, line.from, autoDir);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const lineDirections = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildLineDirs(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildLineDirs(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Right to left only: each line in the direction of its own text (an English
 * line in an Arabic note reads left to right). Left-to-right languages keep the
 * editor exactly as it was.
 */
const linesFor = (dir: "ltr" | "rtl"): Extension => (dir === "rtl" ? lineDirections : []);

function applyFormat(view: EditorView, kind: MdFormat): boolean {
  const sel = view.state.selection.main;
  const edit = formatMarkdown(view.state.doc.toString(), sel.from, sel.to, kind);
  view.dispatch({
    changes: edit.changes,
    selection: edit.selection,
    scrollIntoView: true,
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

function openSearch(view: EditorView, replace = false): boolean {
  view.focus();
  openSearchPanel(view);
  // The panel selects its search field on mount; say so explicitly, so focus
  // lands in the bar however it was opened (and on Replace when asked).
  const field = view.dom.querySelector<HTMLInputElement>(replace ? ".cm-search input[name=replace]" : ".cm-search [main-field]");
  field?.focus();
  field?.select();
  return true;
}

/**
 * CodeMirror's find keys, minus Go to line (Mod-Alt-g): its dialog has
 * labels of its own that are not translated, and the editor has the line in
 * the status bar already. Replace gets a key of its own: Mod-Alt-f, plus
 * Ctrl-h off macOS (Cmd-H hides the app there).
 */
const findKeys = [
  ...searchKeymap.filter((b) => b.key !== "Mod-Alt-g"),
  { key: "Mod-Alt-f", run: (v: EditorView) => openSearch(v, true), preventDefault: true },
  { win: "Ctrl-h", linux: "Ctrl-h", run: (v: EditorView) => openSearch(v, true), preventDefault: true },
];

export function CodeEditor({ ref, initialText, markdown: isMarkdown, label, phrases, onChange, onCursor }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dir = useDir();
  const direction = useRef(new Compartment());
  const phrasesSlot = useRef(new Compartment());
  const callbacks = useRef({ onChange, onCursor });
  callbacks.current = { onChange, onCursor };

  useEffect(() => {
    if (!hostRef.current) return;
    const reportCursor = (state: EditorState) => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      callbacks.current.onCursor({ line: line.number, col: head - line.from + 1 });
    };
    const formatting = isMarkdown
      ? [Prec.high(keymap.of([
          { key: "Mod-b", run: (v) => applyFormat(v, "bold") },
          { key: "Mod-i", run: (v) => applyFormat(v, "italic") },
          { key: "Mod-k", run: (v) => applyFormat(v, "link") },
        ]))]
      : [];
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          // Prose: CodeMirror reads each line's own direction (cursor motion,
          // selection); in a right-to-left language the lines carry dir="auto".
          EditorView.perLineTextDirection.of(true),
          direction.current.of(linesFor(dir)),
          EditorView.contentAttributes.of({ "aria-label": label }),
          ...formatting,
          search({ top: true }),
          highlightSelectionMatches(),
          phrasesSlot.current.of(EditorState.phrases.of(phrases ?? {})),
          keymap.of([...findKeys, ...defaultKeymap, ...historyKeymap]),
          ...(isMarkdown ? [markdown(), markdownHighlight] : []),
          editorTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) reportCursor(u.state);
          }),
        ],
      }),
    });
    viewRef.current = view;
    reportCursor(view.state);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once per mount: the page remounts the editor per file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The language can change while the editor is open.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: direction.current.reconfigure(linesFor(dir)) });
  }, [dir]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: phrasesSlot.current.reconfigure(EditorState.phrases.of(phrases ?? {})) });
  }, [phrases]);

  useImperativeHandle(ref, () => ({
    getText: () => viewRef.current?.state.doc.toString() ?? "",
    setText: (text) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.replace" });
    },
    format: (kind) => { if (viewRef.current) applyFormat(viewRef.current, kind); },
    focus: () => viewRef.current?.focus(),
    scroller: () => viewRef.current?.scrollDOM ?? null,
    openSearch: (opts) => { if (viewRef.current) openSearch(viewRef.current, opts?.replace === true); },
    closeSearch: () => {
      const view = viewRef.current;
      if (!view || !searchPanelOpen(view.state)) return false;
      closeSearchPanel(view);
      return true;
    },
    searchOpen: () => (viewRef.current ? searchPanelOpen(viewRef.current.state) : false),
  }), []);

  return <div ref={hostRef} data-testid="code-editor" className="h-full min-h-0 min-w-0 select-text" />;
}
