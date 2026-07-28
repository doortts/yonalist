import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const generated = join(root, "packages", "contracts", "generated");

function snapshot(directory) {
  return new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")])
  );
}

const before = snapshot(generated);
const temporary = mkdtempSync(join(tmpdir(), "yonalist-v2-contracts-"));
let after;
try {
  execFileSync("cargo", ["test", "-p", "notes-application", "export_bindings", "--quiet"], {
    cwd: root,
    env: { ...process.env, TS_RS_EXPORT_DIR: temporary },
    stdio: "inherit"
  });
  after = snapshot(temporary);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

if (
  before.size !== after.size ||
  [...before].some(([name, contents]) => after.get(name) !== contents)
) {
  throw new Error(
    "generated Notes TypeScript contracts changed; regenerate and include the diff"
  );
}

console.log(`v2 generated contracts PASS (${after.size} files)`);
