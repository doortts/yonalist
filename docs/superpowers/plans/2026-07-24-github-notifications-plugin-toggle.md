# GitHub Notifications Plugin Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a saved Settings toggle that hides and stops the Notes GitHub Notifications plugin while preserving the existing GitHub Inbox.

**Architecture:** Add one boolean to the existing `AppSettings` schema and expose it through the existing Plugins settings form. `App` remains the runtime authority: it removes the GitHub page from `ExternalSourcesContext.pages` and blocks Notes-only refresh, completion, projection, and polling paths when disabled, while the existing Inbox activation path remains unchanged. Notes treats absence from `pages` as disabled, hides the stored plugin subtree without deleting it, and exits a currently open plugin page.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, existing `AppSettings`, `ExternalSourcesContext`, and Notes workspace APIs.

## Global Constraints

- Existing users and fresh installs default `githubNotificationsPluginEnabled` to `true`.
- The setting takes effect in the current session immediately and persists only through the existing `Save settings` action.
- Disabling affects only the Notes GitHub Notifications plugin; GitHub Inbox must continue to fetch and display notifications.
- Do not sign the user out, delete stored Notes nodes, delete external-source snapshots, change the Rust storage schema, or add a generic plugin registry.
- Disable the read-retention input while the plugin is disabled.
- If the GitHub Notifications page is open when disabled, clear Notes selection and return to All notes.
- Re-enabling must reveal the existing stored root and allow Notes fetching to resume.
- Add no dependencies and no new CSS unless an existing control fails visually.
- Preserve the pre-existing user changes in `docs/superpowers/plans/2026-07-24-notes-outliner-latency-remediation.md` and `src/features/notes/notesSplitLatencyProbe.ts`; never stage them in this work.

---

## File Map

- `src/appSettings.ts`: owns the boolean setting, its default, legacy normalization, persistence, and schema-normalization check.
- `src/appSettings.test.ts`: proves default, legacy, explicit false, persistence, and schema-normalization behavior.
- `src/components/SettingsPage.tsx`: renders the existing checkbox control and disables the retention input.
- `src/components/SettingsPage.test.tsx`: proves the Plugins UI emits the boolean update and reflects disabled state.
- `src/App.tsx`: gates only the Notes projection/source boundary and keeps the Inbox activation branch intact.
- `src/App.test.tsx`: proves the Notes boundary is absent and inactive while Inbox still activates; also covers live disable while the plugin page is open.
- `src/features/notes/NotesLibraryPane.tsx`: hides the stored GitHub root when the GitHub page is absent.
- `src/features/notes/NotesLibraryPane.test.tsx`: proves a stored root is hidden without changing workspace data and the local empty state is correct.
- `src/features/notes/NotesOutlinePane.tsx`: hides the stored GitHub subtree and exits an open GitHub root when the page disappears.
- `src/features/notes/NotesWorkspace.test.tsx`: proves the disabled subtree is not projected into All notes.

No new production files are needed.

### Task 1: Setting Schema and Plugins UI

**Files:**
- Modify: `src/appSettings.ts:3-105`
- Test: `src/appSettings.test.ts`
- Modify: `src/components/SettingsPage.tsx:490-525`
- Test: `src/components/SettingsPage.test.tsx:222-280`

**Interfaces:**
- Consumes: existing `AppSettings`, `defaultSettings`, `normalizeSettings`, `settingsNeedNormalization`, `SettingsCheck`, and generic `onUpdate<K extends keyof AppSettings>`.
- Produces: `AppSettings.githubNotificationsPluginEnabled: boolean`, defaulting to `true`.

- [ ] **Step 1: Add failing schema tests**

Add these tests to `src/appSettings.test.ts`:

```ts
  it("defaults and normalizes the GitHub Notifications plugin toggle", () => {
    const legacySettings = { ...defaultSettings };
    Reflect.deleteProperty(
      legacySettings,
      "githubNotificationsPluginEnabled"
    );

    expect(defaultSettings.githubNotificationsPluginEnabled).toBe(true);
    expect(normalizeSettings(legacySettings).githubNotificationsPluginEnabled)
      .toBe(true);
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify(legacySettings)
    );
    expect(loadSettings().githubNotificationsPluginEnabled).toBe(true);
    expect(
      normalizeSettings({ githubNotificationsPluginEnabled: false })
        .githubNotificationsPluginEnabled
    ).toBe(false);
    expect(settingsNeedNormalization(legacySettings)).toBe(true);
    expect(settingsNeedNormalization({ ...defaultSettings })).toBe(false);
  });

  it("persists and reloads a disabled GitHub Notifications plugin", () => {
    persistSettings({
      ...defaultSettings,
      githubNotificationsPluginEnabled: false
    });

    expect(loadSettings().githubNotificationsPluginEnabled).toBe(false);
    expect(window.localStorage.getItem("yonalist.settings.v1")).toContain(
      '"githubNotificationsPluginEnabled":false'
    );
  });
```

- [ ] **Step 2: Run the schema tests and confirm the new contract fails**

Run:

```bash
npm test -- src/appSettings.test.ts
```

Expected: FAIL because `githubNotificationsPluginEnabled` is not part of `AppSettings` or `defaultSettings`.

- [ ] **Step 3: Add the boolean to the existing settings schema**

In `src/appSettings.ts`, add the field beside the existing GitHub retention field:

```ts
export interface AppSettings {
  vaultFolder: string;
  syncQueuedOnReconnect: boolean;
  cacheLinkedAttachments: boolean;
  downloadCommentsWhileSyncing: boolean;
  prefetchVisibleItems: boolean;
  desktopNotifications: boolean;
  markdownStyle: MarkdownStyle;
  githubNotificationsPluginEnabled: boolean;
  githubNotificationsReadRetentionDays: number;
  assetTrashRetentionDays: number;
  assetTrashLargeFileDays: number;
  assetLargeFileThresholdMb: number;
}
```

Add the default:

```ts
  markdownStyle: "github",
  githubNotificationsPluginEnabled: true,
  githubNotificationsReadRetentionDays: 30,
```

Normalize a missing legacy value to the default:

```ts
    githubNotificationsPluginEnabled:
      settings.githubNotificationsPluginEnabled ??
      defaultSettings.githubNotificationsPluginEnabled,
    githubNotificationsReadRetentionDays:
```

Make the schema check require the field:

```ts
    settings.markdownStyle !== normalizeSettings(settings).markdownStyle ||
    settings.githubNotificationsPluginEnabled === undefined ||
    settings.githubNotificationsReadRetentionDays !==
```

- [ ] **Step 4: Run the schema tests**

Run:

```bash
npm test -- src/appSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add a failing Plugins UI test**

Add this test to the `SettingsPage Plugins` block in `src/components/SettingsPage.test.tsx`:

```tsx
  it("toggles GitHub Notifications and disables its retention input", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const props = settingsPageProps();
    const { rerender } = render(
      <SettingsPage
        {...props}
        section="plugins"
        onUpdate={onUpdate}
      />
    );

    const toggle = screen.getByRole("checkbox", {
      name: "GitHub Notifications 사용"
    });
    const retention = screen.getByRole("spinbutton", {
      name: "읽은 알림 표시 기간"
    });
    expect(toggle).toBeChecked();
    expect(retention).toBeEnabled();

    await user.click(toggle);
    expect(onUpdate).toHaveBeenCalledWith(
      "githubNotificationsPluginEnabled",
      false
    );

    rerender(
      <SettingsPage
        {...props}
        section="plugins"
        settings={{
          ...defaultSettings,
          githubNotificationsPluginEnabled: false
        }}
        onUpdate={onUpdate}
      />
    );
    expect(screen.getByRole("checkbox", {
      name: "GitHub Notifications 사용"
    })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", {
      name: "읽은 알림 표시 기간"
    })).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", {
        name: "GitHub Notifications 사용"
      })
    );
    expect(onUpdate).toHaveBeenLastCalledWith(
      "githubNotificationsPluginEnabled",
      true
    );
  });
```

- [ ] **Step 6: Run the Plugins UI test and confirm it fails**

Run:

```bash
npm test -- src/components/SettingsPage.test.tsx
```

Expected: FAIL because the checkbox does not exist.

- [ ] **Step 7: Render the existing checkbox and disable the retention field**

In the Plugins section of `src/components/SettingsPage.tsx`, place this immediately after the section title:

```tsx
            <SettingsCheck
              label="GitHub Notifications 사용"
              checked={settings.githubNotificationsPluginEnabled}
              onCheckedChange={(checked) =>
                onUpdate("githubNotificationsPluginEnabled", checked)
              }
            >
              GitHub Notifications 사용
            </SettingsCheck>
```

Add the native disabled state to the existing retention input:

```tsx
                  required
                  disabled={!settings.githubNotificationsPluginEnabled}
                  value={githubRetentionDraft}
```

Do not add a new checkbox component or stylesheet; reuse `SettingsCheck` and the browser's disabled input behavior.

- [ ] **Step 8: Run the focused schema and UI tests**

Run:

```bash
npm test -- src/appSettings.test.ts src/components/SettingsPage.test.tsx
```

Expected: both test files PASS.

- [ ] **Step 9: Commit the settings slice**

```bash
git add src/appSettings.ts src/appSettings.test.ts src/components/SettingsPage.tsx src/components/SettingsPage.test.tsx
git commit -m "feat(settings): add GitHub notifications plugin toggle"
```

### Task 2: App Runtime Gate Without Inbox Regression

**Files:**
- Modify: `src/App.tsx:420-700`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `settings.githubNotificationsPluginEnabled`, `githubProjectionRequested`, `inboxActive`, `ExternalSourcesBoundary`, and `rejectUnavailableExternalSource`.
- Produces: a Notes boundary with `pages: []` while disabled; Notes refresh and completion reject while disabled; the existing `notificationSourceActive = auth passed AND (Inbox active OR gated Notes projection active)` remains the shared source lifecycle.

- [ ] **Step 1: Add a failing runtime-isolation test**

Add this test to `Yonalist app shell` in `src/App.test.tsx`:

```tsx
  it("disables the Notes notification source while keeping Inbox active", async () => {
    const apiBaseUrl = "https://oss.navercorp.com/api/v3";
    window.localStorage.removeItem("yonalist.auth.skipLogin.v1");
    window.localStorage.setItem(activeFeatureStorageKey, "notes");
    window.localStorage.setItem(
      "yonalist.github.personalTokens.v1",
      JSON.stringify({ [apiBaseUrl]: "ghp_test" })
    );
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ githubNotificationsPluginEnabled: false })
    );
    let notificationGets = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 7, login: "doortts" }), {
          status: 200
        });
      }
      if (target.includes("/notifications")) {
        notificationGets += 1;
        return new Response("[]", { status: 200 });
      }
      if (target.includes("/search/issues")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (target.includes("/api/graphql")) {
        return new Response(
          JSON.stringify({ data: { search: { nodes: [] } } }),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const originalRenderPanes = notesFeatureRuntime.renderPanes;
    notesFeatureRuntime.renderPanes = () => ({
      middle: (
        <>
          <ExternalSourcesProbe />
          <ExternalRefreshProbe />
        </>
      ),
      detail: <div aria-label="External Notes detail" />
    });
    let rendered: ReturnType<typeof render> | null = null;

    try {
      const user = userEvent.setup();
      rendered = render(<App initialOnline />);
      const probe = await screen.findByLabelText("External source probe");

      expect(within(probe).getByText("missing")).toBeInTheDocument();
      await user.click(
        within(probe).getByRole("button", {
          name: "Toggle GitHub projection"
        })
      );
      await act(async () => Promise.resolve());
      expect(notificationGets).toBe(0);
      await expect(
        probedExternalRefresh!(GITHUB_NOTIFICATIONS_PROVIDER_ID)
      ).rejects.toThrow("External source is unavailable.");

      await user.click(screen.getByRole("button", { name: "GitHub Inbox" }));
      await waitFor(() => expect(notificationGets).toBeGreaterThan(0));
    } finally {
      rendered?.unmount();
      notesFeatureRuntime.renderPanes = originalRenderPanes;
      probedExternalRefresh = null;
      vi.unstubAllGlobals();
    }
  });
```

- [ ] **Step 2: Run the runtime-isolation test and confirm it fails**

Run:

```bash
npm test -- src/App.test.tsx -t "disables the Notes notification source while keeping Inbox active"
```

Expected: FAIL because the context still exposes `githubPage` and Notes can activate the shared source.

- [ ] **Step 3: Gate the existing Notes paths with the setting**

In `src/App.tsx`, change the Notes projection condition:

```ts
  const githubProjectionActive =
    settings.githubNotificationsPluginEnabled &&
    activeFeatureId === "notes" &&
    githubProjectionRequested;
```

Keep the Inbox branch structurally unchanged:

```ts
  const notificationSourceActive =
    authGate.state === "passed" && (inboxActive || githubProjectionActive);
```

Add the setting to the existing Notes refresh guard and dependency list:

```ts
  const refreshExternalProvider = useCallback(
    (providerId: string): Promise<void> =>
      settings.githubNotificationsPluginEnabled &&
      providerId === GITHUB_NOTIFICATIONS_PROVIDER_ID &&
      online &&
      notificationSourceHandle
        ? notificationSourceHandle.refresh()
        : rejectUnavailableExternalSource(),
    [
      notificationSourceHandle,
      online,
      settings.githubNotificationsPluginEnabled
    ]
  );
```

Add the same setting to the Notes completion guard and dependency list:

```ts
  const completeExternalBullet = useCallback(
    (key: ExternalBulletKey): Promise<void> =>
      settings.githubNotificationsPluginEnabled &&
      key.providerId === GITHUB_EXTERNAL_KEY_PROVIDER &&
      key.connectionId === sourceConnectionId &&
      online &&
      notificationSourceHandle
        ? notificationSourceHandle.complete(key)
        : rejectUnavailableExternalSource(),
    [
      notificationSourceHandle,
      online,
      settings.githubNotificationsPluginEnabled,
      sourceConnectionId
    ]
  );
```

Expose no Notes page while disabled:

```ts
  const externalSources = useMemo<ExternalSourcesBoundary>(
    () => ({
      pages: settings.githubNotificationsPluginEnabled ? [githubPage] : [],
      projectionNowMs,
      githubProjectionRequested,
      requestGithubProjection,
      registerGithubMaterializedRefresh,
      refresh: refreshExternalProvider,
      complete: completeExternalBullet,
      openDetails: openExternalDetails
    }),
    [
      completeExternalBullet,
      githubPage,
      projectionNowMs,
      githubProjectionRequested,
      openExternalDetails,
      registerGithubMaterializedRefresh,
      refreshExternalProvider,
      requestGithubProjection,
      settings.githubNotificationsPluginEnabled
    ]
  );
```

Do not conditionally create `notificationProvider` or `notificationSourceHandle`; Inbox reuses them.

- [ ] **Step 4: Run the runtime-isolation test**

Run:

```bash
npm test -- src/App.test.tsx -t "disables the Notes notification source while keeping Inbox active"
```

Expected: PASS, including a notification GET only after Inbox is opened.

- [ ] **Step 5: Run the complete App test file**

Run:

```bash
npm test -- src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the App runtime gate**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat(notes): gate GitHub notifications runtime"
```

### Task 3: Hide Stored Notes Data and Exit an Open Plugin Page

**Files:**
- Modify: `src/features/notes/NotesLibraryPane.tsx:1-560`
- Test: `src/features/notes/NotesLibraryPane.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx:650-1870`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: absence of `GITHUB_NOTIFICATIONS_PROVIDER_ID` from `ExternalSourcesContext.pages`, stored `GITHUB_NOTIFICATIONS_ROOT_ID`, flattened rows' `ancestorIds`, and `actions.zoomTo(null)`.
- Produces: no GitHub root or descendants in the Notes library/outline while disabled; a currently open GitHub root transitions to All notes.

- [ ] **Step 1: Add a failing library visibility test**

Add this test to `src/features/notes/NotesLibraryPane.test.tsx`:

```tsx
  it("hides a stored GN root when the provider page is absent", () => {
    const workspace = activeWorkspace();
    workspace.state = normalizeWorkspace({ nodes: [githubRoot()] });

    renderLibraryWithExternal(
      workspace,
      externalBoundary({ pages: [] })
    );

    expect(
      screen.queryByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
      })
    ).not.toBeInTheDocument();
    expect(screen.getByText("No pages yet.")).toBeInTheDocument();
    expect(workspace.state.nodesById[GITHUB_NOTIFICATIONS_ROOT_ID])
      .toBeDefined();
  });
```

- [ ] **Step 2: Add a failing outline visibility test**

Add this test before the existing GitHub outline composition tests in `src/features/notes/NotesWorkspace.test.tsx`:

```tsx
  it("omits the stored GN subtree when the provider page is absent", async () => {
    configureRepository([
      node({ id: "ordinary-root", title: "Ordinary root" }),
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] }
      }),
      node({
        id: "stored-github-date",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: "2026.07.24",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.24" }
      })
    ]);
    renderNotesWorkspace(undefined, undefined, {
      ...githubSources([]),
      pages: []
    });

    await findTitleInput("Ordinary root");
    const outline = screen.getByLabelText("Notes outline");
    expect(
      outline.querySelector(
        `[data-outline-id="${GITHUB_NOTIFICATIONS_ROOT_ID}"]`
      )
    ).toBeNull();
    expect(
      outline.querySelector('[data-outline-id="stored-github-date"]')
    ).toBeNull();
  });
```

- [ ] **Step 3: Add a failing live-disable fallback test**

Add this test to `Yonalist app shell` in `src/App.test.tsx`:

```tsx
  it("returns an open Notes notification page to All when disabled", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(screen.getByRole("button", { name: "Notes" }));
    const library = await screen.findByLabelText("Notes library");
    await user.click(
      within(library).getByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
      })
    );
    expect(screen.getByRole("button", { name: "All notes" }))
      .not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole(
        "tab",
        { name: /Plugins.*GitHub Notifications/ }
      )
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "GitHub Notifications 사용"
      })
    );
    await user.click(screen.getByRole("button", { name: "Notes" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "All notes" }))
        .toHaveAttribute("aria-current", "page")
    );
    expect(
      within(screen.getByLabelText("Notes library")).queryByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
      })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole(
        "tab",
        { name: /Plugins.*GitHub Notifications/ }
      )
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "GitHub Notifications 사용"
      })
    );
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(
      within(await screen.findByLabelText("Notes library")).getByRole(
        "button",
        { name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE }
      )
    ).toBeInTheDocument();
  });
```

- [ ] **Step 4: Run the three visibility tests and confirm they fail**

Run:

```bash
npm test -- src/features/notes/NotesLibraryPane.test.tsx -t "hides a stored GN root when the provider page is absent"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "omits the stored GN subtree when the provider page is absent"
npm test -- src/App.test.tsx -t "returns an open Notes notification page to All when disabled"
```

Expected: all three FAIL because stored Notes rows are still rendered and no fallback runs.

- [ ] **Step 5: Hide the library row using the existing external page boundary**

Import the context and provider ID in `src/features/notes/NotesLibraryPane.tsx`:

```ts
import { useExternalSources } from "../../ExternalSourcesContext";
import {
  GITHUB_NOTIFICATIONS_PROVIDER_ID,
  GITHUB_NOTIFICATIONS_ROOT_ID
} from "../../services/githubNotificationsProvider";
```

Pass one visibility boolean into the existing inner pane:

```tsx
function NotesLibraryPaneContent({
  githubNotificationsVisible
}: {
  readonly githubNotificationsVisible: boolean;
}) {
```

After reading Notes state, derive the visible roots:

```ts
  const visibleRootIds = githubNotificationsVisible
    ? state.rootIds
    : state.rootIds.filter(
        (nodeId) => nodeId !== GITHUB_NOTIFICATIONS_ROOT_ID
      );
```

Use `visibleRootIds.length` for the initial-loading and empty-state checks, and replace `state.rootIds.map` with:

```tsx
            {visibleRootIds.map((nodeId) => {
```

In the exported pane, derive the boolean once and use it for export availability and rendering:

```tsx
export function NotesLibraryPane() {
  const { actions } = useNotesActions();
  const { deletingNotesData, libraryView, state } = useNotesState();
  const githubNotificationsVisible = useExternalSources().pages.some(
    (page) => page.providerId === GITHUB_NOTIFICATIONS_PROVIDER_ID
  );
  const visibleRootCount = state.rootIds.filter(
    (nodeId) =>
      githubNotificationsVisible ||
      nodeId !== GITHUB_NOTIFICATIONS_ROOT_ID
  ).length;
  const lifecycleReadOnly = libraryView === "archive" || libraryView === "trash";

  return (
    <NotesExportControllerProvider
      available={!lifecycleReadOnly && visibleRootCount > 0}
      disabled={deletingNotesData || lifecycleReadOnly}
      loading={state.status === "loading"}
      onFlushDrafts={actions.flushAllDrafts}
    >
      <NotesLibraryPaneContent
        githubNotificationsVisible={githubNotificationsVisible}
      />
    </NotesExportControllerProvider>
  );
}
```

This changes presentation only; do not dispatch a delete or mutate `state`.

- [ ] **Step 6: Hide the outline subtree and add the open-page fallback**

In `src/features/notes/NotesOutlinePane.tsx`, move the existing `githubPage` memo to immediately after the `useNotesState()` destructuring so it is available to structural projection:

```ts
  const githubPage = useMemo(
    () =>
      externalSources.pages.find(
        (page) => page.providerId === GITHUB_NOTIFICATIONS_PROVIDER_ID
      ) ?? null,
    [externalSources.pages]
  );
```

Delete the old duplicate `githubPage` memo near the GitHub projection block.

Move the existing `githubDescendantIds` memo from below the GitHub projection
callbacks to this location so both structural filtering and the existing
selection logic reuse the same set:

```ts
  const githubDescendantIds = useMemo(() => {
    const descendants = new Set<NoteId>();
    const pending = [
      ...(state.childIdsByParent[GITHUB_NOTIFICATIONS_ROOT_ID] ?? [])
    ];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (descendants.has(nodeId)) continue;
      descendants.add(nodeId);
      pending.push(...(state.childIdsByParent[nodeId] ?? []));
    }
    return descendants;
  }, [state.childIdsByParent]);
```

Add the fallback before structural rows are derived:

```ts
  const githubZoomed = state.zoomRootId === GITHUB_NOTIFICATIONS_ROOT_ID;
  const githubPluginPageOpen =
    githubZoomed ||
    (state.zoomRootId !== null &&
      githubDescendantIds.has(state.zoomRootId));
  useLayoutEffect(() => {
    if (githubPage !== null || !githubPluginPageOpen) return;
    actions.clearSelection();
    void actions.zoomTo(null);
  }, [actions, githubPage, githubPluginPageOpen]);
```

Remove the later duplicate `githubZoomed` and `githubDescendantIds`
declarations. Keep the existing `githubRoot` declaration.

Filter the stored subtree at the existing `allStructuralRows` memo:

```ts
  const allStructuralRows = useMemo(() => {
    const rows = flattenVisibleOutlineRows(
      state,
      state.zoomRootId,
      locallyExpandedNodeIds
    );
    const visibleRows =
      githubPage === null
        ? rows.filter(
            (row) =>
              row.id !== GITHUB_NOTIFICATIONS_ROOT_ID &&
              !githubDescendantIds.has(row.id)
          )
        : rows;
    return retainOutlineRowProjection(
      committedOutlineRowsRef.current?.vaultRoot === vaultRoot
        ? committedOutlineRowsRef.current.allStructuralRows
        : [],
      visibleRows
    );
  }, [
    githubDescendantIds,
    githubPage,
    locallyExpandedNodeIds,
    state,
    vaultRoot
  ]);
```

Use `useLayoutEffect` for the fallback so a disabled, zoomed page does not paint an empty intermediate view. Do not remove the stored root from `state` and do not change the GitHub projection helper.

- [ ] **Step 7: Keep existing Notes tests explicit about enabled-disconnected state**

In `src/features/notes/NotesWorkspace.test.tsx`, import the availability type:

```ts
import type {
  ExternalBullet,
  ExternalSourceAvailability
} from "../../domain/externalSources";
```

Extend the existing source helper without changing current call sites:

```ts
function githubSources(
  items: readonly ExternalBullet[],
  availability: ExternalSourceAvailability = "online"
): ExternalSourcesBoundary {
  return {
    pages: [
      {
        providerId: "github-notifications",
        connectionId: items[0]?.key.connectionId ?? null,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        availability,
        items,
        loaded: true,
        loading: false,
        error: null,
        syncedAt: "2026-07-22T12:00:00Z",
        completingKeys: new Set(),
        completionErrors: {}
      }
    ],
    refresh: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    openDetails: vi.fn()
  };
}
```

Change `renderNotesWorkspace` so omitted test input means enabled but
disconnected, matching the pre-toggle behavior:

```tsx
  const featureWithSources = (
    <ExternalSourcesContext.Provider
      value={externalSources ?? githubSources([], "disconnected")}
    >
      {feature}
    </ExternalSourcesContext.Provider>
  );
```

This is test-fixture compatibility only. Production still receives its page
list from `App`.

- [ ] **Step 8: Run the focused visibility tests**

Run:

```bash
npm test -- src/features/notes/NotesLibraryPane.test.tsx -t "hides a stored GN root when the provider page is absent"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "omits the stored GN subtree when the provider page is absent"
npm test -- src/App.test.tsx -t "returns an open Notes notification page to All when disabled"
```

Expected: all three PASS.

- [ ] **Step 9: Run all directly affected test files**

Run:

```bash
npm test -- src/appSettings.test.ts src/components/SettingsPage.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesWorkspace.test.tsx src/App.test.tsx
```

Expected: all listed test files PASS.

- [ ] **Step 10: Commit the Notes presentation and fallback**

```bash
git add src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx src/App.test.tsx
git commit -m "feat(notes): hide disabled GitHub notifications page"
```

### Task 4: Whole-Repository Verification

**Files:**
- Verify only; no production files should change.

**Interfaces:**
- Consumes: all three implementation commits.
- Produces: evidence that behavior, types, lint rules, architecture budgets, plan reconciliation, and build remain valid.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 3: Run the production build**

Run:

```bash
npm run build
```

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 4: Run repository-specific checks**

Run:

```bash
npm run test:architecture
npm run test:plans
```

Expected: both checks PASS.

- [ ] **Step 5: Check patch hygiene and scope**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` prints nothing. `git status --short` contains no
uncommitted files from this plugin-toggle implementation. The pre-existing user
changes in `docs/superpowers/plans/2026-07-24-notes-outliner-latency-remediation.md`
and `src/features/notes/notesSplitLatencyProbe.ts` may remain and must not be
staged.

- [ ] **Step 6: Inspect the final commit sequence**

Run:

```bash
git log -3 --oneline
```

Expected: the three implementation commits appear in this order:

```text
<hash> feat(notes): hide disabled GitHub notifications page
<hash> feat(notes): gate GitHub notifications runtime
<hash> feat(settings): add GitHub notifications plugin toggle
```
