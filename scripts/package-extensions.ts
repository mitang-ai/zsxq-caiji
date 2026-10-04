import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { brand } from "../shared/brand.js";

mkdirSync("release", { recursive: true });
const checksums: string[] = [];
for (const browser of ["chrome", "edge"]) {
  const root = resolve(`extension/dist/${browser}`),
    files: Record<string, Uint8Array> = {};
  const expected = new Set([
    "manifest.json",
    "ui.js",
    "background.js",
    "sidepanel.html",
    "workbench.html",
    "style.css",
    "icons/mark.svg",
    ...[16, 32, 48, 128].map((n) => `icons/icon-${n}.png`),
  ]);
  function walk(dir: string, prefix = "") {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name),
        key = prefix + name,
        stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), `Symlink is not a release file: ${key}`);
      if (stat.isDirectory()) walk(path, key + "/");
      else {
        assert(stat.isFile(), `Not a regular release file: ${key}`);
        assert(expected.delete(key), `Unexpected release file: ${key}`);
        files[key] = readFileSync(path);
      }
    }
  }
  walk(root);
  assert.equal(expected.size, 0, "Missing extension release file");
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  assert.equal(manifest.version, brand.version);
  assert.match(manifest.name, /^集见/);
  files["LICENSE"] = readFileSync("LICENSE");
  files["INSTALL.md"] = readFileSync("docs/plugin-install.md");
  files["VERSION.txt"] = strToU8(
    `${brand.name} ${brand.version} / ${browser}\n`,
  );
  const bytes = zipSync(files, { level: 9 });
  const reopened = unzipSync(bytes);
  assert.deepEqual(Object.keys(reopened).sort(), Object.keys(files).sort());
  for (const [name, data] of Object.entries(files))
    assert.deepEqual(Buffer.from(reopened[name]), Buffer.from(data), name);
  const name = `jijian-${browser}-v${brand.version}.zip`;
  writeFileSync(join("release", name), bytes);
  checksums.push(
    `${createHash("sha256").update(bytes).digest("hex")}  ${name}`,
  );
  console.log(
    `${name}: ${bytes.length} bytes; every archived file reopened and compared`,
  );
}
writeFileSync("release/SHA256SUMS", checksums.join("\n") + "\n");
