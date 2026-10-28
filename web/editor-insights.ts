// PyCharm-like help in a cell: inspections, kernel completion, quick doc and parameter info,
// folded imports, reformat and optimize imports.
import { autocompletion, type Completion as CmCompletion, type CompletionSource } from "@codemirror/autocomplete";
import { codeFolding, ensureSyntaxTree, foldEffect, foldedRanges, foldService, syntaxTree, unfoldEffect } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { type Command, Decoration, type DecorationSet, EditorView, hoverTooltip, showTooltip, type Tooltip } from "@codemirror/view";
import { type Diagnostic, leadingImportsIn, type Severity, toCodePoints, toUtf16 } from "./analysis";
import { complete, formatCode, inspect, optimizeImports, preferredKernel } from "./api";
import { ansiRuns } from "./cell-output";
import { notebookSources } from "./notebook";

// Diagnostics

const RANK: Record<Severity, number> = { error: 3, warning: 2, weak: 1, unused: 0 };
export const setDiagnostics = StateEffect.define<Diagnostic[]>();

const diagnosticsField = StateField.define<{ items: Diagnostic[]; deco: DecorationSet }>({
  create: () => ({ items: [], deco: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setDiagnostics)) continue;
      const len = tr.state.doc.length;
      const items = e.value.filter((d) => d.to <= len && d.from < d.to);
      const deco = Decoration.set(items.map((d) => Decoration.mark({ class: `cm-diag-${d.severity}` }).range(d.from, d.to)), true);
      return { items, deco };
    }
    if (!tr.docChanged) return value;
    const items = value.items
      .map((d) => ({ ...d, from: tr.changes.mapPos(d.from, 1), to: tr.changes.mapPos(d.to, -1) }))
      .filter((d) => d.from < d.to);
    return { items, deco: value.deco.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const worstIn = (state: EditorState, from: number, to: number): Severity | null =>
  state.field(diagnosticsField).items
    .filter((d) => d.from < to && d.to > from)
    .reduce<Severity | null>((w, d) => (w && RANK[w] >= RANK[d.severity] ? w : d.severity), null);

/** Replaces a cell's diagnostics; a folded import block is redrawn so its placeholder shows them. */
export function applyDiagnostics(view: EditorView, items: Diagnostic[]) {
  view.dispatch({ effects: setDiagnostics.of(items) });
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }), foldEffect.of({ from, to }));
  });
  if (effects.length) view.dispatch({ effects });
}

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const diagnosticHover = hoverTooltip((view, pos) => {
  const items = view.state.field(diagnosticsField).items.filter((d) => d.from <= pos && d.to >= pos);
  if (!items.length) return null;
  return {
    pos: Math.min(...items.map((d) => d.from)),
    end: Math.max(...items.map((d) => d.to)),
    above: true,
    create: () => {
      const dom = el("div", "cm-diag-tip");
      for (const d of items) {
        const row = el("div", `cm-diag-row cm-diag-row-${d.severity}`, d.message);
        if (d.code) row.append(el("span", "cm-diag-code", ` ${d.code}`));
        dom.append(row);
      }
      return { dom };
    },
  };
});

// Kernel completion

const KIND: Record<string, string> = {
  function: "function", class: "class", module: "namespace", keyword: "keyword", instance: "variable",
  statement: "variable", param: "variable", property: "property", path: "text", magic: "keyword",
};

const kernelCompletion: CompletionSource = async (ctx) => {
  const kernel = preferredKernel();
  const word = ctx.matchBefore(/[\w.]*$/);
  if (!kernel || (!ctx.explicit && (!word || word.from === word.to))) return null;
  const code = ctx.state.doc.toString();
  const ctl = new AbortController();
  ctx.addEventListener("abort", () => ctl.abort());
  try {
    const r = await complete(kernel, code, toCodePoints(code, ctx.pos), ctl.signal);
    if (!r.matches.length) return null;
    const options: CmCompletion[] = r.matches.map((m) => ({
      label: m.text,
      type: KIND[m.type ?? ""] ?? undefined,
      detail: m.signature || undefined,
    }));
    return { from: toUtf16(code, r.from), to: toUtf16(code, r.to), options, validFor: /^\w*$/ };
  } catch {
    return null; // a busy kernel, or no kernel yet
  }
};

// Quick doc (Ctrl+Q, hover) and parameter info (Ctrl+P)

const showDoc = StateEffect.define<Tooltip | null>();
const docField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, tr) {
    for (const e of tr.effects) if (e.is(showDoc)) return e.value;
    return tr.docChanged || tr.selection ? null : tip;
  },
  provide: (f) => showTooltip.from(f),
});

// oxlint-disable-next-line no-control-regex -- ANSI escapes in IPython's inspect text
const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/** IPython's inspect text, or only its signature lines for parameter info. */
function docText(text: string, signatureOnly: boolean): string {
  if (!signatureOnly) return text;
  const lines = plain(text).split("\n");
  const start = lines.findIndex((l) => /^(Init )?[Ss]ignature:/.test(l));
  if (start < 0) return lines.slice(0, 3).join("\n");
  const end = lines.findIndex((l, i) => i > start && /^[A-Z][\w ]*:/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function docDom(text: string, error = false) {
  const dom = el("div", `cm-doc-tip${error ? " cm-doc-tip-error" : ""}`);
  const pre = el("pre", "cm-doc-pre");
  for (const r of ansiRuns(text)) {
    const span = el("span", "", r.text);
    if (r.style) span.setAttribute("style", r.style);
    pre.append(span);
  }
  dom.append(pre);
  return dom;
}

const tooltipAt = (pos: number, text: string, error = false): Tooltip => ({ pos, above: true, create: () => ({ dom: docDom(text, error) }) });
const flash = (view: EditorView, text: string) =>
  view.dispatch({ effects: showDoc.of(tooltipAt(view.state.selection.main.head, text, true)) });

async function inspectAt(view: EditorView, pos: number, signatureOnly: boolean) {
  const kernel = preferredKernel();
  if (!kernel) return flash(view, "no kernel: run a cell first");
  const code = view.state.doc.toString();
  try {
    const r = await inspect(kernel, code, toCodePoints(code, pos));
    if (view.state.doc.toString() !== code) return;
    view.dispatch({ effects: showDoc.of(r.found && r.text ? tooltipAt(pos, docText(r.text, signatureOnly)) : tooltipAt(pos, "no documentation found")) });
  } catch (e) {
    flash(view, (e as Error).message);
  }
}

/** The end of the dotted name around `pos`, where IPython looks the object up. */
function nameEnd(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos);
  const after = /^[\w.]*/.exec(line.text.slice(pos - line.from))?.[0].length ?? 0;
  const before = /[\w.]*$/.exec(line.text.slice(0, pos - line.from))?.[0].length ?? 0;
  return after + before > 0 ? pos + after : null;
}

export const quickDoc: Command = (view) => {
  const end = nameEnd(view.state, view.state.selection.main.head);
  if (end != null) void inspectAt(view, end, false);
  return true;
};

/** The unmatched `(` before the cursor: the call whose parameters it is in. */
function openParen(state: EditorState, pos: number): number | null {
  const text = state.sliceDoc(Math.max(0, pos - 2000), pos);
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(" && depth-- === 0) return pos - text.length + i;
  }
  return null;
}

export const parameterInfo: Command = (view) => {
  const paren = openParen(view.state, view.state.selection.main.head);
  if (paren == null) return false;
  void inspectAt(view, paren, true);
  return true;
};

const docHover = hoverTooltip(async (view, pos) => {
  const kernel = preferredKernel();
  const word = view.state.wordAt(pos);
  if (!kernel || !word || view.state.field(diagnosticsField).items.some((d) => d.from <= pos && d.to >= pos)) return null;
  const code = view.state.doc.toString();
  const r = await inspect(kernel, code, toCodePoints(code, word.to)).catch(() => null);
  if (!r?.found || !r.text) return null;
  const text = r.text;
  return { pos: word.from, end: word.to, above: true, create: () => ({ dom: docDom(text) }) };
}, { hoverTime: 700 });

/** Closes an open doc tooltip; false when none is open. */
export function dismissDoc(view: EditorView): boolean {
  if (!view.state.field(docField)) return false;
  view.dispatch({ effects: showDoc.of(null) });
  return true;
}

// Folded imports

/** The leading imports past their first keyword, when they span lines: shown as `import ...`. */
function importRange(state: EditorState) {
  const r = leadingImportsIn(syntaxTree(state).topNode);
  if (!r || state.doc.lineAt(r.to).number === state.doc.lineAt(r.from).number) return null;
  const keyword = state.sliceDoc(r.from, r.from + 4) === "from" ? 4 : 6;
  return { from: r.from + keyword, to: r.to };
}
const importFold = foldService.of((state, lineStart) => {
  const range = importRange(state);
  return range && state.doc.lineAt(range.from).from === lineStart ? range : null;
});

/** Folds a cell's leading imports to `import ...`, as PyCharm opens a file. */
export function foldImports(view: EditorView) {
  ensureSyntaxTree(view.state, view.state.doc.length, 200);
  const range = importRange(view.state);
  if (range) view.dispatch({ effects: foldEffect.of(range) });
}

// the placeholder takes the worst diagnostic inside the fold, like PyCharm's red `import ...`
const folding = codeFolding({
  preparePlaceholder: (state, range) => worstIn(state, range.from, range.to),
  placeholderDOM: (_view, onclick, worst: Severity | null) => {
    const span = el("span", `cm-foldPlaceholder${worst ? ` cm-diag-${worst}` : ""}`, " ...");
    span.title = "unfold";
    span.onclick = onclick;
    return span;
  },
});

// Reformat and optimize imports

/** Replaces the document with `next` through its changed middle, so the cursor stays put. */
function replaceDoc(view: EditorView, next: string) {
  const prev = view.state.doc.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let end = 0;
  while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
  view.dispatch({ changes: { from: start, to: prev.length - end, insert: next.slice(start, next.length - end) }, userEvent: "input.format" });
}

export const reformatCell: Command = (view) => {
  const code = view.state.doc.toString();
  formatCode(code)
    .then((next) => view.state.doc.toString() === code && replaceDoc(view, next))
    .catch((e: Error) => flash(view, e.message));
  return true;
};

export const optimizeCellImports: Command = (view) => {
  const id = view.dom.closest<HTMLElement>("[data-cell-id]")?.dataset.cellId;
  const { ids, cells } = notebookSources();
  const index = id ? ids.indexOf(id) : -1;
  if (index < 0) return false;
  const code = view.state.doc.toString();
  cells[index] = code;
  optimizeImports(cells, index)
    .then((next) => view.state.doc.toString() === code && replaceDoc(view, next))
    .catch((e: Error) => flash(view, e.message));
  return true;
};

const theme = EditorView.theme({
  ".cm-diag-error": { textDecoration: "underline wavy var(--color-blocked)", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  ".cm-diag-warning": { textDecoration: "underline wavy var(--color-paused)", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  ".cm-diag-weak": {
    textDecoration: "underline wavy color-mix(in srgb, var(--color-paused) 55%, transparent)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-diag-unused": { opacity: "0.5" },
  ".cm-foldPlaceholder.cm-diag-unused": { opacity: "1" },
  ".cm-tooltip": { backgroundColor: "var(--color-panel)", border: "1px solid var(--color-line)", borderRadius: "6px", color: "var(--color-ink)" },
  ".cm-diag-tip, .cm-doc-tip": { padding: "4px 8px", maxWidth: "640px", fontSize: "11.5px" },
  ".cm-diag-row": { padding: "1px 0 1px 8px", borderLeft: "2px solid var(--color-paused)" },
  ".cm-diag-row-error": { borderLeftColor: "var(--color-blocked)" },
  ".cm-diag-row-unused, .cm-diag-row-weak": { borderLeftColor: "var(--color-ink-faint)" },
  ".cm-diag-code": { color: "var(--color-ink-faint)" },
  ".cm-doc-pre": { margin: "0", maxHeight: "280px", overflow: "auto", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "11px" },
  ".cm-doc-tip-error": { color: "var(--color-blocked)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "11.5px", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "color-mix(in srgb, var(--color-copper) 30%, transparent)", color: "var(--color-ink)" },
  ".cm-completionDetail": { color: "var(--color-ink-faint)", fontStyle: "normal", marginLeft: "1em" },
});

export const insights: Extension = [
  diagnosticsField,
  diagnosticHover,
  docField,
  docHover,
  autocompletion({ override: [kernelCompletion], icons: false }),
  importFold,
  folding,
  theme,
];
