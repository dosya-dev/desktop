import { Fragment, type ReactNode } from "react";
import type { MessageKey } from "../../i18n/keys";
import type { T } from "../../i18n/translator";

/**
 * One message with React elements in some of its placeholders: a bold date,
 * a muted label. The sentence stays a single catalog message, so each
 * language keeps its own word order, and the styled part lands wherever the
 * translation puts its placeholder.
 *
 * `nodes` fill placeholders with elements; `values` fill the rest as plain
 * text, exactly as t() does.
 */
export function richText(
  t: T,
  key: MessageKey,
  values: Record<string, string | number>,
  nodes: Record<string, ReactNode>,
): ReactNode {
  const names = Object.keys(nodes);
  // Control characters cannot occur in catalog text, and values are
  // substituted literally, so the markers survive t() untouched.
  const marked: Record<string, string | number> = { ...values };
  names.forEach((name, i) => {
    marked[name] = `\u0001${i}\u0002`;
  });
  const parts = t(key, marked).split(/\u0001(\d+)\u0002/);
  // split() with a capture group alternates text and marker index.
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 0 ? part : <Fragment key={i}>{nodes[names[Number(part)]]}</Fragment>,
      )}
    </>
  );
}
