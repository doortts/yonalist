<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=superseded -->
> **증거 대조 상태 (2026-07-19): 대체됨.** 구현 branch가 통합된 뒤 revert되어 checkbox는 미완료로 유지한다. 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Graphite & Mist Whole-App Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Soft Paper default with the approved Graphite & Mist visual system across Yonalist while preserving every feature, data contract, keyboard command, pane behavior, and Workflowy-like Notes editing invariant.

**Architecture:** Add a backward-compatible `graphite` light-theme identity, then drive the redesign through existing CSS tokens and focused component state markup. Keep the current App grid, feature providers, kept-mounted Notes workspace, Base UI primitives, and Lucide icon stack. Notes receives presentation-only range positions and a toolbar-local width observer; no selection or command model changes.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, Base UI, Lucide React, CSS custom properties, Tauri 2, Rust.

## Global Constraints

- Do not change routing, data loading, persistence contracts, Tauri commands, or feature information architecture.
- Keep all six Notes library views: All, Starred, Recent, Tags, Archive, and Trash.
- Keep Notes content width, row height, indentation, bullet, guide, textarea, caret, drag, attachment, draft, and history geometry unchanged.
- Do not add a dependency, font package, CSS framework, animation library, icon library, or new design-system directory.
- Use `lucide-react` for every application icon.
- Graphite is the fresh-install and reset light theme; stored `soft-paper` resolves to Graphite without an eager storage rewrite.
- Preserve Yona, Yonal Light, Yonal Dark, Base Light, and Base Dark identities.
- Preserve `.feature-pane-slot { display: contents; }`, direct-child pane order, kept-mounted Notes providers, titlebar drag regions, collapse, maximize, and pane resizing.
- Preserve GitHub virtualization heights: 104 px labelled rows, 80 px compact rows, 34 px date headers, 22 px label line, and threshold 30 unless constants and tests change together.
- Use pane width, not viewport width, to choose Notes selection-toolbar overflow.
- Make status and error copy wrap in full; do not ellipsize command meaning.
- Verify viewport boundaries at 1280, 981, 980, 721, 720, and 320 px, plus 200 percent zoom.
- Follow strict RED, verify RED, GREEN, verify GREEN, refactor, and commit cycles.

---

### Task 1: Graphite Theme Identity, Compatibility, and Reset

**Files:**
- Modify: `src/hooks/useTheme.test.tsx`
- Modify: `src/hooks/useTheme.ts`
- Modify: `src/components/SettingsPage.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: local-storage keys `yonalist.themeMode.v1`, `yonalist.lightTheme.v1`, and `yonalist.darkTheme.v1`.
- Produces: `LightTheme` containing `"graphite"`, `data-theme="graphite"`, a visible Graphite light-theme option, and reset defaults `{ mode: "system", light: "graphite", dark: "dark" }`.

- [ ] **Step 1: Write failing theme-resolution tests**

Replace the current fresh Soft Paper test in `src/hooks/useTheme.test.tsx` and add the two compatibility cases:

```tsx
it("uses Graphite as the fresh light theme", () => {
  installLocalStorageMock();
  installMatchMediaMock(false);

  render(<ThemeProbe />);

  expect(screen.getByLabelText("Theme")).toHaveAttribute(
    "data-light-theme",
    "graphite"
  );
  expect(document.documentElement.dataset.theme).toBe("graphite");
});

it("maps stored Soft Paper to Graphite without rewriting the legacy value", () => {
  installLocalStorageMock();
  installMatchMediaMock(false);
  window.localStorage.setItem("yonalist.themeMode.v1", "light");
  window.localStorage.setItem("yonalist.lightTheme.v1", "soft-paper");

  render(<ThemeProbe />);

  expect(screen.getByLabelText("Theme")).toHaveAttribute(
    "data-light-theme",
    "graphite"
  );
  expect(document.documentElement.dataset.theme).toBe("graphite");
  expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe(
    "soft-paper"
  );
});

it("restores an explicitly selected Graphite theme", () => {
  installLocalStorageMock();
  installMatchMediaMock(false);
  window.localStorage.setItem("yonalist.themeMode.v1", "light");
  window.localStorage.setItem("yonalist.lightTheme.v1", "graphite");

  render(<ThemeProbe />);

  expect(document.documentElement.dataset.theme).toBe("graphite");
});
```

- [ ] **Step 2: Run the focused hook test and verify RED**

Run:

```bash
npm test -- src/hooks/useTheme.test.tsx
```

Expected: the new tests fail because the hook still resolves `soft-paper`.

- [ ] **Step 3: Implement the Graphite identity and legacy mapping**

Use this union and loader in `src/hooks/useTheme.ts`:

```ts
export type LightTheme =
  | "graphite"
  | "default"
  | "yona"
  | "yonal-light"
  | "base-light";

function loadLightTheme(): LightTheme {
  const stored = readStoredValue(lightThemeStorageKey);
  if (stored === "soft-paper") {
    return "graphite";
  }
  if (
    stored === "graphite" ||
    stored === "default" ||
    stored === "yona" ||
    stored === "yonal-light" ||
    stored === "base-light"
  ) {
    return stored;
  }
  return readStoredValue(themeModeStorageKey) === "yona"
    ? "yona"
    : "graphite";
}
```

Rename only the selector `:root[data-theme="soft-paper"]` to
`:root[data-theme="graphite"]` in `src/styles.css`; Task 2 replaces its token
values. Do not keep `soft-paper` in `LightTheme` or Settings.

- [ ] **Step 4: Add failing Settings and reset assertions**

Extend `switches themes from the settings page and persists the choice` in
`src/App.test.tsx`:

```tsx
expect(
  screen.getByRole("radio", { name: "Graphite light theme" })
).toBeInTheDocument();
expect(
  screen.queryByRole("radio", { name: "Soft Paper light theme" })
).not.toBeInTheDocument();

await user.click(
  screen.getByRole("radio", { name: "Graphite light theme" })
);
expect(document.documentElement.dataset.theme).toBe("graphite");
expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe(
  "graphite"
);
```

In `resets all settings and caches without deleting vault documents`, seed a
non-default light theme and add:

```tsx
window.localStorage.setItem("yonalist.lightTheme.v1", "yona");

expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("system");
expect(window.localStorage.getItem("yonalist.lightTheme.v1")).toBe("graphite");
expect(window.localStorage.getItem("yonalist.darkTheme.v1")).toBe("dark");
expect(document.documentElement.dataset.theme).toBe("graphite");
```

- [ ] **Step 5: Run the focused App tests and verify RED**

Run:

```bash
npm test -- src/App.test.tsx -t "switches themes|resets all settings"
```

Expected: Graphite is absent and reset stores `default`.

- [ ] **Step 6: Implement the visible option and reset default**

Use this first Settings option in `src/components/SettingsPage.tsx`:

```ts
const lightThemeOptions: Array<{ value: LightTheme; label: string }> = [
  { value: "graphite", label: "Graphite" },
  { value: "default", label: "Default" },
  { value: "yona", label: "Yona" },
  { value: "yonal-light", label: "Yonal Light" },
  { value: "base-light", label: "Base Light" }
];
```

Use these setters inside `App` reset restoration:

```ts
setThemeMode("system");
setLightTheme("graphite");
setDarkTheme("dark");
```

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npm test -- src/hooks/useTheme.test.tsx src/App.test.tsx
```

Expected: all theme and App tests pass.

Commit:

```bash
git add src/hooks/useTheme.ts src/hooks/useTheme.test.tsx src/components/SettingsPage.tsx src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat(theme): make graphite the default light theme"
```

---

### Task 2: Graphite Tokens, First Paint, and Pane Shell

**Files:**
- Create: `src/styles.graphite.test.ts`
- Modify: `src/styles.css`
- Modify: `src/main.test.tsx`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `loadThemeMode`, `loadLightTheme`, `loadDarkTheme`, and the system dark preference.
- Produces: `loadInitialResolvedTheme(): ResolvedTheme`, Graphite and default-dark tokens, shared semantic aliases, a 1 px visual pane separator with the existing 11 px hit target, and a theme-correct first frame.

- [ ] **Step 1: Write the failing token contract**

Create `src/styles.graphite.test.ts`:

```ts
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
  });

  it("uses a one-pixel pane track without shrinking the resize target", () => {
    expect(declarations(".app-shell")["--pane-gap"]).toBe("1px");
    expect(declarations(".pane-resizer").width).toBe("11px");
    expect(declarations(".pane-resizer::before").background).toBe(
      "var(--border)"
    );
  });
});
```

- [ ] **Step 2: Write failing first-paint tests**

In `src/main.test.tsx`, isolate startup theme state in `beforeEach`:

```tsx
window.localStorage.clear();
document.documentElement.removeAttribute("data-theme");
```

Then add:

```tsx
it("applies the stored resolved theme before the mocked App renders", async () => {
  window.localStorage.setItem("yonalist.themeMode.v1", "light");
  window.localStorage.setItem("yonalist.lightTheme.v1", "graphite");

  await import("./main");

  expect(document.documentElement.dataset.theme).toBe("graphite");
});

it("renders startup failures with Graphite fallback colors", async () => {
  renderMock.mockImplementationOnce(() => {
    throw new Error("boot failed");
  });

  await import("./main");

  await vi.waitFor(() =>
    expect(document.getElementById("root")).toHaveTextContent(
      "Yonalist failed to start"
    )
  );
  expect(document.querySelector("#root > main")).toHaveStyle({
    background: "#d9dee5",
    color: "#1f2732"
  });
});
```

- [ ] **Step 3: Run both tests and verify RED**

Run:

```bash
npm test -- src/styles.graphite.test.ts src/main.test.tsx
```

Expected: token, separator, initial-theme, and startup-color assertions fail.

- [ ] **Step 4: Implement a shared initial resolver**

Extract this pure resolver in `src/hooks/useTheme.ts`, use it inside `useTheme`,
and export the initial loader:

```ts
function resolveTheme(
  mode: ThemeMode,
  lightTheme: LightTheme,
  darkTheme: DarkTheme,
  systemDark: boolean
): ResolvedTheme {
  return mode === "system"
    ? systemDark
      ? darkTheme
      : lightTheme
    : mode === "dark"
      ? darkTheme
      : lightTheme;
}

export function loadInitialResolvedTheme(): ResolvedTheme {
  return resolveTheme(
    loadThemeMode(),
    loadLightTheme(),
    loadDarkTheme(),
    systemPrefersDark()
  );
}
```

In `src/main.tsx`, apply it after CSS import and before `start()`:

```ts
import { loadInitialResolvedTheme } from "./hooks/useTheme";

document.documentElement.dataset.theme = loadInitialResolvedTheme();
```

Set startup error inline colors to `background: #d9dee5` and `color: #1f2732`.

- [ ] **Step 5: Implement semantic aliases and Graphite tokens**

Add these aliases to `:root` before the theme blocks:

```css
--control-border: var(--border-strong);
--focus-ring: var(--accent);
--sidebar-text-1: var(--text-1);
--sidebar-text-2: var(--text-2);
--sidebar-text-3: var(--text-3);
--sidebar-hover-bg: var(--bg-hover);
--sidebar-active-bg: var(--bg-active);
--sidebar-divider: var(--border);
--selection-rail: var(--list-selected-border);
--selection-bg: var(--list-selected-bg);
--shadow-pane: 0 12px 32px rgb(50 39 31 / 7%);
--shadow-menu: var(--shadow-modal);
--status-success-fg: var(--success);
--status-success-bg: var(--bg-card);
--status-success-border: var(--border);
--status-warning-fg: var(--warning);
--status-warning-bg: var(--warning-soft);
--status-warning-border: var(--warning-border);
--status-error-fg: var(--danger);
--status-error-bg: var(--danger-soft);
--status-error-border: var(--danger);
--notification-reason-fg: var(--text-2);
--notification-reason-bg: var(--bg-quiet);
--notification-reason-border: var(--control-border);
```

Replace the retired Soft Paper block with this Graphite block and remove its
theme-specific font declaration:

```css
:root[data-theme="graphite"] {
  color-scheme: light;
  --bg-app: #d9dee5;
  --bg-sidebar: #202630;
  --bg-list: #eef1f5;
  --bg-detail: #fbfcfd;
  --bg-card: #ffffff;
  --bg-hover: rgb(31 39 50 / 6%);
  --bg-active: #e3e8ef;
  --bg-input: #ffffff;
  --bg-quiet: #f4f6f8;
  --comment-header: #eef1f5;
  --border: #ccd3dc;
  --border-strong: #b8c2ce;
  --control-border: #aeb8c5;
  --text-1: #1f2732;
  --text-2: #536171;
  --text-3: #667383;
  --sidebar-text-1: #fbfcfd;
  --sidebar-text-2: #b8c2ce;
  --sidebar-text-3: #8f9aa7;
  --sidebar-hover-bg: #28313d;
  --sidebar-active-bg: #2d3643;
  --sidebar-divider: #394554;
  --accent: #286cc9;
  --accent-strong: #1f5dab;
  --accent-soft: #e5eef9;
  --accent-contrast: #ffffff;
  --focus-ring: #286cc9;
  --list-hover-bg: var(--bg-hover);
  --list-selected-bg: #e5eef9;
  --list-selected-border: #286cc9;
  --list-selected-shadow: inset 2px 0 0 #286cc9;
  --selection-rail: #286cc9;
  --selection-bg: #e5eef9;
  --state-tab-hover-bg: var(--bg-hover);
  --state-tab-active-bg: #ffffff;
  --state-tab-active-border: #aeb8c5;
  --state-tab-active-shadow: none;
  --favorite: #b56b16;
  --danger: #a43125;
  --danger-hover: #85271e;
  --danger-soft: #fff0ed;
  --warning: #8a5a0a;
  --warning-soft: #fff6df;
  --warning-border: #d4a44b;
  --success: #246b45;
  --notification-reason-fg: #536171;
  --notification-reason-bg: #f4f6f8;
  --notification-reason-border: #aeb8c5;
  --status-success-fg: #246b45;
  --status-success-bg: #f0f8f3;
  --status-success-border: #8ebda2;
  --status-warning-fg: #8a5a0a;
  --status-warning-bg: #fff6df;
  --status-warning-border: #d4a44b;
  --status-error-fg: #a43125;
  --status-error-bg: #fff0ed;
  --status-error-border: #d59a92;
  --scrollbar-thumb: rgb(31 39 50 / 28%);
  --scrollbar-thumb-hover: rgb(31 39 50 / 48%);
  --shadow-pane: none;
  --shadow-menu: 0 12px 32px rgb(31 39 50 / 18%);
  --shadow-modal: 0 20px 56px rgb(31 39 50 / 24%);
}
```

Retune only the default dark identity with this counterpart; do not change Yona
Dark or Base Dark colors:

```css
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg-app: #11161d;
  --bg-sidebar: #161d27;
  --bg-list: #1b232e;
  --bg-detail: #202936;
  --bg-card: #263140;
  --bg-hover: rgb(237 242 247 / 7%);
  --bg-active: #2b3a4d;
  --bg-input: #18212c;
  --bg-quiet: #18212c;
  --comment-header: #2a3544;
  --border: #344150;
  --border-strong: #465568;
  --control-border: #53657a;
  --text-1: #edf2f7;
  --text-2: #b8c2ce;
  --text-3: #96a3b2;
  --sidebar-text-1: #edf2f7;
  --sidebar-text-2: #b8c2ce;
  --sidebar-text-3: #96a3b2;
  --sidebar-hover-bg: #202b38;
  --sidebar-active-bg: #2b3a4d;
  --sidebar-divider: #344150;
  --accent: #6ba6f7;
  --accent-strong: #8bb9fa;
  --accent-soft: #243d5c;
  --accent-contrast: #0d1724;
  --focus-ring: #6ba6f7;
  --list-hover-bg: var(--bg-hover);
  --list-selected-bg: #243d5c;
  --list-selected-border: #6ba6f7;
  --list-selected-shadow: inset 2px 0 0 #6ba6f7;
  --selection-rail: #6ba6f7;
  --selection-bg: #243d5c;
  --state-tab-hover-bg: var(--bg-hover);
  --state-tab-active-bg: #263140;
  --state-tab-active-border: #53657a;
  --state-tab-active-shadow: none;
  --favorite: #f0a35b;
  --danger: #ff8b82;
  --danger-hover: #ffaaa4;
  --danger-soft: #432727;
  --warning: #f5c46b;
  --warning-soft: #3a321f;
  --warning-border: #816c3b;
  --success: #78cf9d;
  --notification-reason-fg: #b8c2ce;
  --notification-reason-bg: #263140;
  --notification-reason-border: #53657a;
  --status-success-fg: #78cf9d;
  --status-success-bg: #1c3428;
  --status-success-border: #3f7957;
  --status-warning-fg: #f5c46b;
  --status-warning-bg: #3a321f;
  --status-warning-border: #816c3b;
  --status-error-fg: #ff8b82;
  --status-error-bg: #432727;
  --status-error-border: #8f4f4b;
  --scrollbar-thumb: rgb(237 242 247 / 24%);
  --scrollbar-thumb-hover: rgb(237 242 247 / 42%);
  --shadow-pane: none;
  --shadow-menu: 0 14px 36px rgb(0 0 0 / 42%);
  --shadow-modal: 0 22px 64px rgb(0 0 0 / 55%);
}
```

Every optional theme inherits the semantic aliases from `:root`. Add an
explicit override only when its existing surface/text/accent token would not be
safe; never add a Graphite-only literal to an optional theme.

- [ ] **Step 6: Implement the flat pane shell and Graphite sidebar scope**

Change the shell and pane declarations without changing grid order or width
variables:

```css
.app-shell {
  --shell-inset: 8px;
  --pane-gap: 1px;
  --pane-top: 8px;
  --sidebar-resizer-width: var(--pane-gap);
  --list-resizer-width: var(--pane-gap);
}

.sidebar,
.list-pane,
.detail-pane,
.notifications-pane {
  border: 0;
  border-radius: 0;
  box-shadow: var(--shadow-pane);
}

.pane-resizer::before {
  background: var(--border);
}

.pane-resizer:hover::before,
.pane-resizer:focus-visible::before {
  background: var(--focus-ring);
}
```

Scope dark-navigation assumptions to Graphite:

```css
:root[data-theme="graphite"] .sidebar {
  --text-1: var(--sidebar-text-1);
  --text-2: var(--sidebar-text-2);
  --text-3: var(--sidebar-text-3);
  --bg-hover: var(--sidebar-hover-bg);
  --bg-active: var(--sidebar-active-bg);
  color: var(--sidebar-text-2);
}

:root[data-theme="graphite"] .nav-item.active {
  color: var(--sidebar-text-1);
  box-shadow: inset 2px 0 0 var(--selection-rail);
}

.nav-section-app {
  border-top: 1px solid var(--sidebar-divider);
}
```

Keep `.pane-resizer` at 11 px with its existing negative margins.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npm test -- src/styles.graphite.test.ts src/main.test.tsx src/hooks/useTheme.test.tsx src/components/Sidebar.test.tsx src/components/AppStatusBar.test.tsx src/App.test.tsx
```

Expected: all focused tests pass.

Commit:

```bash
git add src/styles.graphite.test.ts src/styles.css src/main.tsx src/main.test.tsx src/hooks/useTheme.ts
git commit -m "feat(ui): add graphite tokens and pane shell"
```

---

### Task 3: Shared Loading, Empty, Error, and Settings Semantics

**Files:**
- Modify: `src/components/ItemListPane.test.tsx`
- Modify: `src/components/ItemListPane.tsx`
- Modify: `src/components/NotificationsPane.test.tsx`
- Modify: `src/components/NotificationsPane.tsx`
- Modify: `src/components/ItemDetail.test.tsx`
- Modify: `src/components/ItemDetail.tsx`
- Modify: `src/components/NotificationDetail.test.tsx`
- Modify: `src/components/NotificationDetail.tsx`
- Create: `src/components/SettingsPage.test.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/components/SettingsPage.tsx`
- Modify: `src/features/notes/NotesLibraryPane.test.tsx`
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: existing `loading`, `error`, empty collections, thread state, notification detail state, and Settings `status` props.
- Produces: loading/empty `role="status"`, actionable `role="alert"`, `aria-busy`, correct loading-over-empty precedence, and polite Settings save feedback.

- [ ] **Step 1: Write failing Inbox and Notifications state tests**

In `ItemListPane.test.tsx`, replace the override type with:

```tsx
overrides: {
  connection?: GithubConnection;
  demoMode?: boolean;
  online?: boolean;
  loading?: boolean;
  error?: string | null;
} = {}
```

Pass the two new values to `ItemListPane`:

```tsx
loading={overrides.loading ?? false}
error={overrides.error ?? null}
```

Then add:

```tsx
it("exposes loading, empty, and error list states with correct precedence", () => {
  const loading = renderPaneWith([], { loading: true });
  expect(screen.getByRole("status")).toHaveTextContent("Loading items...");
  expect(screen.queryByText("No items match this view.")).toBeNull();
  expect(loading.container.querySelector(".list-pane")).toHaveAttribute(
    "aria-busy",
    "true"
  );
  loading.unmount();

  renderPaneWith([], { error: "Load failed" });
  expect(screen.getByRole("alert")).toHaveTextContent("Load failed");
  expect(screen.queryByText("No items match this view.")).toBeNull();
});
```

In `NotificationsPane.test.tsx`, use `makeState` and add:

```tsx
it("exposes loading, empty, and error states without conflicting copy", () => {
  const { rerender } = render(
    <NotificationsPane
      state={makeState({ notifications: [], loading: true })}
      webBaseUrl="https://github.com"
      online
      selectedId={null}
      onSelect={vi.fn()}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading notifications..."
  );
  expect(screen.queryByText("No notifications.")).toBeNull();

  rerender(
    <NotificationsPane
      state={makeState({ notifications: [], loading: false, error: "Load failed" })}
      webBaseUrl="https://github.com"
      online
      selectedId={null}
      onSelect={vi.fn()}
    />
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Load failed");
  expect(screen.queryByText("No notifications.")).toBeNull();
});
```

- [ ] **Step 2: Write failing detail and Settings assertions**

In `ItemDetail.test.tsx`, extend the existing helper contract exactly:

```tsx
interface RenderOverrides {
  detailMaximized?: boolean;
  onToggleMaximize?: () => void;
  onHeaderVisibilityChange?: (visible: boolean) => void;
  thread?: UseItemThreadResult;
}

function renderDetail(
  item: ItemDocument | null = makeItem(),
  overrides: RenderOverrides = {}
) {
  return render(
    <ItemDetail
      item={item}
      thread={overrides.thread ?? makeThread()}
      online
      commentDraft=""
      onCommentDraftChange={noop}
      onQueueComment={noop}
      onToggleFavorite={noop}
      detailMaximized={overrides.detailMaximized ?? false}
      onToggleMaximize={overrides.onToggleMaximize ?? noop}
      onHeaderVisibilityChange={overrides.onHeaderVisibilityChange ?? noop}
    />
  );
}
```

Add:

```tsx
it("exposes empty, loading, and failed detail states semantically", () => {
  const empty = renderDetail(null);
  expect(screen.getByRole("status")).toHaveTextContent("Nothing selected");
  empty.unmount();

  const loading = renderDetail(makeItem(), {
    thread: { ...makeThread(), loading: true }
  });
  expect(screen.getByRole("status", { name: "Loading comments" }))
    .toHaveTextContent("Loading comments...");
  loading.unmount();

  renderDetail(makeItem(), {
    thread: { ...makeThread(), error: "Comments failed" }
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Comments failed");
});
```

In `NotificationDetail.test.tsx`, add `state?: UseNotificationDetailResult` to
`RenderOverrides`, pass `state={overrides.state ?? makeState()}`, and add:

```tsx
it("exposes conversation loading and failures semantically", () => {
  const loading = renderDetail(makeNotification(), {
    state: { ...makeState(), loading: true }
  });
  expect(screen.getByRole("status", { name: "Loading conversation" }))
    .toHaveTextContent("Loading conversation...");
  loading.unmount();

  renderDetail(makeNotification(), {
    state: { ...makeState(), error: "Conversation failed" }
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Conversation failed");
});
```

In the existing App Settings-save test, add:

```tsx
const settingsPage = screen.getByLabelText("Settings page");
expect(within(settingsPage).getByRole("status")).toHaveTextContent(
  "Settings saved"
);
```

In `resets all settings and caches without deleting vault documents`, add this
assertion after the completed message appears:

```tsx
expect(progress).toHaveAttribute("role", "status");
```

Create `src/components/SettingsPage.test.tsx` with one reset-only prop fixture
and a role table. The unused section props stay typed without constructing
their full state because the reset section does not read them:

```tsx
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../appSettings";
import type { ResetProgressStatus } from "../resetProgress";
import { SettingsPage } from "./SettingsPage";

type SettingsProps = ComponentProps<typeof SettingsPage>;

function renderResetProgress(status: Exclude<ResetProgressStatus, "idle">) {
  const stepStatus = status === "done" ? "done" : status;
  render(
    <SettingsPage
      section="reset"
      settings={defaultSettings}
      status=""
      resetProgress={{
        status,
        message: `${status} reset`,
        steps: [{ id: "cache", label: "Cache", status: stepStatus }]
      }}
      themeMode="system"
      lightTheme="graphite"
      darkTheme="dark"
      onThemeModeChange={vi.fn()}
      onLightThemeChange={vi.fn()}
      onDarkThemeChange={vi.fn()}
      servers={{} as SettingsProps["servers"]}
      auth={{} as SettingsProps["auth"]}
      repositoryGroups={[]}
      projectVisibility={{} as SettingsProps["projectVisibility"]}
      onUpdate={vi.fn()}
      onSave={vi.fn()}
      onResetAll={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

describe("SettingsPage reset feedback", () => {
  it.each([
    ["running", "status"],
    ["done", "status"],
    ["failed", "alert"]
  ] as const)("uses %s reset semantics", (status, role) => {
    renderResetProgress(status);
    expect(screen.getByRole(role, { name: "Reset progress" }))
      .toHaveTextContent(`${status} reset`);
  });
});
```

- [ ] **Step 3: Write failing Notes state assertions**

In the existing `renders loading, empty, and error states` test in
`NotesWorkspace.test.tsx`, capture both pane regions and require independent
live/error semantics:

```tsx
const library = screen.getByLabelText("Notes library");
const outline = screen.getByLabelText("Notes outline");
expect(within(library).getByRole("status")).toHaveTextContent("Loading notes...");
expect(within(outline).getByRole("status")).toHaveTextContent("Loading notes...");

expect(await within(library).findByRole("alert"))
  .toHaveTextContent("Load failed");
expect(within(outline).getByRole("alert")).toHaveTextContent("Load failed");
```

In the existing completed-hidden and no-pages assertions, require the matching
message element to have `role="status"`. This covers `Completed items are
hidden.`, `No outline yet.`, and `No pages yet.` without adding a new state
model.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
npm test -- src/components/ItemListPane.test.tsx src/components/NotificationsPane.test.tsx src/components/ItemDetail.test.tsx src/components/NotificationDetail.test.tsx src/components/SettingsPage.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesWorkspace.test.tsx src/App.test.tsx
```

Expected: roles, loading precedence, and `aria-busy` are absent.

- [ ] **Step 5: Implement semantic state markup without a new component**

Apply these exact rules to the existing conditional markup:

```tsx
<section className="list-pane" aria-label="Items" aria-busy={loading}>
```

```tsx
{error && (
  <p className="surface-state surface-state-error list-error" role="alert">
    {error}
  </p>
)}
{items.length === 0 && loading && !error && (
  <p className="surface-state list-empty" role="status">
    Loading items...
  </p>
)}
{items.length === 0 && !loading && !error && (
  <p className="surface-state list-empty" role="status">
    No items match this view.
  </p>
)}
```

Use the parallel copy `Loading notifications...` and `No notifications.` in
Notifications. Add `role="status"` to detail loading and empty containers, and
`role="alert"` to detail/thread failures. Give the Settings footer status span
`role="status"`, `aria-live="polite"`, and `aria-atomic="true"`.

Give the existing reset progress container a role derived from its terminal
state while keeping its polite live region:

```tsx
role={resetProgress.status === "failed" ? "alert" : "status"}
```

In `NotesLibraryPane`, add `role="status"` to the initial-loading and empty
`.notes-pane-state` messages and `role="alert"` to the library load error. In
`NotesOutlinePane`, add `role="status"` to initial loading, completed-hidden,
and empty-outline messages; keep its existing error alerts unchanged.

- [ ] **Step 6: Add the shared visual grammar**

Add to `src/styles.css`:

```css
.surface-state {
  max-width: 420px;
  margin: 16px;
  padding: 14px 16px;
  border: 1px dashed var(--control-border);
  border-radius: var(--radius);
  background: var(--bg-quiet);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}

.surface-state-error {
  border-style: solid;
  border-color: var(--status-error-border);
  background: var(--status-error-bg);
  color: var(--status-error-fg);
}
```

Do not extract a React state component in this task.

- [ ] **Step 7: Verify GREEN and commit**

Run the Step 4 command again. Expected: all focused tests pass.

Commit:

```bash
git add src/components/ItemListPane.tsx src/components/ItemListPane.test.tsx src/components/NotificationsPane.tsx src/components/NotificationsPane.test.tsx src/components/ItemDetail.tsx src/components/ItemDetail.test.tsx src/components/NotificationDetail.tsx src/components/NotificationDetail.test.tsx src/components/SettingsPage.tsx src/components/SettingsPage.test.tsx src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx src/App.test.tsx src/styles.css
git commit -m "feat(ui): unify application state feedback"
```

---

### Task 4: Shared Surfaces, Controls, Dark Counterpart, and Reduced Motion

**Files:**
- Modify: `src/styles.graphite.test.ts`
- Modify: `src/styles.css`
- Modify: `src/components/ui/form-controls.css`
- Modify: `src/components/NotificationsPane.css`
- Modify: `src/components/ItemListPane.css`
- Modify: `src/themes/base-ui-pure.css`

**Interfaces:**
- Consumes: semantic tokens from Task 2 and state classes from Task 3.
- Produces: a consistent 28/32/36/40 px control rhythm, neutral list/detail/settings surfaces, neutral notification-reason labels, optional-theme containment, and reduced-motion coverage that retains progress rotation.

- [ ] **Step 1: Extend the failing CSS contract**

Add assertions to `src/styles.graphite.test.ts`:

```ts
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
```

Keep existing ItemListPane tests that assert 104/80/148 px virtual geometry.

- [ ] **Step 2: Run CSS and focused surface tests and verify RED**

Run:

```bash
npm test -- src/styles.graphite.test.ts src/components/ItemListPane.test.tsx src/components/NotificationsPane.test.tsx src/components/SettingsFormControls.test.tsx src/components/ui/Tooltip.test.tsx
```

Expected: new layout, selection-token, and reduced-motion assertions fail.

- [ ] **Step 3: Apply the shared surface and control declarations**

Use the compact radius and control system:

```css
:root {
  --radius-sm: 4px;
  --radius: 5px;
  --radius-lg: 8px;
}

.text-button,
.primary-button,
.secondary-button,
.icon-button {
  min-height: 32px;
  border-radius: var(--radius);
}

.danger-button {
  min-height: 40px;
  border-radius: var(--radius);
}

.search-row,
.notifications-search,
.settings-section input[type="text"],
.settings-section input[type="password"] {
  min-height: 36px;
  border-color: var(--control-border);
}

.theme-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 6px;
}

.theme-option span {
  white-space: nowrap;
}
```

Restyle list rows with quiet hover and the existing leading rail. Do not change
the dimensions consumed by virtualization. Use `--control-border` for inputs,
`--focus-ring` for focus, and `--shadow-menu` or `--shadow-modal` for overlays.

Make `.notification-reason` a neutral outlined 30 px marker and neutralize the
old per-reason color overrides:

```css
.notification-reason {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--notification-reason-border);
  border-radius: var(--radius-sm);
  background: var(--notification-reason-bg);
  color: var(--notification-reason-fg);
}

.reason-mention,
.reason-comment,
.reason-author,
.reason-team {
  color: var(--notification-reason-fg);
}
```

Keep `.notification-unread-dot` blue and use:

```css
.notification-row.selected {
  background: var(--selection-bg);
  box-shadow: inset 2px 0 0 var(--selection-rail);
}
```

Preserve inline GitHub label colors and GitHub state badge semantics.

- [ ] **Step 4: Add reduced-motion behavior**

Append one global reduced-motion block after animation declarations:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }

  .avatar-skeleton,
  .comment-author-skeleton {
    animation: none !important;
  }

  .spinning {
    animation: spin 1s linear infinite !important;
  }
}
```

Keep Base UI selectors scoped to `data-theme="base-light"` and
`data-theme="base-dark"`; update only declarations that would otherwise override
the new shared control geometry or focus visibility.

- [ ] **Step 5: Verify GREEN and commit**

Run the Step 2 command again. Expected: all focused tests pass and virtualization
assertions remain unchanged.

Commit:

```bash
git add src/styles.graphite.test.ts src/styles.css src/components/ui/form-controls.css src/components/NotificationsPane.css src/components/ItemListPane.css src/themes/base-ui-pure.css
git commit -m "feat(ui): polish shared graphite surfaces"
```

---

### Task 5: Compact Notes Library and Correct Completed State

**Files:**
- Modify: `src/features/notes/NotesLibraryPane.test.tsx`
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: the existing six `libraryViews`, `actions.createRoot()`, `actions.selectLibraryView(id)`, and `showCompleted` ARIA state.
- Produces: New Page in the title row, a two-row three-column complete view grid, a header budget no greater than 144 px in the normal state, and active styling that follows `aria-pressed="true"`.

- [ ] **Step 1: Write the failing Notes library test**

Add these imports and source fixture to `NotesLibraryPane.test.tsx`:

```tsx
import { readFileSync } from "node:fs";
import { join } from "node:path";

const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);
```

Add this helper immediately after `activeWorkspace`:

```tsx
function renderLibrary(workspace = activeWorkspace()) {
  return render(
    <VaultRootContext.Provider value="/vault">
      <NotesWorkspaceContext.Provider value={workspace}>
        <NotesLibraryPane />
      </NotesWorkspaceContext.Provider>
    </VaultRootContext.Provider>
  );
}
```

Then add:

```tsx
it("keeps New page in the title row and all six views in a compact grid", () => {
  renderLibrary();

  const library = screen.getByRole("region", { name: "Notes library" });
  const header = library.querySelector(".notes-library-header");
  expect(header).not.toBeNull();
  expect(
    within(header as HTMLElement).getByRole("button", { name: "New page" })
  ).toBeVisible();

  const views = within(library).getByRole("group", {
    name: "Notes library views"
  });
  expect(
    within(views).getAllByRole("button").map((button) => button.textContent)
  ).toEqual(["All", "Starred", "Recent", "Tags", "Archive", "Trash"]);

  expect(notesStyles).toMatch(
    /\.notes-library-views\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s
  );
  expect(notesStyles).toMatch(
    /\.notes-library-header\s*\{[^}]*min-height:\s*40px;[^}]*padding-block:\s*4px;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-search-field\s*\{[^}]*min-height:\s*36px;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-library-discovery\s*\{[^}]*padding:\s*4px 10px 2px;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-library-views\s*\{[^}]*gap:\s*2px 4px;[^}]*margin-top:\s*4px;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-library-views button\s*\{[^}]*min-height:\s*28px;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-library-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s
  );
});
```

These source guards lock the normal discovery budget at 144 px: 40 px header,
4 px top padding, 36 px search, 4 px view margin, two 28 px view rows with a
2 px gap, and 2 px bottom padding.

Add this source assertion to `NotesWorkspace.test.tsx`:

```tsx
it("styles the completed filter only when aria-pressed is true", () => {
  expect(notesStyles).toMatch(
    /\.notes-completed-toggle\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--selection-bg\);[^}]*color:\s*var\(--accent\);/s
  );
  expect(notesStyles).not.toContain(
    '.notes-completed-toggle[aria-pressed="false"]'
  );
});
```

- [ ] **Step 2: Run Notes library tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: New Page is outside the header, views are vertical, and completed CSS
targets the false state.

- [ ] **Step 3: Move the existing New Page control without changing behavior**

Move the current conditional New Page button into
`.notes-library-header-actions` before the data-settings button. Keep its exact
disabled condition and `onClick={() => void actions.createRoot()}`. Remove only
the old copy from `.notes-library-discovery`.

- [ ] **Step 4: Apply compact discovery CSS and correct pressed styling**

Use:

```css
.notes-library-header {
  min-height: 40px;
  padding-block: 4px;
}

.notes-new-page {
  width: auto;
  min-height: 32px;
  margin: 0;
  padding-inline: 10px;
}

.notes-library-discovery {
  padding: 4px 10px 2px;
}

.notes-library-views {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px 4px;
  margin-top: 4px;
}

.notes-library-views button {
  min-height: 28px;
  gap: 5px;
  padding: 4px 6px;
}

.notes-completed-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.notes-completed-toggle[aria-pressed="true"] {
  background: var(--selection-bg);
  color: var(--accent);
}
```

Do not hide, rename, reorder, or move any of the six views into overflow.

- [ ] **Step 5: Verify GREEN and commit**

Run the Step 2 command again. Expected: both files pass, including all existing
Workflowy geometry assertions.

Commit:

```bash
git add src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): compact the graphite library"
```

---

### Task 6: Connected Notes Selection Range

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: `materializedSelectionIds` in visible order.
- Produces: `NotesSelectionRangePosition = "single" | "first" | "middle" | "last"` and presentation-only `data-range-position` attributes.

- [ ] **Step 1: Write failing single and three-row range tests**

Extend the existing one-row selection assertion:

```tsx
expect(document.querySelector('[data-outline-id="a"]')).toHaveAttribute(
  "data-range-position",
  "single"
);
```

Add a self-contained three-root selection test using the existing repository,
`node`, and focus helpers:

```tsx
it("marks a visible selected range as first, middle, and last", async () => {
  configureRepository([
    node({ id: "a", title: "Alpha", sortKey: 1 }),
    node({ id: "b", title: "Bravo", sortKey: 2 }),
    node({ id: "c", title: "Charlie", sortKey: 3 })
  ]);
  renderNotesWorkspace();
  const alpha = await findTitleInput("Alpha");

  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
  await waitFor(() => expect(getTitleInput("Bravo")).toHaveFocus());
  fireEvent.keyDown(getTitleInput("Bravo"), {
    key: "ArrowDown",
    shiftKey: true
  });

  await screen.findByRole("toolbar", {
    name: "Actions for 3 selected notes"
  });
  expect(
    ["a", "b", "c"].map((id) =>
      document
        .querySelector(`[data-outline-id="${id}"]`)
        ?.getAttribute("data-range-position")
    )
  ).toEqual(["first", "middle", "last"]);
});
```

- [ ] **Step 2: Run the Notes workspace test and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: `data-range-position` is missing.

- [ ] **Step 3: Derive range positions without new selection state**

Export beside `OutlineNodeRowProps`:

```ts
export type NotesSelectionRangePosition =
  | "single"
  | "first"
  | "middle"
  | "last";
```

Import that type into `NotesOutlinePane` alongside `OutlineNodeRow`:

```ts
import {
  OutlineNodeRow,
  type NotesSelectionRangePosition
} from "./OutlineNodeRow";
```

Replace the row prop `isSelected?: boolean` with:

```ts
rangePosition?: NotesSelectionRangePosition;
```

On both editable and read-only row roots use:

```tsx
data-range-selected={rangePosition ? "true" : undefined}
data-range-position={rangePosition}
```

In `NotesOutlinePane`, derive a memo beside `materializedSelectionIds`:

```ts
const selectedRangePositions = useMemo(() => {
  const positions = new Map<NoteId, NotesSelectionRangePosition>();
  const lastIndex = materializedSelectionIds.length - 1;
  materializedSelectionIds.forEach((id, index) => {
    positions.set(
      id,
      lastIndex === 0
        ? "single"
        : index === 0
          ? "first"
          : index === lastIndex
            ? "last"
            : "middle"
    );
  });
  return positions;
}, [materializedSelectionIds]);
```

Pass `rangePosition={selectedRangePositions.get(row.id)}`. Use the same lookup
instead of `selectedIdSet.has(row.id)` when deciding whether to pass the existing
selection menu bridge. Remove `selectedIdSet` only after its last use is gone.

- [ ] **Step 4: Paint the connected block without geometry changes**

Replace the current selected-row radius rule with:

```css
.notes-node[data-range-selected="true"] > .notes-node-main {
  background: var(--selection-bg);
  border-radius: 0;
  box-shadow: inset 2px 0 0 var(--selection-rail);
}

.notes-node[data-range-position="single"] > .notes-node-main {
  border-radius: 6px;
}

.notes-node[data-range-position="first"] > .notes-node-main {
  border-radius: 6px 6px 0 0;
}

.notes-node[data-range-position="last"] > .notes-node-main {
  border-radius: 0 0 6px 6px;
}
```

Do not add border, padding, margin, height, translate, or line-height changes.

- [ ] **Step 5: Verify GREEN, row memoization, and commit**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: new position tests and existing sibling-row memo, caret, drag, and
geometry tests pass.

Commit:

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/notes.css
git commit -m "feat(notes): connect selected outline ranges"
```

---

### Task 7: Pane-Width Selection Toolbar and Full Feedback

**Files:**
- Modify: `src/features/notes/NotesSelectionActionBar.test.tsx`
- Modify: `src/features/notes/NotesSelectionActionBar.tsx`
- Modify: `src/features/notes/notesSelectionActions.test.ts`
- Modify: `src/features/notes/notesSelectionActions.ts`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: the existing `NotesSelectionActionBarProps`, forwarded toolbar ref, command availability, selection status, and selection error.
- Produces: a local `ResizeObserver` compact decision at 720 px, a sticky action region containing a toolbar plus full-width polite feedback, and explicit user-facing indent blocker copy.

- [ ] **Step 1: Replace viewport compact tests with a failing element-width test**

Add this helper to `NotesSelectionActionBar.test.tsx`:

```tsx
function mockToolbarWidth(width: number): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }

      disconnect() {}
      unobserve() {}
    }
  );
}
```

Replace the compact-mode assertion with:

```tsx
it("moves structural actions into More from toolbar width, not viewport width", async () => {
  mockCompactViewport(false);
  mockToolbarWidth(640);
  renderBar();

  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Move up" })
    ).not.toBeInTheDocument()
  );
  await userEvent.setup().click(
    screen.getByRole("button", { name: "More actions" })
  );
  expect(
    within(await screen.findByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
  ).toEqual([
    "Move up",
    "Move down",
    "Indent",
    "Outdent",
    "Duplicate",
    "Copy",
    "Cut"
  ]);
});
```

- [ ] **Step 2: Write the failing feedback structure and copy tests**

Add:

```tsx
it("places complete feedback below the toolbar without truncation", () => {
  const message =
    "The first selected item cannot be indented because it has no visible unselected sibling above it.";
  renderBar({ error: message });

  const toolbar = screen.getByRole("toolbar");
  const feedback = screen.getByRole("status");
  expect(toolbar.parentElement).toContainElement(feedback);
  expect(toolbar).not.toContainElement(feedback);
  expect(feedback).toHaveTextContent(message);
  expect(feedback.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});
```

Update the three existing indent-eligibility expectations in
`notesSelectionActions.test.ts` to the exact message above.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesSelectionActionBar.test.tsx src/features/notes/notesSelectionActions.test.ts
```

Expected: compactness still follows `matchMedia`, feedback is inside the toolbar,
and eligibility returns the old technical sentence.

- [ ] **Step 4: Replace viewport observation with toolbar observation**

Add `type RefObject` to the existing React import. Move `toolbarRef` before the
compact hook and use:

```ts
const COMPACT_ACTIONS_WIDTH = 720;

function useCompactActions(
  toolbarRef: RefObject<HTMLDivElement | null>
): boolean {
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return;
    }
    const publish = (width: number) => {
      if (width > 0) {
        setCompact(width <= COMPACT_ACTIONS_WIDTH);
      }
    };
    publish(toolbar.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      publish(entry.contentRect.width);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [toolbarRef]);

  return compact;
}
```

Delete `COMPACT_ACTIONS_QUERY`, the `matchMedia` effect, and the viewport-owned
compact state. Preserve every existing action, More menu, disabled reason,
roving-focus key, F6, Escape, busy guard, and forwarded toolbar ref.

- [ ] **Step 5: Separate the action row and feedback row**

Add `AlertCircle` and `CheckCircle2` to the existing Lucide imports. Wrap the
current toolbar and its status sibling in:

```tsx
<div className="notes-selection-action-region">
```

Move `.notes-selection-count` to the first child of the toolbar, then place the
unchanged Clear button immediately after it. Keep Delete as the last toolbar
action. Move the status span outside the toolbar but inside the region and use:

```tsx
<span
  className="notes-selection-action-status"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  data-kind={error ? "error" : status ? "status" : undefined}
>
  {error ? (
    <AlertCircle size={15} aria-hidden="true" />
  ) : status ? (
    <CheckCircle2 size={15} aria-hidden="true" />
  ) : null}
  <span>{error ?? status ?? ""}</span>
</span>
```

Keep the toolbar root as the forwarded-ref target.

- [ ] **Step 6: Apply non-truncating pane-owned CSS**

Use:

```css
.notes-selection-action-region {
  position: sticky;
  top: 0;
  z-index: 3;
  container-name: notes-selection-toolbar;
  container-type: inline-size;
  border-bottom: 1px solid var(--border);
  background: var(--bg-detail);
}

.notes-selection-action-bar {
  position: static;
  min-height: 48px;
  border: 0;
}

.notes-selection-count {
  margin-inline-end: 4px;
  padding-inline-end: 8px;
  border-inline-end: 1px solid var(--border);
}

.notes-selection-action-status {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  max-width: none;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 12px 8px;
  overflow: visible;
  white-space: normal;
  overflow-wrap: anywhere;
}

.notes-selection-action-status:not([data-kind]) {
  display: none;
}

.notes-selection-action-status[data-kind="status"] {
  border-top: 1px solid var(--status-success-border);
  background: var(--status-success-bg);
  color: var(--status-success-fg);
}

.notes-selection-action-status[data-kind="error"] {
  border-top: 1px solid var(--status-error-border);
  background: var(--status-error-bg);
  color: var(--status-error-fg);
}
```

Move the existing 480 px label-hiding rule into
`@container notes-selection-toolbar (max-width: 480px)` and delete every status
`max-width`, ellipsis, nowrap, and viewport-width override.

- [ ] **Step 7: Replace the technical indent reason**

In `indentEligibility`, return exactly:

```ts
"The first selected item cannot be indented because it has no visible unselected sibling above it."
```

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
npm test -- src/features/notes/NotesSelectionActionBar.test.tsx src/features/notes/notesSelectionActions.test.ts src/features/notes/NotesWorkspace.test.tsx
```

Expected: all selection behavior, focus, More menu, copy, and full feedback tests
pass.

Commit:

```bash
git add src/features/notes/NotesSelectionActionBar.tsx src/features/notes/NotesSelectionActionBar.test.tsx src/features/notes/notesSelectionActions.ts src/features/notes/notesSelectionActions.test.ts src/features/notes/notes.css
git commit -m "feat(notes): refine selection toolbar feedback"
```

---

### Task 8: Pane Keyboard Coverage, Full Verification, and Visual QA

**Files:**
- Modify: `src/App.test.tsx`
- Modify: `docs/superpowers/plans/2026-07-16-graphite-mist-whole-app-redesign.md` only to check completed boxes during execution.

**Interfaces:**
- Consumes: the integrated Graphite theme and existing `usePaneResize` separator ARIA contract.
- Produces: regression coverage for keyboard resizing and recorded automated plus visual verification.

- [ ] **Step 1: Write a separate keyboard resize characterization test**

Do not extend the existing pointer-resize test because it leaves the sidebar at
340 px. Add a fresh test in `src/App.test.tsx` so defaults, steps, clamps, ARIA,
and persistence are deterministic:

```tsx
it("resizes and clamps both panes from the keyboard", async () => {
  render(<App />);

  const layout = screen.getByLabelText("Yonalist layout");
  const navigationResizer = screen.getByRole("separator", {
    name: "Resize navigation pane"
  });
  const listResizer = screen.getByRole("separator", {
    name: "Resize item list pane"
  });

  fireEvent.keyDown(navigationResizer, { key: "ArrowRight" });
  expect(layout).toHaveStyle("--sidebar-width: 256px");
  expect(navigationResizer).toHaveAttribute("aria-valuenow", "256");

  fireEvent.keyDown(navigationResizer, {
    key: "ArrowLeft",
    shiftKey: true
  });
  expect(layout).toHaveStyle("--sidebar-width: 220px");
  expect(navigationResizer).toHaveAttribute("aria-valuemin", "220");
  expect(navigationResizer).toHaveAttribute("aria-valuemax", "420");

  for (let index = 0; index < 10; index += 1) {
    fireEvent.keyDown(navigationResizer, {
      key: "ArrowRight",
      shiftKey: true
    });
  }
  expect(layout).toHaveStyle("--sidebar-width: 420px");
  expect(navigationResizer).toHaveAttribute("aria-valuenow", "420");

  fireEvent.keyDown(listResizer, { key: "ArrowRight" });
  expect(layout).toHaveStyle("--list-width: 356px");
  expect(listResizer).toHaveAttribute("aria-valuenow", "356");

  fireEvent.keyDown(listResizer, {
    key: "ArrowLeft",
    shiftKey: true
  });
  expect(layout).toHaveStyle("--list-width: 320px");
  expect(listResizer).toHaveAttribute("aria-valuemin", "320");
  expect(listResizer).toHaveAttribute("aria-valuemax", "640");

  for (let index = 0; index < 10; index += 1) {
    fireEvent.keyDown(listResizer, { key: "ArrowRight", shiftKey: true });
  }
  expect(layout).toHaveStyle("--list-width: 640px");
  expect(listResizer).toHaveAttribute("aria-valuenow", "640");

  await waitFor(() => {
    expect(
      JSON.parse(window.localStorage.getItem("yonalist.paneWidths.v1")!)
    ).toEqual({ sidebar: 420, list: 640 });
  });
});
```

The current contract is sidebar default 240 px and clamp 220–420 px, list
default 340 px and clamp 320–640 px, with a 16 px normal step and 48 px Shift
step. Use the same `yonalist.paneWidths.v1` JSON object for list separator
persistence assertions. If current behavior already passes, retain the test as
characterization coverage and do not change production resize logic.

- [ ] **Step 2: Run the complete automated gate**

Run in this order:

```bash
npm run lint
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: lint and build exit 0; 146 or more frontend files pass with the known
baseline skips; Rust tests pass; diff check prints nothing. Existing baseline
React `act` and nested-form warnings may remain, but no new warning category may
be introduced.

- [ ] **Step 3: Run the app for visual verification**

Run:

```bash
npm run dev -- --port 4173
```

Inspect the running application, using real controls rather than static HTML, at
1280, 981, 980, 721, 720, and 320 px. Also inspect 200 percent zoom and reduced
motion. The native Tauri minimum width is 900 px, so narrower checks use the web
viewport.

- [ ] **Step 4: Verify the required visual state matrix**

Confirm all of the following before completion:

- Graphite Notes with no selection, connected three-row selection, and the full
  indent failure sentence.
- Graphite All, Starred, Recent, Tags, Archive, and Trash controls remain visible.
- At a 720 px viewport height, the 144 px Notes discovery area leaves the page
  list independently scrollable; the final page and scrollbar remain reachable.
- Notifications unread, selected, loading, empty, and error states.
- GitHub Inbox list, selected row, label colors, issue detail, comments, and
  create form.
- Settings category list, Graphite option, theme controls on one line, save
  status, reset state, dialogs, and destructive control height.
- Default dark Notes and Settings.
- Sidebar/list collapsed, detail maximized, and both pane separators resized.
- Visible keyboard focus, no horizontal overflow, no titlebar collision, and no
  clipped menu or dialog at every required width.
- Reduced motion disables shimmer and non-essential transitions while progress
  spinners still rotate.

- [ ] **Step 5: Fix every visual defect through a new RED/GREEN cycle**

For each defect, first add the smallest focused DOM or CSS-source assertion that
fails for the observed condition, run it to verify RED, apply the minimal style
or markup fix, and rerun the focused test before repeating the complete gate.
Do not make untested production corrections during this step.

- [ ] **Step 6: Commit the final verification coverage and any tested polish**

```bash
git add src/App.test.tsx src
git commit -m "test(ui): verify graphite redesign integration"
```

If `git status --short` shows no source changes after the verification pass, do
not create an empty commit.
