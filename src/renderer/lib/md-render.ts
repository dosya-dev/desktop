// apps/desktop/src/renderer/lib/md-render.ts
//
// The text editor's live preview: Markdown (GitHub flavour: tables, task
// lists, strikethrough) to HTML with marked, then through DOMPurify before it
// may touch the DOM. The source is a file anyone in the workspace could have
// written, so the output is treated as hostile:
//
//   - no scripts, event handlers, inline styles, forms, frames or SVG;
//   - no class or id attributes, so a file cannot dress itself in the app's
//     own Tailwind classes (a full-window "fixed inset-0" cover) or clobber
//     globals by id;
//   - links keep only http(s) and mailto targets; the page opens them in the
//     system browser and never navigates the app window;
//   - images keep only http(s) and data:image sources (and the renderer CSP
//     still decides which hosts load);
//   - task-list boxes are read-only.

import { Marked } from "marked";
import DOMPurify, { type DOMPurify as Purifier } from "dompurify";

const marked = new Marked({ gfm: true, breaks: false, async: false });

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const IMAGE_SRC_RE = /^(https?:\/\/|data:image\/)/i;

let purifier: Purifier | null = null;
/** A private instance, so these settings never leak into another DOMPurify user. */
function getPurifier(): Purifier {
  purifier ??= DOMPurify(window);
  return purifier;
}

export function isPreviewLink(href: string | null): boolean {
  if (!href) return false;
  try {
    return LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

export function renderMarkdown(src: string): string {
  const html = marked.parse(src) as string;
  const fragment = getPurifier().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "iframe", "frame", "object", "embed", "button", "textarea", "select", "option", "link", "meta", "base"],
    FORBID_ATTR: ["style", "class", "id", "name", "srcset", "formaction", "action"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });

  for (const a of fragment.querySelectorAll("a")) {
    if (isPreviewLink(a.getAttribute("href"))) {
      a.setAttribute("rel", "noreferrer noopener");
      a.setAttribute("target", "_blank");
    } else {
      a.removeAttribute("href");
    }
  }
  for (const img of fragment.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!IMAGE_SRC_RE.test(src)) img.remove();
    else img.setAttribute("referrerpolicy", "no-referrer");
  }
  for (const input of fragment.querySelectorAll("input")) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else input.setAttribute("disabled", "");
  }

  const holder = document.createElement("div");
  holder.appendChild(fragment);
  return holder.innerHTML;
}
