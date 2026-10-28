// Static checks over a page's cells: offsets from ruff and Jupyter, imported modules, names shadowing the notebook's.
import { pythonLanguage } from "@codemirror/lang-python";
import type { SyntaxNode } from "@lezer/common";

export type Severity = "error" | "warning" | "weak" | "unused";
/** a diagnostic on one cell, in CodeMirror offsets (UTF-16) */
export type Diagnostic = { from: number; to: number; severity: Severity; message: string; code?: string | null };

/** Jupyter and ruff count code points; CodeMirror counts UTF-16 units. */
export function toUtf16(text: string, codePoints: number): number {
  let i = 0;
  for (let n = 0; n < codePoints && i < text.length; n++) i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  return i;
}
export const toCodePoints = (text: string, offset: number) => Array.from(text.slice(0, offset)).length;

/** ruff's 1-based row and code-point column → an offset, clamped to the text */
export function rowColToOffset(text: string, row: number, col: number): number {
  const lines = text.split("\n");
  if (row > lines.length) return text.length;
  let at = 0;
  for (let i = 0; i < row - 1; i++) at += lines[i].length + 1;
  return Math.min(at + toUtf16(lines[row - 1], col - 1), text.length);
}

export type RuffDiagnostic = { cell: number; from: [number, number]; to: [number, number]; code: string | null; message: string; severity: Severity };

export function fromRuff(text: string, d: RuffDiagnostic): Diagnostic {
  let from = rowColToOffset(text, ...d.from);
  let to = rowColToOffset(text, ...d.to);
  // an empty range (a syntax error at the end) still needs a character to underline
  if (to <= from) [from, to] = from < text.length ? [from, from + 1] : [Math.max(0, from - 1), text.length];
  return { from, to, severity: d.severity, message: d.message, code: d.code };
}

const parse = (src: string) => pythonLanguage.parser.parse(src).topNode;
const kids = (node: SyntaxNode) => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};

/** The names an import statement binds: `import a.b as c, d.e` → c, d; `from x import y as z` → z. */
function importBindings(node: SyntaxNode, src: string): string[] {
  const parts = kids(node);
  const start = parts.findIndex((p) => p.name === "import") + 1;
  const names: string[] = [];
  let afterDot = false;
  let afterAs = false;
  for (const p of parts.slice(start)) {
    if (p.name === ".") afterDot = true;
    else if (p.name === "as") afterAs = true;
    else if (p.name === "VariableName") {
      const name = src.slice(p.from, p.to);
      if (afterAs) names[names.length - 1] = name;
      else if (!afterDot) names.push(name);
      afterDot = afterAs = false;
    } else if (p.name === ",") afterDot = afterAs = false;
  }
  return names;
}

/** Names a cell binds at module level: assignments, defs, classes, imports, for targets. */
export function topLevelNames(src: string): string[] {
  const names: string[] = [];
  for (const stmt of kids(parse(src))) {
    const parts = kids(stmt);
    const text = (n: SyntaxNode) => src.slice(n.from, n.to);
    if (stmt.name === "ImportStatement") names.push(...importBindings(stmt, src));
    else if (stmt.name === "FunctionDefinition" || stmt.name === "ClassDefinition") {
      const name = parts.find((p) => p.name === "VariableName");
      if (name) names.push(text(name));
    } else if (stmt.name === "AssignStatement" || stmt.name === "ForStatement") {
      const end = parts.findIndex((p) => p.name === (stmt.name === "ForStatement" ? "in" : "AssignOp"));
      for (const p of parts.slice(0, end < 0 ? 0 : end)) if (p.name === "VariableName") names.push(text(p));
    }
  }
  return names;
}

/** Function parameters named like a module-level name of the notebook (PyCharm's "shadows name from outer scope"). */
export function shadowedParams(src: string, outer: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  parse(src).cursor().iterate((n) => {
    if (n.name !== "ParamList") return;
    let inDefault = false;
    for (const p of kids(n.node)) {
      if (p.name === "AssignOp") inDefault = true;
      else if (p.name === ",") inDefault = false;
      else if (p.name === "VariableName" && !inDefault) {
        const name = src.slice(p.from, p.to);
        if (outer.has(name) && name !== "self" && name !== "cls") {
          out.push({ from: p.from, to: p.to, severity: "weak", message: `Shadows name '${name}' from outer scope` });
        }
      }
    }
  });
  return out;
}

/** Top-level modules a cell imports, with where each is named; relative imports are left out. */
export function importedModules(src: string): { name: string; from: number; to: number }[] {
  const out: { name: string; from: number; to: number }[] = [];
  parse(src).cursor().iterate((n) => {
    if (n.name !== "ImportStatement") return;
    const parts = kids(n.node);
    const isFrom = parts[0]?.name === "from";
    const stop = isFrom ? parts.findIndex((p) => p.name === "import") : parts.length;
    let expectModule = true;
    for (const p of parts.slice(1, stop)) {
      if (p.name === "." && expectModule) return false; // relative: the package's own
      if (p.name === "VariableName" && expectModule) {
        out.push({ name: src.slice(p.from, p.to), from: p.from, to: p.to });
        expectModule = false;
      } else if (p.name === "," && !isFrom) expectModule = true;
    }
    return false;
  });
  return out;
}

/** The leading run of import statements in a parsed cell, comments allowed between. */
export function leadingImportsIn(top: SyntaxNode): { from: number; to: number } | null {
  let first: SyntaxNode | null = null;
  let last: SyntaxNode | null = null;
  for (let stmt = top.firstChild; stmt; stmt = stmt.nextSibling) {
    if (stmt.name === "Comment") continue;
    if (stmt.name !== "ImportStatement") break;
    first ??= stmt;
    last = stmt;
  }
  return first && last ? { from: first.from, to: last.to } : null;
}

/** The leading imports when they span two lines or more: what a cell folds to `import ...`. */
export function leadingImports(src: string): { from: number; to: number } | null {
  const r = leadingImportsIn(parse(src));
  return r && src.slice(r.from, r.to).includes("\n") ? r : null;
}
