import { expect, test } from "bun:test";
import { PLOTLY_MIME, plotlyFigure, plotlyHtml } from "./plotly";

test.each([
  ["object from a live run", { [PLOTLY_MIME]: { data: [{ type: "bar" }] } }, 1],
  ["JSON string from an import", { [PLOTLY_MIME]: '{"data": [], "layout": {}}' }, 0],
  ["broken JSON", { [PLOTLY_MIME]: "{" }, null],
  ["no data array", { [PLOTLY_MIME]: { layout: {} } }, null],
  ["not plotly", { "text/plain": "x" }, null],
])("plotlyFigure: %s", (_id, bundle, traces) => {
  const fig = plotlyFigure(bundle);
  expect(fig ? fig.data?.length : null).toBe(traces);
});

test("plotlyHtml: a title cannot close the script", () => {
  const html = plotlyHtml({ data: [], layout: { title: "</script><b>x" } });
  expect(html.match(/<\/script>/g)?.length).toBe(2);
});
