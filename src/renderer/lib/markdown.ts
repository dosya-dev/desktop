// Ported from apps/web/src/lib/markdown.ts - keep in sync with the web copy.
/**
 * Markdown parsed into renderable blocks.
 *
 * Hand-rolled for the same reason as csv-table.ts (and kept in step with apps/mobile/src/viewer/markdown.ts - parity is by copy): the README/notes subset
 * that actually gets uploaded - headings, emphasis, code, lists, quotes,
 * links - is small, the body is capped at 200KB, and every maintained RN
 * markdown dependency drags in a full CommonMark AST for output we would
 * then have to restyle anyway. What this does not do (tables, images,
 * nesting) degrades to plain paragraph text, never to broken layout.
 */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inline: InlineToken[] }
  | { kind: "paragraph"; inline: InlineToken[] }
  | { kind: "code"; text: string; lang: string | null }
  | { kind: "quote"; inline: InlineToken[] }
  | { kind: "list"; ordered: boolean; items: InlineToken[][] }
  | { kind: "hr" };

/**
 * Inline emphasis, resolved earliest-match-first so `**a** and *b*` cannot
 * mis-nest. Code spans are matched before emphasis on purpose: `*ptr` inside
 * backticks must stay literal.
 */
const INLINE = [
  { kind: "code" as const, re: /`([^`\n]+)`/ },
  { kind: "bold" as const, re: /\*\*([^*\n]+)\*\*|__([^_\n]+)__/ },
  { kind: "italic" as const, re: /\*([^*\n]+)\*|_([^_\n]+)_/ },
  { kind: "link" as const, re: /\[([^\]\n]+)\]\(([^)\s]+)\)/ },
];

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = text;
  while (rest.length > 0) {
    let earliest: { kind: "code" | "bold" | "italic" | "link"; m: RegExpExecArray } | null = null;
    for (const { kind, re } of INLINE) {
      const m = re.exec(rest);
      if (m && (earliest == null || m.index < earliest.m.index)) earliest = { kind, m };
    }
    if (!earliest) {
      tokens.push({ kind: "text", text: rest });
      break;
    }
    if (earliest.m.index > 0) tokens.push({ kind: "text", text: rest.slice(0, earliest.m.index) });
    const body = earliest.m[1] ?? earliest.m[2] ?? "";
    if (earliest.kind === "link") tokens.push({ kind: "link", text: earliest.m[1], url: earliest.m[2] });
    else tokens.push({ kind: earliest.kind, text: body });
    rest = rest.slice(earliest.m.index + earliest.m[0].length);
  }
  return tokens;
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ").trim()) });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      // An unclosed fence swallows to EOF - showing its content as code beats
      // rendering half a README through the emphasis rules.
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1] || null });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, inline: parseInline(heading[2].trim()) });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "hr" });
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      blocks.push({ kind: "quote", inline: parseInline(quote.join(" ").trim()) });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      flush();
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: InlineToken[][] = [];
      while (i < lines.length && marker.test(lines[i])) {
        items.push(parseInline(marker.exec(lines[i++])![1].trim()));
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
