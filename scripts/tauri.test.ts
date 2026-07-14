import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const wrapperPath = join(root, "scripts", "tauri.mjs");

describe("Tauri command runner", () => {
  it("pins Tauri commands to the repository Rust toolchain", async () => {
    expect(existsSync(wrapperPath)).toBe(true);

    const { isMainModule, withRustupCargoBin } = await import(
      /* @vite-ignore */ pathToFileURL(wrapperPath).href
    );
    expect(isMainModule).toEqual(expect.any(Function));
    expect(
      isMainModule(
        "file:///Users/tester/yonalist/scripts/tauri.mjs",
        "/Users/tester/yonalist/scripts/tauri.mjs"
      )
    ).toBe(true);
    expect(
      isMainModule(
        "file:///Users/tester/yonalist/scripts/tauri.mjs",
        "/Users/tester/yonalist/node_modules/vitest/vitest.mjs"
      )
    ).toBe(false);
    expect(withRustupCargoBin("/usr/local/bin", "/Users/tester", true)).toBe(
      ["/Users/tester/.cargo/bin", "/usr/local/bin"].join(delimiter)
    );
    expect(withRustupCargoBin("/usr/local/bin", "/Users/tester", false)).toBe(
      "/usr/local/bin"
    );

    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .scripts;
    expect(scripts["tauri:dev"]).toBe("node scripts/tauri.mjs dev");
    expect(scripts["tauri:build"]).toBe("node scripts/tauri.mjs build");

    const toolchain = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
    expect(toolchain).toContain('channel = "1.97.0"');
  });
});
