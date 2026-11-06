// Task 9 of the right-to-left programme: media stays left to right, the editor
// and viewers follow the page, the map moves its controls.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderInLocale, type RenderResult } from "../test-utils/rtl";

vi.mock("@dosya-dev/video-player/react", () => ({
  DosyaVideo: ({ className }: { className?: string }) => <div data-testid="dp-root" className={className} />,
}));
vi.mock("@dosya-dev/video-player/skin.css", () => ({}));
vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  apiBase: () => "https://api.test",
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/components/files/audio/usePeaks", () => ({
  usePeaks: () => ({ peaks: new Float32Array(900).fill(0.5), state: "ready" }),
}));
vi.mock("@/components/files/audio/useAudioTags", () => ({ useAudioTags: () => ({ tags: {}, artworkUrl: null }) }));

// maplibre is mocked so the control positions can be read back.
const map = vi.hoisted(() => ({ controls: [] as { kind: string; pos: string }[], removed: [] as string[] }));
vi.mock("maplibre-gl", () => {
  class Map {
    on() { return this; }
    once() { return this; }
    off() { return this; }
    remove() {}
    resize() {}
    addControl(c: { kind: string }, pos: string) { map.controls.push({ kind: c.kind, pos }); }
    removeControl(c: { kind: string }) { map.removed.push(c.kind); }
    getBounds() { return { getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85 }; }
    loaded() { return true; }
    isStyleLoaded() { return true; }
    getZoom() { return 2; }
    getCenter() { return { lng: 0, lat: 0 }; }
    queryRenderedFeatures() { return []; }
    getContainer() { return document.createElement("div"); }
    setStyle() {}
    getCanvas() { return document.createElement("canvas"); }
    fitBounds() {}
  }
  class NavigationControl { kind = "nav"; }
  class AttributionControl { kind = "attr"; }
  class Marker { setLngLat() { return this; } addTo() { return this; } remove() {} getElement() { return document.createElement("div"); } }
  const lib = { Map, NavigationControl, AttributionControl, Marker, addProtocol: vi.fn() };
  return { default: lib, ...lib };
});
vi.mock("pmtiles", () => ({ Protocol: class { tile() {} } }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspace: () => ({ active: { id: "w1" } }) }));
vi.mock("@/lib/map/map-pins", () => ({ fetchMapPins: vi.fn(async () => ({ pins: [], counts: { gps: 0, approximate: 0, pending: 0 } })) }));
vi.mock("@/lib/map/map-style", () => ({ buildMapStyle: () => ({ version: 8, sources: {}, layers: [] }), checkBasemapAvailable: async () => false }));

const { VideoPlayer } = await import("@/components/files/VideoPlayer");
const { AudioPlayer } = await import("@/components/files/audio/AudioPlayer");
const { Waveform } = await import("@/components/files/audio/Waveform");
const { QueuePanel } = await import("@/components/files/audio/QueuePanel");
const { LyricsPanel } = await import("@/components/files/audio/LyricsPanel");
const { BookViewer } = await import("@/components/files/BookViewer");
const { OfficePreview } = await import("@/components/files/OfficePreview");
const { FileViewer } = await import("@/components/files/FileViewer");
const { EditorPage } = await import("@/pages/EditorPage");
const { MapPage } = await import("@/pages/MapPage");

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

let mounted: RenderResult | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  map.controls = []; map.removed = [];
  vi.unstubAllGlobals();
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const read = (p: string) => readFileSync(resolve(__dirname, "../../..", p), "utf8");
const file = (id: string, name: string, extra: object = {}) =>
  ({ id, name, size_bytes: 1000, mime_type: "audio/mpeg", extension: name.split(".").pop(), folder_id: null, ...extra }) as never;

describe("video", () => {
  it("keeps the player inside a left-to-right wrapper in ar", async () => {
    mounted = await renderInLocale(
      <VideoPlayer file={file("f1", "clip.mp4")} rawUrl="/raw" onDownload={() => {}} />, "ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.querySelector('[data-testid="dp-root"]')!.closest('[dir="ltr"]')).not.toBeNull();
  });

  it("gives the report popover and shortcuts panel the page direction", () => {
    expect(read("src/renderer/styles/index.css")).toContain('[dir="rtl"] :is(.dp-report, .dp-keys-panel) { direction: rtl; }');
    expect(read("vendor/video-player/report/popover.ts")).toContain("dp-report");
  });
});

describe("audio", () => {
  it("renders transport and timeline inside left-to-right containers in ar, the tabs not", async () => {
    mounted = await renderInLocale(
      <AudioPlayer file={file("a", "one.mp3")} files={[file("a", "one.mp3"), file("b", "two.mp3")]}
        rawUrl="/raw" downloadUrl="/dl" version={undefined} onNavigate={() => {}} />, "ar");
    const body = document.body;
    expect(body.querySelector(".lucide-skip-back")!.closest('[dir="ltr"]')).not.toBeNull();
    expect(body.querySelector('[role="slider"]')!.closest('[dir="ltr"]')).not.toBeNull();
    expect(body.querySelector("input[type=range]")!.closest('[dir="ltr"]')).not.toBeNull();
    expect(body.querySelector('[role="tab"]')!.closest('[dir="ltr"]')).toBeNull();
  });

  it("seeks back five seconds on ArrowLeft in ar", async () => {
    const onSeek = vi.fn();
    mounted = await renderInLocale(
      <Waveform peaks={new Float32Array(100).fill(0.5)} position={30} duration={100} loop={null} onSeek={onSeek} />, "ar");
    const slider = document.querySelector('[role="slider"]')!;
    act(() => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(onSeek).toHaveBeenCalledWith(25);
    act(() => { slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(onSeek).toHaveBeenLastCalledWith(35);
    expect(slider.closest('[dir="ltr"]')).not.toBeNull();
  });

  it("lets queue names and lyrics lines pick their own direction", async () => {
    mounted = await renderInLocale(
      <QueuePanel queue={[file("a", "שיר.mp3")]} activeIndex={0} playing={false} folder="" onPick={() => {}} />, "ar");
    const name = [...document.querySelectorAll("span.truncate")].find((s) => s.textContent === "שיר")!;
    expect(name.getAttribute("dir")).toBe("auto");
    mounted.unmount();
    mounted = await renderInLocale(<LyricsPanel lines={[{ t: 0, line: "مرحبا" }]} synced position={0} />, "ar");
    expect(document.querySelector("li")!.getAttribute("dir")).toBe("auto");
  });
});

describe("text editor", () => {
  it("builds the theme from logical properties", () => {
    const src = read("src/renderer/components/text-editor/editor-theme.ts");
    expect(src).not.toMatch(/\bborderRight\b|\bpaddingLeft\b|\bpaddingRight\b/);
    expect(src).toContain("borderInlineEnd");
    expect(src).toMatch(/paddingInlineStart/);
    expect(src).toMatch(/paddingInlineEnd/);
    expect(src).not.toMatch(/padding: "0 10px 0 12px"|padding: '0 10px 0 12px'/);
  });

  it("keeps per-line direction on", () => {
    expect(read("src/renderer/components/text-editor/CodeEditor.tsx")).toContain("perLineTextDirection.of(true)");
  });

  it("plaintext-isolates preview blocks in rtl only", () => {
    const css = read("src/renderer/styles/index.css");
    expect(css).toContain('[dir="rtl"] .md-preview :is(p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th) { unicode-bidi: plaintext; }');
    expect(css).not.toMatch(/^\.md-preview[^{]*\{[^}]*unicode-bidi/m);
  });

  it("the split divider is logical", () => {
    expect(read("src/renderer/pages/TextEditorPage.tsx")).toContain("border-e border-[var(--color-border)]");
  });
});

describe("book", () => {
  it("ArrowLeft turns to the previous page in ar", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    mounted = await renderInLocale(<BookViewer file={{ id: "b1", name: "book.epub" }} />, "ar");
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="book-frame"]')!;
    const win = frame.contentWindow as unknown as Record<string, unknown>;
    win.__dosyaOpen = vi.fn(); win.__dosyaPrev = vi.fn(); win.__dosyaNext = vi.fn();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(win.__dosyaPrev).toHaveBeenCalled();
    expect(win.__dosyaNext).not.toHaveBeenCalled();
  });
});

describe("iframes", () => {
  it("wraps the PDF frame in a left-to-right container", async () => {
    mounted = await renderInLocale(
      <FileViewer file={file("p", "a.pdf", { mime_type: "application/pdf" })} files={[]} onClose={() => {}} onNavigate={() => {}} />, "ar");
    const frame = document.querySelector('iframe[src*="toolbar=1"]')!;
    expect(frame.parentElement!.getAttribute("dir")).toBe("ltr");
  });

  it("wraps the converted Office preview in a left-to-right container", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, blob: async () => new Blob(["x"]) })));
    mounted = await renderInLocale(<OfficePreview file={{ id: "o", name: "a.docx" }} />, "ar");
    await flush();
    const frame = document.querySelector('[data-testid="office-frame"]')!;
    expect(frame.parentElement!.getAttribute("dir")).toBe("ltr");
  });

  it("wraps the ONLYOFFICE host in a left-to-right container", async () => {
    const Editor = EditorPage;
    mounted = await renderInLocale(
      <MemoryRouter initialEntries={["/editor/f1"]}><Routes><Route path="/editor/:fileId" element={<Editor />} /></Routes></MemoryRouter>, "ar");
    expect(document.getElementById("oo-editor")!.parentElement!.getAttribute("dir")).toBe("ltr");
  });
});

describe("map", () => {
  const Page = MapPage;
  it("puts zoom and attribution bottom-left in ar", async () => {
    mounted = await renderInLocale(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Page /></MemoryRouter></QueryClientProvider>, "ar");
    await flush();
    expect(map.controls).toContainEqual({ kind: "nav", pos: "bottom-left" });
    expect(map.controls).toContainEqual({ kind: "attr", pos: "bottom-left" });
  });
  it("keeps them bottom-right in en", async () => {
    mounted = await renderInLocale(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Page /></MemoryRouter></QueryClientProvider>, "en");
    await flush();
    expect(map.controls).toContainEqual({ kind: "nav", pos: "bottom-right" });
    expect(map.controls).toContainEqual({ kind: "attr", pos: "bottom-right" });
  });
});
