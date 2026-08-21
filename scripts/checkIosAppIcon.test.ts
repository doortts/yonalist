import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = "apps/yonalist/src-tauri/icons/ios";
const catalog = "apps/yonalist/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset";

const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const icons = (directory: string) =>
  readdirSync(directory).filter((name) => name.endsWith(".png")).sort();

/**
 * `tauri ios init` writes its own placeholder icons into the asset catalog
 * rather than the ones the project already generated, and it will do it again
 * on any regeneration. The app shipped to a device with the Tauri logo on it
 * once because of that, and nothing else would have noticed: the build
 * succeeds either way and the icon is only visible on a home screen.
 */
describe("the iOS app icon", () => {
  it("has every size the project generated", () => {
    expect(icons(catalog)).toEqual(icons(source));
  });

  it("is the app's own icon, byte for byte, and not a placeholder", () => {
    const drifted = icons(source).filter(
      (name) => digest(join(source, name)) !== digest(join(catalog, name))
    );

    expect(drifted).toEqual([]);
  });
});
