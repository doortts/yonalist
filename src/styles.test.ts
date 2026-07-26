import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const notesStyles = readFileSync("src/features/notes/notes.css", "utf8");

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("surviving application styles", () => {
  it("keeps the status bar transparent", () => {
    const statusbar = rule(styles, ".app-statusbar");
    expect(statusbar).toContain("background: transparent");
    expect(statusbar).not.toContain("border-top");
  });

  it("keeps the sidebar transparent and unframed", () => {
    const sidebar = rule(styles, ".sidebar");
    expect(sidebar).toContain("background: transparent");
    expect(sidebar).toContain("border: 0");
    expect(sidebar).toContain("box-shadow: none");
  });

  it("keeps Settings scrollable inside its pane", () => {
    const settings = rule(styles, ".settings-body");
    expect(settings).toContain("min-height: 0");
    expect(settings).toContain("overflow: auto");
  });

  it("keeps Markdown content width and wrapping", () => {
    const markdown = rule(styles, ".markdown-body");
    expect(markdown).toContain("max-width: 980px");
    expect(markdown).toContain("overflow-wrap: break-word");
  });

  it("keeps the Notes outline geometry", () => {
    const outline = rule(notesStyles, ".notes-outline");
    expect(outline).toContain("--notes-outline-indent: 36px");
    expect(outline).toContain("flex-direction: column");
    expect(outline).toContain("min-height: 100%");
  });
});
