// Reader page glue: assembles base64 chunks sent from the host RN app into
// a book file, opens it with the vendored foliate-js <foliate-view>, and
// bridges navigation/relocation/errors back to the host via
// window.ReactNativeWebView.postMessage.
//
// Globals below (__dosyaInit/__dosyaChunk/__dosyaOpen/__dosyaGoTo/__dosyaApply
// /__dosyaSearch/__dosyaSearchClear) and the postMessage shapes are a fixed
// contract with the host - do not rename.

import "../foliate-js/view.js";
import { makeTxtBook } from "./txt.js";

const post = (msg) => window.ReactNativeWebView?.postMessage(JSON.stringify(msg));

// The host now resolves theme ids to concrete colors itself (see
// src/reader/readerThemes.ts) and sends them directly - the page has no
// notion of theme names any more, it just paints whatever bg/fg it's given.
// `color-scheme` still needs a light/dark verdict (it drives native form
// control and scrollbar rendering inside the section iframes), so derive it
// from the resolved background's perceived luminance instead of a theme
// name.
function relativeLuminance(color) {
  // Accepts "#rgb", "#rrggbb" or "rgb()/rgba()". The host resolves the app's
  // theme through getComputedStyle, which always answers in rgb(), while the
  // reader's own palettes are hex.
  let r, g, b;
  const rgb = /rgba?\(([^)]+)\)/.exec(color);
  if (rgb) {
    const parts = rgb[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    [r, g, b] = parts;
  } else {
    let hex = String(color).replace("#", "");
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  }
  if ([r, g, b].some((v) => !Number.isFinite(v))) return 1;
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const readerCss = (s) => `
  html { color-scheme: ${relativeLuminance(s.bg) < 0.5 ? "dark" : "light"}; font-size: ${s.fontSizePct}%; }
  body { background: ${s.bg} !important; color: ${s.fg}; }
  a, a:visited { color: inherit; }
`;

let config = null;
let view = null;
let settings = null;
const chunks = [];
let received = 0;
// Bumped on every __dosyaSearch call and on __dosyaSearchClear, so a search
// generator started for a since-superseded (or since-cleared) query can
// tell it's stale and stop posting - without this, typing "cat" then
// "cathedral" past the host's debounce runs two whole-book search
// generators concurrently and their results/done/error messages interleave
// on the host side.
let searchGen = 0;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function flattenToc(items, depth = 0, out = []) {
  for (const item of items ?? []) {
    out.push({ label: item.label ?? "", href: item.href ?? "", depth });
    flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

function applySettings(next) {
  settings = next;
  // Set directly (not via readerCss's injected stylesheet) so the native
  // page-behind-the-iframe background updates synchronously and page turns
  // don't flash the previous theme's color before the new stylesheet lands.
  document.documentElement.style.background = next.bg;
  view?.renderer?.setStyles?.(readerCss(next));
}

function onRelocate(e) {
  const d = e.detail ?? {};
  post({
    type: "relocated",
    location: d.cfi ?? String(d.fraction ?? 0),
    fraction: d.fraction ?? 0,
    section: d.tocItem?.label ?? null,
  });
}

// The rendered book content lives inside a sandboxed same-origin <iframe>
// created by vendor/foliate-js/paginator.js (Paginator's `#iframe`), which
// sits inside <foliate-view>'s closed shadow root. A click on that content
// does NOT bubble out to a listener on the <foliate-view> element itself
// (iframes are separate browsing contexts) - only clicks on chrome outside
// the iframe would. So tap-to-turn-page/tap-to-toggle-chrome has to attach
// to each rendered section's own `doc`, exactly like vendor/foliate-js's own
// reference reader.js does for its keydown handler
// (`#onLoad({ detail: { doc } }) { doc.addEventListener('keydown', ...) }`).
// The View re-emits the renderer's `load` event as `{detail: {doc, index}}`
// once per section load (see view.js's `#onLoad`/`#emit('load', ...)`), so
// re-attach on every `load` rather than once.
function onLoad(e) {
  const doc = e.detail?.doc;
  if (!doc) return;
  doc.addEventListener("click", (ev) => {
    // vendor/foliate-js/view.js's own #handleLinks attaches a click listener
    // to this same `doc` before the `load` event we're responding to ever
    // fires (see #onLoad: #handleLinks(doc, index) runs, then #emit('load',
    // ...)). Both listeners see every click, and preventDefault() in one
    // doesn't stop the other from also running - so without this early
    // return, tapping a link would ALSO be treated as a page-turn/chrome-
    // toggle tap by the code below. Anchor clicks are foliate's to handle
    // (internal goTo or the external-link event wired up in __dosyaOpen).
    if (ev.target?.closest?.("a[href]")) return;
    const width = doc.defaultView?.innerWidth || window.innerWidth;
    const x = ev.clientX / width;
    if (x < 0.25) view.renderer?.prev?.();
    else if (x > 0.75) view.renderer?.next?.();
    else post({ type: "tap" });
  });
}

// foliate-js emits this (cancelable) instead of navigating itself when a
// link resolves to an external URL (see view.js #handleLinks: it only calls
// `globalThis.open(href_, '_blank')` if this event's listeners don't cancel
// it). `globalThis.open` inside this WebView would either no-op or spawn an
// unwanted in-app browser view, so cancel it here and hand the URL to the
// host instead - the host opens it in the system browser via Linking.
function onExternalLink(e) {
  e.preventDefault();
  const href = e.detail?.href_ ?? e.detail?.a?.getAttribute?.("href") ?? "";
  if (href) post({ type: "externalLink", href });
}

window.__dosyaInit = (c) => { config = c; applySettings({ fontSizePct: c.fontSizePct, bg: c.bg, fg: c.fg }); };
window.__dosyaChunk = (b64) => {
  try {
    const b = base64ToBytes(b64);
    chunks.push(b);
    received += b.length;
  } catch (err) {
    // A malformed chunk means the transfer is corrupted and the book can
    // never open correctly, so this is a legitimate fatal error, not
    // something to swallow and degrade gracefully from.
    post({ type: "error", message: String(err?.message ?? err) });
  }
};
window.__dosyaApply = (s) => applySettings(s);
// Deliberately swallow goTo failures: a stale bookmark/CFI (e.g. from a
// re-imported or slightly different copy of the book) should just fail to
// jump, not drop the whole reader into the terminal error screen.
window.__dosyaGoTo = (target) => { view?.goTo(target)?.catch?.(() => {}); };

// Desktop-only additions. The mobile host turns pages by tapping the rendered
// document's left/right quarter (see onLoad above); a desktop reader also needs
// toolbar buttons and arrow keys, and the renderer lives inside <foliate-view>'s
// closed shadow root, so the host cannot reach it without these.
window.__dosyaPrev = () => { view?.renderer?.prev?.(); };
window.__dosyaNext = () => { view?.renderer?.next?.(); };

const SEARCH_RESULT_CAP = 100;

// vendor/foliate-js/search.js's makeExcerpt (see its CONTEXT_LENGTH-bounded
// snippet builder) returns `{ pre, match, post }` - three plain-text pieces
// around the hit, with a leading/trailing "…" already included when the
// surrounding text was truncated - not a single string. The host's
// SearchHit type (bridge.ts) is `{ cfi, excerpt: string }`, so flatten the
// three pieces back into one string here on the page side before posting.
const excerptText = (excerpt) => `${excerpt?.pre ?? ""}${excerpt?.match ?? ""}${excerpt?.post ?? ""}`;

// vendor/foliate-js/view.js's View#search(opts) is an async generator, not a
// plain search(query) call:
//   - opts = { query } (no `index`) makes it search the WHOLE book via the
//     private #searchBook generator (view.js:530-541), not a single section.
//   - it yields a MIX of progress pings (`{ progress }`, no `cfi`/`subitems`
//     - dropped here, they're for a search-in-progress UI we don't have) and
//     per-section result batches (`{ label, subitems: [{ cfi, excerpt }] }`,
//     view.js:558-567) as each section finishes being searched.
//   - it always finishes with the literal string `'done'` (view.js:577),
//     not an object - there is no separate "search finished" event to
//     listen for.
// This is the real, load-bearing shape - the task's `{ type: "searchResults",
// items: [...] }` / `{ type: "searchDone" }` postMessage protocol is this
// generator's output reshaped into what the host expects, not a 1:1 mirror
// of a `search(query)` the library doesn't have.
// Search failures must never reach the host as a plain `{type:"error"}` -
// readerReducer treats that as terminal and swaps the whole reader to the
// "Couldn't open this book" screen (see bridge.ts), which would kill a
// perfectly healthy book over nothing worse than a failed search. Report
// search-side failures (including "not ready yet") as the distinct
// `searchError` type instead, which the host routes to the search sheet.
window.__dosyaSearch = async (query) => {
  const gen = ++searchGen;
  // ReaderChrome renders above the "preparing" overlay, so a user can open
  // Search while the book is still being delivered/opened - `view` is only
  // created at the end of __dosyaOpen. Without this guard, `view.search`
  // below throws on the null `view` and (before this fix) that fell through
  // to the generic error path.
  if (!view) {
    post({ type: "searchError", gen, message: "The book is still loading - try searching again in a moment." });
    return;
  }
  try {
    let count = 0;
    for await (const result of view.search({ query })) {
      // A newer __dosyaSearch call or a __dosyaSearchClear bumped searchGen
      // since this generator started - stop immediately and post nothing
      // more (including the "done" below), so its stale results/done can't
      // interleave with (or prematurely stop the spinner for) whatever
      // superseded it.
      if (gen !== searchGen) return;
      if (result === "done") break;
      if (!result?.subitems?.length) continue; // a bare `{ progress }` ping
      const room = SEARCH_RESULT_CAP - count;
      if (room <= 0) break;
      const items = result.subitems
        .slice(0, room)
        .map(({ cfi, excerpt }) => ({ cfi, excerpt: excerptText(excerpt) }));
      count += items.length;
      // `gen` rides along on every message so the host can tell a batch
      // this generator already had in flight over the bridge apart from
      // one that actually belongs to whatever query is current there now -
      // see BookReader.tsx's currentGenRef/pendingGenRef.
      post({ type: "searchResults", gen, items });
      if (count >= SEARCH_RESULT_CAP) break;
    }
    if (gen === searchGen) post({ type: "searchDone", gen });
  } catch (err) {
    if (gen === searchGen) post({ type: "searchError", gen, message: String(err?.message ?? err) });
  }
};

// View#clearSearch() (view.js:579-583) removes the search-highlight
// overlayers `search()` drew as results came in (it also does this
// internally as its own first step, but a user closing the search sheet
// without running a new query still needs a way to clear the old
// highlights).
window.__dosyaSearchClear = () => {
  // Cancel any in-flight __dosyaSearch generator - closing the sheet (or
  // its Done button, which calls this) must stop stale work, not just hide
  // its output.
  searchGen++;
  try {
    view?.clearSearch?.();
  } catch (err) {
    post({ type: "searchError", message: String(err?.message ?? err) });
  }
};

/**
 * Two pages side by side when the shape allows it, like a physical book.
 *
 * foliate's paginator already defaults max-column-count to 2 and drops to 1 in
 * portrait, so this only has to decide when the container counts as landscape
 * and keep the divider in step. Apple Books behaves the same way: a spread when
 * there is room for one, a single page when there is not.
 */
const SPREAD_MIN_WIDTH = 820;

function isSpread() {
  return window.innerWidth >= SPREAD_MIN_WIDTH && window.innerWidth > window.innerHeight;
}

/**
 * The gutter line between the two pages.
 *
 * foliate draws no divider, and its paginator lives in a CLOSED shadow root, so
 * this is drawn over the top instead of inside it. Hidden in single-page mode -
 * a line down the middle of one page would just look like a rendering fault.
 */
function ensureDivider() {
  let el = document.getElementById("dosya-gutter");
  if (!el) {
    el = document.createElement("div");
    el.id = "dosya-gutter";
    el.setAttribute("aria-hidden", "true");
    document.body.append(el);
  }
  const on = isSpread();
  el.style.display = on ? "block" : "none";
  return on;
}

function applySpread() {
  const on = ensureDivider();
  // 1 rather than 2: the paginator's own portrait rule would already give one
  // column, but saying it explicitly keeps the divider and the layout deciding
  // on exactly the same condition.
  view?.renderer?.setAttribute?.("max-column-count", on ? "2" : "1");
}

window.__dosyaOpen = async () => {
  try {
    const buffer = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buffer.set(c, off); off += c.length; }
    chunks.length = 0;

    view = document.createElement("foliate-view");
    document.body.append(view);
    view.addEventListener("relocate", onRelocate);
    view.addEventListener("load", onLoad);
    view.addEventListener("external-link", onExternalLink);

    if (config.format === "txt") {
      const text = new TextDecoder("utf-8").decode(buffer);
      await view.open(makeTxtBook(text, config.name));
    } else {
      await view.open(new File([buffer], config.name));
    }
    view.renderer?.setAttribute?.("flow", "paginated");
    // Turns on the paginator's eased page-turn animation. Without this
    // attribute, vendor/foliate-js/paginator.js's #scrollTo assigns the new
    // scroll offset outright and pages snap between positions with no motion;
    // with it, a page turn interpolates over 300ms (easeOutQuad). It gates
    // BOTH tap-zone turns (prev/next reach #scrollToPage(page, 'page', true))
    // and swipe snapping (reason === 'snap'), and it also drops #turnPage's
    // 100ms settle wait, since the animation itself now covers that time.
    view.renderer?.setAttribute?.("animated", "");
    applySpread();
    window.addEventListener("resize", applySpread);
    applySettings(settings);
    post({ type: "toc", items: flattenToc(view.book?.toc) });
    if (config.location) {
      try { await view.init({ lastLocation: config.location }); }
      catch { view.renderer?.next?.(); }
    } else {
      view.renderer?.next?.();
    }
  } catch (err) {
    post({ type: "error", message: String(err?.message ?? err) });
  }
};

post({ type: "loaded" });
