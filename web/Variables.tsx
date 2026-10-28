// The kernel's variables, as PyCharm's Jupyter Variables view: name, type, shape or length, value.
import { useEffect, useState } from "react";
import { Button, ErrorNote, MENU_LABEL, Popover, TextInput } from "@trame/web-api";
import { listVariables, useCellRuns, type Variable } from "./api";

export function VariablesButton({ kernel }: { kernel: string | null }) {
  const [open, setOpen] = useState(false);
  const [vars, setVars] = useState<Variable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const runs = useCellRuns();
  // refreshed when opened and after every cell run while open
  useEffect(() => {
    if (!open || !kernel) return;
    let live = true;
    listVariables(kernel)
      .then((v) => live && (setVars(v), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [open, kernel, runs]);

  const q = filter.trim().toLowerCase();
  const shown = (vars ?? []).filter((v) => !q || v.name.toLowerCase().includes(q) || v.type.toLowerCase().includes(q));
  return (
    <div className="relative">
      <Button variant="ghost" size="sm" disabled={!kernel} onClick={() => setOpen(!open)} title="the kernel's variables">
        {"{x}"} Variables
      </Button>
      {open && (
        <Popover portal onClose={() => setOpen(false)} className="w-[560px] p-1.5">
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
            <span className={MENU_LABEL}>VARIABLES</span>
            <span className="text-[11px] text-ink-faint">{vars ? shown.length : "…"}</span>
            <span className="flex-1" />
            <span className="w-44">
              <TextInput autoFocus placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </span>
          </div>
          {error && <ErrorNote className="mx-2 mb-1">{error}</ErrorNote>}
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full table-fixed border-collapse text-[11.5px]">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
                <col />
              </colgroup>
              <tbody>
                {shown.map((v) => (
                  <tr key={v.name} className="border-t border-line-soft align-top hover:bg-panel">
                    <td className="truncate px-2 py-1 font-mono text-ink" title={v.name}>{v.name}</td>
                    <td className="truncate px-2 py-1 text-ink-muted" title={v.type}>{v.type}</td>
                    <td className="truncate px-2 py-1 font-mono text-ink-faint">{v.shape ?? (v.len != null ? `len ${v.len}` : "")}</td>
                    <td className="truncate px-2 py-1 font-mono text-ink-soft" title={v.value}>{v.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {vars && shown.length === 0 && <div className="px-2 py-2 text-xs text-ink-muted">No variables</div>}
          </div>
        </Popover>
      )}
    </div>
  );
}
