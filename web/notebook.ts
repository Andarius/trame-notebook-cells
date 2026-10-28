// The page's cells read as one notebook: their live sources, and diagnostics from one lint pass over all of them.
import { type Diagnostic, fromRuff, importedModules, shadowedParams, topLevelNames } from "./analysis";
import { lintCells, missingModules, preferredKernel } from "./api";
import { pageOrder } from "./cell-mode";
import { store } from "./store";

/** a cell's diagnostics, with the source they were computed on */
export type CellDiagnostics = { source: string; items: Diagnostic[] };

const sources = new Map<string, string>();
const results = store<Record<string, CellDiagnostics>>({});
const lintError = store<string | null>(null);
export const useCellDiagnostics = (id: string): CellDiagnostics | undefined => results.use()[id];
export const useLintError = lintError.use;

/** The cells' current sources in page order, unsaved edits included. */
export function notebookSources(): { ids: string[]; cells: string[] } {
  const ids = pageOrder();
  return { ids, cells: ids.map((id) => sources.get(id) ?? "") };
}

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

/** A cell's source changed (typed, synced, mounted): lint the notebook once things settle. */
export function setCellSource(id: string, source: string) {
  if (sources.get(id) === source) return;
  sources.set(id, source);
  clearTimeout(timer);
  timer = setTimeout(() => void lintNow(), 500);
}

export function dropCell(id: string) {
  sources.delete(id);
}

// asked again only when the kernel or the imports change: a probe queues behind a running cell
let checked: { key: string; missing: Set<string> } | null = null;
async function missingFor(kernel: string, names: string[]): Promise<Set<string>> {
  const key = `${kernel} ${[...names].sort().join(",")}`;
  if (checked?.key !== key) checked = { key, missing: new Set(await missingModules(kernel, names).catch(() => [])) };
  return checked.missing;
}

async function lintNow() {
  const run = ++generation;
  const { ids, cells } = notebookSources();
  if (ids.length === 0) return;
  const per: Record<string, CellDiagnostics> = Object.fromEntries(ids.map((id, i) => [id, { source: cells[i], items: [] }]));
  try {
    for (const d of await lintCells(cells)) {
      const id = ids[d.cell];
      if (id) per[id].items.push(fromRuff(cells[d.cell], d));
    }
    lintError.set(null);
  } catch (e) {
    lintError.set((e as Error).message);
  }
  const outer = new Set(cells.flatMap(topLevelNames));
  cells.forEach((src, i) => per[ids[i]].items.push(...shadowedParams(src, outer)));
  // the kernel's environment decides what imports: PyCharm's unresolved import
  const kernel = preferredKernel();
  const imports = cells.map(importedModules);
  const names = [...new Set(imports.flat().map((m) => m.name))];
  if (kernel && names.length) {
    const missing = await missingFor(kernel, names);
    imports.forEach((list, i) => {
      for (const m of list) {
        if (missing.has(m.name)) per[ids[i]].items.push({ from: m.from, to: m.to, severity: "error", message: `No module named '${m.name}'` });
      }
    });
  }
  if (run === generation) results.set(per);
}

/** Lint again without an edit, asking the kernel afresh, e.g. once the kernel changed. */
export function relint() {
  checked = null;
  void lintNow();
}
