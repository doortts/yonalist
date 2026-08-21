import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";

/**
 * Where the pinned toolchain's `cargo` and `rustc` live, or `null` when rustup
 * cannot say.
 *
 * Asking rustup is the only reliable question. `~/.cargo/bin` exists only when
 * rustup was installed by its own installer; a Homebrew-installed rustup keeps
 * its shims elsewhere, and on such a machine the old probe silently fell
 * through to whatever `cargo` was first on PATH — which is the Homebrew `rust`
 * formula, carrying the host target and nothing else. That reads as fine on
 * desktop and dies on `tauri ios build`.
 *
 * The answer is a toolchain bin directory rather than the shim directory so
 * `rustc` comes from the same place as `cargo`; a shim that resolves through
 * rustup would work too, but only if nothing earlier on PATH shadows it.
 */
export function toolchainBinDir({
  runRustup = (args, cwd) =>
    spawnSync("rustup", args, { cwd, encoding: "utf8" }),
  exists = existsSync,
  home = homedir()
} = {}, cwd = undefined) {
  const found = runRustup(["which", "cargo"], cwd);
  const reported = found?.status === 0 ? String(found.stdout ?? "").trim() : "";
  if (reported) return dirname(reported);
  const installerBin = join(home, ".cargo", "bin");
  return exists(join(installerBin, cargoName)) ? installerBin : null;
}
