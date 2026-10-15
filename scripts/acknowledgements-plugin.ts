import { readFileSync } from "fs";
import { resolve } from "path";
import { collectAcknowledgements } from "./acknowledgements.mjs";

/**
 * About › Acknowledgements as a Vite virtual module: the runtime dependencies
 * this build installed, with their licence text. Resolved at build time so
 * the list can never drift from package.json, and nothing generated is
 * committed. Shared by electron.vite.config.ts and vitest.config.ts so the
 * component test sees exactly what the build ships.
 */
export const ACKNOWLEDGEMENTS_ID = "virtual:acknowledgements";
const RESOLVED_ID = "\0" + ACKNOWLEDGEMENTS_ID;

export function acknowledgementsPlugin(rootDir: string) {
  return {
    name: "dosya-acknowledgements",
    resolveId(id: string) {
      return id === ACKNOWLEDGEMENTS_ID ? RESOLVED_ID : null;
    },
    load(id: string) {
      if (id !== RESOLVED_ID) return null;
      const { dependencies } = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      const list = collectAcknowledgements({
        dependencies,
        read: (rel: string) => {
          try { return readFileSync(resolve(rootDir, rel), "utf8"); } catch { return null; }
        },
        exclude: ["@dosya-dev/shared"],
      });
      return `export default ${JSON.stringify(list)};`;
    },
  };
}
