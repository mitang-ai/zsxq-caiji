import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAppearance,
  resolvedAppearance,
} from "../shared/appearance.js";

test("legacy palettes normalize without introducing more themes", () => {
  for (const value of ["paper", "warm", "mist"])
    assert.equal(normalizeAppearance(value), "paper");
  assert.equal(normalizeAppearance("graphite"), "graphite");
});
test("invalid preferences follow the system", () => {
  for (const value of [undefined, null, "", "orange", 1, {}])
    assert.equal(normalizeAppearance(value), "system");
});
test("system appearance resolves both OS modes", () => {
  assert.equal(resolvedAppearance("system", false), "paper");
  assert.equal(resolvedAppearance("system", true), "graphite");
});
test("explicit appearance is not overridden by OS changes", () => {
  for (const dark of [false, true]) {
    assert.equal(resolvedAppearance("graphite", dark), "graphite");
    assert.equal(resolvedAppearance("paper", dark), "paper");
    assert.equal(resolvedAppearance("warm", dark), "paper");
    assert.equal(resolvedAppearance("mist", dark), "paper");
  }
});
