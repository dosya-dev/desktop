// The open-source packages the app ships, for About › Acknowledgements.
//
// Collected at build time from package.json's runtime dependencies and each
// package's own manifest and LICENSE file, then served to the renderer as the
// `virtual:acknowledgements` module (electron.vite.config.ts). Nothing is
// committed: the list is always exactly what this build installed.
//
// Pure on purpose - the reader is injected - so the shape and the edge cases
// (a scoped workspace package, a missing LICENSE, a legacy `licenses` array)
// unit-test under node --test with no filesystem.

/**
 * @typedef {{ name: string; version: string; license: string; text: string | null }} Acknowledgement
 */

/**
 * @param {object} opts
 * @param {Record<string, string>} opts.dependencies  package.json `dependencies`
 * @param {(relPath: string) => string | null} opts.read  returns a file's text, or null when absent
 * @param {string[]} [opts.exclude]  package names to leave out (first-party code)
 * @returns {Acknowledgement[]} sorted by name
 */
export function collectAcknowledgements({ dependencies, read, exclude = [] }) {
  const out = [];
  for (const name of Object.keys(dependencies)) {
    if (exclude.includes(name)) continue;
    const manifestText = read(`node_modules/${name}/package.json`);
    if (!manifestText) continue;
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { continue; }
    out.push({
      name,
      version: typeof manifest.version === "string" ? manifest.version : "",
      license: licenseOf(manifest),
      text: licenseText(name, read),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** SPDX string from `license`, or the legacy `licenses: [{type}]` array. */
export function licenseOf(manifest) {
  if (typeof manifest.license === "string" && manifest.license) return manifest.license;
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (types.length) return types.join(" OR ");
  }
  return "Unknown";
}

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "license", "license.md", "License", "COPYING"];

function licenseText(name, read) {
  for (const f of LICENSE_FILES) {
    const text = read(`node_modules/${name}/${f}`);
    if (text) return text.trim();
  }
  return null;
}
