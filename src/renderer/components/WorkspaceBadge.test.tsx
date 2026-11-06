import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api-client", () => ({ apiBase: () => "https://api.test" }));

import { WorkspaceBadge } from "./WorkspaceBadge";
import { useWorkspaceIconVersion } from "@/lib/workspace-icon-version";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = { id: "ws_1", icon_initials: "AC", icon_color: "#123456" };

describe("WorkspaceBadge", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows initials on the workspace colour when there is no logo", () => {
    act(() => root.render(<WorkspaceBadge ws={{ ...base, icon_image_url: null }} />));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("AC");
  });

  it("shows the uploaded logo, and a new upload changes its URL", () => {
    act(() => root.render(<WorkspaceBadge ws={{ ...base, icon_image_url: "workspace-icons/ws_1/icon.png" }} />));
    const first = host.querySelector("img")!.getAttribute("src")!;
    expect(first).toMatch(/^https:\/\/api\.test\/api\/workspaces\/ws_1\/icon\?v=\d+$/);

    act(() => useWorkspaceIconVersion.getState().bump());
    expect(host.querySelector("img")!.getAttribute("src")).not.toBe(first);
  });

  it("falls back to initials when the logo fails to load", () => {
    act(() => root.render(<WorkspaceBadge ws={{ ...base, icon_image_url: "workspace-icons/ws_1/icon.png" }} />));
    act(() => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("AC");
  });
});
