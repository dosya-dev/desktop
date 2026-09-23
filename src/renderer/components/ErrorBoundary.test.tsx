// The boundary used to log to console only, which reaches a file on the
// user's disk and nothing else. This pins that a caught render error is also
// handed to the crash reporter with the surface name, and that a healthy
// subtree reports nothing.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";

const reportError = vi.hoisted(() => vi.fn());
vi.mock("../lib/sentry", () => ({ reportError }));

function Boom(): never {
  throw new Error("render exploded");
}

describe("ErrorBoundary", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    reportError.mockReset();
    vi.restoreAllMocks();
  });

  it("reports a caught render error with the surface it came from", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <ErrorBoundary where="the map">
          <Boom />
        </ErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("This page didn't load");
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, extra] = reportError.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("render exploded");
    expect(extra).toMatchObject({ where: "the map" });
    expect(typeof extra.componentStack).toBe("string");
  });

  it("reports nothing when the subtree renders", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <ErrorBoundary>
          <p>fine</p>
        </ErrorBoundary>,
      );
    });
    expect(container.textContent).toBe("fine");
    expect(reportError).not.toHaveBeenCalled();
  });
});
