import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("package and manifest describe the same OpenClaw plugin", () => {
  const pkg = readJson("package.json");
  const manifest = readJson("openclaw.plugin.json");

  assert.equal(pkg.name, "@hamstudy/wildduck-openclaw-plugin");
  assert.equal(manifest.id, "wildduck");
  assert.deepEqual(pkg.openclaw.extensions, ["./src/index.ts"]);
  assert.deepEqual(manifest.skills, ["skills/wildduck-email"]);
});

test("manifest defaults to read-only permissions", () => {
  const manifest = readJson("openclaw.plugin.json");
  assert.deepEqual(manifest.configSchema.properties.permissions.default, ["read"]);
  assert.equal(manifest.uiHints.accessToken.sensitive, true);
});

test("companion skill has usable frontmatter", () => {
  const skill = fs.readFileSync(path.join(root, "skills/wildduck-email/SKILL.md"), "utf8");
  assert.match(skill, /^---\n/m);
  assert.match(skill, /name: wildduck-email/);
  assert.match(skill, /description: Use the WildDuck OpenClaw plugin/);
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}
