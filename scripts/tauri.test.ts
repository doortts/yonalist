import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const wrapperPath = join(root, "scripts", "tauri.mjs");

describe("Tauri command runner", () => {
  it("allows blob image URLs only in the CSP img-src directive", () => {
    const config = JSON.parse(
      readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
    ) as { app: { security: { csp: string } } };
    const directives = config.app.security.csp
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => Boolean(name));

    const imageSources = directives.find(([name]) => name === "img-src")?.slice(1);
    expect(imageSources).toContain("blob:");
    for (const [name, ...sources] of directives) {
      if (name !== "img-src") expect(sources).not.toContain("blob:");
    }
  });

  it("pins Tauri commands to the repository Rust toolchain", async () => {
    expect(existsSync(wrapperPath)).toBe(true);

    const { isMainModule, withRustupCargoBin } = await import(
      /* @vite-ignore */ pathToFileURL(wrapperPath).href
    );
    expect(isMainModule).toEqual(expect.any(Function));
    const fixtureEntryPath = join(root, "scripts", "tauri.mjs");
    expect(
      isMainModule(pathToFileURL(fixtureEntryPath).href, fixtureEntryPath)
    ).toBe(true);
    expect(
      isMainModule(
        pathToFileURL(fixtureEntryPath).href,
        join(root, "node_modules", "vitest", "vitest.mjs")
      )
    ).toBe(false);
    const fixturePath = join(root, "bin");
    const fixtureHome = join(root, "home");
    expect(withRustupCargoBin(fixturePath, fixtureHome, true)).toBe(
      [join(fixtureHome, ".cargo", "bin"), fixturePath].join(delimiter)
    );
    expect(withRustupCargoBin(fixturePath, fixtureHome, false)).toBe(fixturePath);

    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .scripts;
    expect(scripts["tauri:dev"]).toBe("node scripts/tauri.mjs dev");
    expect(scripts["tauri:build"]).toBe("node scripts/tauri.mjs build");

    const toolchain = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
    expect(toolchain).toContain('channel = "1.97.0"');
  });
});
