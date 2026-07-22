# Flat Sidebar and Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the bottom status bar background and flatten the left navigation pane without changing other panes.

**Architecture:** Keep the change CSS-only and scoped to `.app-statusbar` and `.sidebar`. Add a small source-level style contract test so later theme or layout changes cannot silently restore the removed chrome.

**Tech Stack:** CSS, Vitest, Node.js file APIs

## Global Constraints

- Preserve the status bar top divider, spacing, text, and actions.
- Remove only the sidebar background, border, and box shadow.
- Do not change list, notification, detail, or settings content pane styling.

---

### Task 1: Flatten Application Chrome

**Files:**
- Create: `src/styles.test.ts`
- Modify: `src/styles.css:631-683,897-910`

**Interfaces:**
- Consumes: existing `.sidebar` and `.app-statusbar` CSS selectors
- Produces: transparent status bar and unframed transparent sidebar

- [ ] **Step 1: Write the failing style contract test**

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/styles.test.ts`

Expected: both tests fail because the current rules use `var(--bg-app)`, `var(--bg-sidebar)`, and the shared pane frame.

- [ ] **Step 3: Apply the minimal CSS change**

In the existing `.sidebar` rule add:

```css
border: 0;
box-shadow: none;
background: transparent;
```

In `.app-statusbar`, replace the background declaration with:

```css
background: transparent;
```

- [ ] **Step 4: Verify the focused and frontend gates**

Run:

```bash
npx vitest run src/styles.test.ts src/App.test.tsx
npx eslint src/styles.test.ts
npm run build
git diff --check
```

Expected: all tests and checks pass.

- [ ] **Step 5: Verify the desktop appearance and commit**

Reload the running Tauri app and confirm the status bar is transparent while retaining its top divider, and the sidebar has no fill, border, or shadow. Then commit:

```bash
git add src/styles.css src/styles.test.ts
git commit -m "style(ui): flatten sidebar and status bar"
```
