// What the running kernel knows: completions, docs, its variables and which modules it can import.
use super::{Server, ask};
use anyhow::{Result, bail};
use serde_json::{Value, json};

// Defined silently on each probe; `_`-prefixed so the variables list skips them. `_J` hands the result
// back as application/json, so no Python repr has to be parsed.
const PROBE: &str = r#"
def _trame_json(d):
    class _J:
        def _repr_json_(self): return d
    return _J()

def _trame_vars():
    import types
    skip = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)
    out = []
    for k, v in list(globals().items()):
        if k.startswith("_") or k in ("In", "Out", "exit", "quit", "get_ipython", "open") or isinstance(v, skip):
            continue
        try:
            shape = getattr(v, "shape", None)
            shape = " × ".join(map(str, shape)) if isinstance(shape, tuple) else None
            size = len(v) if shape is None and hasattr(v, "__len__") else None
            r = repr(v)
        except Exception as e:
            shape, size, r = None, None, f"<repr failed: {type(e).__name__}>"
        out.append({"name": k, "type": type(v).__name__, "shape": shape, "len": size, "value": " ".join(r[:600].split())[:200]})
    return _trame_json(out[:500])

def _trame_missing(names):
    import importlib.util, sys
    def found(n):
        try:
            return n in sys.modules or importlib.util.find_spec(n) is not None
        except (ImportError, ValueError):
            return False
    return _trame_json([n for n in names if not found(n)])
"#;

// Run silently before each cell. Once matplotlib is imported: retina figures (set once, so a
// later `%config` wins) and a "trame" style in the page's colours, opt-in with
// `plt.style.use("trame")` or `sns.set_theme(rc=plt.style.library["trame"])`. It hooks
// post_execute, so a cell that first imports matplotlib gets both before its figures flush.
const PLOT_SETUP: &str = r##"
def _trame_plots(theme):
    import sys
    ip = get_ipython()
    ip._trame_theme = theme
    def apply(*_):
        if "matplotlib" not in sys.modules:
            return
        try:
            import matplotlib, matplotlib.style
            dark = ip._trame_theme == "dark"
            ink, soft, muted = ("#e6e9ef", "#a9b2c3", "#8b93a3") if dark else ("#1c1f26", "#3d4350", "#626a7c")
            line, grid = ("#2f3542", "#232633") if dark else ("#cfd4dc", "#e2e5ea")
            canvas = "#0e1014" if dark else "#ffffff"  # bar edges: seaborn's white is harsh on dark
            matplotlib.style.library["trame"] = matplotlib.RcParams({
                "figure.facecolor": "none", "axes.facecolor": "none", "savefig.facecolor": "none",
                "savefig.transparent": True, "text.color": ink, "axes.titlecolor": ink, "axes.labelcolor": soft,
                "xtick.color": muted, "ytick.color": muted, "axes.edgecolor": line, "grid.color": grid,
                "axes.grid": True, "axes.spines.top": False, "axes.spines.right": False,
                "legend.frameon": False, "legend.labelcolor": soft, "patch.edgecolor": canvas,
            })
            if "trame" not in matplotlib.style.available:
                matplotlib.style.available.append("trame")
            if not getattr(ip, "_trame_retina", False):
                ip._trame_retina = True
                from matplotlib_inline.config import InlineBackend
                InlineBackend.instance().figure_formats = {"retina"}
        except Exception:
            pass
    if not getattr(ip, "_trame_hooked", False):
        ip._trame_hooked = True
        ip.events.register("post_execute", apply)
    apply()

_trame_plots("__THEME__")
"##;

/// The setup for a page in `theme` ("dark" or "light").
pub(super) fn plot_setup(theme: &str) -> String {
    PLOT_SETUP.replace("__THEME__", theme)
}

/// Evaluates one `_trame_*` call after defining PROBE, without touching history or the execution count.
async fn probe(server: &Server, kernel: &str, expr: &str) -> Result<Value> {
    let reply = ask(
        server,
        kernel,
        "execute_request",
        json!({"code": PROBE, "silent": true, "store_history": false, "user_expressions": {"v": expr}, "allow_stdin": false, "stop_on_error": false}),
    )
    .await?;
    let v = &reply["user_expressions"]["v"];
    if v["status"] != "ok" {
        bail!("{}", v["evalue"].as_str().unwrap_or("probe failed"));
    }
    Ok(v["data"]["application/json"].clone())
}

pub(super) async fn variables(server: &Server, kernel: &str) -> Result<Value> {
    Ok(json!({"variables": probe(server, kernel, "_trame_vars()").await?}))
}

/// Top-level module names only: `find_spec("a.b")` would import `a`.
pub(super) fn module_names(raw: &Value) -> Result<Vec<String>> {
    let names: Vec<String> = raw
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if names.len() > 200 {
        bail!("at most 200 modules");
    }
    if let Some(bad) = names.iter().find(|n| {
        n.is_empty()
            || n.len() > 100
            || n.starts_with(|c: char| c.is_ascii_digit())
            || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    }) {
        bail!("not a module name: {bad}");
    }
    Ok(names)
}

pub(super) async fn missing_modules(
    server: &Server,
    kernel: &str,
    names: &[String],
) -> Result<Value> {
    if names.is_empty() {
        return Ok(json!({"missing": []}));
    }
    let expr = format!("_trame_missing({})", json!(names));
    Ok(json!({"missing": probe(server, kernel, &expr).await?}))
}

/// `cursor` and the returned `from`/`to` count code points, as the Jupyter protocol does.
pub(super) async fn complete(
    server: &Server,
    kernel: &str,
    code: &str,
    cursor: u64,
) -> Result<Value> {
    let r = ask(
        server,
        kernel,
        "complete_request",
        json!({"code": code, "cursor_pos": cursor}),
    )
    .await?;
    let typed = r["metadata"]["_jupyter_types_experimental"].as_array();
    let matches: Vec<Value> = r["matches"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, m)| {
            let text = m.as_str()?;
            let meta = typed.and_then(|t| t.get(i)).filter(|t| t["text"] == text);
            Some(json!({"text": text, "type": meta.map(|t| &t["type"]), "signature": meta.map(|t| &t["signature"])}))
        })
        .take(300)
        .collect();
    Ok(json!({"matches": matches, "from": r["cursor_start"], "to": r["cursor_end"]}))
}

pub(super) async fn inspect(
    server: &Server,
    kernel: &str,
    code: &str,
    cursor: u64,
) -> Result<Value> {
    let r = ask(
        server,
        kernel,
        "inspect_request",
        json!({"code": code, "cursor_pos": cursor, "detail_level": 0}),
    )
    .await?;
    Ok(json!({"found": r["found"] == true, "text": r["data"]["text/plain"]}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_names_must_be_identifiers() {
        assert_eq!(
            module_names(&json!(["pandas", "padwan_ai", 3])).unwrap(),
            ["pandas", "padwan_ai"]
        );
        for bad in [
            json!(["os); import x"]),
            json!(["a.b"]),
            json!(["1abc"]),
            json!([""]),
        ] {
            assert!(module_names(&bad).is_err(), "{bad}");
        }
    }
}
