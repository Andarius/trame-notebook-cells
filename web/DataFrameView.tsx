// A DataFrame as PyCharm shows it: shape bar, sortable headers, text left and numbers right, a row filter.
import { useMemo, useState } from "react";
import { compareCells, type Frame, isNumeric } from "./dataframe";

type Sort = { col: number; dir: 1 | -1 } | null; // col -1 is the index

function SortMark({ active, dir }: { active: boolean; dir: 1 | -1 }) {
  return <span className={`ml-auto pl-2 text-[10px] ${active ? "text-copper" : "text-ink-faint"}`}>{active ? (dir > 0 ? "▲" : "▼") : "⇅"}</span>;
}

export function DataFrameView({ frame }: { frame: Frame }) {
  const [sort, setSort] = useState<Sort>(null);
  const [filter, setFilter] = useState("");
  const numeric = useMemo(() => frame.columns.map((_, c) => isNumeric(frame.rows.map((r) => r[c]))), [frame]);
  const order = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const gap = (i: number) => frame.rows[i].every((v) => v === "...");
    let ids = frame.rows.map((_, i) => i).filter((i) => !q || gap(i) || `${frame.index[i]} ${frame.rows[i].join(" ")}`.toLowerCase().includes(q));
    if (sort) {
      const value = (i: number) => (sort.col < 0 ? frame.index[i] : frame.rows[i][sort.col]);
      // pandas' "..." row holds no values: it goes last
      ids = [...ids.filter((i) => !gap(i)).sort((a, b) => compareCells(value(a), value(b), sort.dir)), ...ids.filter(gap)];
    }
    return ids;
  }, [frame, sort, filter]);
  const toggle = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  const head = "sticky top-0 z-10 cursor-pointer select-none border-b border-l border-line bg-panel px-3 py-1.5 font-normal text-ink-soft first:border-l-0 hover:text-ink";

  return (
    <div className="overflow-hidden rounded-md border border-line-soft">
      <div className="flex items-center gap-3 border-b border-line-soft bg-panel px-3 py-1 text-[11px] text-ink-muted">
        <span>{frame.shape[0]} rows × {frame.shape[1]} cols</span>
        {filter && <span className="text-ink-faint">{order.length} shown</span>}
        <span className="flex-1" />
        {frame.rows.length >= 8 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter rows"
            className="w-48 rounded border border-line-soft bg-transparent px-2 py-0.5 text-[11px] text-ink outline-none focus:border-copper/60"
          />
        )}
      </div>
      <div className="max-h-[480px] overflow-auto">
        <table className="min-w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              <th className={`${head} text-right`} onClick={() => toggle(-1)} title="sort by the index">
                <span className="flex items-center">{frame.indexName}<SortMark active={sort?.col === -1} dir={sort?.dir ?? 1} /></span>
              </th>
              {frame.columns.map((name, c) => (
                <th key={c} className={`${head} ${numeric[c] ? "text-right" : "text-left"}`} onClick={() => toggle(c)} title={`sort by ${name}`}>
                  <span className="flex items-center gap-1">
                    {numeric[c] && <span className="flex-1" />}
                    <span className="whitespace-nowrap">{name}</span>
                    <SortMark active={sort?.col === c} dir={sort?.dir ?? 1} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((i) => (
              <tr key={i} className="border-t border-line-soft hover:bg-panel/60">
                <td className="px-3 py-1 text-right text-ink-faint">{frame.index[i]}</td>
                {frame.rows[i].map((v, c) => (
                  <td key={c} title={v} className={`max-w-[480px] truncate border-l border-line-soft px-3 py-1 text-ink ${numeric[c] ? "text-right" : "text-left"}`}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
