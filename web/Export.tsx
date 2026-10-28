// Under a page's brief: export the page's cells as a standalone HTML report, import an .ipynb's cells.
import { useEffect, useRef, useState } from "react";
import { type Block, Button, openInBrowser, type PageDetail, TextInput, updatePage, usePluginEnabled } from "@trame/web-api";
import { clearAll, runAll } from "./cell-mode";
import { createReport, interrupt, type Kernel, listKernels, readNotebook, restart, setPreferredKernel, usePreferredKernel } from "./api";
import { pageToHtml } from "./export-html";
import { KernelMenu } from "./KernelMenu";
import { relint, useLintError } from "./notebook";
import { VariablesButton } from "./Variables";
import type { CellOutput, PageBlock } from "./types";


// The page's one kernel: every cell runs on it (Jupyter's top-right kernel indicator).
function KernelBar({ cells }: { cells: number }) {
  const kernel = usePreferredKernel();
  const [kernels, setKernels] = useState<Kernel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const cancel = useRef(false);
  const load = () =>
    listKernels().then((list) => {
      setKernels(list);
      setError(null);
      if (!list.some((k) => k.id === kernel)) setPreferredKernel(list[0]?.id ?? null);
    }).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- polls the kernel list and its busy state
  }, [kernel]);
  const lintError = useLintError();
  // missing modules depend on the kernel's environment
  useEffect(relint, [kernel]);
  const current = kernels?.find((k) => k.id === kernel);
  const busy = runningAll || current?.state === "busy";
  const fail = (e: Error) => setError(e.message);
  const runEverything = () => {
    cancel.current = false;
    setRunningAll(true);
    runAll(() => cancel.current).finally(() => setRunningAll(false));
  };
  const stopEverything = () => {
    cancel.current = true;
    if (kernel) interrupt(kernel).catch(fail);
  };
  return (
    <>
      {kernels
        ? <KernelMenu kernels={kernels} current={kernel} onPick={setPreferredKernel} onChanged={() => void load()} />
        : <span className="px-2">{error ?? "connecting…"}</span>}
      <span className="mx-1 h-4 w-px bg-chipline" />
      {busy
        ? <Button variant="ghost" size="sm" onClick={stopEverything} disabled={!kernel}>■ Stop</Button>
        : <Button variant="ghost" size="sm" onClick={runEverything} disabled={!kernel || cells === 0}>▶ Run all</Button>}
      <Button
        variant="ghost"
        size="sm"
        title="restart the kernel with its current settings: its variables are lost, outputs stay"
        disabled={!kernel}
        onClick={() => kernel && (cancel.current = true, restart(kernel).then((id) => (setPreferredKernel(id), load())).catch(fail))}
      >
        ↻ Restart
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void clearAll()} disabled={cells === 0 || runningAll}>⌫ Clear outputs</Button>
      <VariablesButton kernel={kernel} />
      {error && kernels && <span className="text-blocked">{error}</span>}
      {lintError && <span className="text-paused" title={lintError}>inspections off: {lintError}</span>}
    </>
  );
}

export function NotebookCellsPageHeader({ page, onDone }: { page: PageDetail; onDone: () => void }) {
  const enabled = usePluginEnabled("notebook-cells");
  const [importing, setImporting] = useState(false);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const content = page.content as PageBlock[];
  const cells = content.filter((b) => b.type === "code").length;
  if (!enabled && cells === 0) return null;

  const exportHtml = () =>
    createReport(page.title, pageToHtml(page.title, content))
      .then((r) => openInBrowser(`/report/${r.id}`))
      .then(() => setStatus("exported to Reports"))
      .catch((e: Error) => setStatus(e.message));

  const importCells = () =>
    readNotebook(path.trim()).then((nb) => {
      const blocks: PageBlock[] = nb.cells.map((c) =>
        c.cell_type === "code"
          ? { type: "code", source: c.source, outputs: (c.outputs ?? []) as CellOutput[], count: c.count ?? null, id: crypto.randomUUID() }
          : { type: "text", text: c.source, id: crypto.randomUUID() }
      );
      return updatePage(page.id, { content: [...content, ...blocks] as Block[] });
    }).then(() => {
      setImporting(false);
      setStatus(null);
      onDone();
    }).catch((e: Error) => setStatus(e.message));

  return (
    // sticky: the kernel and run controls stay in reach down a long notebook
    <div className="sticky top-0 z-30 -mx-2 bg-canvas px-2 py-2">
      <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-card px-2.5 py-1.5 text-[11.5px] text-ink-muted">
        {enabled && <KernelBar cells={cells} />}
        <span className="flex-1" />
        <span className="mr-1">{cells} cell{cells === 1 ? "" : "s"}</span>
        <Button variant="chip" size="sm" onClick={exportHtml} disabled={cells === 0}>Export HTML</Button>
        {importing
          ? (
            <>
              <span className="w-64">
                <TextInput
                  autoFocus
                  mono
                  placeholder="notebook path on the server, e.g. deviations.ipynb"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && path.trim()) importCells();
                    if (e.key === "Escape") setImporting(false);
                  }}
                />
              </span>
              <Button variant="chip" size="sm" onClick={importCells} disabled={!path.trim()}>Import</Button>
            </>
          )
          : <Button variant="chip" size="sm" onClick={() => setImporting(true)}>Import .ipynb</Button>}
        {status && <span>{status}</span>}
      </div>
    </div>
  );
}
