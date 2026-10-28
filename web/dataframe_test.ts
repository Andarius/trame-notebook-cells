import { expect, test } from "bun:test";
import { asNumber, compareCells, isNumeric, shapeNote } from "./dataframe";

test.each([
  ["thousands", "1,234.5", 1234.5],
  ["negative", "-3", -3],
  ["blank", " ", null],
  ["NaN is no value", "NaN", null],
  ["text", "github", null],
])("asNumber: %s", (_id, s, want) => {
  expect(asNumber(s)).toBe(want);
});

test.each([
  ["numbers with a NaN", ["1", "NaN", "2.5"], true],
  ["mixed", ["1", "a"], false],
  ["all blank", ["", "NaN"], false],
])("isNumeric: %s", (_id, values, want) => {
  expect(isNumeric(values)).toBe(want);
});

test.each([
  ["numbers by value", ["10", "9", "100"], 1, ["9", "10", "100"]],
  ["descending", ["10", "9", "100"], -1, ["100", "10", "9"]],
  ["text naturally", ["a10", "a2"], 1, ["a2", "a10"]],
  ["blanks last ascending", ["", "2", "1"], 1, ["1", "2", ""]],
  ["blanks last descending", ["NaN", "1", "2"], -1, ["2", "1", "NaN"]],
] as const)("compareCells: %s", (_id, values, dir, want) => {
  expect([...values].sort((a, b) => compareCells(a, b, dir))).toEqual([...want]);
});

test.each([
  ["html note", "<p>100 rows × 3 columns</p>", [100, 3]],
  ["text repr", "[100 rows x 3 columns]", [100, 3]],
  ["none", "2 rows", null],
])("shapeNote: %s", (_id, text, want) => {
  expect(shapeNote(text)).toEqual(want);
});
