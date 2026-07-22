import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("application chrome styles", () => {
  it("keeps the status bar transparent", () => {
    expect(rule(".app-statusbar")).toContain("background: transparent");
  });

  it("keeps the sidebar transparent and unframed", () => {
    const sidebar = rule(".sidebar");
    expect(sidebar).toContain("background: transparent");
    expect(sidebar).toContain("border: 0");
    expect(sidebar).toContain("box-shadow: none");
  });
});
