/**
 * The ICU message subset the desktop catalogs use, parsed and formatted.
 * Pure: no DOM, no Electron, so the renderer, the main process and the
 * dev text matcher (match.ts) share it.
 *
 * Supported (all the catalog uses): {arg}, {arg, plural, ...} with =N / one /
 * other and #, and {arg, select, ...}, nested.
 */

export type IcuNode =
  | string
  | { type: "arg"; name: string }
  | { type: "pound" }
  | { type: "plural" | "select"; name: string; options: Record<string, IcuNode[]> };

export function parseIcu(src: string): IcuNode[] {
  let i = 0;

  const parseNodes = (inPlural: boolean, stopAtBrace: boolean): IcuNode[] => {
    const out: IcuNode[] = [];
    let text = "";
    const pushText = () => {
      if (text) out.push(text);
      text = "";
    };
    while (i < src.length) {
      const c = src[i];
      if (c === "}") {
        if (!stopAtBrace) throw new Error(`unexpected } at ${i}`);
        break;
      }
      if (c === "{") {
        pushText();
        out.push(parseArg(inPlural));
        continue;
      }
      if (c === "#" && inPlural) {
        pushText();
        out.push({ type: "pound" });
        i++;
        continue;
      }
      text += c;
      i++;
    }
    pushText();
    return out;
  };

  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  const readWord = (): string => {
    skipWs();
    const start = i;
    while (i < src.length && /[^\s,{}]/.test(src[i])) i++;
    return src.slice(start, i);
  };

  // `#` stays live inside a select nested in a plural:
  // {n, plural, other {{kind, select, videos {# videos}}}}.
  const parseArg = (inPlural: boolean): IcuNode => {
    i++; // {
    const name = readWord();
    skipWs();
    if (src[i] === "}") {
      i++;
      return { type: "arg", name };
    }
    if (src[i] !== ",") throw new Error(`expected , after ${name} at ${i}`);
    i++;
    const kind = readWord();
    skipWs();
    if (kind !== "plural" && kind !== "select") {
      // {x, number} and friends: treat as a plain argument.
      while (i < src.length && src[i] !== "}") i++;
      i++;
      return { type: "arg", name };
    }
    if (src[i] !== ",") throw new Error(`expected , after ${kind} at ${i}`);
    i++;
    const options: Record<string, IcuNode[]> = {};
    for (;;) {
      skipWs();
      if (src[i] === "}") {
        i++;
        break;
      }
      const key = readWord();
      if (!key) throw new Error(`expected option key at ${i}`);
      skipWs();
      if (src[i] !== "{") throw new Error(`expected { after ${key} at ${i}`);
      i++;
      options[key] = parseNodes(kind === "plural" || inPlural, true);
      if (src[i] !== "}") throw new Error(`unclosed option ${key}`);
      i++;
    }
    return { type: kind, name, options };
  };

  const nodes = parseNodes(false, false);
  if (i < src.length) throw new Error(`trailing input at ${i}`);
  return nodes;
}

// ── Formatting the target message ─────────────────────────────────────

/** A bound argument: text, a number, or a number the English did not reveal. */
export type ArgValue = string | number | typeof UNKNOWN;
export const UNKNOWN = Symbol("unknown");

class Unformattable extends Error {}

export function formatIcu(nodes: IcuNode[], args: Record<string, ArgValue>, locale: string): string {
  const rules = new Intl.PluralRules(locale);
  const nf = new Intl.NumberFormat(locale);
  const walk = (list: IcuNode[], pound: number | null): string => {
    let out = "";
    for (const n of list) {
      if (typeof n === "string") out += n;
      else if (n.type === "pound") {
        if (pound === null) throw new Unformattable();
        out += nf.format(pound);
      } else if (n.type === "arg") {
        const v = args[n.name];
        if (v === undefined || v === UNKNOWN) throw new Unformattable();
        out += typeof v === "number" ? nf.format(v) : v;
      } else if (n.type === "select") {
        const v = args[n.name];
        const key = typeof v === "string" && n.options[v] ? v : "other";
        const branch = n.options[key];
        if (!branch) throw new Unformattable();
        out += walk(branch, pound);
      } else {
        const v = args[n.name];
        if (typeof v !== "number") {
          // The English branch gave no count. Only a message that has a single
          // branch without # can still be rendered honestly.
          const keys = Object.keys(n.options);
          if (keys.length === 1 && !JSON.stringify(n.options[keys[0]]).includes('"pound"')) {
            out += walk(n.options[keys[0]], pound);
            continue;
          }
          throw new Unformattable();
        }
        const exact = n.options[`=${v}`];
        const branch = exact ?? n.options[rules.select(v)] ?? n.options.other;
        if (!branch) throw new Unformattable();
        out += walk(branch, v);
      }
    }
    return out;
  };
  return walk(nodes, null);
}

/**
 * The app's formatter: like formatIcu, but it never throws on a value the
 * caller left out. A missing {arg} renders as its own placeholder text and a
 * plural without a number takes its "other" branch with a literal #, so a
 * slip shows on screen instead of blanking the string.
 *
 * `rules` picks the plural category (the message's language); `nf` formats
 * numbers (the user's formatting locale).
 */
export function renderIcu(
  nodes: IcuNode[],
  values: Record<string, string | number>,
  rules: Intl.PluralRules,
  nf: Intl.NumberFormat,
): string {
  const walk = (list: IcuNode[], pound: number | null): string => {
    let out = "";
    for (const n of list) {
      if (typeof n === "string") out += n;
      else if (n.type === "pound") out += pound === null ? "#" : nf.format(pound);
      else if (n.type === "arg") {
        const v = values[n.name];
        out += v === undefined ? `{${n.name}}` : typeof v === "number" ? nf.format(v) : v;
      } else if (n.type === "select") {
        const v = values[n.name];
        const key = v !== undefined && n.options[String(v)] ? String(v) : "other";
        const branch = n.options[key];
        if (branch) out += walk(branch, pound);
      } else {
        const v = values[n.name];
        if (typeof v !== "number") {
          const branch = n.options.other;
          if (branch) out += walk(branch, null);
          continue;
        }
        const branch = n.options[`=${v}`] ?? n.options[rules.select(v)] ?? n.options.other;
        if (branch) out += walk(branch, v);
      }
    }
    return out;
  };
  return walk(nodes, null);
}
