import test from "node:test";
import assert from "node:assert/strict";
import {
  clearMaterialListStates,
  materialListKey,
  readMaterialListState,
  saveMaterialListState,
} from "../src/listState";

test("Material list UI state is user/workspace/route scoped and cleared on logout", () => {
  const key = materialListKey("test-user", "personal", false);
  const selected = ["material-a"];
  saveMaterialListState(key, {
    q: "完整原文",
    status: "",
    group: "123",
    author: "456",
    selected,
    limit: 200,
    scroll: 1234,
  });
  selected.push("mutation-not-authorized");
  assert.deepEqual(readMaterialListState(key, false).selected, ["material-a"]);
  assert.equal(
    readMaterialListState(
      materialListKey("other-user", "personal", false),
      false,
    ).q,
    "",
  );
  assert.equal(
    readMaterialListState(materialListKey("test-user", "team", false), false)
      .scroll,
    0,
  );
  assert.equal(
    readMaterialListState(materialListKey("test-user", "personal", true), true)
      .status,
    "unread",
  );
  const result = readMaterialListState(key, false);
  result.selected.push("mutation");
  assert.deepEqual(readMaterialListState(key, false).selected, ["material-a"]);
  clearMaterialListStates("test-user");
  assert.equal(readMaterialListState(key, false).q, "");
});
