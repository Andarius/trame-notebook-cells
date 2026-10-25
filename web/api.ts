// Client of /api/plugins/notebook-cells: kernels, streamed execution, settings, export.
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
export const restart = (kernel: string) => postJson<{ ok: boolean }>("/restart", { kernel });
export const readNotebook = (path: string) =>
  get<{ path: string; cells: { cell_type: string; source: string; outputs?: unknown[]; count?: number | null }[] }>("/notebook", { path });

// Runs `code` and hands every event to `onEvent` as it streams; resolves when the kernel is idle again.
export async function execute(code: string, kernel: string | null, onEvent: (ev: CellEvent) => void, signal?: AbortSignal) {
  const res = await post("/execute", { code, kernel }, signal);
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
export const usePreferredKernel = preferred.use;

export const createReport = (title: string, html: string) => postJson<{ id: string }>("/api/reports", { title, html });

export const readPyCharmKeymap = () => get<PyCharmKeymap>("/pycharm-keymap");

// The editor keymap imported from PyCharm, shared by every cell; loaded once from the settings.
const keymap = store<ImportedKeymap | null>(null, () => void getSettings().then((s) => keymap.set(s.keymap ?? null)).catch(() => {}));
export const setCellKeymap = keymap.set;
export const useCellKeymap = keymap.use;
