// Table header cells. The browser centres a <th> unless its parent's
// text-align differs from the initial value, and the initial value is
// `start`: so `text-left` on a <table> used to reach every header cell, while
// `text-start` (what the right-to-left conversion turned it into) does not,
// and the headers moved to the middle of their columns in every language. A
// header cell therefore says its own alignment.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "reader" ? [] : sources(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

describe("table header cells", () => {
  it("each <th> carries its own text alignment", () => {
    const missing: string[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/<th\b[^>]*>/g)) {
        const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(m[0]);
        const classes = (cls?.[1] ?? cls?.[2] ?? "").split(/\s+/);
        if (!classes.some((c) => /^text-(start|end|center)$/.test(c))) {
          const line = text.slice(0, m.index).split("\n").length;
          missing.push(`${path.relative(ROOT, file)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
