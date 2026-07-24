// Ported from apps/web/src/lib/vcard.ts (parse-only subset) — keep in sync with the web copy.
// The desktop viewer is read-only, so the serializer/editor half
// (serializeVCards, applyEdits, escapeText, foldLine) is intentionally absent.

export interface VProp {
  name: string;                        // base name, uppercased (group stripped), e.g. "TEL"
  group: string | null;               // "item1" for grouped lines, else null
  params: Record<string, string[]>;   // uppercased keys → values
  value: string;                       // escaped, as in the source
  raw: string | null;                 // original unfolded line, or null when rebuilt
}

export interface VPhone { type: string; value: string; }
export interface VEmail { type: string; value: string; }
export interface VAddress { type: string; value: string; }

export interface ParsedVCard {
  fullName: string;
  org: string | null;
  title: string | null;
  phones: VPhone[];
  emails: VEmail[];
  addresses: VAddress[];
  urls: string[];
  birthday: string | null;
  note: string | null;
  photo: { dataUrl: string } | null;
  props: VProp[];
}

// ── text escaping ──────────────────────────────────────────
function unescapeText(s: string): string {
  return s.replace(/\\([\\nN,;:])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}
// Split a structured value (N, ORG, ADR) on unescaped ';', then unescape each part.
function splitStructured(value: string): string[] {
  return value.split(/(?<!\\);/).map(unescapeText);
}

// ── line unfolding ─────────────────────────────────────────
function unfold(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// ── property parsing ───────────────────────────────────────
function parseParams(segments: string[]): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  const add = (k: string, v: string) => {
    const key = k.toUpperCase();
    (params[key] ??= []).push(v.replace(/^"|"$/g, ''));
  };
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq === -1) {
      if (seg) add('TYPE', seg); // v2.1 bare type, e.g. TEL;HOME;VOICE
    } else {
      const key = seg.slice(0, eq);
      for (const v of seg.slice(eq + 1).split(',')) add(key, v);
    }
  }
  return params;
}

function parseLine(line: string): VProp | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = head.split(';');
  let nameSeg = segments[0];
  let group: string | null = null;
  const dot = nameSeg.indexOf('.');
  if (dot !== -1) {
    group = nameSeg.slice(0, dot);
    nameSeg = nameSeg.slice(dot + 1);
  }
  return {
    name: nameSeg.toUpperCase(),
    group,
    params: parseParams(segments.slice(1)),
    value,
    raw: line,
  };
}

// ── type labels ────────────────────────────────────────────
function phoneType(types: string[]): string {
  const U = types.map((t) => t.toUpperCase());
  if (U.some((t) => t === 'CELL' || t === 'MOBILE' || t === 'IPHONE')) return 'mobile';
  if (U.includes('WORK')) return 'work';
  if (U.includes('HOME')) return 'home';
  if (U.includes('FAX')) return 'fax';
  if (U.includes('MAIN')) return 'main';
  const m = U.find((t) => !['VOICE', 'PREF', 'INTERNET', 'CANONICAL'].includes(t));
  return m ? m.toLowerCase() : 'other';
}
function emailType(types: string[]): string {
  const U = types.map((t) => t.toUpperCase());
  if (U.includes('HOME')) return 'home';
  if (U.includes('WORK')) return 'work';
  const m = U.find((t) => !['INTERNET', 'PREF'].includes(t));
  return m ? m.toLowerCase() : 'other';
}

function photoDataUrl(prop: VProp): string {
  if (prop.value.startsWith('data:')) return prop.value;
  const t = (prop.params.TYPE?.[0] ?? 'JPEG').toUpperCase();
  const mime = t.includes('PNG') ? 'image/png' : t.includes('GIF') ? 'image/gif' : t.includes('WEBP') ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${prop.value}`;
}

function formatAddress(value: string): string {
  const [po, ext, street, city, region, postal, country] = splitStructured(value);
  const streetLine = [po, ext, street].filter(Boolean).join(' ');
  const cityLine = [city, [region, postal].filter(Boolean).join(' ').trim()].filter(Boolean).join(', ');
  return [streetLine, cityLine, country].filter(Boolean).join(', ');
}

// ── build the display view from raw props ──────────────────
function fromProps(props: VProp[]): ParsedVCard {
  const first = (name: string) => props.find((p) => p.name === name);
  const all = (name: string) => props.filter((p) => p.name === name);

  let fullName = first('FN') ? unescapeText(first('FN')!.value) : '';
  if (!fullName && first('N')) {
    const [family, given] = splitStructured(first('N')!.value);
    fullName = [given, family].filter(Boolean).join(' ').trim();
  }
  const orgProp = first('ORG');
  const org = orgProp ? (splitStructured(orgProp.value).find(Boolean) ?? null) : null;
  const photoProp = first('PHOTO');

  return {
    fullName,
    org,
    title: first('TITLE') ? unescapeText(first('TITLE')!.value) : null,
    phones: all('TEL').map((p) => ({ type: phoneType(p.params.TYPE ?? []), value: unescapeText(p.value) })),
    emails: all('EMAIL').map((p) => ({ type: emailType(p.params.TYPE ?? []), value: unescapeText(p.value) })),
    addresses: all('ADR').map((p) => ({ type: phoneType(p.params.TYPE ?? []), value: formatAddress(p.value) })),
    urls: all('URL').map((p) => unescapeText(p.value)),
    birthday: first('BDAY') ? unescapeText(first('BDAY')!.value) : null,
    note: first('NOTE') ? unescapeText(first('NOTE')!.value) : null,
    photo: photoProp ? { dataUrl: photoDataUrl(photoProp) } : null,
    props,
  };
}

// ── public API ─────────────────────────────────────────────
export function parseVCards(text: string): ParsedVCard[] {
  const lines = unfold(text);
  const cards: ParsedVCard[] = [];
  let cur: VProp[] | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') { cur = []; continue; }
    if (upper === 'END:VCARD') { if (cur) cards.push(fromProps(cur)); cur = null; continue; }
    if (cur === null) continue;
    const prop = parseLine(line);
    if (prop) cur.push(prop);
  }
  if (cur && cur.length) cards.push(fromProps(cur)); // tolerate a missing END
  return cards;
}
