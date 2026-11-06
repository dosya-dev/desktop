import { describe, expect, it } from "vitest";
import { searchCommitParams } from "./files-params";

describe("searchCommitParams (desktop QA TC-022)", () => {
  it("sets q and drops the page when a term is committed", () => {
    const next = searchCommitParams(new URLSearchParams("filter=all&page=3&sort=largest"), "test2");
    expect(next?.get("q")).toBe("test2");
    expect(next?.has("page")).toBe(false);
    expect(next?.get("sort")).toBe("largest");
    expect(next?.get("filter")).toBe("all");
  });

  it("clearing the box removes q, which restores the full listing", () => {
    const next = searchCommitParams(new URLSearchParams("filter=all&q=test2&folder=f1"), "");
    expect(next).not.toBeNull();
    expect(next!.has("q")).toBe(false);
    expect(next!.get("folder")).toBe("f1");
  });

  it("returns null when the URL already holds the term", () => {
    expect(searchCommitParams(new URLSearchParams("q=test2"), "test2")).toBeNull();
    expect(searchCommitParams(new URLSearchParams("filter=all"), "")).toBeNull();
  });
});
