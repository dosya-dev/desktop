// The real CodeMirror wrapper, as far as jsdom lets it run (no layout): it
// mounts, reports changes and the cursor, and runs toolbar commands through
// the handle as single edits.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CodeEditor, type EditorHandle } from "./CodeEditor";
import { renderInLocale } from "../../test-utils/rtl";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
});

function mount(initialText: string, markdown = true, phrases?: Record<string, string>) {
  const ref = createRef<EditorHandle>();
  const onChange = vi.fn();
  const onCursor = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<CodeEditor ref={ref} initialText={initialText} markdown={markdown} label="plan.md" phrases={phrases} onChange={onChange} onCursor={onCursor} />);
  });
  return { ref, onChange, onCursor };
}

describe("CodeEditor", () => {
  it("shows the text with line numbers and an accessible name", () => {
    const { ref, onCursor } = mount("# Title\nbody");
    expect(ref.current!.getText()).toBe("# Title\nbody");
    expect(container!.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(container!.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("plan.md");
    expect(onCursor).toHaveBeenCalledWith({ line: 1, col: 1 });
  });

  it("runs a toolbar command as one edit and reports the change", () => {
    const { ref, onChange } = mount("hello");
    act(() => ref.current!.format("heading"));
    expect(ref.current!.getText()).toBe("# hello");
    expect(onChange).toHaveBeenLastCalledWith("# hello");
  });

  it("replaces the whole text for a restored draft", () => {
    const { ref, onChange } = mount("old");
    act(() => ref.current!.setText("new text"));
    expect(ref.current!.getText()).toBe("new text");
    expect(onChange).toHaveBeenLastCalledWith("new text");
  });

  it("styles itself from theme tokens only", () => {
    mount("x");
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("\n")
      + Array.from(document.adoptedStyleSheets ?? []).flatMap((sh) => Array.from(sh.cssRules).map((r) => r.cssText)).join("\n");
    expect(css).toContain("var(--color-primary)");
    expect(css).toContain("var(--font-mono)");
  });

  it("in a right-to-left language each line takes the direction of its own text; in English the lines are as they were", async () => {
    const text = "\u0645\u0644\u0627\u062d\u0638\u0627\u062a\nThis line is English only.";
    const lines = (c: HTMLElement) => Array.from(c.querySelectorAll(".cm-line")).map((l) => l.getAttribute("dir"));
    const ar = await renderInLocale(<CodeEditor initialText={text} markdown label="notes.md" onChange={() => {}} onCursor={() => {}} />, "ar");
    expect(lines(ar.container)).toEqual(["auto", "auto"]);
    ar.unmount();
    const en = await renderInLocale(<CodeEditor initialText={text} markdown label="notes.md" onChange={() => {}} onCursor={() => {}} />, "en");
    expect(lines(en.container)).toEqual([null, null]);
    en.unmount();
  });

  it("opens the find panel, focused on the search field, and closes it again", () => {
    const { ref } = mount("one two one", false);
    expect(ref.current!.searchOpen()).toBe(false);
    act(() => ref.current!.openSearch());
    expect(ref.current!.searchOpen()).toBe(true);
    const field = container!.querySelector<HTMLInputElement>(".cm-search input[name=search]");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    let closed = false;
    act(() => { closed = ref.current!.closeSearch(); });
    expect(closed).toBe(true);
    expect(ref.current!.searchOpen()).toBe(false);
    expect(container!.querySelector(".cm-search")).toBeNull();
    // Nothing to close: says so, so Escape can fall through to leaving.
    act(() => { closed = ref.current!.closeSearch(); });
    expect(closed).toBe(false);
  });

  it("opens straight into the replace field when asked", () => {
    const { ref } = mount("one two one", false);
    act(() => ref.current!.openSearch({ replace: true }));
    expect(document.activeElement).toBe(container!.querySelector(".cm-search input[name=replace]"));
  });

  it("finds and replaces every match as one edit", () => {
    const { ref, onChange } = mount("one two one", false);
    act(() => ref.current!.openSearch());
    const panel = container!.querySelector(".cm-search")!;
    const set = (name: string, value: string) => {
      const input = panel.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
      input.value = value;
      act(() => { input.dispatchEvent(new Event("change")); });
    };
    set("search", "one");
    set("replace", "three");
    act(() => panel.querySelector<HTMLButtonElement>("button[name=replaceAll]")!.click());
    expect(ref.current!.getText()).toBe("three two three");
    expect(onChange).toHaveBeenLastCalledWith("three two three");
  });

  it("labels the find panel in the app's language", () => {
    const { ref } = mount("x", false, {
      Find: "Bul", Replace: "Değiştir", next: "sonraki", previous: "önceki", all: "tümü",
      "match case": "büyük/küçük harf", regexp: "düzenli ifade", "by word": "sözcük",
      replace: "değiştir", "replace all": "tümünü değiştir", close: "kapat",
    });
    act(() => ref.current!.openSearch());
    const panel = container!.querySelector(".cm-search")!;
    expect(panel.querySelector("input[name=search]")!.getAttribute("placeholder")).toBe("Bul");
    expect(panel.querySelector("input[name=replace]")!.getAttribute("aria-label")).toBe("Değiştir");
    expect(panel.querySelector("button[name=next]")!.textContent).toBe("sonraki");
    expect(panel.querySelector("button[name=replaceAll]")!.textContent).toBe("tümünü değiştir");
    expect(panel.querySelector("button[name=close]")!.getAttribute("aria-label")).toBe("kapat");
    expect(panel.textContent).toContain("büyük/küçük harf");
  });

  it("styles the find panel and match marks from theme tokens, not CodeMirror's greys", () => {
    const { ref } = mount("x", false);
    act(() => ref.current!.openSearch());
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("\n")
      + Array.from(document.adoptedStyleSheets ?? []).flatMap((sh) => Array.from(sh.cssRules).map((r) => r.cssText)).join("\n");
    expect(css).toMatch(/\.cm-searchMatch[^{]*\{[^}]*var\(--color-warning\)/);
    expect(css).toMatch(/\.cm-panels[^{]*\{[^}]*var\(--color-bg-secondary\)/);
  });

  it("lays the find bar out with logical sides, so it mirrors in right to left", () => {
    const { ref } = mount("x", false);
    act(() => ref.current!.openSearch());
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("\n")
      + Array.from(document.adoptedStyleSheets ?? []).flatMap((sh) => Array.from(sh.cssRules).map((r) => r.cssText)).join("\n");
    const rule = (sel: RegExp) => css.match(new RegExp(`${sel.source}\\s*\\{([^}]*)\\}`, "g"))?.join("\n") ?? "";
    const panel = rule(/\.cm-panel\.cm-search/);
    expect(panel).toMatch(/padding-inline-start:\s*12px/);
    expect(panel).toMatch(/padding-inline-end:\s*40px/);
    const close = rule(/\.cm-panel\.cm-search button\[name=close\]/);
    expect(close).toMatch(/inset-inline-end:\s*8px/);
    expect(close).toMatch(/inset-inline-start:\s*auto/);
    expect(close).not.toMatch(/(^|[;{\s])right:/);
    expect(rule(/\.cm-panel\.cm-search label/)).not.toMatch(/margin-left/);
  });
});
