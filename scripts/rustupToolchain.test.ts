import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain ESM helper, no type declarations
import { toolchainBinDir } from "./rustupToolchain.mjs";

const ok = (stdout: string) => () => ({ status: 0, stdout });
const missing = () => ({ status: 1, stdout: "" });

describe("toolchainBinDir", () => {
  it("uses the directory rustup reports, not a guessed one", () => {
    const dir = toolchainBinDir({
      runRustup: ok("/opt/rustup/toolchains/1.97.0-aarch64-apple-darwin/bin/cargo\n"),
      exists: () => false
    });
    expect(dir).toBe("/opt/rustup/toolchains/1.97.0-aarch64-apple-darwin/bin");
  });

  it("still finds an installer-placed toolchain when rustup cannot answer", () => {
    const installerBin = join(homedir(), ".cargo", "bin");
    const dir = toolchainBinDir({
      runRustup: missing,
      exists: (path: string) => path.startsWith(installerBin)
    });
    expect(dir).toBe(installerBin);
  });

  it("reports nothing rather than a directory that holds no cargo", () => {
    expect(toolchainBinDir({ runRustup: missing, exists: () => false })).toBeNull();
  });

  it("ignores a rustup that exits non-zero but still prints", () => {
    const dir = toolchainBinDir({
      runRustup: () => ({ status: 101, stdout: "/nope/bin/cargo" }),
      exists: () => false
    });
    expect(dir).toBeNull();
  });
});
