// Client of /api/plugins/notebook-cells: kernels, streamed execution, settings, export.
import type { RuffDiagnostic } from "./analysis";
import type { CellEvent } from "./cell-output";
import { store } from "./store";

const BASE = "/api/plugins/notebook-cells";

export type ImportedKeymap = { name: string; actions: Record<string, string[]>; importedAt?: string };
export type Settings = { enabled: boolean; serverUrl: string; hasToken: boolean; keymap: ImportedKeymap | null };
export type PyCharmKeymap = { ide: string | null; keymap: string; chain: string[]; missing: string[]; actions: Record<string, string[]> };
export type Kernel = {
  id: string;
  name: string;
  state: string;
  path: string | null;
  lastActivity?: string | null;
  connections?: number | null;
};
export type ProjectKernelConfig = {
  path: string;
  display?: string | null;
  python?: string | null;
  packages?: string[];
  env?: Record<string, string>;
};
export type KernelSpec = {
  name: string;
  display: string;
  language?: string | null;
  project?: string | null;
  config?: (Omit<ProjectKernelConfig, "path"> & { project?: string }) | null;
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
// the plugin's routes by sub path; Trame's own by their /api/ path
const url = (path: string) => (path.startsWith("/api/") ? path : `${BASE}${path}`);
const get = <T,>(path: string, params?: Record<string, string>) =>
  fetch(params ? `${url(path)}?${new URLSearchParams(params)}` : url(path)).then((r) => json<T>(r));
const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

export const getSettings = () => get<Settings>("/settings");
export const saveSettings = (patch: { serverUrl?: string; token?: string; enabled?: boolean; keymap?: ImportedKeymap | null }) =>
  post("/settings", patch).then((r) => json<Settings>(r));
export const listKernels = () => get<{ kernels: Kernel[] }>("/kernels").then((r) => r.kernels);
const postJson = <T,>(path: string, body: unknown) => post(path, body).then((r) => json<T>(r));
export const startKernel = (name?: string) => postJson<{ id: string }>("/kernels", name ? { name } : {});
export const listKernelSpecs = () => get<{ default: string; specs: KernelSpec[] }>("/kernelspecs");
// registers the folder's pyproject env as a uv kernel spec, then starts it
export const saveProjectKernel = (cfg: ProjectKernelConfig, start: boolean) =>
  postJson<{ id?: string; spec: string }>("/project-kernel", { ...cfg, start });
export type ProjectInfo = {
  dir: string;
  name: string | null;
  version: string | null;
  requiresPython: string | null;
  dependencies: string[];
  dev: string[];
  lock: boolean;
};
export type PythonVersion = { version: string; installed: boolean };
export type PyPiProject = { name: string; summary: string | null; latest: string; versions: { version: string; at: string | null }[] };
export const readProject = (path: string) => get<ProjectInfo>("/project", { path });
export const listPythons = () => get<PythonVersion[]>("/pythons");
export const pypiVersions = (name: string) => get<PyPiProject>("/pypi", { name });
export const removeProjectKernel = (name: string) => postJson<{ ok: boolean }>("/project-kernel/remove", { name });
export const shutdownKernel = (kernel: string) => postJson<{ ok: boolean }>("/shutdown", { kernel });
export const interrupt = (kernel: string) => postJson<{ ok: boolean }>("/interrupt", { kernel });
// may come back as a new kernel (one started from the current spec)
export const restart = (kernel: string) => postJson<{ id: string }>("/restart", { kernel }).then((r) => r.id);
export const readNotebook = (path: string) =>
  get<{ path: string; cells: { cell_type: string; source: string; outputs?: unknown[]; count?: number | null }[] }>("/notebook", { path });

// Runs `code` and hands every event to `onEvent` as it streams; resolves when the kernel is idle again.
// `theme` colours the kernel's "trame" plot style like the page
export async function execute(
  code: string,
  kernel: string | null,
  theme: "dark" | "light",
  onEvent: (ev: CellEvent) => void,
  signal?: AbortSignal,
) {
  const res = await post("/execute", { code, kernel, theme }, signal);
  if (!res.ok) await json(res);
  if (!res.body) throw new Error("no output stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value, { stream: !done });
    const lines = buf.split("\n");
    buf = done ? "" : lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as CellEvent);
      } catch { /* a torn line at the end of the stream */ }
    }
    if (done) break;
  }
}

// The kernel the page's cells run on, shared by every cell in the window.
const preferred = store<string | null>(null);
export const setPreferredKernel = preferred.set;
export const preferredKernel = preferred.get;
export const usePreferredKernel = preferred.use;

export const createReport = (title: string, html: string) => postJson<{ id: string }>("/api/reports", { title, html });

export const readPyCharmKeymap = () => get<PyCharmKeymap>("/pycharm-keymap");

// ruff over the page's cells, read as one notebook
export const lintCells = (cells: string[]) => postJson<{ diagnostics: RuffDiagnostic[] }>("/lint", { cells }).then((r) => r.diagnostics);
export const formatCode = (code: string) => postJson<{ code: string }>("/format", { code }).then((r) => r.code);
export const optimizeImports = (cells: string[], index: number) =>
  postJson<{ code: string }>("/optimize-imports", { cells, index }).then((r) => r.code);

// what the running kernel knows; cursors and ranges count code points
export type Completion = { text: string; type?: string | null; signature?: string | null };
export const complete = (kernel: string, code: string, cursor: number, signal?: AbortSignal) =>
  post("/complete", { kernel, code, cursor }, signal).then((r) => json<{ matches: Completion[]; from: number; to: number }>(r));
export const inspect = (kernel: string, code: string, cursor: number) =>
  postJson<{ found: boolean; text: string | null }>("/inspect", { kernel, code, cursor });
export type Variable = { name: string; type: string; shape: string | null; len: number | null; value: string };
export const listVariables = (kernel: string) => postJson<{ variables: Variable[] }>("/variables", { kernel }).then((r) => r.variables);
export const missingModules = (kernel: string, names: string[]) =>
  postJson<{ missing: string[] }>("/modules", { kernel, names }).then((r) => r.missing);

// Bumped after every cell run, so views of the kernel's state refresh.
const runs = store(0);
export const noteCellRan = () => runs.set(runs.get() + 1);
export const useCellRuns = runs.use;

// The editor keymap imported from PyCharm, shared by every cell; loaded once from the settings.
const keymap = store<ImportedKeymap | null>(null, () => void getSettings().then((s) => keymap.set(s.keymap ?? null)).catch(() => {}));
export const setCellKeymap = keymap.set;
export const useCellKeymap = keymap.use;
