# Notes Feature Host Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static first-party feature host, register Notes in the left navigation, and preserve existing Inbox and Settings behavior behind feature adapters.

**Architecture:** The current `App.tsx` remains the controller for existing Inbox state during this phase. A static registry supplies feature metadata, authentication requirements, a provider, and a pane renderer; Inbox and Settings delegate to legacy pane render functions while Notes owns a minimal, non-authenticated workspace shell.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Base UI, Lucide, existing Tauri application shell.

## Global Constraints

- Preserve all existing Inbox filters, repository selection, notifications, Settings, vault, and outbox behavior.
- Keep the feature registry compile-time only; do not load code or manifests dynamically.
- Use `FeatureId = "inbox" | "notes" | "settings"` everywhere.
- Persist feature selection in `yonalist.activeFeature.v1`, falling back to Inbox for missing or invalid values.
- Notes must be reachable from the login screen and must not wait for GitHub authentication.
- Inbox and Settings retain their current auth requirements.
- Do not add SQLite, Notes data, or drag-and-drop in this phase.

---

## Target File Structure

| File | Responsibility |
| --- | --- |
| `src/features/core/featureTypes.ts` | Shared feature and pane contracts |
| `src/features/core/featureSelection.ts` | Safe local persistence of active feature |
| `src/features/core/featureRegistry.tsx` | Static ordered registry and lookup helpers |
| `src/features/core/featureSelection.test.ts` | Persistence/fallback behavior |
| `src/features/core/featureRegistry.test.tsx` | Registry order and descriptor behavior |
| `src/features/inbox/InboxFeature.tsx` | Adapter that renders existing Inbox panes |
| `src/features/settings/SettingsFeature.tsx` | Adapter that renders existing Settings panes |
| `src/features/notes/NotesFeature.tsx` | Notes shell used before persistence and editor phases |
| `src/components/Sidebar.tsx` | Registry-driven feature navigation |
| `src/components/LoginPage.tsx` | Notes route from the unauthenticated entry point |
| `src/App.tsx` | Active-feature state, auth boundary, and legacy pane closures |

## Stable Interfaces

```ts
// src/features/core/featureTypes.ts
import type { ComponentType, PropsWithChildren, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type FeatureId = "inbox" | "notes" | "settings";
export type FeatureNavigationSection = "workspace" | "app";

export interface FeaturePanes {
  middle: ReactNode;
  detail: ReactNode;
}

export interface FeatureRenderContext {
  renderInboxPanes: () => FeaturePanes;
  renderSettingsPanes: () => FeaturePanes;
}

export interface FeatureDefinition {
  id: FeatureId;
  label: string;
  icon: LucideIcon;
  section: FeatureNavigationSection;
  order: number;
  requiresGithubAuth: boolean;
  Provider: ComponentType<PropsWithChildren>;
  renderPanes: (context: FeatureRenderContext) => FeaturePanes;
}
```

```ts
// src/features/core/featureSelection.ts
export const activeFeatureStorageKey = "yonalist.activeFeature.v1";

export function loadActiveFeature(): FeatureId;
export function persistActiveFeature(featureId: FeatureId): void;
export function isFeatureId(value: unknown): value is FeatureId;
```

### Task 1: Build the Static Feature Contracts and Registry

**Files:**
- Create: `src/features/core/featureTypes.ts`
- Create: `src/features/core/featureSelection.ts`
- Create: `src/features/core/featureSelection.test.ts`
- Create: `src/features/core/featureRegistry.tsx`
- Create: `src/features/core/featureRegistry.test.tsx`
- Create: `src/features/inbox/InboxFeature.tsx`
- Create: `src/features/settings/SettingsFeature.tsx`
- Create: `src/features/notes/NotesFeature.tsx`

**Interfaces:**
- Consumes: no feature-private code; only React, Lucide, and the types above.
- Produces: `featureRegistry`, `getFeatureDefinition`, `loadActiveFeature`, and `persistActiveFeature` for the App shell and Sidebar.

- [ ] **Step 1: Write failing feature-selection and registry tests**

```ts
it("falls back to Inbox when the saved feature is invalid", () => {
  window.localStorage.setItem(activeFeatureStorageKey, "remote-plugin");
  expect(loadActiveFeature()).toBe("inbox");
});

it("registers Notes as an offline workspace feature", () => {
  const notes = getFeatureDefinition("notes");
  expect(notes.requiresGithubAuth).toBe(false);
  expect(notes.section).toBe("workspace");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/core/featureSelection.test.ts src/features/core/featureRegistry.test.tsx`

Expected: FAIL because the feature modules do not exist.

- [ ] **Step 3: Implement the contracts, persistence, and three descriptors**

```tsx
export const inboxFeature: FeatureDefinition = {
  id: "inbox",
  label: "Inbox",
  icon: Inbox,
  section: "workspace",
  order: 10,
  requiresGithubAuth: true,
  Provider: PassthroughFeatureProvider,
  renderPanes: ({ renderInboxPanes }) => renderInboxPanes()
};

export const notesFeature: FeatureDefinition = {
  id: "notes",
  label: "Notes",
  icon: NotebookPen,
  section: "workspace",
  order: 20,
  requiresGithubAuth: false,
  Provider: PassthroughFeatureProvider,
  renderPanes: () => ({
    middle: <NotesLibraryPlaceholder />,
    detail: <NotesOutlinePlaceholder />
  })
};
```

`NotesLibraryPlaceholder` and `NotesOutlinePlaceholder` render only the
structural pane headings and an empty state. They must not import GitHub hooks,
`vaultStore`, or Tauri commands.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npm test -- src/features/core/featureSelection.test.ts src/features/core/featureRegistry.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add src/features/core src/features/inbox/InboxFeature.tsx src/features/settings/SettingsFeature.tsx src/features/notes/NotesFeature.tsx
git commit -m "refactor: introduce static feature registry"
```

### Task 2: Make Sidebar and Login Navigation Feature-Aware

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/Sidebar.test.tsx`
- Modify: `src/components/LoginPage.tsx`
- Create: `src/components/LoginPage.test.tsx`

**Interfaces:**
- Consumes: `FeatureDefinition`, `FeatureId`, and `featureRegistry` from Task 1.
- Produces: `SidebarProps.activeFeatureId`, `SidebarProps.featureEntries`, and `SidebarProps.onFeatureChange`; `LoginPageProps.onOpenNotes`.

- [ ] **Step 1: Write failing navigation tests**

```tsx
it("renders Notes in the Workspace section and activates it", async () => {
  const onFeatureChange = vi.fn();
  renderSidebar({ activeFeatureId: "notes", onFeatureChange });
  const notes = screen.getByRole("button", { name: "Notes" });
  expect(notes).toHaveAttribute("aria-pressed", "true");
  await userEvent.setup().click(notes);
  expect(onFeatureChange).toHaveBeenCalledWith("notes");
});

it("offers Notes before GitHub authentication", async () => {
  render(<LoginPage {...loginProps} onOpenNotes={onOpenNotes} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Notes" }));
  expect(onOpenNotes).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/components/Sidebar.test.tsx src/components/LoginPage.test.tsx`

Expected: FAIL because the new props and buttons are absent.

- [ ] **Step 3: Implement registry-driven navigation**

```tsx
<section className="nav-section">
  <h2>Workspace</h2>
  {featureEntries
    .filter((entry) => entry.section === "workspace" && entry.id === "notes")
    .map(({ id, label, icon: Icon }) => (
      <button
        key={id}
        className={activeFeatureId === id ? "nav-item active" : "nav-item"}
        type="button"
        aria-pressed={activeFeatureId === id}
        onClick={() => onFeatureChange(id)}
      >
        <Icon size={16} />
        <span>{label}</span>
      </button>
    ))}
</section>
```

Keep existing Inbox filter buttons, notification entry, repository tree, and
their counts intact. Their App callbacks set the active feature back to
`"inbox"` before applying their existing behavior. Add a compact `Notes`
button to `LoginPage` that calls `onOpenNotes` without setting skip-login.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npm test -- src/components/Sidebar.test.tsx src/components/LoginPage.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the navigation layer**

```bash
git add src/components/Sidebar.tsx src/components/Sidebar.test.tsx src/components/LoginPage.tsx src/components/LoginPage.test.tsx
git commit -m "feat: expose notes as a workspace feature"
```

### Task 3: Route the App Shell Through the Registry Without Resetting Inbox State

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/features/core/featureRegistry.tsx`

**Interfaces:**
- Consumes: `loadActiveFeature`, `persistActiveFeature`, `getFeatureDefinition`, and `FeaturePanes` from Task 1.
- Produces: a selected-feature app shell that keeps existing Inbox controller state mounted while Notes is visible.

- [ ] **Step 1: Add failing App integration tests**

```tsx
it("opens Notes without a GitHub session and keeps Inbox filter state on return", async () => {
  window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "Notes" }));
  expect(screen.getByLabelText("Notes library")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /^All items/ }));
  expect(screen.getByLabelText("GitHub login")).toBeInTheDocument();
});

it("persists a selected Notes feature", async () => {
  render(<App />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Notes" }));
  expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("notes");
});
```

- [ ] **Step 2: Run App tests to verify they fail**

Run: `npm test -- src/App.test.tsx`

Expected: FAIL because the auth gate currently blocks Notes and no active feature is persisted.

- [ ] **Step 3: Replace top-level boolean navigation with active feature selection**

```tsx
const [activeFeatureId, setActiveFeatureId] = useState<FeatureId>(loadActiveFeature);
const activeFeature = getFeatureDefinition(activeFeatureId);
const showSettings = activeFeatureId === "settings";

useEffect(() => {
  persistActiveFeature(activeFeatureId);
}, [activeFeatureId]);

if (activeFeature.requiresGithubAuth && authGate.state === "checking") {
  return <AuthRestorePage />;
}

if (activeFeature.requiresGithubAuth && authGate.state === "required" && !showingResetResult) {
  return <LoginPage {...loginProps} onOpenNotes={() => setActiveFeatureId("notes")} />;
}
```

Extract the current middle/detail conditional JSX into `renderInboxPanes()`
and `renderSettingsPanes()`. Resolve `const panes =
activeFeature.renderPanes({ renderInboxPanes, renderSettingsPanes })`, then
render its middle and detail nodes inside the unchanged pane grid. The current
Inbox state hooks remain in `App.tsx`, so selecting Notes never clears their
values.

- [ ] **Step 4: Run App and Sidebar regression tests**

Run: `npm test -- src/App.test.tsx src/components/Sidebar.test.tsx`

Expected: PASS, including existing notification, repository, Settings, and
login assertions.

- [ ] **Step 5: Commit the shell migration**

```bash
git add src/App.tsx src/App.test.tsx src/features/core/featureRegistry.tsx
git commit -m "refactor: route app shell through feature registry"
```

### Task 4: Verify the Feature Host Against Existing Application Boundaries

**Files:**
- Modify: `README.md`
- Create: `src/features/notes/NotesFeature.test.tsx`

**Interfaces:**
- Consumes: all completed feature-host contracts.
- Produces: documented behavior and a full regression baseline for Phase 2.

- [ ] **Step 1: Add a Notes shell isolation regression test**

```tsx
it("renders the Notes shell without a GitHub feature provider", () => {
  render(
    <NotesFeatureProvider>
      <NotesLibraryPlaceholder />
      <NotesOutlinePlaceholder />
    </NotesFeatureProvider>
  );
  expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
  expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the new regression test to verify the current guard**

Run: `npm test -- src/features/notes/NotesFeature.test.tsx`

Expected: PASS after the Phase 1 shell is complete.

- [ ] **Step 3: Document the static feature model**

Add one README bullet stating that Notes is an offline local workspace backed
by a separate database and registered as a built-in feature. Do not change the
existing GitHub Inbox description.

- [ ] **Step 4: Run complete frontend and native verification**

Run: `npm test && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all commands exit with status 0.

- [ ] **Step 5: Commit the verified foundation**

```bash
git add README.md src/features/notes/NotesFeature.test.tsx
git commit -m "test: lock feature host inbox isolation"
```
