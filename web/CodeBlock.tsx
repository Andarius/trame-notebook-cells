// A python cell: source on top, outputs below, run on the page's Jupyter kernel.
import { useEffect, useRef, useState } from "react";
import { type BlockViewProps, Button, ErrorNote, IconButton, type PluginBlock, useResolvedTheme } from "@trame/web-api";
import { execute, interrupt, noteCellRan, setPreferredKernel, usePreferredKernel } from "./api";
import { editCell, markCell, neighbourCell, registerCell, selectCell, useSelectedCell } from "./cell-mode";
import { applyEvent, CellOutputs, type RunState, storable } from "./cell-output";
import { CodeEditor } from "./CodeEditor";
import { dropCell, setCellSource } from "./notebook";
import type { CellRun, CodeCell } from "./types";

type CodeB = CodeCell;

/** PyCharm's run time: 52ms, 27s 329ms, 2m 5s */
export function duration(ms: number): string {
  const total = Math.round(ms);
  if (total < 1000) return `${total}ms`;
  if (total < 60_000) return `${Math.floor(total / 1000)}s ${total % 1000}ms`;
  const s = Math.round(total / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// under the source, as PyCharm: ✓ [5] 52ms after a run, a spinner and a live clock during one
function RunStatus({ run, count, since }: { run?: CellRun | null; count?: number | null; since: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => tick((n) => n + 1), 97);
    return () => clearInterval(t);
  }, [since]);
  if (since == null && !run) return null;
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1 font-mono text-[11px] text-ink-faint">
      {since != null
        ? (
          <>
            <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-ink-faint border-t-transparent" />
            <span>{duration(performance.now() - since)}</span>
          </>
        )
        : run && (
          <span title={`${run.ok ? "ran" : "failed"} at ${new Date(run.at).toLocaleString()}`} className="flex items-center gap-1.5">
            <span className={run.ok ? "text-active" : "text-blocked"}>{run.ok ? "✓" : "✗"}</span>
            {count != null && <span>[{count}]</span>}
            <span>{duration(run.ms)}</span>
          </span>
        )}
    </div>
  );
}

function CodeBlock({ block: raw, enabled, onPatch, onRemove, onInsert, onOpenSettings }: BlockViewProps) {
  const block = raw as CodeB;
  const [draft, setDraft] = useState(block.source);
  const [run, setRun] = useState<RunState | null>(null); // live outputs while running, else the block's
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [since, setSince] = useState<number | null>(null); // when the kernel started this run
  const kernel = usePreferredKernel();
  const theme = useResolvedTheme();
  const id = block.id ?? "";
  const selected = useSelectedCell() === id;
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;

  // a cell edited elsewhere (another device, an agent) shows its new source
  useEffect(() => setDraft(block.source), [block.source]);
  useEffect(() => () => abort.current?.abort(), []);
  // the notebook-wide lint reads every cell's live text
  useEffect(() => setCellSource(id, draft), [id, draft]);
  useEffect(() => () => dropCell(id), [id]);

  const commitSource = () => {
    if (draft !== block.source) onPatch({ source: draft });
  };

  const execCell = async () => {
    if (running || !enabled) return;
    commitSource();
    setRunning(true);
    setErr(null);
    let state: RunState = { outputs: [], clearPending: false, count: null };
    setRun(state);
    const ctl = new AbortController();
    abort.current = ctl;
    let began = performance.now();
    let timing: CellRun | null = null;
    setSince(began);
    try {
      await execute(draft, kernel, theme, (ev) => {
        if (ev.type === "start") {
          if (ev.kernel !== kernel) setPreferredKernel(ev.kernel);
          return;
        }
        // queued behind another cell until the kernel echoes the input
        if (ev.type === "input") setSince(began = performance.now());
        if (ev.type === "reply") timing = { ms: ev.ms ?? performance.now() - began, ok: ev.status === "ok", at: new Date().toISOString() };
        state = applyEvent(state, ev);
        setRun(state);
      }, ctl.signal);
      patchRef.current({ source: draft, outputs: storable(state.outputs), count: state.count, run: timing });
    } catch (e) {
      if (!ctl.signal.aborted) setErr((e as Error).message);
    } finally {
      setRunning(false);
      setRun(null);
      setSince(null);
      abort.current = null;
      noteCellRan();
    }
  };

  const execRef = useRef(execCell);
  execRef.current = execCell;
  useEffect(() =>
    registerCell(id, {
      run: () => execRef.current(),
      clear: () => patchRef.current({ outputs: [], count: null, run: null }),
    }), [id]);

  const stop = () => {
    if (kernel) interrupt(kernel).catch((e: Error) => setErr(e.message));
  };

  // Shift+Enter: run, then select the next cell, or open a new one below the last (Jupyter)
  const runAndAdvance = () => {
    void execCell();
    const next = neighbourCell(id, 1);
    if (next) selectCell(next);
    else editCell(onInsert("below"));
  };

  // command mode (cell selected, editor not focused): Jupyter's single-key commands
  const onCommandKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const now = Date.now();
    const twice = (k: string) => lastKey.current?.key === k && now - lastKey.current.at < 600;
    const take = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === "Enter" && e.shiftKey) return (take(), runAndAdvance());
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return (take(), void execCell());
    if (e.key === "Enter") return (take(), editCell(id));
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "a") return (take(), selectCell(onInsert("above")));
    if (k === "b") return (take(), selectCell(onInsert("below")));
    if (k === "arrowdown" || k === "j") return (take(), selectCell(neighbourCell(id, 1) ?? id));
    if (k === "arrowup" || k === "k") return (take(), selectCell(neighbourCell(id, -1) ?? id));
    if (k === "escape") return (take(), selectCell(null), e.currentTarget.blur());
    if (k === "d" || k === "i") {
      take();
      if (!twice(k)) return void (lastKey.current = { key: k, at: now });
      lastKey.current = null;
      if (k === "i") return stop();
      selectCell(neighbourCell(id, 1) ?? neighbourCell(id, -1));
      return onRemove();
    }
    lastKey.current = null;
  };

  const outputs = run?.outputs ?? block.outputs ?? [];
  const count = running ? "*" : block.count ?? " ";

  return (
    <div
      data-cell-id={id}
      tabIndex={-1}
      onKeyDown={onCommandKey}
      onMouseDown={(e) => {
        // a click outside the editor selects the cell (command mode); inside, CodeMirror takes it
        if (!(e.target as HTMLElement).closest(".cm-editor, button, a, iframe")) selectCell(id);
      }}
      onFocus={(e) => (e.target as HTMLElement).closest(".cm-editor") && markCell(id)}
      className={`group/cell relative my-1 overflow-hidden rounded-lg border bg-block outline-none ${
        selected ? "border-copper/60" : "border-line-soft"
      }`}
    >
      {/* Jupyter's selection bar */}
      <span className={`absolute inset-y-0 left-0 w-[3px] ${selected ? "bg-copper" : "bg-transparent"}`} />
      <div className="flex items-center gap-2 px-2 pt-1">
        <span className="w-10 shrink-0 font-mono text-[10.5px] text-ink-faint">[{count}]</span>
        {enabled
          ? (
            <Button variant="chip" size="sm" className="shrink-0" onClick={running ? stop : execCell} title={running ? "interrupt the kernel (i i)" : "run (ctrl+enter)"}>
              {running ? "■ stop" : "▶ run"}
            </Button>
          )
          : (
            <Button variant="chip" size="sm" className="shrink-0" onClick={onOpenSettings} title="the Notebook cells plugin runs cells on a Jupyter kernel">
              turn on to run
            </Button>
          )}
        <span className="flex-1" />
        <span className="hidden text-[10px] text-ink-faint group-hover/cell:inline">
          esc · a/b insert · dd delete · ⇧⏎ run next
        </span>
        <Button variant="chip" size="sm" className="shrink-0" title="clear outputs" disabled={!block.outputs?.length || running} onClick={() => onPatch({ outputs: [], count: null, run: null })}>
          clear
        </Button>
        <IconButton tone="danger" onClick={onRemove} title="remove the cell (d d)" className="shrink-0 rounded px-1 hover:bg-panel">
          ×
        </IconButton>
      </div>
      <CodeEditor
        cellId={id}
        value={draft}
        onChange={setDraft}
        onBlur={commitSource}
        onRun={() => void execCell()}
        onRunNext={runAndAdvance}
        onEscape={() => selectCell(id)}
      />
      <RunStatus run={block.run} count={block.count} since={running ? since : null} />
      {err && <ErrorNote className="mx-2 my-1.5">{err}</ErrorNote>}
      <CellOutputs outputs={outputs} />
    </div>
  );
}

export const CODE_CELL: PluginBlock = {
  type: "code",
  label: "Code cell",
  hint: "python on a Jupyter kernel",
  create: () => ({ source: "" }),
  View: CodeBlock,
  wide: true,
};
