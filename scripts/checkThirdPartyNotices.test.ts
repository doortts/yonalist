import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const notices = readFileSync(
  "apps/yonalist/src-tauri/resources/THIRD-PARTY-NOTICES.md",
  "utf8"
);
const manifest = JSON.parse(
  readFileSync("apps/yonalist/src-tauri/tauri.conf.json", "utf8")
) as { bundle: { resources: string[] } };

/**
 * Both icon licences ask that their copyright notice travel with the software.
 * The notice is only kept if it is in the bundle and it names them, so this
 * pins both halves: a set added without its line, or a notice that stops being
 * shipped, is a licence term quietly dropped.
 */
describe("third-party notices", () => {
  it("ships with the app rather than sitting in the repository", () => {
    expect(manifest.bundle.resources).toContain("resources/THIRD-PARTY-NOTICES.md");
  });

  it("carries the copyright line for every icon set the app redistributes", () => {
    expect(notices).toContain("Copyright (c) 2020-2026 Paweł Kuna");
    expect(notices).toContain("Copyright (c) 2026 Lucide Icons and Contributors");
  });

  it("carries the terms, not only the names", () => {
    expect(notices).toContain("MIT License");
    expect(notices).toContain("ISC License");
  });
});
