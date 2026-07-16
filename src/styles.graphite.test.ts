import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);
const baseThemeStyles = readFileSync(
  join(process.cwd(), "src/themes/base-ui-pure.css"),
  "utf8"
);

function declarations(
  selector: string,
  source = styles
): Record<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`Missing CSS selector: ${selector}`);
  }
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return Object.fromEntries(
    source
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
      "--reason-mention": "#b39dff",
      "--reason-comment": "#4dd0c4",
      "--reason-author": "#ff8a65",
      "--reason-team": "#8c9eff",
      "--yona-comment": "#78cf9d",
      "--yona-code-bg": "#18212c",
      "--yona-table-border": "#465568",
      "--yona-table-head": "#263140",
      "--shadow-pane": "none"
    });
    expect(contrast(dark["--text-3"], dark["--bg-detail"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark["--accent-contrast"], dark["--accent"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark["--text-1"], dark["--yona-code-bg"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(styles).not.toMatch(
      /:root\[data-theme="dark"\] \.detail-pane\s*{[^}]*(?:#181818|#080e14)/s
    );
  });

  it("uses sidebar tokens for the expanded Graphite sidebar toggle only", () => {
    const toggle = declarations(
      ':root[data-theme="graphite"] .app-shell:not([data-sidebar-collapsed="true"]) > .pane-toggle-group[data-position="sidebar-end"]'
    );
    expect(toggle).toMatchObject({
      "--text-1": "var(--sidebar-text-1)",
      "--text-2": "var(--sidebar-text-2)",
      "--text-3": "var(--sidebar-text-3)",
      "--bg-hover": "var(--sidebar-hover-bg)",
      "--bg-active": "var(--sidebar-active-bg)"
    });
  });

  it("uses a one-pixel pane track without shrinking the resize target", () => {
    expect(declarations(".app-shell")["--pane-gap"]).toBe("1px");
    expect(declarations(".pane-resizer").width).toBe("11px");
    expect(declarations(".pane-resizer::before").background).toBe(
      "var(--border)"
    );
  });

  it("shrinks desktop pane requests around a usable detail minimum", () => {
    expect(
      declarations(".app-shell")["grid-template-columns"].replace(/\s+/g, " ")
    ).toBe(
      "minmax(0, var(--sidebar-width, 240px)) var(--sidebar-resizer-width, 10px) minmax(0, var(--list-width, 340px)) var(--list-resizer-width, 10px) minmax(320px, 1fr)"
    );
    expect(styles).toMatch(/@media \(min-width: 981px\)/);
    expect(styles).toMatch(/@media \(max-width: 980px\)/);
  });

  it("uses shared interactive tokens and restrained motion", () => {
    expect(styles).toMatch(
      /\.theme-options\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(112px,\s*1fr\)\)/s
    );
    expect(styles).toMatch(
      /\.theme-option span\s*\{[^}]*white-space:\s*nowrap/s
    );
    expect(styles).toMatch(
      /\.notification-row\.selected\s*\{[^}]*var\(--selection-bg\)[^}]*var\(--selection-rail\)/s
    );
    expect(styles).toMatch(
      /\.notification-reason\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border:\s*1px solid var\(--notification-reason-border\);[^}]*border-radius:\s*var\(--radius-sm\);[^}]*background:\s*var\(--notification-reason-bg\);[^}]*color:\s*var\(--notification-reason-fg\);/s
    );
    expect(styles).toMatch(
      /\.reason-mention,\s*\.reason-comment,\s*\.reason-author,\s*\.reason-team\s*\{[^}]*color:\s*var\(--notification-reason-fg\);/s
    );
    expect(styles).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*\.avatar-skeleton[\s\S]*animation:\s*none/s
    );
    expect(styles).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*\.spinning\s*\{[^}]*animation:\s*spin/s
    );
  });

  it("wraps markdown choice copy without changing ordinary theme labels", () => {
    expect(
      declarations(".markdown-style-options")["grid-template-columns"]
    ).toBe("repeat(auto-fit, minmax(min(220px, 100%), 1fr))");
    expect(declarations(".markdown-style-options .theme-option")["min-width"])
      .toBe("0");
    expect(
      declarations(
        ".markdown-style-options .theme-option > span:not(.ui-radio)"
      )
    ).toMatchObject({
      "min-width": "0",
      "white-space": "normal",
      "overflow-wrap": "anywhere"
    });
    expect(declarations(".theme-option span")["white-space"]).toBe("nowrap");
  });

  it("enforces the compact control rhythm and radius scale", () => {
    expect(styles).toMatch(
      /:root\s*\{[^}]*--radius-sm:\s*4px;[^}]*--radius:\s*5px;[^}]*--radius-lg:\s*8px;/s
    );
    expect(styles).toMatch(
      /\.nav-section-icon-button\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*var\(--radius-sm\);/s
    );
    expect(styles).toMatch(
      /\.text-button,[\s\S]*?\.icon-button\s*\{[^}]*min-height:\s*32px;[^}]*border-radius:\s*var\(--radius\);/s
    );
    expect(styles).toMatch(
      /(?:^|\n)\.icon-button\s*\{[^}]*width:\s*32px;/s
    );
    expect(styles).toMatch(
      /\.list-refresh\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*min-height:\s*28px;/s
    );
    expect(styles).toMatch(
      /\.item-state-tab\s*\{[^}]*min-height:\s*32px;[^}]*border-radius:\s*var\(--radius-sm\) var\(--radius-sm\) 0 0;/s
    );
    expect(styles).toMatch(
      /\.item-sort-trigger\s*\{[^}]*min-height:\s*32px;[^}]*border-radius:\s*var\(--radius-sm\);/s
    );
    expect(styles).toMatch(
      /\.notifications-open-all\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*var\(--radius-sm\);/s
    );
  });

  it("stores optional row identity in semantic selection tokens", () => {
    expect(declarations(':root[data-theme="yonal-light"]')).toMatchObject({
      "--selection-bg":
        "var(--nav-list-selected-bg, var(--list-selected-bg))",
      "--selection-rail":
        "var(--nav-list-selected-border, var(--list-selected-border))"
    });
    expect(declarations(':root[data-theme="yona-dark"]')).toMatchObject({
      "--selection-bg": "var(--yonal-gradient-soft)",
      "--selection-rail": "var(--accent)"
    });
    expect(baseThemeStyles).toMatch(
      /:root\[data-theme="base-light"\],\s*:root\[data-theme="base-dark"\]\s*\{[^}]*--selection-bg:\s*var\(--bg-active\);[^}]*--selection-rail:\s*var\(--text-1\);/s
    );
  });

  it("keeps shared row selection and unread declarations authoritative", () => {
    expect(styles).toMatch(
      /\.item-card\.selected\s*\{[^}]*background:\s*var\(--selection-bg\);[^}]*box-shadow:\s*inset 2px 0 0 var\(--selection-rail\);/s
    );
    expect(styles).toMatch(
      /\.notification-row\.selected\s*\{[^}]*background:\s*var\(--selection-bg\);[^}]*box-shadow:\s*inset 2px 0 0 var\(--selection-rail\);/s
    );
    expect(declarations(".notification-unread-dot").background).toBe(
      "var(--accent)"
    );
    expect(styles).not.toMatch(
      /:root\[data-theme="yonal-light"\] \.item-card\.selected/
    );
    expect(styles).not.toMatch(
      /:root\[data-theme="yona-dark"\] \.item-card\.selected/
    );
    expect(styles).not.toMatch(
      /:root\[data-theme="yona-dark"\] \.notification-unread-dot/
    );
    expect(baseThemeStyles).not.toMatch(
      /:root\[data-theme="base-(?:light|dark)"\] \.item-card\.selected/
    );
    expect(baseThemeStyles).not.toMatch(
      /:root\[data-theme="base-(?:light|dark)"\] \.notification-row\.selected/
    );
  });

  it("uses the semantic focus ring for login-required controls", () => {
    expect(
      declarations(".icon-button.login-required-button:focus-visible").outline
    ).toBe("2px solid var(--focus-ring)");
    expect(styles).not.toContain("outline: 2px solid rgb(220 38 38 / 34%)");
  });

  it("uses accessible semantic contrast for solid danger buttons", () => {
    const root = declarations(":root");
    const dark = declarations(':root[data-theme="dark"]');
    const yonaDark = declarations(':root[data-theme="yona-dark"]');

    expect(root["--danger-contrast"]).toBe("#ffffff");
    expect(dark["--danger-contrast"]).toBe("#0d1724");
    expect(yonaDark["--danger-contrast"]).toBe("#1a1020");
    expect(contrast(dark["--danger-contrast"], dark["--danger"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark["--danger-contrast"], dark["--danger-hover"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(yonaDark["--danger-contrast"], yonaDark["--danger"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(yonaDark["--danger-contrast"], yonaDark["--danger-hover"]))
      .toBeGreaterThanOrEqual(4.5);
    expect(declarations(".danger-button").color).toBe(
      "var(--danger-contrast)"
    );
    expect(baseThemeStyles).toMatch(
      /:root\[data-theme="base-light"\] \.danger-button,[\s\S]*?:root\[data-theme="base-dark"\] \.danger-button\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--danger\);/s
    );
  });

  it("keeps every pane flat through the shared root token", () => {
    expect(declarations(":root")["--shadow-pane"]).toBe("none");
  });

  it("shows semantic two-pixel focus on Inbox and Notes search wrappers", () => {
    expect(styles).toMatch(
      /\.search-row:focus-within\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\);/s
    );
    expect(declarations(".notes-search-field", notesStyles).border).toBe(
      "1px solid var(--control-border)"
    );
    const notesFocus = declarations(
      ".notes-search-field:focus-within",
      notesStyles
    );
    expect(notesFocus.outline).toBe("2px solid var(--focus-ring)");
    expect(notesFocus).not.toHaveProperty("border-color");
  });
});
