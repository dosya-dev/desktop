import { describe, it, expect } from "vitest";
import { directionBetween } from "./auth-direction";

describe("directionBetween", () => {
  it("enters forward on a cold open, with no previous screen to compare", () => {
    expect(directionBetween(null, "/login")).toBe("fwd");
    expect(directionBetween(null, "/2fa")).toBe("fwd");
  });

  it("calls the real journeys correctly", () => {
    // The two that matter: login is the hub, so leaving it is forward and
    // returning to it is back.
    expect(directionBetween("/login", "/2fa")).toBe("fwd");
    expect(directionBetween("/login", "/forgot-password")).toBe("fwd");
    expect(directionBetween("/forgot-password", "/login")).toBe("back");
    expect(directionBetween("/2fa", "/login")).toBe("back");
    expect(directionBetween("/signup", "/verify")).toBe("fwd");
    expect(directionBetween("/verify", "/signup")).toBe("back");
  });

  it("treats a re-render of the same screen as forward, not back", () => {
    // Equal positions must not read as a reversal - a remount on the same route
    // would otherwise slide the card in from the wrong side.
    expect(directionBetween("/login", "/login")).toBe("fwd");
  });

  it("refuses to guess a direction for a path outside the flow", () => {
    // Arriving from the dashboard, or heading to it, has no position to compare.
    expect(directionBetween("/dashboard", "/login")).toBe("fwd");
    expect(directionBetween("/login", "/dashboard")).toBe("fwd");
    expect(directionBetween("/nonsense", "/also-nonsense")).toBe("fwd");
  });
});
