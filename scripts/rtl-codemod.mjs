#!/usr/bin/env node
// Physical-direction to logical-direction codemod and scanner for Tailwind 4.2.
//
//   node scripts/rtl-codemod.mjs --check <files...>   report, exit 1 if anything convertible is left
//   node scripts/rtl-codemod.mjs --write <files...>   rewrite the files in place
//
// The same token scanner backs the source gate (src/i18n/rtl-gate.test.ts, run by test:unit), so
// the gate and the codemod cannot disagree about what counts as physical.
//
// Never converted, only reported: translate-x-*, origin-*-left/right, a
// left-1/2 or right-1/2 that sits with -translate-x-1/2 (centering), variants
// like data-[side=left], and anything on a line (or the line below a line)
// carrying `rtl-ok:`. A token whose value is not a Tailwind value (pl-PL, a
// locale) is not a class and is ignored.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A marker needs a reason: `rtl-ok: media timeline`. */
const MARK = /rtl-ok:\s*\S/;

/** A Tailwind spacing / inset value: number, px, auto, full, fraction, [arbitrary], (var). */
const VALUE = String.raw`(?:\d+(?:\.\d+)?|px|auto|full|\d+\/\d+|\[[^\s]+\]|\([^\s]+\))`;
const RADIUS = String.raw`(?:xs|sm|md|lg|xl|2xl|3xl|4xl|none|full|\[[^\s]+\]|\([^\s]+\))`;
const SUFFIX = String.raw`[A-Za-z0-9_\-\[\]\(\)\/\.#%,]+`;

/** [pattern, builder]; the first pattern that matches the utility wins. */
const RULES = [
  [new RegExp(`^m([lr])-(${VALUE})$`), (m) => `m${m[1] === 'l' ? 's' : 'e'}-${m[2]}`],
  [new RegExp(`^p([lr])-(${VALUE})$`), (m) => `p${m[1] === 'l' ? 's' : 'e'}-${m[2]}`],
  [new RegExp(`^(left|right)-(${VALUE})$`), (m) => `inset-${m[1] === 'left' ? 's' : 'e'}-${m[2]}`],
  [/^text-(left|right)$/, (m) => `text-${m[1] === 'left' ? 'start' : 'end'}`],
  [new RegExp(`^rounded-([lr])(?:-(${RADIUS}))?$`), (m) => `rounded-${m[1] === 'l' ? 's' : 'e'}${m[2] ? `-${m[2]}` : ''}`],
  [
    new RegExp(`^rounded-(tl|tr|bl|br)(?:-(${RADIUS}))?$`),
    (m) => `rounded-${{ tl: 'ss', tr: 'se', bl: 'es', br: 'ee' }[m[1]]}${m[2] ? `-${m[2]}` : ''}`,
  ],
  [new RegExp(`^border-([lr])(?:-(${SUFFIX}))?$`), (m) => `border-${m[1] === 'l' ? 's' : 'e'}${m[2] ? `-${m[2]}` : ''}`],
  [new RegExp(`^scroll-([mp])([lr])-(${VALUE})$`), (m) => `scroll-${m[1]}${m[2] === 'l' ? 's' : 'e'}-${m[3]}`],
  [/^float-(left|right)$/, (m) => `float-${m[1] === 'left' ? 'start' : 'end'}`],
];

const REPORT_ONLY = [
  [/^translate-x-/, 'translate-x is physical'],
  [/^translate-(?:\d|\[|\()/, 'translate moves on the x axis too'],
  [/^origin-(?:top-|bottom-)?(?:left|right)$/, 'transform-origin is physical'],
];

/** Splits a token on `:` outside brackets. Returns variants and the utility's offset. */
function splitToken(token) {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) last = i;
  }
  return { variants: last < 0 ? '' : token.slice(0, last), offset: last + 1 };
}

/** Strips punctuation that belongs to the surrounding prose or code, not the class. */
function trim(raw, start) {
  let s = raw;
  let a = start;
  while (/^[(\[]/.test(s) && s.split(s[0]).length - 1 > s.split(s[0] === '(' ? ')' : ']').length - 1) {
    s = s.slice(1);
    a += 1;
  }
  for (;;) {
    const last = s[s.length - 1];
    if (last === '.' || last === ',' || last === ';' || last === ':') s = s.slice(0, -1);
    else if (last === ')' && s.split('(').length < s.split(')').length) s = s.slice(0, -1);
    else if (last === ']' && s.split('[').length < s.split(']').length) s = s.slice(0, -1);
    else break;
  }
  return { token: s, start: a };
}

/** -translate-x-1/2, -translate-x-[50%], translate-x-[-50%] and the two-axis forms: the other half of a centering pair. */
function isHalfTranslate(lead, util) {
  const negative = lead.replace('!', '') === '-';
  if (negative) return /^translate-(?:x-)?(?:1\/2|\[50%\])$/.test(util);
  return /^translate-(?:x-)?\[-50%\]$/.test(util);
}

/** Classifies one token. Returns null when it is not a physical-direction class. */
export function classify(token) {
  const { variants, offset } = splitToken(token);
  if (/(^|:)(rtl|ltr)$/.test(variants) || /\b(rtl|ltr):/.test(variants)) return null;
  let util = token.slice(offset);
  const prefixLen = (util.startsWith('!') ? 1 : 0) + (/^!?-/.test(util) ? 1 : 0);
  const lead = util.slice(0, prefixLen);
  util = util.slice(prefixLen);
  let tail = '';
  if (util.endsWith('!')) {
    util = util.slice(0, -1);
    tail = '!';
  }
  const dataSide = /=(?:left|right)\]/.test(variants);
  for (const [re, build] of RULES) {
    const m = re.exec(util);
    if (!m) continue;
    const logical = build(m);
    if (dataSide) return { kind: 'report', reason: 'side variant is physical', util, centeringKey: null };
    return {
      kind: 'convertible',
      reason: `${util} has a logical form`,
      util,
      replacement: token.slice(0, offset) + lead + logical + tail,
      centeringKey: /^(?:left|right)-(?:1\/2|\[50%\])$/.test(util) ? 'inset' : null,
    };
  }
  for (const [re, reason] of REPORT_ONLY) {
    if (re.test(util)) {
      return { kind: 'report', reason, util, centeringKey: isHalfTranslate(lead, util) ? 'translate' : null };
    }
  }
  return null;
}

const STYLE_PATTERNS = [
  [/\b(?:padding|margin|border)(?:Left|Right)\w*\s*:/g, 'inline style uses a physical property'],
  // A style key follows `{`, `,`, `;`, a quote or the start of a line; a type annotation or prose does not.
  [/(?:^|(?<=[{,;"'`]))\s*(?:left|right)\s*:\s*(?!(?:null|undefined|number|string|boolean|unknown)\b|[A-Z]|\w+\.(?:left|right)\b)[^\s,;}]/gm, 'inline style uses left/right'],
  [/\btextAlign\s*:\s*['"](?:left|right)['"]/g, 'textAlign is physical'],
  [/\bfloat\s*:\s*['"]?(?:left|right)\b/g, 'float is physical'],
  [/\b(?:padding|margin|border)-(?:left|right)\b\s*:/g, 'CSS uses a physical property'],
  [/\btext-align\s*:\s*(?:left|right)\b/g, 'text-align is physical'],
];

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
function lineOf(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Finds every physical-direction token or style in `text`.
 * Each finding: { line, token, start, end, kind: 'convertible' | 'report' | 'style',
 * reason, replacement?, exempt?: 'marked' | 'centering' }.
 */
export function scanSource(text) {
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const marked = (line) => MARK.test(lines[line - 1] ?? '') || MARK.test(lines[line - 2] ?? '');
  const findings = [];
  const candidates = [];
  const allUtils = [];
  const re = /[^\s'"`{}<>;]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const { token, start } = trim(m[0], m.index);
    if (!token) continue;
    const info = classify(token);
    if (info) candidates.push({ token, start, info });
    if (token.includes('rounded')) allUtils.push({ token, start });
  }
  // Centering: a left/right-1/2 and a -translate-x-1/2 in one string, or on one line.
  const hasCentering = (cand, other) => {
    const { start } = cand;
    const line = lineOf(starts, start);
    const segFrom = Math.max(text.lastIndexOf('"', start), text.lastIndexOf("'", start), text.lastIndexOf('`', start)) + 1;
    const nextQ = [text.indexOf('"', start), text.indexOf("'", start), text.indexOf('`', start)].filter((i) => i >= 0);
    const segTo = nextQ.length ? Math.min(...nextQ) : text.length;
    const inSeg = candidates.some((c) => c.info.centeringKey === other && c.start >= segFrom && c.start < segTo);
    if (inSeg) return true;
    return candidates.some((c) => c.info.centeringKey === other && lineOf(starts, c.start) === line);
  };
  // Tailwind emits rounded-s/e/ss/se/es/ee BEFORE rounded-t/b, so converting rounded-l/r/tl/tr/bl/br next
  // to a rounded-t/b in the same string would change which corner wins in LTR. Such a token stays physical
  // (reported) until it is written by hand with an rtl: twin.
  const groupOf = (start) => {
    const line = lineOf(starts, start);
    const segFrom = Math.max(text.lastIndexOf('"', start), text.lastIndexOf("'", start), text.lastIndexOf('`', start)) + 1;
    const nextQ = [text.indexOf('"', start), text.indexOf("'", start), text.indexOf('`', start)].filter((i) => i >= 0);
    const segTo = nextQ.length ? Math.min(...nextQ) : text.length;
    return (o) => (o.start >= segFrom && o.start < segTo) || lineOf(starts, o.start) === line;
  };
  const utilOf = (token) => token.slice(splitToken(token).offset).replace(/^!?-?/, '');
  for (const cand of candidates) {
    if (cand.info.kind !== 'convertible' || !/^rounded-(?:l|r|tl|tr|bl|br)(?:-|$)/.test(cand.info.util)) continue;
    const inGroup = groupOf(cand.start);
    const near = allUtils.filter((o) => o.start !== cand.start && inGroup(o));
    if (near.some((o) => /^rounded-[tb](?:-|$)/.test(utilOf(o.token)))) {
      cand.info = { kind: 'report', reason: 'radius order differs from logical corners', util: cand.info.util, centeringKey: null };
      if (near.some((o) => /(?:^|:)rtl$/.test(splitToken(o.token).variants))) cand.twin = true;
    }
  }
  for (const cand of candidates) {
    const line = lineOf(starts, cand.start);
    const f = {
      line,
      token: cand.token,
      start: cand.start,
      end: cand.start + cand.token.length,
      kind: cand.info.kind,
      reason: cand.info.reason,
    };
    if (cand.info.replacement) f.replacement = cand.info.replacement;
    if (marked(line)) f.exempt = 'marked';
    else if (cand.twin) f.exempt = 'twin';
    else if (cand.info.centeringKey === 'inset' && hasCentering(cand, 'translate')) f.exempt = 'centering';
    else if (cand.info.centeringKey === 'translate' && hasCentering(cand, 'inset')) f.exempt = 'centering';
    findings.push(f);
  }
  for (const [pattern, reason] of STYLE_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const lead = m[0].length - m[0].trimStart().length;
      const at = m.index + lead;
      const line = lineOf(starts, at);
      const f = { line, token: m[0].slice(lead), start: at, end: m.index + m[0].length, kind: 'style', reason };
      if (marked(line)) f.exempt = 'marked';
      findings.push(f);
    }
  }
  findings.sort((a, b) => a.start - b.start);
  return findings;
}

/** Rewrites every convertible token; the rest is returned in `skipped`. */
export function convertSource(text) {
  const findings = scanSource(text);
  const skipped = [];
  let output = '';
  let pos = 0;
  for (const f of findings) {
    if (f.kind === 'convertible' && !f.exempt) {
      output += text.slice(pos, f.start) + f.replacement;
      pos = f.end;
    } else if (f.exempt !== 'centering' || f.kind !== 'convertible') {
      skipped.push({ line: f.line, token: f.token, reason: f.exempt === 'marked' ? 'marked rtl-ok' : f.reason });
    } else {
      skipped.push({ line: f.line, token: f.token, reason: 'centering pair' });
    }
  }
  output += text.slice(pos);
  return { output, skipped };
}

/** Findings the gate counts: not marked, not part of a centering pair. */
export function gateFindings(text) {
  return scanSource(text).filter((f) => !f.exempt);
}

const SOURCE = /\.(?:ts|tsx|css)$/;
const TEST = /\.(?:test|spec)\.|(?:^|[\\/])(?:__tests__|test-stubs)[\\/]/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (SOURCE.test(name) && !name.endsWith('.d.ts') && !TEST.test(p)) out.push(p);
  }
  return out;
}

/** Walks `dir` for source files (no tests, no .d.ts), sorted. */
function walkSources(dir) {
  return walk(dir, []).sort();
}

/**
 * Trees exempt from the gate: the vendored foliate reader and the reader page
 * (src/renderer/lib/reader/). They are third-party or self-contained pages that
 * pick their own direction, so they carry no markers.
 */
export const VENDORED_LTR = ['src/renderer/lib/reader/'];

/** Gate findings for every source file under `<root>/src`: { 'src/a.tsx': [finding...] }. */
export function scanTree(root) {
  const result = {};
  const base = resolve(root);
  for (const file of walkSources(join(base, 'src'))) {
    const rel = relative(base, file).split(sep).join('/');
    if (VENDORED_LTR.some((v) => rel.startsWith(v))) continue;
    const findings = gateFindings(readFileSync(file, 'utf8'));
    if (findings.length) result[rel] = findings;
  }
  return result;
}

/** Why a marked line may stay physical. A reason must begin with one of these. */
export const ALLOWED_REASONS = [
  'centering',
  'pointer coordinates',
  'canvas coordinates',
  'media timeline',
  'code',
  'map',
  'mirrored',
  'physical geometry',
  'rtl selector',
];

/** Null when `reason` starts with an allowed reason (whole words), else a message. */
export function reasonError(reason) {
  const r = reason.trim().toLowerCase();
  const ok = ALLOWED_REASONS.some((a) => r === a || (r.startsWith(a) && /^[^a-z0-9]/.test(r.slice(a.length))));
  return ok ? null : `reason "${reason.trim()}" does not begin with one of: ${ALLOWED_REASONS.join(', ')}`;
}

/** Every `rtl-ok: <reason>` in the source under `<root>/src`: [{ file, line, reason }]. */
export function markedLines(root) {
  const out = [];
  const base = resolve(root);
  for (const file of walkSources(join(base, 'src'))) {
    const rel = relative(base, file).split(sep).join('/');
    if (VENDORED_LTR.some((v) => rel.startsWith(v))) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        const at = text.indexOf('rtl-ok:');
        if (at < 0) return;
        const reason = text.slice(at + 'rtl-ok:'.length).split('*/')[0].replace(/-->.*$/, '').trim();
        out.push({ file: rel, line: i + 1, reason });
      });
  }
  return out;
}

/**
 * The gate: one message per physical-direction use that is not on an
 * `rtl-ok:` line, naming file and line. There is no ratchet: every finding is
 * an error.
 */
export function checkGate(scan) {
  const errors = [];
  for (const [file, findings] of Object.entries(scan)) {
    errors.push(...findings.map((f) => `${file}:${f.line} ${f.token} (${f.reason})`));
  }
  return errors;
}

function main(argv) {
  const mode = argv[0];
  if (mode !== '--check' && mode !== '--write') {
    console.error('usage: rtl-codemod.mjs --check|--write <files...>');
    return 2;
  }
  let convertible = 0;
  for (const file of argv.slice(1)) {
    const text = readFileSync(file, 'utf8');
    const { output, skipped } = convertSource(text);
    for (const s of skipped) console.log(`${file}:${s.line} skipped ${s.token}: ${s.reason}`);
    if (output !== text) {
      if (mode === '--write') {
        writeFileSync(file, output);
        console.log(`${file}: converted`);
      } else {
        convertible += scanSource(text).filter((f) => f.kind === 'convertible' && !f.exempt).length;
        console.log(`${file}: convertible tokens remain`);
      }
    }
  }
  return mode === '--check' && convertible > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
