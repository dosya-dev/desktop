// CodeMirror's look, built only from the app's --color-* aliases so it follows
// all eight themes in light and dark without knowing which one is active: the
// values are CSS variable references, resolved by the browser at paint time.
// One theme therefore serves both modes; nothing here is a fixed color.
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** Markdown punctuation (#, **, -, >, backticks): present but quiet. */
const MARKUP = "color-mix(in oklab, var(--color-text-secondary) 70%, var(--color-bg))";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--color-bg)",
    color: "var(--color-text)",
    fontSize: "13px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.75",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--color-primary)",
    padding: "16px 0",
  },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-primary)", // rtl-ok: physical geometry, caret
    borderLeftWidth: "1.5px", // rtl-ok: physical geometry, caret
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--color-primary) 22%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--color-bg-secondary) 55%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg)",
    color: "var(--color-text-muted)",
    border: "none",
    borderInlineEnd: "1px solid var(--color-border)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
  },
  ".cm-lineNumbers .cm-gutterElement": { paddingInlineStart: "12px", paddingInlineEnd: "10px", minWidth: "40px" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--color-text-secondary)",
  },

  // ── Find / replace ──────────────────────────────────────
  // CodeMirror's base theme paints the panel and its controls in fixed greys
  // and gradients; every one of those is replaced here with the app's tokens
  // so the bar reads like the editor's toolbar in every theme.
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--color-warning) 28%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--color-warning) 55%, transparent)",
    outline: "1px solid var(--color-warning)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklab, var(--color-primary) 14%, transparent)",
  },
  ".cm-searchMatch .cm-selectionMatch": { backgroundColor: "transparent" },
  ".cm-panels": {
    backgroundColor: "var(--color-bg-secondary)",
    color: "var(--color-text)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border)" },
  // CodeMirror lays the bar out inline with a <br> before the replace row,
  // so it stays inline and wraps on its own when the window is narrow. The
  // spacing is logical, so in right to left the bar mirrors with the page.
  ".cm-panel.cm-search": {
    padding: "5px 0",
    paddingInlineStart: "12px",
    paddingInlineEnd: "40px",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "12px",
    "& input, & button, & label": { margin: "3px 0", marginInlineStart: "0", marginInlineEnd: "6px", verticalAlign: "middle" },
    "& label": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      marginInlineStart: "4px",
      fontSize: "12px",
      color: "var(--color-text-secondary)",
      cursor: "pointer",
    },
    "& label input[type=checkbox]": {
      margin: "0",
      accentColor: "var(--color-primary)",
    },
    "& button[name=close]": {
      position: "absolute",
      top: "6px",
      // CodeMirror's base theme pins it with left in right to left; the
      // logical pair replaces both its sides.
      insetInlineStart: "auto",
      insetInlineEnd: "8px",
      width: "24px",
      height: "24px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "6px",
      border: "none",
      backgroundColor: "transparent",
      color: "var(--color-text-muted)",
      fontSize: "16px",
      lineHeight: "1",
      cursor: "pointer",
    },
    "& button[name=close]:hover": {
      backgroundColor: "var(--color-bg-tertiary)",
      color: "var(--color-text)",
    },
    "& button[name=close]:focus-visible": {
      outline: "none",
      boxShadow: "0 0 0 1px var(--color-primary)",
    },
  },
  ".cm-textfield": {
    width: "220px",
    maxWidth: "100%",
    height: "26px",
    padding: "0 8px",
    borderRadius: "6px",
    border: "1px solid var(--color-border)",
    backgroundColor: "var(--color-bg)",
    color: "var(--color-text)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    outline: "none",
  },
  ".cm-textfield::placeholder": { color: "var(--color-text-muted)" },
  ".cm-textfield:focus": {
    borderColor: "var(--color-primary)",
    boxShadow: "0 0 0 1px var(--color-primary)",
  },
  ".cm-button": {
    height: "26px",
    padding: "0 10px",
    borderRadius: "6px",
    border: "1px solid var(--color-border)",
    backgroundColor: "var(--color-bg)",
    backgroundImage: "none",
    color: "var(--color-text)",
    fontSize: "12px",
    fontWeight: "500",
    cursor: "pointer",
  },
  ".cm-button:hover": { backgroundColor: "var(--color-bg-tertiary)" },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--color-bg-tertiary)" },
  ".cm-button:focus-visible": {
    outline: "none",
    borderColor: "var(--color-primary)",
    boxShadow: "0 0 0 1px var(--color-primary)",
  },
});

export const markdownHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", color: "var(--color-text)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--color-primary)" },
  { tag: tags.monospace, color: "var(--color-primary)" },
  { tag: tags.quote, color: "var(--color-text-secondary)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: MARKUP },
]));
