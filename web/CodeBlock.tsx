// A python cell: source on top, outputs below, run on the page's Jupyter kernel.
import { useEffect, useRef, useState } from "react";
import { type BlockViewProps, Button, ErrorNote, IconButton, type PluginBlock } from "@trame/web-api";
import { execute, interrupt, setPreferredKernel, usePreferredKernel } from "./api";
import { editCell, markCell, neighbourCell, registerCell, selectCell, useSelectedCell } from "./cell-mode";
import { applyEvent, CellOutputs, type RunState, storable } from "./cell-output";
import { CodeEditor } from "./CodeEditor";
import type { CodeCell } from "./types";

type CodeB = CodeCell;

function CodeBlock({ block: raw, enabled, onPatch, onRemove, onInsert, onOpenSettings }: BlockViewProps) {
  const block = raw as CodeB;
  const [draft, setDraft] = useState(block.source);
  const [run, setRun] = useState<RunState | null>(null); // live outputs while running, else the block's
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kernel = usePreferredKernel();
  const id = block.id ?? "";
  const selected = useSelectedCell() === id;
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;

  // a cell edited elsewhere (another device, an agent) shows its new source
  useEffect(() => setDraft(block.source), [block.source]);
  useEffect(() => () => abort.current?.abort(), []);

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
    try {
      await execute(draft, kernel, (ev) => {
        if (ev.type === "start") {
          if (ev.kernel !== kernel) setPreferredKernel(ev.kernel);
          return;
        }
        state = applyEvent(state, ev);
        setRun(state);
      }, ctl.signal);
      patchRef.current({ source: draft, outputs: storable(state.outputs), count: state.count });
    } catch (e) {
      if (!ctl.signal.aborted) setErr((e as Error).message);
    } finally {
      setRunning(false);
      setRun(null);
      abort.current = null;
    }
  };

  const execRef = useRef(execCell);
  execRef.current = execCell;
  useEffect(() =>
    registerCell(id, {
      run: () => execRef.current(),
      clear: () => patchRef.current({ outputs: [], count: null }),
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
        <Button variant="chip" size="sm" className="shrink-0" title="clear outputs" disabled={!block.outputs?.length || running} onClick={() => onPatch({ outputs: [], count: null })}>
          clear
        </Button>
        <IconButton tone="danger" onClick={onRemove} title="remove the cell (d d)" className="shrink-0 rounded px-1 hover:bg-panel">
          ×
        </IconButton>
      </div>
      <CodeEditor
        value={draft}
        onChange={setDraft}
        onBlur={commitSource}
        onRun={() => void execCell()}
        onRunNext={runAndAdvance}
        onEscape={() => selectCell(id)}
      />
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
