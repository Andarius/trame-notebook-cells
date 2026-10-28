// A pandas DataFrame read back from its HTML repr, so it renders as a grid rather than a static table.

export type Frame = { columns: string[]; indexName: string; index: string[]; rows: string[][]; shape: [number, number] };

/** "1,234.5" → 1234.5; blank or text → null */
export function asNumber(s: string): number | null {
  const t = s.replace(/,/g, "").trim();
  if (t === "" || t === "NaN") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/** A column is numeric when every non-blank cell parses as a number (NaN counts as blank). */
export const isNumeric = (values: string[]) =>
  values.some((v) => asNumber(v) !== null) && values.every((v) => v.trim() === "" || v === "NaN" || asNumber(v) !== null);

/** Numbers by value, text naturally ("a2" before "a10"), blanks last either way. */
export function compareCells(a: string, b: string, dir: 1 | -1): number {
  const blank = (s: string) => s.trim() === "" || s === "NaN";
  if (blank(a) || blank(b)) return blank(a) === blank(b) ? 0 : blank(a) ? 1 : -1;
  const x = asNumber(a), y = asNumber(b);
  return dir * (x !== null && y !== null ? x - y : a.localeCompare(b, undefined, { numeric: true }));
}

/** pandas prints the full shape under a truncated table: "[100 rows x 3 columns]" or "100 rows × 3 columns". */
export function shapeNote(text: string): [number, number] | null {
  const m = /(\d+) rows [x×] (\d+) columns/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const cellText = (c: Element) => (c.textContent ?? "").trim();

/** The single `table.dataframe` in a pandas HTML repr; null for anything else (MultiIndex spans, extra markup). */
export function parseFrame(html: string): Frame | null {
  if (!html.includes("dataframe")) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = doc.querySelectorAll("table");
  const t = tables[0];
  if (tables.length !== 1 || !t.classList.contains("dataframe") || t.querySelector("[colspan],[rowspan]")) return null;
  const head = t.tHead?.rows;
  const body = t.tBodies[0];
  if (!head?.length || head.length > 2 || !body) return null;
  const columns = [...head[0].cells].slice(1).map(cellText);
  // a second header row names the index
  const indexName = head.length === 2 ? cellText(head[1].cells[0]) : cellText(head[0].cells[0]);
  const index: string[] = [];
  const rows: string[][] = [];
  for (const r of body.rows) {
    const cells = [...r.cells];
    if (cells.length !== columns.length + 1 || cells[0].tagName !== "TH") return null;
    index.push(cellText(cells[0]));
    rows.push(cells.slice(1).map(cellText));
  }
  const note = shapeNote(doc.body.textContent ?? "");
  // pandas' "..." row stands for the rows it left out
  const shown = rows.filter((r) => !r.every((c) => c === "...")).length;
  return { columns, indexName, index, rows, shape: note ?? [shown, columns.length] };
}
