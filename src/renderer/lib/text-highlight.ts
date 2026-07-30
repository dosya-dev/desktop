// Ported from apps/web/src/lib/text-highlight.ts - keep in sync with the web copy.
import type { HighlighterCore } from 'shiki/core';

const THEME = 'github-dark-default';

// Lang id → dynamic grammar import. Only these ship (on demand).
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighterCore } = await import('shiki/core');
      const { createJavaScriptRegexEngine } = await import('@shikijs/engine-javascript');
      const theme = await import('shiki/themes/github-dark-default.mjs');
      return createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
    // Reset on failure so a later call can retry the bootstrap instead of
    // staying permanently rejected. Does not swallow the rejection for
    // whoever is currently awaiting this promise.
    highlighterPromise.catch(() => {
      highlighterPromise = null;
    });
  }
  return highlighterPromise;
}

export async function highlightToHtml(code: string, lang: string): Promise<string> {
  try {
    const hl = await getHighlighter();
    const loader = LANG_LOADERS[lang];
    if (loader && !loaded.has(lang)) {
      try {
        await hl.loadLanguage(loader() as never);
        loaded.add(lang);
      } catch {
        /* fall through to plaintext */
      }
    }
    const effective = loaded.has(lang) ? lang : 'text';
    return hl.codeToHtml(code, { lang: effective, theme: THEME });
  } catch {
    return `<pre class="shiki">${escapeHtml(code)}</pre>`;
  }
}
