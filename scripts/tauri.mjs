import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

export function withRustupCargoBin(path, homeDirectory, rustupCargoAvailable) {
  if (!rustupCargoAvailable) {
    return path;
  }

  return [join(homeDirectory, ".cargo", "bin"), path]
    .filter(Boolean)
    .join(delimiter);
}

export function isMainModule(moduleUrl, entryPath) {
  return Boolean(entryPath) && moduleUrl === pathToFileURL(entryPath).href;
}

function runTauri(argumentsToForward) {
  const rustupBin = join(homedir(), ".cargo", "bin");
  const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
  const environment = {
    ...process.env,
    PATH: withRustupCargoBin(
      process.env.PATH,
      homedir(),
      existsSync(join(rustupBin, cargoName))
    )
  };
  const tauriCommand = process.platform === "win32" ? "tauri.cmd" : "tauri";
  return spawnSync(tauriCommand, argumentsToForward, {
    env: environment,
    stdio: "inherit"
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const result = runTauri(process.argv.slice(2));
  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}
