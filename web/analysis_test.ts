import { expect, test } from "bun:test";
import { fromRuff, importedModules, leadingImports, rowColToOffset, shadowedParams, toCodePoints, toUtf16, topLevelNames } from "./analysis";

test.each([
  ["ascii", "abc", 2, 2],
  ["astral char counts twice in UTF-16", "😀x", 1, 2],
  ["past the end clamps", "ab", 9, 2],
])("toUtf16: %s", (_id, text, points, units) => {
  expect(toUtf16(text, points)).toBe(units);
  expect(toCodePoints(text, units)).toBe(Math.min(points, [...text].length));
});

test.each([
  ["second line", "ab\ncd", 2, 2, 4],
  ["row past the end", "ab", 5, 1, 2],
  ["column after an emoji", "😀 = 1", 1, 3, 3],
])("rowColToOffset: %s", (_id, text, row, col, offset) => {
  expect(rowColToOffset(text, row, col)).toBe(offset);
});

test.each([
  ["a name", "x = y", [1, 5], [1, 6], [4, 5]],
  ["empty range mid-text", "f(", [1, 2], [1, 2], [1, 2]],
  ["empty range at the end", "f(", [1, 3], [1, 3], [1, 2]],
] as const)("fromRuff: %s", (_id, text, from, to, want) => {
  const d = fromRuff(text, { cell: 0, from: [...from], to: [...to], code: "F821", message: "m", severity: "error" });
  expect([d.from, d.to]).toEqual([...want]);
});

test("topLevelNames: assignments, defs, classes, imports, for targets", () => {
  const src = "import pandas as pd, os.path\nfrom a.b import (c, d as e)\nx, y = 1, 2\ndef f(q):\n    z = 1\nclass C: pass\nfor i in r: pass\n";
  expect(topLevelNames(src)).toEqual(["pd", "os", "c", "e", "x", "y", "f", "C", "i"]);
});

test("shadowedParams: names, not defaults or self", () => {
  const src = "def label_ends(self, ax, df: int = ax, palette=None):\n    pass\n";
  const got = shadowedParams(src, new Set(["ax", "df", "self", "None"])).map((d) => src.slice(d.from, d.to));
  expect(got).toEqual(["ax", "df"]);
});

test.each([
  ["plain and dotted", "import os.path, json as j", ["os", "json"]],
  ["from", "from pandas.api import types", ["pandas"]],
  ["relative is left out", "from .x import y\nfrom . import z", []],
  ["nested in a function", "def f():\n    import numpy", ["numpy"]],
])("importedModules: %s", (_id, src, names) => {
  expect(importedModules(src).map((m) => m.name)).toEqual(names);
});

test.each([
  ["two lines with a comment", "import a\n# x\nfrom b import c\nx = 1", "import a\n# x\nfrom b import c"],
  ["a single line is not folded", "import a\nx = 1", null],
  ["code first", "x = 1\nimport a\nimport b", null],
])("leadingImports: %s", (_id, src, want) => {
  const r = leadingImports(src);
  expect(r && src.slice(r.from, r.to)).toBe(want);
});
