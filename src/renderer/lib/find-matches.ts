// Ported from apps/web/src/lib/find-matches.ts - keep in sync with the web copy.
interface NodeEntry { node: Text; start: number; }

function flatten(container: Node): { text: string; nodes: NodeEntry[] } {
  const nodes: NodeEntry[] = [];
  let text = '';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    nodes.push({ node: t, start: text.length });
    text += t.data;
  }
  return { text, nodes };
}

/** Map a global character offset back to (text node, offset within node). */
function locate(nodes: NodeEntry[], offset: number): { node: Text; offset: number } | null {
  for (const e of nodes) {
    const end = e.start + e.node.data.length;
    if (offset >= e.start && offset <= end) {
      return { node: e.node, offset: offset - e.start };
    }
  }
  return null;
}

export function collectMatchRanges(container: Node, query: string): Range[] {
  const ranges: Range[] = [];
  if (!query) return ranges;
  const { text, nodes } = flatten(container);
  if (!nodes.length) return ranges;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  let i: number;
  while ((i = hay.indexOf(needle, from)) !== -1) {
    const end = i + needle.length;
    const s = locate(nodes, i);
    const e = locate(nodes, end);
    if (s && e) {
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      ranges.push(range);
    }
    from = end;
  }
  return ranges;
}
