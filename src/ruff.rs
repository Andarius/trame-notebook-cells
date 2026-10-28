// Lint, format and import fixes for a page's cells with ruff, which reads them as one notebook.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

// pyflakes, pycodestyle's error classes and unused arguments: what PyCharm flags while typing
const SELECT: &str = "E4,E7,E9,F,ARG";

/// ruff on PATH (or the usual user bin dirs), else `uv tool run ruff`.
fn ruff() -> Result<Command> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let find = |name: &str| {
        super::on_path(name).or_else(|| {
            let home = home.as_ref()?;
            [".local/bin", ".cargo/bin"]
                .iter()
                .map(|d| home.join(d).join(name))
                .find(|p| p.is_file())
        })
    };
    if let Some(bin) = find("ruff") {
        return Ok(Command::new(bin));
    }
    let uv = find("uv").context("ruff not found (install it, or uv to fetch it)")?;
    let mut cmd = Command::new(uv);
    cmd.args(["tool", "run", "ruff"]);
    Ok(cmd)
}

/// The cells as an .ipynb, the shape ruff lints with notebook semantics (magics, top-level await).
pub(super) fn notebook(cells: &[String]) -> Value {
    let cells: Vec<Value> = cells
        .iter()
        .map(|s| json!({"cell_type": "code", "metadata": {}, "source": s, "outputs": [], "execution_count": null}))
        .collect();
    json!({"cells": cells, "metadata": {"language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5})
}

/// Runs ruff with `stdin`; exit 1 means "diagnostics found", anything else non-zero is a failure.
fn run(mut cmd: Command, stdin: &str) -> Result<String> {
    let mut child = cmd
        .args([
            "--isolated",
            "--no-cache",
            "--stdin-filename",
            "cells.ipynb",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("ruff failed to start")?;
    // ruff reads all of stdin before it writes, so this cannot deadlock
    child
        .stdin
        .take()
        .context("no stdin")?
        .write_all(stdin.as_bytes())?;
    let out = child.wait_with_output()?;
    if !matches!(out.status.code(), Some(0 | 1)) {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!(
            "{}",
            err.lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("ruff failed")
        );
    }
    Ok(String::from_utf8(out.stdout)?)
}

/// error, warning, or unused (drawn dimmed, like `PyCharm`'s unused symbols)
fn severity(code: Option<&str>) -> &'static str {
    match code {
        None => "error", // a syntax error
        Some(c) if c == "F401" || c == "F841" || c.starts_with("ARG") => "unused",
        Some(c) if c.starts_with("E9") || ["F821", "F822", "F823", "F706", "F704"].contains(&c) => {
            "error"
        }
        _ => "warning",
    }
}

/// ruff's JSON diagnostics → `{cell, from: [row, col], to, code, message, severity}`, 0-based cell, 1-based row/col.
pub(super) fn diagnostics(raw: &str) -> Result<Vec<Value>> {
    let list: Vec<Value> = serde_json::from_str(raw).context("ruff output does not parse")?;
    Ok(list
        .iter()
        .filter_map(|d| {
            let cell = d["cell"].as_u64()?.checked_sub(1)?;
            let at = |k: &str| json!([d[k]["row"], d[k]["column"]]);
            let code = d["code"].as_str();
            Some(
                json!({"cell": cell, "from": at("location"), "to": at("end_location"),
                "code": code, "message": d["message"], "severity": severity(code)}),
            )
        })
        .collect())
}

pub(super) fn lint(cells: &[String]) -> Result<Value> {
    let mut cmd = ruff()?;
    cmd.args(["check", "--output-format", "json", "--select", SELECT]);
    let out = run(cmd, &notebook(cells).to_string())?;
    Ok(json!({"diagnostics": diagnostics(&out)?}))
}

fn cell_source(nb: &Value, index: usize) -> Result<String> {
    let src = &nb["cells"][index]["source"];
    Ok(match src {
        Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect(),
        Value::String(s) => s.clone(),
        _ => bail!("ruff returned no cell {index}"),
    })
}

pub(super) fn format(code: &str) -> Result<String> {
    let mut cmd = ruff()?;
    cmd.arg("format");
    let out = run(cmd, &notebook(&[code.to_owned()]).to_string())?;
    cell_source(&serde_json::from_str(&out)?, 0)
}

/// Sorts the cell's imports and drops the ones no cell uses, with every cell as context.
pub(super) fn optimize_imports(cells: &[String], index: usize) -> Result<String> {
    if index >= cells.len() {
        bail!("no such cell");
    }
    let mut cmd = ruff()?;
    cmd.args(["check", "--fix", "--quiet", "--select", "I,F401"]);
    let out = run(cmd, &notebook(cells).to_string())?;
    cell_source(&serde_json::from_str(&out)?, index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_per_cell_with_a_severity() {
        let raw = json!([
            {"cell": 2, "code": "F821", "message": "Undefined name `y`", "location": {"row": 2, "column": 22}, "end_location": {"row": 2, "column": 23}},
            {"cell": 1, "code": "F401", "message": "`os` imported but unused", "location": {"row": 1, "column": 8}, "end_location": {"row": 1, "column": 10}},
            {"cell": 1, "code": "ARG001", "message": "Unused function argument", "location": {"row": 1, "column": 1}, "end_location": {"row": 1, "column": 2}},
            {"cell": 1, "code": null, "message": "SyntaxError: Expected an expression", "location": {"row": 3, "column": 1}, "end_location": {"row": 3, "column": 2}},
            {"cell": 1, "code": "E711", "message": "Comparison to `None`", "location": {"row": 4, "column": 1}, "end_location": {"row": 4, "column": 2}},
            {"code": "F401", "message": "no cell: dropped", "location": {"row": 1, "column": 1}, "end_location": {"row": 1, "column": 2}},
        ]);
        let out = diagnostics(&raw.to_string()).unwrap();
        let got: Vec<(u64, &str)> = out
            .iter()
            .map(|d| (d["cell"].as_u64().unwrap(), d["severity"].as_str().unwrap()))
            .collect();
        assert_eq!(
            got,
            [
                (1, "error"),
                (0, "unused"),
                (0, "unused"),
                (0, "error"),
                (0, "warning")
            ]
        );
        assert_eq!(out[0]["from"], json!([2, 22]));
    }

    #[test]
    fn cell_source_joins_nbformat_lines() {
        let nb = json!({"cells": [{"source": ["import json\n", "x = 1"]}, {"source": "y"}]});
        assert_eq!(cell_source(&nb, 0).unwrap(), "import json\nx = 1");
        assert_eq!(cell_source(&nb, 1).unwrap(), "y");
        assert!(cell_source(&nb, 2).is_err());
    }
}
