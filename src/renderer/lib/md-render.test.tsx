// The editor preview: marked (GFM) then DOMPurify. The file is untrusted -
// anyone with access to the workspace wrote it - so these pin what may and
// may not reach the DOM.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./md-render";

function dom(md: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(md);
  return el;
}

describe("renderMarkdown", () => {
  it("renders headings, emphasis and code", () => {
    const el = dom("# Title\n\nSome **bold** and _italic_ and `code`.\n\n```\nblock\n```");
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    expect(el.querySelector("em")?.textContent).toBe("italic");
    expect(el.querySelector("p code")?.textContent).toBe("code");
    expect(el.querySelector("pre code")?.textContent).toBe("block\n");
  });

  it("renders GFM tables, strikethrough and task lists", () => {
    const el = dom("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] open");
    expect(el.querySelectorAll("table td")).toHaveLength(2);
    expect(el.querySelector("del")?.textContent).toBe("gone");
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    // Read-only: ticking a box in the preview would not change the file.
    expect([...boxes].every((b) => b.disabled)).toBe(true);
  });

  it("strips scripts, event handlers and inline styles", () => {
    const el = dom('<script>alert(1)</script>\n\n<img src="https://x.test/a.png" onerror="alert(1)">\n\n<p style="position:fixed" onclick="x()">hi</p>');
    expect(el.querySelector("script")).toBeNull();
    expect(el.innerHTML).not.toMatch(/onerror|onclick|alert|position:fixed/);
  });

  it("drops class names, so a file cannot borrow the app's own styling", () => {
    const el = dom('<div class="fixed inset-0 z-50">cover</div>');
    expect(el.innerHTML).not.toContain("class=");
  });

  it("removes javascript: and other non-web link targets but keeps the text", () => {
    const el = dom("[click](javascript:alert(1)) [data](data:text/html,x) [ok](https://dosya.dev) [mail](mailto:a@b.c)");
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([null, null, "https://dosya.dev", "mailto:a@b.c"]);
    expect(el.textContent).toContain("click");
    expect(el.innerHTML).not.toContain("javascript:");
  });

  it("keeps http(s) and data images, drops anything else", () => {
    const el = dom("![a](https://x.test/a.png) ![b](data:image/png;base64,AAAA) ![c](file:///etc/passwd) ![d](javascript:x)");
    const srcs = [...el.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["https://x.test/a.png", "data:image/png;base64,AAAA"]);
  });

  it("refuses forms, iframes and svg", () => {
    const el = dom('<form action="https://x.test"><input name="p"></form><iframe src="https://x.test"></iframe><svg><script>x</script></svg>');
    expect(el.querySelector("form, iframe, svg, input:not([type=checkbox])")).toBeNull();
  });
});
