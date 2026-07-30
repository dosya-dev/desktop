// Ported from apps/web/src/lib/text-detect.ts - keep in sync with the web copy.
import { extOf } from '@/lib/file-type';

// Extensions that render as text (superset of the old helpers TEXT_EXTS).
export const TEXT_READABLE_EXTS = new Set<string>([
  // plain / docs / data
  'txt', 'log', 'md', 'markdown', 'rst', 'tex', 'csv', 'tsv', 'json', 'jsonc',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'diff', 'patch', 'sql', 'graphql', 'proto',
  // web
  'html', 'htm', 'css', 'scss', 'less', 'styl', 'svg',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  // general programming
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'dart',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'lua', 'pl', 'r', 'sh', 'bash', 'zsh',
  'fish', 'bat', 'ps1', 'gradle', 'dockerfile', 'makefile',
  // dotfiles / config files (from EXTENSIONLESS_TEXT_NAMES)
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'dockerignore',
  'prettierrc', 'babelrc',
]);

// Base names (lowercased) that are text even with no extension.
const EXTENSIONLESS_TEXT_NAMES = new Set<string>([
  'dockerfile', 'makefile', 'readme', 'license', 'licence', 'changelog',
  'authors', 'notice', 'copying', '.gitignore', '.gitattributes', '.env',
  '.editorconfig', '.npmrc', '.dockerignore', '.prettierrc', '.babelrc',
]);

function isTextMime(mime?: string | null): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  if (m.startsWith('text/')) return true;
  return [
    'application/json', 'application/xml', 'application/javascript',
    'application/x-yaml', 'application/x-sh', 'application/toml',
    'application/x-www-form-urlencoded',
  ].includes(m);
}

export function isTextReadable(name: string, mime?: string | null): boolean {
  const ext = extOf(name);
  if (ext && TEXT_READABLE_EXTS.has(ext)) return true;
  if (!ext && EXTENSIONLESS_TEXT_NAMES.has(name.toLowerCase())) return true;
  if (isTextMime(mime)) return true;
  return false;
}

/** Heuristic: presence of a NUL byte in the sampled prefix means "not text". */
export function looksBinary(sample: string): boolean {
  return sample.includes('\0');
}

// Extension → canonical Shiki language id.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  cjs: 'javascript', py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift',
  dart: 'dart', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  lua: 'lua', pl: 'perl', r: 'r', sh: 'bash', bash: 'bash', zsh: 'bash',
  fish: 'fish', ps1: 'powershell', sql: 'sql', json: 'json', jsonc: 'jsonc',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', html: 'html',
  htm: 'html', css: 'css', scss: 'scss', less: 'less', md: 'markdown',
  markdown: 'markdown', vue: 'vue', svelte: 'svelte', graphql: 'graphql',
  proto: 'proto', diff: 'diff', patch: 'diff', dockerfile: 'docker',
  makefile: 'make', gradle: 'groovy',
};

export function langFromExtension(name: string): string {
  const ext = extOf(name);
  if (ext && EXT_LANG[ext]) return EXT_LANG[ext];
  const base = name.toLowerCase();
  if (base === 'dockerfile') return 'docker';
  if (base === 'makefile') return 'make';
  return 'text';
}