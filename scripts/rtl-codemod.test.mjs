import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertSource, gateFindings } from './rtl-codemod.mjs';

/** it.each: `%s` in the title takes the row's values in order. */
function eachCase(rows, title, fn) {
  for (const row of rows) {
    let i = 0;
    it(title.replace(/%s/g, () => String(row[i++])), () => fn(...row));
  }
}

const conv = (s) => convertSource(s).output;

describe('rtl-codemod mapping', () => {
  eachCase([
    ['ml-2', 'ms-2'],
    ['mr-2', 'me-2'],
    ['pl-4', 'ps-4'],
    ['pr-4', 'pe-4'],
    ['left-0', 'inset-s-0'],
    ['right-0', 'inset-e-0'],
    ['text-left', 'text-start'],
    ['text-right', 'text-end'],
    ['rounded-l', 'rounded-s'],
    ['rounded-r-lg', 'rounded-e-lg'],
    ['rounded-tl-md', 'rounded-ss-md'],
    ['rounded-tr', 'rounded-se'],
    ['rounded-bl-xl', 'rounded-es-xl'],
    ['rounded-br', 'rounded-ee'],
    ['border-l', 'border-s'],
    ['border-r-2', 'border-e-2'],
    ['border-l-red-500', 'border-s-red-500'],
    ['border-r-border', 'border-e-border'],
    ['scroll-ml-2', 'scroll-ms-2'],
    ['scroll-mr-2', 'scroll-me-2'],
    ['scroll-pl-2', 'scroll-ps-2'],
    ['scroll-pr-2', 'scroll-pe-2'],
    ['float-left', 'float-start'],
    ['float-right', 'float-end'],
    ['ml-auto', 'ms-auto'],
    ['pl-0.5', 'ps-0.5'],
    ['right-1/3', 'inset-e-1/3'],
  ], '%s -> %s', (from, to) => {
    assert.equal(conv(`"${from}"`), `"${to}"`);
  });

  it('keeps variant prefixes, negatives, arbitrary values and important', () => {
    assert.equal(conv('"md:hover:ml-2"'), '"md:hover:ms-2"');
    assert.equal(conv('"-mr-1"'), '"-me-1"');
    assert.equal(conv('"pl-[3px]"'), '"ps-[3px]"');
    assert.equal(conv('"!text-left"'), '"!text-start"');
    assert.equal(conv('"dark:md:-left-2"'), '"dark:md:-inset-s-2"');
    assert.equal(conv('"[&>svg]:ml-2"'), '"[&>svg]:ms-2"');
  });

  it('converts inside cn(), cva variants and template literals', () => {
    assert.equal(conv("cn('flex ml-2', open && 'mr-1')"), "cn('flex ms-2', open && 'me-1')");
    assert.equal(conv('cva("base", { variants: { size: { sm: "pl-2 pr-3" } } })'), 'cva("base", { variants: { size: { sm: "ps-2 pe-3" } } })');
    assert.equal(conv('const c = `flex ${on ? "ml-2" : ""} text-left`'), 'const c = `flex ${on ? "ms-2" : ""} text-start`');
  });

  it('leaves the centering pair alone and reports it', () => {
    const src = '"absolute left-1/2 -translate-x-1/2"';
    const { output, skipped } = convertSource(src);
    assert.equal(output, src);
    assert.ok(skipped.map((s) => s.token).includes('left-1/2'));
  });

  it('converts left-1/2 on its own', () => {
    assert.equal(conv('"absolute left-1/2"'), '"absolute inset-s-1/2"');
  });

  it('reports translate-x, origin and side variants without converting', () => {
    for (const src of ['"translate-x-full"', '"origin-left"', '"origin-top-right"', '"data-[side=left]:ml-2"']) {
      const { output, skipped } = convertSource(src);
      assert.equal(output, src);
      assert.equal(skipped.length, 1);
    }
  });

  it('does not touch locales or prose that only look like classes', () => {
    for (const src of ["'pl-PL'", '"ml-IN"', '"left-aligned text"', 'const side = "right"']) {
      const { output, skipped } = convertSource(src);
      assert.equal(output, src);
      assert.deepEqual(skipped, []);
    }
  });

  it('skips explicit ltr: and rtl: pairs', () => {
    const src = '"ltr:ml-2 rtl:mr-2"';
    assert.equal(convertSource(src).output, src);
  });

  it('honours rtl-ok on the line or the line above', () => {
    const same = '"ml-2" // rtl-ok: timeline';
    assert.equal(convertSource(same).output, same);
    const above = '// rtl-ok: timeline\n"ml-2"';
    assert.equal(convertSource(above).output, above);
    assert.equal(convertSource(above).skipped[0].reason, 'marked rtl-ok');
  });

  it('is idempotent', () => {
    const once = conv('cn("ml-2 mr-1 text-left", `pl-4 ${x}`)');
    assert.equal(conv(once), once);
  });

  it('reports line numbers', () => {
    const { skipped } = convertSource('a\n"translate-x-full"');
    assert.equal(skipped[0].line, 2);
    assert.equal(skipped[0].token, 'translate-x-full');
  });
});

describe('rtl-codemod radius is LTR-safe', () => {
  // Tailwind emits rounded-s/e/ss/se/es/ee before rounded-t/b, so these must stay physical.
  eachCase([
    ['rounded-t-lg rounded-l-none'],
    ['rounded-l-none rounded-t-lg'],
    ['rounded-b-md rounded-r-lg'],
    ['rounded-t-lg rounded-tl-none'],
    ['rounded-t-lg rounded-tr-none'],
    ['rounded-b-lg rounded-bl-none'],
    ['rounded-b-lg rounded-br-none'],
    ['rounded-t-lg md:rounded-l-none'],
  ], '%s is left physical and reported', (cls) => {
    const src = `"${cls}"`;
    const { output, skipped } = convertSource(src);
    assert.equal(output, src);
    assert.equal(skipped.some((s) => s.reason.includes('radius order')), true);
  });

  it('still converts a radius that has no rounded-t/b neighbour', () => {
    assert.equal(conv('"rounded-l-md rounded-r-md"'), '"rounded-s-md rounded-e-md"');
    assert.equal(conv('"rounded-lg rounded-tl-none"'), '"rounded-lg rounded-ss-none"');
  });

  it('accepts a hand-written rtl: twin as the exemption in the gate', () => {
    const src = '"rounded-t-lg rounded-l-none rtl:rounded-r-none rtl:rounded-tl-lg"';
    assert.deepEqual(gateFindings(src), []);
  });

  it('the gate counts a physical radius next to rounded-t', () => {
    assert.equal(gateFindings('"rounded-t-lg rounded-l-none"').length, 1);
  });
});

describe('rtl-codemod centering forms', () => {
  eachCase([
    ['absolute left-[50%] -translate-x-1/2'],
    ['absolute left-1/2 -translate-x-[50%]'],
    ['absolute left-1/2 -translate-1/2'],
    ['absolute left-[50%] translate-x-[-50%]'],
    ['absolute md:left-1/2 md:-translate-x-1/2'],
    ['absolute right-1/2 translate-x-[-50%]'],
  ], '%s is a centering pair, left alone', (cls) => {
    const src = `"${cls}"`;
    assert.equal(convertSource(src).output, src);
    assert.deepEqual(gateFindings(src), []);
  });

  it('reports a lone -translate-1/2 and a lone -translate-x-[50%]', () => {
    assert.equal(gateFindings('"-translate-1/2"').length, 1);
    assert.equal(gateFindings('"-translate-x-[50%]"').length, 1);
  });
});

describe('rtl-codemod marker needs a reason', () => {
  it('an empty rtl-ok: does not exempt', () => {
    assert.equal(convertSource('"ml-2" // rtl-ok:').output, '"ms-2" // rtl-ok:');
    assert.equal(convertSource('"ml-2" // rtl-ok: why').output, '"ml-2" // rtl-ok: why');
  });
});

describe('rtl-codemod style scanning', () => {
  it('counts physical inline style keys and textAlign', () => {
    const src = [
      'const a = { paddingLeft: 8 };',
      'const b = { marginRight: 4 };',
      'const c = { left: 0, right: 2 };',
      "const d = { textAlign: 'left' };",
    ].join('\n');
    assert.deepEqual(gateFindings(src).map((f) => f.line), [1, 2, 3, 3, 4]);
  });

  it('counts physical CSS and ignores logical properties', () => {
    assert.equal(gateFindings('.a { margin-left: 4px; text-align: right; left: 6px }').length, 3);
    assert.equal(gateFindings('.a { margin-inline-start: 4px; inset-inline-start: 6px }').length, 0);
  });
});
