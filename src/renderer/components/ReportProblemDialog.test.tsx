import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const apiRequest = vi.fn();
vi.mock("../lib/api-client", () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock("../lib/workspace-context", () => ({ useWorkspace: () => ({ active: { id: "ws_1" } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const authState = { value: true };
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: authState.value }) }));

const electronAPI = {
  getDiagnosticsInfo: vi.fn(async () => ({ version: "3.0.11", distribution: "direct", arch: "arm64", platform: "macOS 24.6.0", locale: "en-GB" })),
  getSyncStatus: vi.fn(async () => ({ pairs: [{ status: "error", fileErrorCount: 2 }], globalPaused: false })),
  readLogTail: vi.fn(async () => "line one\nline two"),
  captureWindow: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
};

const { ReportProblemDialog } = await import("./ReportProblemDialog");
const { openReport, useReportProblem } = await import("../lib/report-problem-store");

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = electronAPI;
  for (const fn of Object.values(electronAPI)) fn.mockClear();
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ ok: true, ticket: { id: "t_1" } });
  authState.value = true;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  act(() => useReportProblem.getState().closeReport());
});

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={["/sync?localPath=%2FUsers%2Fme"]}><ReportProblemDialog /></MemoryRouter>);
  });
}
async function open(prefill?: Parameters<typeof openReport>[0]) {
  await act(async () => { openReport(prefill); });
  // The dialog loads device info and sync status on open.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const q = <T extends Element>(sel: string) => document.body.querySelector<T>(sel);
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;
async function type(text: string) {
  const ta = q<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function sentForm(): FormData {
  const [, opts] = apiRequest.mock.calls[0] as [string, { body: FormData }];
  return opts.body;
}

describe("ReportProblemDialog", () => {
  it("renders nothing until opened", async () => {
    await mount();
    expect(q('[role="dialog"]')).toBeNull();
  });

  it("shows the device rows and the error reference, never the vendor", async () => {
    await mount();
    await open({ errorRef: "evt_1", errorMessage: "boom" });
    const dialog = q('[role="dialog"]')!;
    expect(dialog.textContent).toContain("3.0.11");
    expect(dialog.textContent).toContain("macOS 24.6.0");
    expect(dialog.textContent).toContain("Error reference");
    expect(dialog.textContent).toContain("evt_1");
    expect(dialog.textContent).toContain("1 folder · 1 in error · 2 files failed");
    expect(dialog.textContent?.toLowerCase()).not.toContain("sentry");
  });

  it("sends a bug ticket with the text, the workspace, the diagnostics and the screenshot; the log is off by default", async () => {
    await mount();
    await open();
    await type("Sync stuck at Preparing");
    await act(async () => { button("Send report")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [path, opts] = apiRequest.mock.calls[0] as [string, { method: string; body: FormData }];
    expect(path).toBe("/api/support/tickets");
    expect(opts.method).toBe("POST");
    const fd = opts.body;
    expect(fd.get("category")).toBe("bug");
    expect(fd.get("subject")).toBe("");
    expect(fd.get("body")).toBe("Sync stuck at Preparing");
    expect(fd.get("workspace_id")).toBe("ws_1");
    const d = JSON.parse(fd.get("diagnostics") as string) as { client: string; page: string; extra: Record<string, string> };
    expect(d.client).toBe("desktop");
    expect(d.page).toBe("/sync");
    expect(d.extra.Sync).toContain("in error");
    const images = fd.getAll("images") as File[];
    expect(images).toHaveLength(1);
    expect(images[0].type).toBe("image/jpeg");
    expect(electronAPI.readLogTail).not.toHaveBeenCalled();
    expect(q('[role="dialog"]')).toBeNull();
  });

  it("appends the log tail to the body when the log toggle is on", async () => {
    await mount();
    await open();
    await type("Stuck");
    await act(async () => { q<HTMLInputElement>('[data-testid="include-log"]')!.click(); });
    await act(async () => { button("Send report")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(electronAPI.readLogTail).toHaveBeenCalledTimes(1);
    const body = sentForm().get("body") as string;
    expect(body.startsWith("Stuck\n\n--- Recent log (last 200 lines) ---\n")).toBe(true);
    expect(body.endsWith("line one\nline two")).toBe(true);
  });

  it("sends no diagnostics and no screenshot when both are unticked", async () => {
    await mount();
    await open();
    await type("x");
    await act(async () => { q<HTMLInputElement>('[data-testid="include-diagnostics"]')!.click(); });
    await act(async () => { q<HTMLInputElement>('[data-testid="include-screenshot"]')!.click(); });
    await act(async () => { button("Send report")!.click(); });
    await act(async () => { await Promise.resolve(); });
    const fd = sentForm();
    expect(fd.get("diagnostics")).toBeNull();
    expect(fd.getAll("images")).toHaveLength(0);
    expect(electronAPI.captureWindow).not.toHaveBeenCalled();
  });

  it("still sends when the screenshot cannot be captured, and says so", async () => {
    electronAPI.captureWindow.mockRejectedValueOnce(new Error("No window to capture"));
    const { toast } = await import("sonner");
    await mount();
    await open();
    await type("x");
    await act(async () => { button("Send report")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(sentForm().getAll("images")).toHaveLength(0);
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith("Screenshot skipped", expect.objectContaining({ description: expect.any(String) }));
  });

  it("keeps the dialog and the text when the request fails", async () => {
    apiRequest.mockRejectedValueOnce(new Error("Request failed (500)"));
    await mount();
    await open();
    await type("keep me");
    await act(async () => { button("Send report")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[role="dialog"]')).toBeTruthy();
    expect(q<HTMLTextAreaElement>("textarea")!.value).toBe("keep me");
  });

  it("disables Send while the text is empty", async () => {
    await mount();
    await open();
    expect(button("Send report")!.disabled).toBe(true);
  });

  it("shows a sign-in state instead of the form when signed out", async () => {
    authState.value = false;
    await mount();
    await open();
    const dialog = q('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sign in first");
    expect(q("textarea")).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("skips an oversized screenshot and still sends the report", async () => {
    electronAPI.captureWindow.mockResolvedValueOnce(new Uint8Array(4_600_000));
    const { toast } = await import("sonner");
    await mount();
    await open();
    await type("x");
    await act(async () => { button("Send report")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(sentForm().getAll("images")).toHaveLength(0);
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
      "Screenshot skipped",
      expect.objectContaining({ description: "The window image was too large to attach. Your report was sent without it." }),
    );
  });

  it("does not carry a stale sync summary into a fresh open", async () => {
    await mount();
    await open();
    expect(q('[role="dialog"]')!.textContent).toContain("1 folder · 1 in error · 2 files failed");
    await act(async () => { useReportProblem.getState().closeReport(); });
    electronAPI.getSyncStatus.mockResolvedValueOnce({ pairs: [], globalPaused: false });
    await open();
    expect(q('[role="dialog"]')!.textContent).not.toContain("in error");
  });
});
