// A plotly figure (application/vnd.plotly.v1+json) as an HTML fragment: plotly.js from a CDN,
// themed from the --trame-* variables of the document it lands in.
export const PLOTLY_MIME = "application/vnd.plotly.v1+json";
const PLOTLY_JS = "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@4.1.1/plotly.min.js";

export type PlotlyFigure = { data?: unknown[]; layout?: Record<string, unknown>; config?: Record<string, unknown> };

/** The figure from a mime bundle: an object from a live run, a JSON string from some imports. */
export function plotlyFigure(data: Record<string, unknown>): PlotlyFigure | null {
  const raw = data[PLOTLY_MIME];
  if (raw == null) return null;
  try {
    const fig = (typeof raw === "string" ? JSON.parse(raw) : raw) as PlotlyFigure;
    return Array.isArray(fig.data) ? fig : null;
  } catch {
    return null;
  }
}

// Runs in the output document (stringified). Colours the figure like the page wherever the figure
// itself leaves them to its template, so explicit choices in the layout win.
function render(fig: PlotlyFigure, id: string) {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const ink = v("--trame-ink", "#e6e9ef"), muted = v("--trame-muted", "#8b93a3"), line = v("--trame-line", "#232633");
  const layout: Record<string, unknown> = { ...fig.layout };
  layout.paper_bgcolor ??= "rgba(0,0,0,0)";
  layout.plot_bgcolor ??= "rgba(0,0,0,0)";
  layout.font = { color: ink, ...(layout.font as object) };
  for (const key of new Set([...Object.keys(layout), "xaxis", "yaxis"])) {
    if (!/^[xy]axis\d*$/.test(key)) continue;
    const axis = { ...(layout[key] as Record<string, unknown>) };
    axis.gridcolor ??= line;
    axis.linecolor ??= line;
    axis.zerolinecolor ??= line;
    axis.tickfont = { color: muted, ...(axis.tickfont as object) };
    layout[key] = axis;
  }
  const plotly = (window as unknown as { Plotly?: { newPlot: (...a: unknown[]) => void } }).Plotly;
  const el = document.getElementById(id);
  if (!plotly || !el) {
    if (el) el.textContent = "plotly.js could not load (offline?)";
    return;
  }
  plotly.newPlot(el, fig.data, layout, { responsive: true, displaylogo: false, ...fig.config });
}

/** The fragment for one figure; `</` is escaped so the JSON cannot close the script. */
export function plotlyHtml(fig: PlotlyFigure): string {
  const id = `plot-${Math.random().toString(36).slice(2)}`;
  const json = JSON.stringify(fig).replace(/<\//g, "<\\/");
  return `<div id="${id}"></div><script src="${PLOTLY_JS}"></script>` +
    `<script>(${render.toString()})(${json}, ${JSON.stringify(id)})</script>`;
}
