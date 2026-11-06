import { afterEach, describe, expect, it } from "vitest";
import { isSweepClick } from "./ThemeMenu";

describe("isSweepClick", () => {
  const root = document.documentElement;
  afterEach(() => root.removeAttribute("data-theme-sweep"));

  it("treats a click on <html> during the theme wipe as part of the menu", () => {
    root.setAttribute("data-theme-sweep", "");
    expect(isSweepClick({ target: root })).toBe(true);
  });

  it("still closes for a real outside click during the wipe", () => {
    root.setAttribute("data-theme-sweep", "");
    expect(isSweepClick({ target: document.body })).toBe(false);
  });

  it("still closes for a click on <html> when no wipe is running", () => {
    expect(isSweepClick({ target: root })).toBe(false);
  });
});
