// Customer report: after opening a folder the only way back was clicking
// "Files" in the breadcrumb. The titlebar now has Back / Forward, and the
// mouse side buttons navigate too.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { NavButtons } from "./NavButtons";
import { HistoryNavigation } from "@/lib/use-history-nav";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (window as { navigation?: unknown }).navigation;
});

let go: ReturnType<typeof useNavigate> = () => {};
function Where() {
  const loc = useLocation();
  go = useNavigate();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={["/files"]}>
        <NavButtons />
        <HistoryNavigation />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
  });
}

const where = () => container!.querySelector('[data-testid="where"]')!.textContent;
const back = () => container!.querySelector('button[aria-label="Back"]') as HTMLButtonElement;
const forward = () => container!.querySelector('button[aria-label="Forward"]') as HTMLButtonElement;
/** MemoryRouter does not drive window.navigation, so stand it in. */
const setCan = (b: boolean, f: boolean) => { (window as { navigation?: unknown }).navigation = { canGoBack: b, canGoForward: f }; };

describe("titlebar Back / Forward", () => {
  it("goes back to the folder list after opening a folder, and forward again", () => {
    setCan(false, false);
    render();
    expect(back().disabled).toBe(true);

    setCan(true, false);
    act(() => go("/files?folder=test"));
    expect(back().disabled).toBe(false);

    setCan(false, true);
    act(() => back().click());
    expect(where()).toBe("/files");
    expect(forward().disabled).toBe(false);

    setCan(true, false);
    act(() => forward().click());
    expect(where()).toBe("/files?folder=test");
  });

  it("the mouse back and forward side buttons navigate", () => {
    setCan(false, false);
    render();
    setCan(true, false);
    act(() => go("/files?folder=test"));
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { button: 3 })); });
    expect(where()).toBe("/files");
    setCan(true, true);
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { button: 4 })); });
    expect(where()).toBe("/files?folder=test");
  });
});
