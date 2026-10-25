// Notebook cells settings: the Jupyter server the page's cells run on. The token is write-only.
import { type ReactNode, useEffect, useState } from "react";
import { Button, Field, FIELD_LABEL, TextInput } from "@trame/web-api";
import { ACTIONS } from "./pycharm-keymap";
import { getSettings, listKernels, readPyCharmKeymap, saveSettings, setCellKeymap, type Settings } from "./api";

const Note = ({ children }: { children: ReactNode }) => <span className="text-[11.5px] text-ink-muted">{children}</span>;

export function NotebookCellsSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((v) => (setS(v), setUrl(v.serverUrl))).catch(() => {});
  }, []);

  const save = () =>
    saveSettings({ serverUrl: url, ...(token ? { token } : {}) }).then((v) => {
      setS(v);
      setToken("");
      setStatus("saved");
    }).catch((e: Error) => setStatus(e.message));
  const importKeymap = () =>
    readPyCharmKeymap().then((km) => {
      const actions = Object.fromEntries(Object.entries(km.actions).filter(([id]) => id in ACTIONS));
      return saveSettings({ keymap: { name: `${km.keymap} (${km.ide ?? "PyCharm"})`, actions } }).then((v) => {
        setS(v);
        setCellKeymap(v.keymap);
        const lost = km.missing.length ? ` · parent not found: ${km.missing.join(", ")}` : "";
        setKeyStatus(`imported ${Object.keys(actions).length} editor actions from ${km.chain.join(" → ")}${lost}`);
      });
    }).catch((e: Error) => setKeyStatus(`✗ ${e.message}`));
  const resetKeymap = () =>
    saveSettings({ keymap: null }).then((v) => (setS(v), setCellKeymap(null), setKeyStatus("back to the default shortcuts")));
  const test = () =>
    listKernels().then((k) => setStatus(`connected · ${k.length} kernel${k.length === 1 ? "" : "s"} running`)).catch((e: Error) =>
      setStatus(`✗ ${e.message}`)
    );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11.5px] text-ink-muted">
        Cells run on a Jupyter Server you start yourself, e.g. <code className="font-mono">jupyter lab --no-browser</code>. Paste its URL and token
        (<code className="font-mono">jupyter server list</code>).
      </p>
      <Field label="SERVER URL">
        <TextInput value={url} placeholder="http://127.0.0.1:8888" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="TOKEN" hint={s?.hasToken && "stored, leave blank to keep"}>
        <TextInput type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={!url.trim()}>Save</Button>
        <Button size="sm" onClick={test} disabled={!s?.enabled}>Test connection</Button>
        {status && <Note>{status}</Note>}
      </div>
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <span className={FIELD_LABEL}>EDITOR SHORTCUTS</span>
        <Note>{s?.keymap ? `PyCharm keymap: ${s.keymap.name}` : "CodeMirror defaults"}. Running a cell stays on ⇧⏎ and Ctrl+⏎.</Note>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={importKeymap} disabled={!s?.enabled}>
            {s?.keymap ? "Re-import from PyCharm" : "Import from PyCharm"}
          </Button>
          {s?.keymap && <Button size="sm" onClick={resetKeymap}>Reset</Button>}
        </div>
        {keyStatus && <Note>{keyStatus}</Note>}
      </div>
    </div>
  );
}
