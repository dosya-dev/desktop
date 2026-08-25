// Ported from apps/web/src/lib/csv-table.ts - keep in sync with the web copy.
/**
 * A CSV body parsed into something a table can render.
 *
 * Hand-rolled rather than a dependency (kept in step with apps/mobile/src/viewer/csvTable.ts - the apps cannot import shared code, so parity is by copy, like the validation policy): the grammar that matters here is
 * quoted fields, embedded delimiters, escaped quotes and embedded newlines -
 * about forty lines - and the body is already capped at 200KB by the preview
 * fetch, so streaming performance is not a concern.
 */

export interface CsvTable {
  /** The first row. Rendered emphasised; most real CSVs lead with names. */
  header: string[];
  rows: string[][];
  /** Rows beyond the render cap, dropped from `rows` but counted honestly. */
  truncatedRows: number;
  columns: number;
  delimiter: "," | ";" | "\t";
}

/**
 * Enough for any spreadsheet a phone screen can be useful for; a 200KB body
 * can hold tens of thousands of short rows, and rendering them all turns the
 * first paint into seconds of layout for rows nobody will scroll to.
 */
export const MAX_CSV_RENDER_ROWS = 300;

/**
 * The delimiter is whichever candidate appears most in the first line,
 * counted OUTSIDE quotes - a title like "Surname, first name" must not vote
 * for comma. Ties go tab, then semicolon: a tab in line one is near-proof of
 * TSV, while semicolon-delimited files (the European Excel default) usually
 * contain commas as decimal separators.
 */
function sniffDelimiter(firstLine: string): "," | ";" | "\t" | null {
  const counts: Record<string, number> = { "\t": 0, ";": 0, ",": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  for (const d of ["\t", ";", ","] as const) {
    if (counts[d] > 0 && counts[d] >= counts[","] && counts[d] >= counts[";"]) return d;
  }
  return null;
}

/** RFC 4180-ish field splitter: quotes, "" escapes, newlines inside quotes. */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); records.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return records;
}

/**
 * Null means "this is not usefully a table" - no delimiter, or a single
 * column - and the caller should fall back to the plain text card, which
 * renders any of those degenerate shapes perfectly well.
 */
export function parseCsvTable(text: string): CsvTable | null {
  const body = text.replace(/^\uFEFF/, ""); // Excel exports lead with a BOM
  const firstLine = body.slice(0, body.indexOf("\n") < 0 ? body.length : body.indexOf("\n"));
  const delimiter = sniffDelimiter(firstLine);
  if (!delimiter) return null;

  const records = splitRecords(body, delimiter).filter(
    // A trailing newline produces one phantom empty record; drop empties.
    (r) => r.length > 1 || r[0] !== "",
  );
  if (records.length < 2) return null;

  const columns = Math.max(...records.map((r) => r.length));
  if (columns < 2) return null;

  const padded = records.map((r) =>
    r.length === columns ? r : [...r, ...Array<string>(columns - r.length).fill("")],
  );
  const [header, ...rest] = padded;
  return {
    header,
    rows: rest.slice(0, MAX_CSV_RENDER_ROWS),
    truncatedRows: Math.max(0, rest.length - MAX_CSV_RENDER_ROWS),
    columns,
    delimiter,
  };
}
