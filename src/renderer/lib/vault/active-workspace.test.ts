import { describe, it, expect, beforeEach } from "vitest";
import { getActiveGlobalWorkspaceId, setActiveGlobalWorkspaceId } from "./active-workspace";

/**
 * Desktop keeps the active storage workspace in React context
 * (workspace-context.tsx), which a Zustand store cannot read. The provider
 * publishes the id here so the Vault store can scope Spaces the way the web
 * store does from its own workspace store.
 */
describe("active global workspace seam", () => {
  beforeEach(() => setActiveGlobalWorkspaceId(null));

  it("starts empty and reflects the last value set", () => {
    expect(getActiveGlobalWorkspaceId()).toBeNull();
    setActiveGlobalWorkspaceId("gw-1");
    expect(getActiveGlobalWorkspaceId()).toBe("gw-1");
    setActiveGlobalWorkspaceId(null);
    expect(getActiveGlobalWorkspaceId()).toBeNull();
  });
});
