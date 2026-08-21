import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { toolchainBinDir } from "./rustupToolchain.mjs";

const root = resolve(import.meta.dirname, "..");
const project = join(root, "apps", "desktop", "src-tauri");
// Resolved from the project directory so `rust-toolchain.toml` picks the
// toolchain, and put ahead of PATH so a separately installed `cargo`/`rustc`
// cannot answer instead — an iOS build needs the targets that only the pinned
// toolchain carries.
const toolchainBin = toolchainBinDir(undefined, project);
const path = toolchainBin
  ? [toolchainBin, process.env.PATH].filter(Boolean).join(delimiter)
  : process.env.PATH;
const tauriEntry = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const result = spawnSync(process.execPath, [tauriEntry, ...process.argv.slice(2)], {
  cwd: project,
  env: { ...process.env, PATH: path },
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
