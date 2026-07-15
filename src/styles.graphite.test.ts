import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function declarations(selector: string): Record<string, string> {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`Missing CSS selector: ${selector}`);
  }
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return Object.fromEntries(
    styles
      .slice(open + 1, close)
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const colon = value.indexOf(":");
        return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
      })
  );
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4)
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("Graphite & Mist CSS contract", () => {
  it("defines the approved light tokens and accessible text pairs", () => {
    const graphite = declarations(':root[data-theme="graphite"]');
    expect(graphite).toMatchObject({
      "--bg-app": "#d9dee5",
      "--bg-sidebar": "#202630",
      "--sidebar-active-bg": "#2d3643",
      "--bg-list": "#eef1f5",
      "--bg-detail": "#fbfcfd",
      "--bg-card": "#ffffff",
      "--border": "#ccd3dc",
      "--control-border": "#aeb8c5",
      "--text-1": "#1f2732",
      "--text-2": "#536171",
      "--text-3": "#667383",
      "--sidebar-text-2": "#b8c2ce",
      "--sidebar-text-3": "#8f9aa7",
      "--accent": "#286cc9",
      "--accent-strong": "#1f5dab",
      "--accent-soft": "#e5eef9",
      "--focus-ring": "#286cc9",
      "--selection-rail": "#286cc9",
      "--selection-bg": "#e5eef9",
      "--danger": "#a43125",
      "--danger-soft": "#fff0ed",
      "--shadow-pane": "none"
    });
    expect(contrast(graphite["--text-3"], graphite["--bg-detail"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", graphite["--accent"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(styles).not.toContain('"Avenir Next"');
  });

  it("defines an accessible default-dark counterpart and neutral reasons", () => {
    const dark = declarations(':root[data-theme="dark"]');
    expect(dark).toMatchObject({
      "--bg-app": "#11161d",
      "--bg-sidebar": "#161d27",
      "--bg-list": "#1b232e",
      "--bg-detail": "#202936",
      "--bg-card": "#263140",
      "--control-border": "#53657a",
      "--text-1": "#edf2f7",
      "--text-2": "#b8c2ce",
      "--text-3": "#96a3b2",
      "--accent": "#6ba6f7",
      "--accent-contrast": "#0d1724",
      "--selection-rail": "#6ba6f7",
      "--selection-bg": "#243d5c",
      "--notification-reason-fg": "#b8c2ce",
      "--notification-reason-bg": "#263140",
      "--notification-reason-border": "#53657a",
      "--shadow-pane": "none"
    });
    expect(contrast(dark["--text-3"], dark["--bg-detail"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark["--accent-contrast"], dark["--accent"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(styles).not.toMatch(
      /:root\[data-theme="dark"\] \.detail-pane\s*{[^}]*(?:#181818|#080e14)/s
    );
  });

  it("uses a one-pixel pane track without shrinking the resize target", () => {
    expect(declarations(".app-shell")["--pane-gap"]).toBe("1px");
    expect(declarations(".pane-resizer").width).toBe("11px");
    expect(declarations(".pane-resizer::before").background).toBe(
      "var(--border)"
    );
  });
});
