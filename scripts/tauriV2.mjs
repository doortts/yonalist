import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = join(root, "apps", "desktop", "src-tauri");
const rustupBin = join(homedir(), ".cargo", "bin");
const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const path = existsSync(join(rustupBin, cargoName))
  ? [rustupBin, process.env.PATH].filter(Boolean).join(delimiter)
  : process.env.PATH;
const tauriEntry = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const result = spawnSync(process.execPath, [tauriEntry, ...process.argv.slice(2)], {
  cwd: project,
  env: { ...process.env, PATH: path },
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
