# GitHub Inbox Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the GitHub Inbox UI, code, native storage, IPC, and existing development data while keeping Yonalist, the GitHub Notifications (GN) plugin, its link behavior, GitHub authentication, and desktop notifications working.

**Architecture:** Move the surviving GitHub Notifications lifecycle out of the legacy Inbox controller and into one Yonalist-owned runtime. Reduce the application shell to the Yonalist and Settings feature host, then delete the unreachable Inbox frontend and native storage slices from the outside inward. Remove development data with a one-time, narrowly targeted cleanup after the new desktop bundle proves it no longer recreates that data.

**Tech Stack:** React 19, TypeScript 6, Vitest and Testing Library, Tauri 2, Rust 1.97, rusqlite SQLite, macOS WebKit localStorage.

## Global Constraints

- The source contract is `docs/superpowers/specs/2026-07-27-github-inbox-removal-and-yonalist-boundary-design.md`.
- “Yonalist” is the product term. Do not mass-rename established internal identifiers such as `NotesFeature`, `src/features/notes`, `notes.sqlite`, or Notes IPC commands in this work.
- The compiled feature registry contains only `notes` and `settings`; Yonalist opens by default even when `yonalist.activeFeature.v1` contains the old value `"inbox"`.
- GitHub authentication is not an application startup gate. An unauthenticated user can open Yonalist and Settings.
- Keep the GN provider, external-source snapshot, Yonalist materialization bridge, read-completion path, current link button behavior, GitHub server/authentication settings, and `yonalist.notifications.viewedAt.v1`.
- GN projection fetching requires the plugin, a validated GitHub account, online state, and an active Yonalist projection lease. Desktop notifications require the plugin, a validated GitHub account, online state, and the desktop-notification setting; they do not require an Inbox feature or repository-visibility filter.
- Remove the existing GitHub create-issue/create-comment outbox. A Yonalist offline/online outbox is a separate future project and must not reuse the deleted operation documents or lifecycle.
- This is development data. Add no migration, compatibility reader, format version, dual-write path, startup cleanup, or legacy fallback for Inbox data.
- Preserve `<app-data>/notes/**`, `<vault>/.yonalist/notes.sqlite*`, `<vault>/.yonalist/notes-assets/**`, `<vault>/.yonalist/asset-trash/**`, Yonalist Markdown, Trash, and GN materialized Markdown such as `Github-Notifications.<id>.md`.
- Keep `fetch_image`, remote Markdown image rendering, the notification plugin, OAuth/keychain commands, external URL opening, and every `notes_*` command.
- Add no runtime dependency.
- Each code task ends with a focused test and a commit. Run the full frontend and native gates once after the production diff is frozen.

---

## Target file structure

### New Yonalist-owned GN boundary

| File | Responsibility |
| --- | --- |
| `src/features/notes/githubNotifications/githubNotificationViewedStore.ts` | Own the existing `yonalist.notifications.viewedAt.v1` key and first-view timestamp rule. |
| `src/features/notes/githubNotifications/githubNotificationViewedStore.test.ts` | Prove corrupt-storage fallback, first-view stability, and key preservation. |
| `src/features/notes/githubNotifications/useGithubNotificationsRuntime.ts` | Own provider creation, source lease, projection, native materialization bridge, safe link opening, and desktop notifications. |
| `src/features/notes/githubNotifications/useGithubNotificationsRuntime.test.tsx` | Prove GN activation, projection lease, desktop-notification independence from UI selection, completion, and link behavior. |

### Existing files that remain but become smaller

| File | Final responsibility |
| --- | --- |
| `src/App.tsx` | Yonalist/Settings shell, Vault changes, theme/layout, GitHub auth input, and GN runtime mounting. |
| `src/components/Sidebar.tsx` | Yonalist, Settings, sign-in status, and online/offline controls only. |
| `src/components/AppStatusBar.tsx` | Yonalist feedback and online/offline status only. |
| `src/appSettings.ts` | Vault, theme/Markdown, Notes assets, GN, and desktop-notification settings only. |
| `src/components/SettingsPage.tsx` | Appearance, GitHub servers, Vault, Notes, Plugins, and Reset. |
| `src/services/notifications.ts` | GitHub Notifications fetch, unread probe, remote read completion, and the in-memory feed cache. |
| `src/services/imageProxy.ts` | Authenticated remote Markdown image fetching only; no avatar storage. |
| `src/services/appReset.ts` | Session sign-out, surviving runtime-cache clearing, and app-local setting/cache clearing. |
| `src-tauri/src/lib.rs` | Window, auth/keychain, external URL, remote image, performance, and Yonalist commands. |

### Frontend files to delete

Delete the production file and its same-named test unless the file list explicitly names only one:

```text
src/features/inbox/InboxFeature.tsx

src/components/Avatar.tsx
src/components/Avatar.test.tsx
src/components/CommentComposer.tsx
src/components/CommentComposer.test.tsx
src/components/CommentThread.tsx
src/components/CommentThread.test.tsx
src/components/DetailRenderSnapshotOverlay.tsx
src/components/DetailRenderSnapshotOverlay.test.tsx
src/components/ItemDetail.tsx
src/components/ItemDetail.test.tsx
src/components/ItemListPane.tsx
src/components/ItemListPane.test.tsx
src/components/ItemListPane.css
src/components/LabelChip.tsx
src/components/LabelChip.test.tsx
src/components/LoadingDots.tsx
src/components/LoginPage.tsx
src/components/LoginPage.test.tsx
src/components/NewIssuePage.tsx
src/components/NotificationDetail.tsx
src/components/NotificationDetail.test.tsx
src/components/NotificationsPane.tsx
src/components/NotificationsPane.test.tsx
src/components/NotificationsPane.css
src/components/OutboxModal.tsx
src/components/OutboxModal.test.tsx
src/components/ProjectsVisibilitySection.tsx
src/components/StateBadge.tsx
src/components/StateBadge.test.tsx
src/components/ui/composer-dock.css
src/components/ui/tabs.css

src/domain/comments.ts
src/domain/comments.test.ts
src/domain/conversation.ts
src/domain/conversation.test.ts
src/domain/favorites.ts
src/domain/favorites.test.ts
src/domain/itemLinks.ts
src/domain/itemThreadVersion.ts
src/domain/items.ts
src/domain/items.test.ts
src/domain/markdown.ts
src/domain/markdown.test.ts
src/domain/outbox.ts
src/domain/outbox.test.ts
src/domain/paths.ts
src/domain/paths.test.ts
src/domain/types.ts
src/domain/vaultIndex.ts
src/domain/vaultIndex.test.ts

src/fixtures/sampleItems.ts
src/fixtures/sampleNotifications.ts

src/hooks/useAppBadge.ts
src/hooks/useAppBadge.test.tsx
src/hooks/useAuthorNames.ts
src/hooks/useAuthorNames.test.tsx
src/hooks/useDetailContentPaintReady.ts
src/hooks/useDetailContentPaintReady.test.tsx
src/hooks/useDetailDisplayTiming.ts
src/hooks/useDetailDisplayTiming.test.tsx
src/hooks/useDetailRenderSnapshotCapture.ts
src/hooks/useDetailRenderSnapshotCapture.test.tsx
src/hooks/useDetailRevalidation.ts
src/hooks/useDetailRevalidation.test.tsx
src/hooks/useDraftIssue.ts
src/hooks/useItemThread.ts
src/hooks/useItemThread.test.tsx
src/hooks/useNotificationDetail.ts
src/hooks/useNotificationDetail.test.tsx
src/hooks/useNotifications.ts
src/hooks/useOutboxSync.ts
src/hooks/useProjectVisibility.ts
src/hooks/useProjectVisibility.test.tsx
src/hooks/useRepositories.ts
src/hooks/useRepositories.test.tsx
src/hooks/useRepositoryOpenCounts.ts
src/hooks/useRepositoryOpenCounts.test.tsx
src/hooks/useVisibleItemPrefetch.ts
src/hooks/useVisibleItemPrefetch.test.tsx
src/hooks/useVisibleItemPrefetch.integration.test.tsx
src/hooks/useVisibleNotificationPrefetch.ts
src/hooks/useVisibleNotificationPrefetch.test.tsx
src/hooks/useVisiblePrefetchQueue.ts
src/hooks/useVisiblePrefetchQueue.test.tsx
src/hooks/useWorkItems.ts
src/hooks/useWorkItems.test.tsx

src/services/appBadge.ts
src/services/appBadge.test.ts
src/services/conversationMapping.ts
src/services/detailRenderCache.ts
src/services/detailRenderCache.test.ts
src/services/favoritesStore.ts
src/services/favoritesStore.test.ts
src/services/github.ts
src/services/github.test.ts
src/services/githubItems.ts
src/services/githubItems.test.ts
src/services/itemThread.ts
src/services/itemThread.test.ts
src/services/notificationDetail.ts
src/services/notificationDetail.test.ts
src/services/notificationStores.ts
src/services/notificationStores.test.ts
src/services/projectVisibilityStore.ts
src/services/projectVisibilityStore.test.ts
src/services/repositoryCache.ts
src/services/sync.ts
src/services/sync.test.ts
src/services/userProfiles.ts
src/services/vaultIndex.ts
src/services/vaultIndex.test.ts
src/services/vaultIndex.worker.ts
src/services/vaultIndexReconcile.ts
src/services/vaultIndexReconcile.test.ts
src/services/vaultStore.ts
src/services/vaultStore.test.ts
src/services/vaultStore.tauri.test.ts
src/services/versionedConversationCache.ts
src/services/versionedConversationCache.test.ts

src/App.preload.test.tsx
src/services/imageProxy.tauri.test.ts
```

`MarkdownBody`, `markdownRender`, `dateGroups`, `lruCache`, `cacheStats`,
`GithubConnectionContext`, `githubTransport`, `notifications`,
`githubNotificationsProvider`, `externalSourceHost`,
`externalSourceSnapshotStore`, `githubMaterializedBridge`, and all Notes files
stay because Yonalist or GN still imports them.

### Native files and generated permissions to delete

```text
src-tauri/src/vault_index_reconcile.rs

src-tauri/permissions/autogenerated/ensure_vault.toml
src-tauri/permissions/autogenerated/read_text_file.toml
src-tauri/permissions/autogenerated/write_text_file.toml
src-tauri/permissions/autogenerated/delete_text_file.toml
src-tauri/permissions/autogenerated/move_text_file.toml
src-tauri/permissions/autogenerated/list_outbox_markdown_files.toml
src-tauri/permissions/autogenerated/list_vault_item_index.toml
src-tauri/permissions/autogenerated/upsert_vault_item_index.toml
src-tauri/permissions/autogenerated/get_vault_document_hash.toml
src-tauri/permissions/autogenerated/upsert_vault_document_hash.toml
src-tauri/permissions/autogenerated/persist_vault_documents.toml
src-tauri/permissions/autogenerated/delete_vault_document_hash.toml
src-tauri/permissions/autogenerated/move_vault_document_hash.toml
src-tauri/permissions/autogenerated/clear_vault_cache.toml
src-tauri/permissions/autogenerated/scan_vault_item_index_changes.toml
src-tauri/permissions/autogenerated/commit_vault_item_index_changes.toml
src-tauri/permissions/autogenerated/load_cached_avatar_image.toml
src-tauri/permissions/autogenerated/store_cached_avatar_image.toml
src-tauri/permissions/autogenerated/touch_cached_avatar_image.toml
```

`src-tauri/src/file_io.rs` stays. Yonalist attachment, export, watcher, repair,
and sync modules use its guarded file operations.

## Stable interfaces

```ts
// src/features/notes/githubNotifications/githubNotificationViewedStore.ts
export type GithubNotificationViewedAt = Readonly<Record<string, string>>;

export function loadGithubNotificationViewedAt(): GithubNotificationViewedAt;

export function recordGithubNotificationViewedAt(
  url: string,
  at?: Date
): GithubNotificationViewedAt;
```

```ts
// src/features/notes/githubNotifications/useGithubNotificationsRuntime.ts
export interface GithubNotificationsRuntimeInput {
  connection: GithubConnection;
  authState: AuthGateState;
  account: GithubAccountIdentity | null;
  online: boolean;
  pluginEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  readRetentionDays: number;
}

export interface GithubNotificationsRuntimeResult {
  externalSources: ExternalSourcesBoundary;
}

export function useGithubNotificationsRuntime(
  input: GithubNotificationsRuntimeInput
): GithubNotificationsRuntimeResult;
```

The runtime owns `githubProjectionRequested` internally. The Notes workspace
continues to request and release that lease through `ExternalSourcesBoundary`.
No active-feature or repository-visibility input is allowed on the runtime or
`useDesktopNotifications`.

## Refactoring sequence

The implementation order intentionally applies these Fowler refactorings:

| Refactoring | Applied in | Concrete change |
| --- | --- | --- |
| Encapsulate Variable | Task 1 | Move `yonalist.notifications.viewedAt.v1` access behind `githubNotificationViewedStore`. |
| Extract Function / Move Function | Task 1 | Move GN provider, projection, materialization, link, and desktop-notification orchestration out of `App.tsx` into `useGithubNotificationsRuntime`. |
| Change Function Declaration | Task 1 | Remove the Inbox-only repository predicate from `useDesktopNotifications`. |
| Replace Conditional with Polymorphism | Task 2 | Let the two remaining feature definitions render themselves instead of retaining an Inbox-special shell branch. |
| Inline Function | Task 2 | Fold one-use Inbox pane and reset wrappers into their surviving Yonalist/Settings callers before deletion. |
| Remove Dead Code | Tasks 2–4 | Delete unreachable Inbox UI, domain, service, IPC, SQLite, avatar-cache, and permission slices after their callers disappear. |
| Split Phase | Tasks 4 and 6 | Remove runtime writers first, then perform the separate one-time development-data cleanup. |
| Separate Query from Modifier | Task 6 | Inventory and validate every deletion candidate before running the guarded delete commands. |

Do not introduce an abstraction merely to match a refactoring name. Each
extraction above has a surviving owner and an explicit test contract.

---

### Task 1: Encapsulate GN viewed state and move the surviving GitHub lifecycle

**Files:**

- Create: `src/features/notes/githubNotifications/githubNotificationViewedStore.ts`
- Create: `src/features/notes/githubNotifications/githubNotificationViewedStore.test.ts`
- Create: `src/features/notes/githubNotifications/useGithubNotificationsRuntime.ts`
- Create: `src/features/notes/githubNotifications/useGithubNotificationsRuntime.test.tsx`
- Modify: `src/hooks/useDesktopNotifications.ts`
- Modify: `src/hooks/useDesktopNotifications.test.tsx`

**Interfaces:**

- Consumes: `GithubConnection`, `AuthGateState`, `GithubAccountIdentity`, `ExternalSourcesBoundary`, `createGithubNotificationsProvider`, `createExternalSourceHost`, `createGithubMaterializedBridgePump`, and `useDesktopNotifications`.
- Produces: the stable interfaces shown above.
- Preserves: `yonalist.notifications.viewedAt.v1`, external-source snapshot keys, GN materialization callbacks, safe external link opening, and the 60-second desktop probe.

- [ ] **Step 1: Write failing viewed-store tests**

Create tests with these exact cases:

```ts
describe("githubNotificationViewedStore", () => {
  beforeEach(() => window.localStorage.clear());

  it("uses the existing GN viewed-at key", () => {
    window.localStorage.setItem(
      "yonalist.notifications.viewedAt.v1",
      JSON.stringify({ "https://github.com/acme/app/issues/7": "2026-07-27T01:00:00.000Z" })
    );
    expect(loadGithubNotificationViewedAt()).toEqual({
      "https://github.com/acme/app/issues/7": "2026-07-27T01:00:00.000Z"
    });
  });

  it("records only the first view of one URL", () => {
    recordGithubNotificationViewedAt(
      "https://github.com/acme/app/issues/7",
      new Date("2026-07-27T01:00:00Z")
    );
    const result = recordGithubNotificationViewedAt(
      "https://github.com/acme/app/issues/7",
      new Date("2026-07-27T02:00:00Z")
    );
    expect(result["https://github.com/acme/app/issues/7"])
      .toBe("2026-07-27T01:00:00.000Z");
  });

  it("falls back to an empty map for corrupt storage", () => {
    window.localStorage.setItem(
      "yonalist.notifications.viewedAt.v1",
      "{broken"
    );
    expect(loadGithubNotificationViewedAt()).toEqual({});
  });
});
```

- [ ] **Step 2: Run the viewed-store test and confirm the missing-module failure**

Run:

```bash
npm test -- src/features/notes/githubNotifications/githubNotificationViewedStore.test.ts
```

Expected: FAIL because `githubNotificationViewedStore.ts` does not exist.

- [ ] **Step 3: Implement the viewed store without renaming its persisted key**

Use immutable return values and preserve the first timestamp:

```ts
const viewedStorageKey = "yonalist.notifications.viewedAt.v1";

export type GithubNotificationViewedAt =
  Readonly<Record<string, string>>;

export function loadGithubNotificationViewedAt(): GithubNotificationViewedAt {
  try {
    const stored = window.localStorage.getItem(viewedStorageKey);
    const parsed = stored ? (JSON.parse(stored) as unknown) : {};
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.freeze({ ...(parsed as Record<string, string>) })
      : Object.freeze({});
  } catch {
    return Object.freeze({});
  }
}

export function recordGithubNotificationViewedAt(
  url: string,
  at = new Date()
): GithubNotificationViewedAt {
  const current = loadGithubNotificationViewedAt();
  if (current[url]) return current;
  const next = Object.freeze({ ...current, [url]: at.toISOString() });
  try {
    window.localStorage.setItem(viewedStorageKey, JSON.stringify(next));
  } catch {
    // The current session can still use the returned timestamp.
  }
  return next;
}
```

- [ ] **Step 4: Write failing GN runtime tests**

Cover all five runtime contracts in the new hook test:

```ts
it("does not acquire or expose GN when the plugin is disabled", () => {
  const { result } = renderRuntime({ pluginEnabled: false });
  expect(result.current.externalSources.pages).toEqual([]);
  expect(sourceHandle.acquire).not.toHaveBeenCalled();
  expect(useDesktopNotificationsMock).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: false })
  );
});

it("acquires the source only while the authenticated online Notes lease is requested", () => {
  const { result } = renderRuntime();
  expect(sourceHandle.acquire).not.toHaveBeenCalled();
  act(() => result.current.externalSources.requestGithubProjection?.(true));
  expect(sourceHandle.acquire).toHaveBeenCalledOnce();
});

it("enables desktop notifications without an Inbox or active-feature input", () => {
  renderRuntime({ desktopNotificationsEnabled: true });
  expect(useDesktopNotificationsMock).toHaveBeenCalledWith({
    connection,
    viewedAt: expect.any(Object),
    online: true,
    enabled: true,
    demoMode: false
  });
});

it("submits a completed source snapshot to the registered Notes materializer", async () => {
  const { result } = renderRuntime();
  const materialize = vi.fn().mockResolvedValue("committed");
  act(() => result.current.externalSources.registerGithubMaterializedRefresh?.(materialize));
  act(() => result.current.externalSources.requestGithubProjection?.(true));
  await waitFor(() => expect(materialize).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: expect.any(String),
      webBaseUrl: "https://github.com",
      items: [notification]
    })
  ));
});

it("opens only a safe GitHub URL and records it as viewed", () => {
  const { result } = renderRuntime();
  act(() => result.current.externalSources.openDetails(externalKey, notificationUrl));
  expect(openExternalMock).toHaveBeenCalledWith(notificationUrl);
  expect(loadGithubNotificationViewedAt()).toHaveProperty(notificationUrl);

  act(() => result.current.externalSources.openDetails(externalKey, "javascript:alert(1)"));
  expect(openExternalMock).toHaveBeenCalledTimes(1);
});
```

The test harness supplies a passed auth state, a concrete account, an online
connection, and a controllable `ExternalSourceHandle`. It does not accept an
`activeFeatureId` field.

- [ ] **Step 5: Implement the GN runtime by moving, not duplicating, App logic**

Move these existing `App.tsx` responsibilities into the hook:

```text
githubProjectionRequested and projection clock
provider and source-handle creation/disposal
source activation and snapshot projection
materialized bridge pump registration/submission/invalidation
refresh, complete, and openDetails ExternalSourcesBoundary methods
viewedAt loading and recording
useDesktopNotifications invocation
```

Use these named policy values:

```ts
const connected =
  input.pluginEnabled &&
  input.authState === "passed" &&
  input.account !== null &&
  input.online &&
  Boolean(input.connection.token.trim());

const projectionActive = connected && githubProjectionRequested;
const desktopNotificationsActive =
  connected && input.desktopNotificationsEnabled;
```

Call `useExternalSource(handle, projectionActive)`. Build `pages` only when
`pluginEnabled` is true. `refresh` and `complete` reject with
`rejectUnavailableExternalSource()` unless `connected` is true. `openDetails`
uses the current notification URL when the remote ID is present and otherwise
uses only a fallback that passes `isSafeExternalHttpUrl`.

- [ ] **Step 6: Remove repository filtering from desktop notifications**

Delete `isRepoVisible` from `UseDesktopNotificationsInput`, the callback
dependency, and the early `continue` branch. Keep `isReadAndQuiet`, the
separate unread probe, permission handling, and the 60-second timer.

Add this test:

```ts
it("sends a new unread GN item without a repository-visibility callback", async () => {
  fetchUnreadNotificationUpdatesMock.mockResolvedValue([notification]);
  renderHook(() =>
    useDesktopNotifications({
      connection,
      viewedAt: {},
      online: true,
      enabled: true,
      demoMode: false
    })
  );
  await waitFor(() =>
    expect(sendDesktopNotificationMock).toHaveBeenCalledWith({
      title: "acme/app",
      body: "Fix sync"
    })
  );
});
```

- [ ] **Step 7: Run the focused GN tests**

Run:

```bash
npm test -- \
  src/features/notes/githubNotifications/githubNotificationViewedStore.test.ts \
  src/features/notes/githubNotifications/useGithubNotificationsRuntime.test.tsx \
  src/hooks/useDesktopNotifications.test.tsx \
  src/services/githubNotificationsProvider.test.ts \
  src/services/githubMaterializedBridge.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the Yonalist-owned GN boundary**

```bash
git add \
  src/features/notes/githubNotifications \
  src/hooks/useDesktopNotifications.ts \
  src/hooks/useDesktopNotifications.test.tsx
git commit -m "refactor(gn): move notifications into Yonalist runtime"
```

---

### Task 2: Replace the Inbox application shell with Yonalist and Settings

**Files:**

- Modify: `src/App.tsx`
- Rewrite: `src/App.test.tsx`
- Modify: `src/App.featureActivationTiming.test.tsx`
- Modify: `src/App.featurePaneMemo.test.tsx`
- Modify: `src/App.lazyFeatureRuntime.test.tsx`
- Modify: `src/AppNavigationContext.test.tsx`
- Delete: `src/App.preload.test.tsx`
- Modify: `src/features/core/featureTypes.ts`
- Modify: `src/features/core/featureRegistry.tsx`
- Modify: `src/features/core/featureRegistry.test.tsx`
- Modify: `src/features/core/featureSelection.ts`
- Modify: `src/features/core/featureSelection.test.ts`
- Modify: `src/features/core/useFeatureRuntimeHost.test.tsx`
- Modify: `src/features/settings/SettingsFeature.tsx`
- Delete: `src/features/inbox/InboxFeature.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/Sidebar.test.tsx`
- Modify: `src/components/AppStatusBar.tsx`
- Modify: `src/components/AppStatusBar.test.tsx`
- Modify: `src/components/SettingsCategoryPane.tsx`
- Modify: `src/components/SettingsCategoryPane.test.tsx`
- Modify: `src/components/SettingsPage.tsx`
- Modify: `src/components/SettingsPage.test.tsx`
- Modify: `src/components/SettingsFormControls.test.tsx`
- Modify: `src/appSettings.ts`
- Modify: `src/appSettings.test.ts`
- Modify: `src/hooks/useSettingsReset.ts`
- Modify: `src/services/appReset.ts`
- Modify: `src/services/appReset.test.ts`

**Interfaces:**

- Consumes: `useGithubNotificationsRuntime` from Task 1.
- Produces: `FeatureId = "notes" | "settings"` and a shell with no GitHub authentication gate.
- Preserves: Notes lazy loading and mounted-session retention, settings runtime, Vault drain/flush, GitHub server management, and all Yonalist contexts.

- [ ] **Step 1: Write the failing feature-selection and registry tests**

Change the expected contract to:

```ts
it("registers only Yonalist and Settings", () => {
  expect(featureRegistry.map((feature) => feature.id))
    .toEqual(["notes", "settings"]);
  expect(featureRegistry.map((feature) => feature.label))
    .toEqual(["Yonalist", "Settings"]);
});

it.each([null, "inbox", "remote-plugin"])(
  "loads Yonalist for an absent or invalid saved feature: %s",
  (stored) => {
    if (stored !== null) {
      window.localStorage.setItem(activeFeatureStorageKey, stored);
    }
    expect(loadActiveFeature()).toBe("notes");
  }
);

it("recognizes only compiled feature identifiers", () => {
  expect(isFeatureId("notes")).toBe(true);
  expect(isFeatureId("settings")).toBe(true);
  expect(isFeatureId("inbox")).toBe(false);
});
```

Update the runtime-host fixtures so `notes` is the lazy workspace and
`settings` is the eager destination used for navigation-away tests.

- [ ] **Step 2: Run the feature-core tests and confirm the old Inbox expectations fail**

Run:

```bash
npm test -- \
  src/features/core/featureSelection.test.ts \
  src/features/core/featureRegistry.test.tsx \
  src/features/core/useFeatureRuntimeHost.test.tsx
```

Expected: FAIL because the registry and fallback still contain `inbox`.

- [ ] **Step 3: Remove Inbox from the feature model**

Make these exact structural changes:

```ts
export type FeatureId = "notes" | "settings";

export interface FeatureRenderContext {
  renderSettingsPanes: () => FeaturePanes;
}
```

Delete `requiresGithubAuth` from `FeatureMetadata` and from both remaining
definitions. Change only the Notes feature's visible `label` to `"Yonalist"`;
keep its internal `id: "notes"`, file names, comments, and lazy import. Export
this registry and lookup:

```ts
export const featureRegistry: readonly FeatureDefinition[] = [
  notesFeature,
  settingsFeature
];

const definitionsById: Record<FeatureId, FeatureDefinition> = {
  notes: notesFeature,
  settings: settingsFeature
};
```

Use `"notes"` as the only fallback in `loadActiveFeature`. Delete
`InboxFeature.tsx`.

- [ ] **Step 4: Write failing Sidebar and status-bar tests**

Replace the legacy Sidebar harness with the final props and assert:

```ts
it("shows only Yonalist and Settings navigation", () => {
  renderSidebar({ activeFeatureId: "notes" });
  expect(screen.getByRole("button", { name: "Yonalist" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  expect(screen.queryByText("GitHub Inbox")).toBeNull();
  expect(screen.queryByText("Notifications")).toBeNull();
  expect(screen.queryByText("Favorites")).toBeNull();
  expect(screen.queryByText("Repository")).toBeNull();
});
```

The final Sidebar props are:

```ts
export interface SidebarProps {
  online: boolean;
  loginRequired: boolean;
  onToggleOnline: () => void;
  activeFeatureId: FeatureId;
  featureEntries?: readonly FeatureDefinition[];
  onFeatureChange: (featureId: FeatureId) => void;
  onOpenSettings: () => void;
}
```

Replace AppStatusBar tests with:

```ts
it("shows Yonalist feedback and current connectivity without an outbox", () => {
  render(
    <AppStatusBar online={false} feedback={<span>Saving locally</span>} />
  );
  expect(screen.getByText("Saving locally")).toBeInTheDocument();
  expect(screen.getByText("Offline")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /outbox/i })).toBeNull();
  expect(screen.queryByLabelText("Performance metrics")).toBeNull();
});
```

- [ ] **Step 5: Simplify Sidebar and AppStatusBar**

Render all `workspace` feature entries in the primary section, which now yields
only Notes. Keep the sign-in-required icon, offline badge, online toggle, and
Settings button. Delete list filters, repository groups, counts, Notifications,
and project-settings props and branches.

Reduce AppStatusBar to:

```tsx
interface AppStatusBarProps {
  online: boolean;
  feedback?: ReactNode;
}

export const AppStatusBar = memo(function AppStatusBar({
  online,
  feedback
}: AppStatusBarProps) {
  return (
    <footer className="app-statusbar" aria-label="Status bar">
      <div className="statusbar-feedback">{feedback}</div>
      <div className="statusbar-actions">
        <span className="statusbar-state">
          {online ? "Online" : "Offline"}
        </span>
      </div>
    </footer>
  );
});
```

- [ ] **Step 6: Write failing settings tests for the new ownership**

Add or update these assertions:

```ts
it("omits Inbox project and queue settings", () => {
  expect(settingsSections.map(({ key }) => key)).toEqual([
    "appearance",
    "servers",
    "vault",
    "notes",
    "plugins",
    "reset"
  ]);
  expect(settingsSections.find(({ key }) => key === "notes")?.label)
    .toBe("Yonalist");
});

it("keeps desktop notifications with the GN plugin settings", () => {
  render(<SettingsPage {...settingsPageProps()} section="plugins" />);
  expect(screen.getByRole("checkbox", {
    name: "Desktop notifications for GitHub Notifications"
  })).toBeChecked();
  expect(screen.queryByText("Sync queued changes when online")).toBeNull();
  expect(screen.queryByText("Download comments while syncing")).toBeNull();
  expect(screen.queryByText("Prefetch visible conversations")).toBeNull();
});

it("drops legacy Inbox fields when settings are normalized", () => {
  const result = normalizeSettings({
    ...defaultSettings,
    syncQueuedOnReconnect: true,
    cacheLinkedAttachments: true,
    downloadCommentsWhileSyncing: true,
    prefetchVisibleItems: true
  } as Partial<AppSettings> & Record<string, unknown>);
  expect(result).not.toHaveProperty("syncQueuedOnReconnect");
  expect(result).not.toHaveProperty("cacheLinkedAttachments");
  expect(result).not.toHaveProperty("downloadCommentsWhileSyncing");
  expect(result).not.toHaveProperty("prefetchVisibleItems");
});
```

- [ ] **Step 7: Remove Inbox settings and project visibility**

Delete these keys from `AppSettings`, `defaultSettings`,
`normalizeSettings`, and `settingsNeedNormalization`:

```text
syncQueuedOnReconnect
cacheLinkedAttachments
downloadCommentsWhileSyncing
prefetchVisibleItems
```

Delete the `projects` Settings section, `FolderTree`,
`ProjectsVisibilitySection`, `OwnerGroup`, `UseProjectVisibilityResult`,
`repositoryGroups`, and `projectVisibility`. Move the existing
`desktopNotifications` checkbox from the Vault section to Plugins and use the
label `Desktop notifications for GitHub Notifications`.

Keep `vaultFolder`, `markdownStyle`, all three Notes asset settings,
`githubNotificationsPluginEnabled`,
`githubNotificationsReadRetentionDays`, and `desktopNotifications`.
Keep the internal Settings key `"notes"` but change its visible category label
to `"Yonalist"`. Update navigation and lazy-runtime tests to select the
`Yonalist` button/tab while retaining internal Notes component names and
accessibility fixtures that are outside this removal.

- [ ] **Step 8: Write the failing application-shell tests**

Rewrite `App.test.tsx` around the remaining shell contracts. Keep one test per
observable boundary:

```ts
it("opens Yonalist without waiting for GitHub authentication", async () => {
  window.localStorage.setItem(activeFeatureStorageKey, "inbox");
  render(<App initialOnline={false} />);
  expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();
  expect(screen.queryByLabelText("GitHub login")).toBeNull();
});

it("does not expose the removed Inbox surfaces", async () => {
  render(<App />);
  await screen.findByLabelText("Notes library");
  expect(screen.queryByText("GitHub Inbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /outbox/i })).toBeNull();
});

it("opens GitHub server settings while signed out", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("tab", { name: /GitHub 서버/ }));
  expect(screen.getByLabelText("GitHub servers")).toBeInTheDocument();
  expect(screen.queryByLabelText("GitHub login")).toBeNull();
});

it("returns from Settings to Yonalist", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Close settings" }));
  expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();
  expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("notes");
});
```

Retain the existing Vault-change tests that prove current Notes drafts flush
before changing `vaultFolder`, stale picker responses cannot overwrite a newer
choice, and a failed drain leaves the current Vault selected. Remove every
fixture, fetch route, assertion, and mock that exists only for work items,
standalone Notifications, comments, details, repositories, Inbox cache,
prefetch, or GitHub outbox.

- [ ] **Step 9: Collapse `App.tsx` onto the surviving shell**

Start from the current file and remove the complete legacy slice:

```text
Item/notification/outbox imports, state, refs, memoized projections, and handlers
Inbox Vault load and index reconciliation effects
work item, repository, visibility, count, detail, thread, and prefetch hooks
standalone Notifications selection/detail and app badge
detail render snapshots, revalidation, and Inbox performance metrics
new issue and comment/reply queue handlers
renderInboxPanes
AuthRestorePage, LoginPage, and requiresGithubAuth render branches
Inbox outbox modal and reconnect confirmation
```

Mount Task 1's runtime with:

```ts
const githubNotificationsRuntime = useGithubNotificationsRuntime({
  connection: auth.connection,
  authState: authGate.state,
  account: authGate.account,
  online,
  pluginEnabled: settings.githubNotificationsPluginEnabled,
  desktopNotificationsEnabled: settings.desktopNotifications,
  readRetentionDays: settings.githubNotificationsReadRetentionDays
});
```

Pass `githubNotificationsRuntime.externalSources` to
`ExternalSourcesContext.Provider`. Keep `GithubConnectionContext` because
`MarkdownBody` still uses authenticated remote-image resolution.

Use this Vault fallback in both the current-root calculation and folder-change
calculation:

```ts
const vaultRoot =
  settings.vaultFolder.trim() || defaultSettings.vaultFolder;
```

`closeSettings()` selects `"notes"`. The settings renderer no longer receives
repository or project-visibility props. `FeatureRuntime.renderPanes` receives
only `{ renderSettingsPanes }`.

- [ ] **Step 10: Simplify the Settings reset path**

Remove `vaultRoot` from `UseSettingsResetOptions` and
`ResetApplicationDataOptions`. Remove the `vault-cache` step and the
`clear_vault_cache` Tauri invocation. Clear only the surviving runtime caches:

```ts
clearNotificationCache();
clearImageProxyCache();
```

The reset flow intentionally removes all `yonalist.*` browser keys because the
user explicitly chose “Reset settings and caches”; it does not call any
`notes_*` delete command and does not touch the filesystem. Change its final
message to:

```text
Reset complete. Yonalist notes and attachments were kept.
```

Change the Settings explanation and confirmation to say that Yonalist notes
and attachments are kept. Remove repository, avatar, index, Vault Markdown, and
outbox wording.

- [ ] **Step 11: Run the shell, settings, and reset tests**

Run:

```bash
npm test -- \
  src/features/core/featureSelection.test.ts \
  src/features/core/featureRegistry.test.tsx \
  src/features/core/useFeatureRuntimeHost.test.tsx \
  src/components/Sidebar.test.tsx \
  src/components/AppStatusBar.test.tsx \
  src/components/SettingsCategoryPane.test.tsx \
  src/components/SettingsPage.test.tsx \
  src/components/SettingsFormControls.test.tsx \
  src/appSettings.test.ts \
  src/services/appReset.test.ts \
  src/AppNavigationContext.test.tsx \
  src/App.test.tsx \
  src/App.featureActivationTiming.test.tsx \
  src/App.featurePaneMemo.test.tsx \
  src/App.lazyFeatureRuntime.test.tsx
```

Expected: PASS.

- [ ] **Step 12: Commit the shell pivot**

```bash
git add src
git commit -m "refactor(app): remove GitHub Inbox shell"
```

---

### Task 3: Delete the unreachable Inbox frontend and trim shared modules

**Files:**

- Delete: every frontend path listed under “Frontend files to delete”
- Modify: `src/services/notifications.ts`
- Modify: `src/services/notifications.test.ts`
- Modify: `src/services/githubNotificationsProvider.test.ts`
- Modify: `src/services/imageProxy.ts`
- Modify: `src/services/imageProxy.test.ts`
- Modify: `src/components/ui/dialog.css`
- Modify: `src/styles.css`
- Modify: `src/styles.test.ts`
- Modify: `src/hooks/useNavigationListAccent.test.tsx`
- Modify: `src/test/setup.ts`

**Interfaces:**

- Consumes: the shell and GN boundary from Tasks 1–2.
- Produces: no frontend import or storage key for Inbox items, details,
  repositories, avatars, outbox, or `index.sqlite`.
- Preserves: GN notification types/projection, authenticated remote Markdown
  images, generic Markdown rendering, generic dialogs, and Notes styling.

- [ ] **Step 1: Record the surviving reverse-reference baseline**

Run:

```bash
rg -l \
  'ItemDetail|ItemListPane|NewIssuePage|NotificationDetail|NotificationsPane|OutboxModal|useOutboxSync|useWorkItems|vaultStore|vaultIndexReconcile|githubItems|projectVisibilityStore' \
  src --glob '*.{ts,tsx}'
```

Expected: only the files scheduled for deletion in this task. If `App.tsx`,
Settings, or the new GN directory appears, Task 2 is incomplete and this task
must stop before deleting files.

- [ ] **Step 2: Delete the listed components, hooks, domains, fixtures, services, and tests**

Delete the exact paths from “Frontend files to delete”. Do not delete
`src/components/MarkdownBody.tsx`, `src/domain/dateGroups.ts`,
`src/domain/externalSources.ts`, `src/domain/notifications.ts`,
`src/services/githubTransport.ts`, `src/services/notifications.ts`,
`src/services/imageProxy.ts`, or the Yonalist GN modules.

- [ ] **Step 3: Point notification errors directly at the retained transport**

Change:

```ts
import { GitHubRequestError } from "./github";
```

to:

```ts
import { GitHubRequestError } from "./githubTransport";
```

in `src/services/notifications.ts`. Remove `getNotificationCacheStats`,
`cacheStatsMemo`, `invalidateCacheStats`, and the `cacheStats` imports. Keep
`clearNotificationCache`, both fetch paths, conditional-probe protection,
in-flight coalescing, and `markNotificationRead`.

Delete the cache-stat-only assertion from
`githubNotificationsProvider.test.ts`; keep every projection, fetch,
deduplication, completion, and strict-decoding test.

- [ ] **Step 4: Remove avatar persistence from the shared image proxy**

In `imageProxy.ts`, retain only:

```text
resolvedCache
inflight
failedCache
FAILED_IMAGE_RETRY_INTERVAL_MS
clearImageProxyCache
needsAuthenticatedFetch
arrayBufferToBase64
fetchAsDataUrl
recordImageFailure
resolveAuthenticatedImage
```

Delete the avatar cache key, avatar types, browser storage, native
`load/store/touch_cached_avatar_image` calls, one-hour refresh policy, and
avatar in-flight map. In `clearImageProxyCache`, clear only the three retained
caches.

Keep the `needsAuthenticatedFetch` and `resolveAuthenticatedImage` test groups.
Delete the avatar test group and `imageProxy.tauri.test.ts`.

- [ ] **Step 5: Remove dead CSS without touching Yonalist geometry**

Delete the standalone `ItemListPane.css`, `NotificationsPane.css`,
`composer-dock.css`, and `tabs.css` files. Remove the `.outbox-checkbox*`
rules from `components/ui/dialog.css`; Notes dialogs still import the rest.

Remove only these selector families from `styles.css`:

```text
.status-outbox-button*
.item-state-*
.item-sort-*
.item-list*
.item-date-row*
.item-card*
.item-meta*
.item-footer*
.item-time*
.item-title*
.item-label*
.item-repo*
.item-comments*
.item-row-actions*
.item-sync-pending*
.detail-render-snapshot*
.state-badge*
.avatar*
.comment-*
.label-chip*
.notifications-pane*
.notifications-header*
.notifications-toggle*
.notifications-search*
.notifications-note*
.notifications-list*
.notifications-date-row*
.notifications-open-all*
.outbox-*
```

Keep shared `.detail-pane`, `.detail-scroll`, `.detail-loading`,
`.notifications-error`, `.settings-*`, `.markdown-body`, `.chip`, and every
`.notes-*`/outline selector. Update `styles.test.ts` so it asserts current
shell, Settings, Markdown, and Notes contracts only.

- [ ] **Step 6: Update the remaining small test seams**

Remove Avatar-specific mocks and cleanup from `src/test/setup.ts`. Change
`useNavigationListAccent.test.tsx` fixture keys from `inbox:all` and
`repo:pi/agent-dev` to `workspace:notes` and `app:settings`; the hook itself
stays.

- [ ] **Step 7: Prove the retained shared services**

Run:

```bash
npm test -- \
  src/domain/notifications.test.ts \
  src/services/notifications.test.ts \
  src/services/githubTransport.test.ts \
  src/services/githubNotificationsProvider.test.ts \
  src/services/imageProxy.test.ts \
  src/components/MarkdownBody.test.tsx \
  src/markdownRender.test.ts \
  src/styles.test.ts \
  src/hooks/useNavigationListAccent.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Prove that no deleted frontend boundary remains**

Run:

```bash
rg -n \
  'InboxFeature|renderInboxPanes|useOutboxSync|create_issue|create_comment|list_outbox_markdown_files|list_vault_item_index|yonalist\\.favorites|yonalist\\.projectVisibility|yonalist\\.repositorySummaries|yonalist\\.notifications\\.(hidden|details)|yonalist\\.avatarImages' \
  src
```

Expected: no matches.

Then run:

```bash
npm run lint
npm run build
```

Expected: both PASS.

- [ ] **Step 9: Commit the frontend dead-code removal**

```bash
git add -A src
git commit -m "refactor(inbox): delete legacy frontend stack"
```

---

### Task 4: Remove Inbox SQLite, Vault IPC, and avatar-cache commands

**Files:**

- Delete: `src-tauri/src/vault_index_reconcile.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/permissions/main-window.toml`
- Delete: the 19 autogenerated permission files listed above
- Regenerate: `src-tauri/gen/schemas/acl-manifests.json`
- Regenerate: `src-tauri/gen/schemas/capabilities.json`
- Regenerate: `src-tauri/gen/schemas/desktop-schema.json`
- Regenerate: `src-tauri/gen/schemas/macOS-schema.json`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**

- Consumes: no Inbox frontend IPC after Task 3.
- Produces: a native command manifest containing auth, URL/image, performance,
  and Yonalist commands only.
- Preserves: `NOTES_DATA_ROOT`, `expand_vault_path`, `metadata_dir`,
  `file_io`, `fetch_image`, OAuth/session-token commands, notification plugin,
  and every `notes_*` command.

- [ ] **Step 1: Add a failing native manifest test that excludes Inbox commands**

In the existing `src-tauri/src/lib.rs` test module, replace the two
Inbox-blocking-pool tests with:

```rust
#[test]
fn github_inbox_commands_are_absent_from_native_contracts() {
    let removed = [
        "ensure_vault",
        "read_text_file",
        "write_text_file",
        "delete_text_file",
        "move_text_file",
        "list_outbox_markdown_files",
        "list_vault_item_index",
        "upsert_vault_item_index",
        "get_vault_document_hash",
        "upsert_vault_document_hash",
        "persist_vault_documents",
        "delete_vault_document_hash",
        "move_vault_document_hash",
        "clear_vault_cache",
        "scan_vault_item_index_changes",
        "commit_vault_item_index_changes",
        "load_cached_avatar_image",
        "store_cached_avatar_image",
        "touch_cached_avatar_image",
    ];
    let registered = registered_app_commands();
    let manifest = manifest_app_commands();
    for command in removed {
        assert!(!registered.iter().any(|value| value == command));
        assert!(!manifest.iter().any(|value| value == command));
    }
}
```

Keep `application_manifest_covers_every_registered_command_exactly_once`,
`application_commands_are_granted_only_to_local_main_window`, and
`external_notes_commands_are_registered_once_and_granted_only_to_local_main_window`.

- [ ] **Step 2: Run the native contract test and confirm it fails**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  github_inbox_commands_are_absent_from_native_contracts
```

Expected: FAIL because all 19 commands are still registered.

- [ ] **Step 3: Remove the Inbox native storage implementation**

Delete `mod vault_index_reconcile`, `INDEX_DATA_ROOT`, the reconcile imports,
and these complete areas from `lib.rs`:

```text
VaultPaths
VaultMarkdownFile
VaultPersistDocument
VaultPersistResult
VaultItemIndexRecord
CachedAvatarImage
vault_paths
index storage directory and SQLite connection/schema helpers
index cache path and file helpers
resolve_vault_file
Markdown/outbox collection
all Vault item/document hash persistence
all item-index read/write/reconcile operations
clear_vault_cache
all avatar cache parsing/read/write/touch operations
the async Tauri wrappers for the 19 removed commands
their invoke-handler entries
their unit and security tests
```

Keep these shared path helpers because Notes imports them:

```rust
fn expand_vault_path(vault_path: &str) -> PathBuf;
pub(crate) fn metadata_dir(vault_path: &str) -> PathBuf;
pub(crate) static NOTES_DATA_ROOT: OnceLock<PathBuf>;
```

Keep `mod file_io`; remove only the now-unused
`use file_io::{ensure_parent, write_text_file_inner};` import from `lib.rs`.
Remove the `INDEX_DATA_ROOT.set(app_data_root.join("indexes"))` setup block.

- [ ] **Step 4: Shrink the application command manifest and permission set**

Remove the same 19 command strings from `src-tauri/build.rs` and the matching
`allow-*` entries from `src-tauri/permissions/main-window.toml`. Remove
`core:window:allow-set-badge-count` from
`src-tauri/capabilities/default.json` because Task 3 deleted the application
badge.

Delete the 19 autogenerated permission TOML files listed in the target map.
Do not remove these surviving commands:

```text
session_token_storage_backend
store_token
load_token
delete_token
oauth_start
oauth_wait
oauth_exchange
open_url
open_external_url
fetch_image
record_perf_event
all notes_* commands
```

- [ ] **Step 5: Regenerate Tauri ACL schemas through the build**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked
```

Expected: PASS and regenerated schema files no longer contain any removed
command or permission identifier. Do not hand-edit the four JSON schema files.

- [ ] **Step 6: Update the package description**

Change the Cargo package description from:

```toml
description = "Offline-first GitHub issue and pull request client"
```

to:

```toml
description = "Local-first outliner with pluggable external sources"
```

- [ ] **Step 7: Prove the native boundary**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  github_inbox_commands_are_absent_from_native_contracts
cargo test --manifest-path src-tauri/Cargo.toml \
  application_manifest_covers_every_registered_command_exactly_once
cargo test --manifest-path src-tauri/Cargo.toml \
  application_commands_are_granted_only_to_local_main_window
cargo test --manifest-path src-tauri/Cargo.toml \
  external_notes_commands_are_registered_once_and_granted_only_to_local_main_window
```

Expected: PASS.

Run the residue scan:

```bash
rg -n \
  'INDEX_DATA_ROOT|index\\.sqlite|item_index|document_hashes|avatar_cache|outbox|ensure_vault|vault_index_reconcile|cached_avatar' \
  src-tauri/src src-tauri/build.rs src-tauri/permissions src-tauri/gen/schemas
```

Expected: no Inbox implementation or permission matches. A test fixture or
historical error message under `src-tauri/src/notes/**` may mention a
development-only legacy `notes.sqlite`; that is not an Inbox match and stays.

- [ ] **Step 8: Commit the native removal**

```bash
git add -A src-tauri
git commit -m "refactor(inbox): remove native index and IPC"
```

---

### Task 5: Update current documentation while preserving the reconstruction record

**Files:**

- Modify: `README.md`
- Modify: `docs/yonalist-architecture/index.html`
- Create: `docs/yonalist-architecture/README.md`
- Modify if implementation names differ: `docs/superpowers/specs/2026-07-27-github-inbox-removal-and-yonalist-boundary-design.md`

**Interfaces:**

- Consumes: final module names and commands from Tasks 1–4.
- Produces: a current product overview plus an explicit legacy-architecture
  archive pointer.
- Preserves: all old GitHub Inbox diagrams and the detailed reconstruction
  sections in the approved design document.

- [ ] **Step 1: Replace the README product and architecture summary**

Describe Yonalist as the primary local-first outliner. The current feature list
must include:

```text
Yonalist outline editing and Notes SQLite storage
Yonalist Markdown and attachment synchronization
GN as a bundled external-source plugin
GitHub server/authentication settings
GN desktop notifications
```

Delete current-product claims about issue/PR lists, standalone Notifications,
comments, GitHub outbox, Inbox Markdown persistence, Inbox cache/index, and
Projects visibility. Link the removed design to:

```text
docs/superpowers/specs/2026-07-27-github-inbox-removal-and-yonalist-boundary-design.md
```

- [ ] **Step 2: Mark the old visual architecture as a legacy snapshot**

Add a visible banner near the top of `docs/yonalist-architecture/index.html`:

```html
<p class="legacy-notice">
  이 자료는 제거 전 GitHub Inbox 구조를 기록한 역사 자료입니다.
  현재 Yonalist 구조와 제거 결정은 2026-07-27 설계 문서를 따릅니다.
</p>
```

Do not delete or redraw the existing runtime and outbox SVGs. They are evidence
for reconstructing the old design.

Create `docs/yonalist-architecture/README.md` with links to the visual archive
and the 2026-07-27 design document. State that the latter is authoritative for
both the old reconstruction contract and the new Yonalist boundary.

- [ ] **Step 3: Reconcile implementation names with the design**

Search:

```bash
rg -n \
  'useGithubNotificationsRuntime|githubNotificationViewedStore|notes-assets|INDEX_DATA_ROOT|renderInboxPanes' \
  docs/superpowers/specs/2026-07-27-github-inbox-removal-and-yonalist-boundary-design.md \
  src src-tauri
```

If the implementation used the planned names, add those exact paths to the
target-structure section. If a name changed during implementation, update the
design to the actual committed name and keep the documented responsibility
unchanged. Do not remove sections 4.13–4.28, the GitHub outbox protocol, schema,
API, or reconstruction order.

- [ ] **Step 4: Validate the documentation residue**

Run:

```bash
rg -n \
  'Offline-first GitHub issue|GitHub Inbox|Projects 표시|create_issue|create_comment|index\\.sqlite|\\.yonalist/outbox' \
  README.md docs/yonalist-architecture src-tauri/Cargo.toml
```

Expected: legacy terms appear only inside the clearly marked visual archive or
its README; the root README and Cargo description describe the current
Yonalist product.

- [ ] **Step 5: Commit the documentation update**

```bash
git add \
  README.md \
  docs/yonalist-architecture \
  docs/superpowers/specs/2026-07-27-github-inbox-removal-and-yonalist-boundary-design.md
git commit -m "docs: mark GitHub Inbox architecture as legacy"
```

---

### Task 6: Delete the existing development Inbox data once

**Files:**

- Delete from the local machine, not Git:
  `/Users/doortts/Library/Application Support/com.doortts.yonalist/indexes/`
- Delete from the current Vault:
  `/Users/doortts/Yonalist/.yonalist/index.sqlite*`
- Delete from the current Vault:
  `/Users/doortts/Yonalist/.yonalist/cache/avatars/`
- Delete from the current Vault:
  `/Users/doortts/Yonalist/.yonalist/outbox/`
- Delete only validated depth-four Inbox kind directories under:
  `/Users/doortts/Yonalist/<github-host>/<owner>/<repo>/{issues,pulls,discussions}/`
- Remove exact Inbox-only localStorage keys and fields through Web Inspector.

**Interfaces:**

- Consumes: the desktop build from Tasks 1–5, which no longer writes Inbox data.
- Produces: no existing Inbox database, Markdown item, avatar cache, or outbox
  operation on this development machine.
- Preserves: every Yonalist database, asset, Markdown file, GN materialized
  file, GitHub credential/server key, GN snapshot, and viewed timestamp.

- [ ] **Step 1: Stop every Yonalist process before touching SQLite**

Quit the development app and any packaged Yonalist app. Run:

```bash
pgrep -fl 'Yonalist.app/Contents/MacOS/Yonalist|target/.*/yonalist'
```

Expected: no output. If a process appears, stop it and rerun the command.

- [ ] **Step 2: Capture a read-only deletion inventory**

Use exact absolute roots:

```bash
APP_DATA='/Users/doortts/Library/Application Support/com.doortts.yonalist'
VAULT_ROOT='/Users/doortts/Yonalist'

find "$APP_DATA/indexes" -maxdepth 3 -print 2>/dev/null | sort
find "$VAULT_ROOT/.yonalist" -maxdepth 4 \
  \( -name 'index.sqlite*' -o -path '*/cache/avatars*' -o -path '*/outbox*' \) \
  -print 2>/dev/null | sort
find "$VAULT_ROOT" -mindepth 4 -maxdepth 4 -type d \
  \( -name issues -o -name pulls -o -name discussions \) -print | sort
```

Expected on the inspected 2026-07-27 baseline: three app-data index roots,
legacy `index.sqlite`, avatar files, one outbox operation, and GitHub
issue/pull/discussion directories.

- [ ] **Step 3: Validate that candidate Markdown belongs to Inbox**

For each directory returned by the final `find`, inspect only Markdown inside
that directory:

```bash
while IFS= read -r directory; do
  while IFS= read -r -d '' file; do
    if ! rg -q '^kind: (issue|pull|discussion|issue_comment)$' "$file"; then
      printf '%s\n' "$file"
    fi
  done < <(find "$directory" -type f -name '*.md' -print0)
done < <(
  find "$VAULT_ROOT" -mindepth 4 -maxdepth 4 -type d \
    \( -name issues -o -name pulls -o -name discussions \) -print | sort
)
```

Expected: no output. Every Markdown file in the candidate directories has an
Inbox kind. Do not include Vault-root files such as
`Github-Notifications.<id>.md`, `trash.md`, or normal Yonalist documents in
the candidate set.

- [ ] **Step 4: Delete the exact native and Vault Inbox targets**

Guard the two destructive roots before deleting:

```bash
APP_DATA='/Users/doortts/Library/Application Support/com.doortts.yonalist'
VAULT_ROOT='/Users/doortts/Yonalist'

test "$APP_DATA" = '/Users/doortts/Library/Application Support/com.doortts.yonalist'
test "$VAULT_ROOT" = '/Users/doortts/Yonalist'

rm -rf "$APP_DATA/indexes"
rm -f \
  "$VAULT_ROOT/.yonalist/index.sqlite" \
  "$VAULT_ROOT/.yonalist/index.sqlite-wal" \
  "$VAULT_ROOT/.yonalist/index.sqlite-shm" \
  "$VAULT_ROOT/.yonalist/index.sqlite-journal"
rm -rf "$VAULT_ROOT/.yonalist/cache/avatars"
rm -rf "$VAULT_ROOT/.yonalist/outbox"
```

Delete only the validated depth-four kind directories. Resolve the exact list
first and refuse any other depth or final component:

```bash
while IFS= read -r directory; do
  relative=${directory#"$VAULT_ROOT/"}
  depth=$(awk -F/ '{print NF}' <<<"$relative")
  leaf=${directory##*/}
  test "$depth" -eq 4
  case "$leaf" in
    issues|pulls|discussions) ;;
    *) exit 1 ;;
  esac
  rm -rf "$directory"
done < <(
  find "$VAULT_ROOT" -mindepth 4 -maxdepth 4 -type d \
    \( -name issues -o -name pulls -o -name discussions \) -print | sort
)
```

This is the authorized one-time development cleanup. Do not add these commands
to application startup.

- [ ] **Step 5: Remove Inbox-only browser data without clearing GN/auth**

Start the newly built app once with Web Inspector attached. Run this exact
snippet in its console:

```js
[
  "yonalist.favorites.v1",
  "yonalist.projectVisibility.v1",
  "yonalist.repositorySummaries.v1",
  "yonalist.repositoryOpenCounts.v1",
  "yonalist.vaultDocuments.v1",
  "yonalist.vaultDocumentHashes.v1",
  "yonalist.notifications.hidden.v1",
  "yonalist.notifications.details.v1",
  "yonalist.avatarImages.v1"
].forEach((key) => window.localStorage.removeItem(key));

if (window.localStorage.getItem("yonalist.activeFeature.v1") === "inbox") {
  window.localStorage.removeItem("yonalist.activeFeature.v1");
}

const settingsKey = "yonalist.settings.v1";
const settings = JSON.parse(window.localStorage.getItem(settingsKey) ?? "{}");
for (const key of [
  "syncQueuedOnReconnect",
  "cacheLinkedAttachments",
  "downloadCommentsWhileSyncing",
  "prefetchVisibleItems"
]) {
  delete settings[key];
}
window.localStorage.setItem(settingsKey, JSON.stringify(settings));
```

Do not remove:

```text
yonalist.notifications.viewedAt.v1
yonalist.externalSources.snapshots.v1
yonalist.github.*
theme keys
GN plugin and retention settings
desktopNotifications
Vault and Notes settings
```

- [ ] **Step 6: Verify preserved Yonalist data and removed Inbox data**

Run:

```bash
test ! -e '/Users/doortts/Library/Application Support/com.doortts.yonalist/indexes'
test ! -e '/Users/doortts/Yonalist/.yonalist/index.sqlite'
test ! -e '/Users/doortts/Yonalist/.yonalist/outbox'
test ! -e '/Users/doortts/Yonalist/.yonalist/cache/avatars'

find '/Users/doortts/Library/Application Support/com.doortts.yonalist/notes' \
  -name 'notes.sqlite' -type f -print
test -d '/Users/doortts/Yonalist/.yonalist/notes-assets'
test -f '/Users/doortts/Yonalist/Github-Notifications.6983f947.md'
```

Expected: all four absence checks pass, Notes databases are listed, the Notes
asset directory remains, and the GN materialized Yonalist Markdown remains.

This task changes no tracked file and therefore has no commit.

---

### Task 7: Prove a fresh desktop runtime and freeze the final diff

**Files:**

- No planned production edits
- Update tests only if fresh runtime evidence exposes a contract violation

**Interfaces:**

- Consumes: the frozen code and cleaned development data from Tasks 1–6.
- Produces: direct proof that Yonalist and GN work and Inbox data is not
  recreated.

- [ ] **Step 1: Build and start a fresh Tauri process**

Run:

```bash
npm run tauri:build
```

Expected: PASS. Quit any older development process before opening the newly
built bundle. Confirm the running binary belongs to this build, not a previous
`tauri dev` session.

- [ ] **Step 2: Exercise the unauthenticated shell**

With GitHub signed out:

```text
1. Launch the fresh bundle.
2. Confirm Yonalist opens without a GitHub login page.
3. Confirm the Sidebar shows Yonalist and Settings only.
4. Open Settings and then GitHub 서버.
5. Return to Yonalist and edit one existing ordinary bullet.
6. Restart and confirm the edit persists.
```

Expected: every step succeeds; no Inbox, standalone Notifications, project
filter, or outbox control appears.

- [ ] **Step 3: Exercise GN projection and the existing link button**

With a validated GitHub account and the GN plugin enabled:

```text
1. Expand the GitHub Notifications root or zoom into it.
2. Confirm a GitHub Notifications request starts.
3. Confirm the fetched rows materialize into Yonalist.
4. Use the existing link button on one GN row.
5. Confirm the corresponding safe GitHub URL opens.
6. Complete one unread GN row and confirm the remote read PATCH occurs once.
```

Expected: GN remains inside Yonalist and never opens a removed internal
Notifications detail screen.

- [ ] **Step 4: Exercise GN and desktop-notification gates**

Verify these rows:

| Plugin | Auth/account | Online | Desktop setting | Projection lease | Expected |
| --- | --- | --- | --- | --- | --- |
| off | yes | yes | on | yes | no GN fetch, materialization, or desktop probe |
| on | no | yes | on | yes | no authenticated GN work |
| on | yes | no | on | yes | cached Yonalist rows only; no remote work |
| on | yes | yes | off | yes | GN fetch/materialization, no desktop probe |
| on | yes | yes | on | no | desktop probe active, projection fetch lease inactive |
| on | yes | yes | on | yes | GN projection and desktop probe active |

- [ ] **Step 5: Confirm deleted data is not recreated**

Quit the app and run:

```bash
test ! -e '/Users/doortts/Library/Application Support/com.doortts.yonalist/indexes'
test ! -e '/Users/doortts/Yonalist/.yonalist/index.sqlite'
test ! -e '/Users/doortts/Yonalist/.yonalist/outbox'
test ! -e '/Users/doortts/Yonalist/.yonalist/cache/avatars'
```

Expected: all PASS after a full launch, GN refresh, Yonalist edit, and restart.

- [ ] **Step 6: Run the complete final gates once**

Run:

```bash
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
git diff --check
```

Expected: all PASS. Do not rerun a known flaky test to manufacture a pass;
record the exact baseline if one is pre-existing.

- [ ] **Step 7: Run final residue and preservation scans**

Run:

```bash
rg -n \
  'InboxFeature|renderInboxPanes|activeFeatureId === "inbox"|useOutboxSync|create_issue|create_comment|list_outbox_markdown_files|list_vault_item_index|INDEX_DATA_ROOT|avatar_cache' \
  src src-tauri README.md

rg -n \
  'useGithubNotificationsRuntime|fetchNotifications|markNotificationRead|notes_refresh_materialized_github_notifications|notes_mark_materialized_github_notification_read|plugin\\(tauri_plugin_notification::init\\)' \
  src src-tauri
```

Expected: the first scan has no current-product implementation matches. The
second scan shows the GN runtime, provider operations, Yonalist native bridge,
and desktop notification plugin.

- [ ] **Step 8: Review the final diff and commit any verification-only fixes**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only intentional tracked changes and the pre-existing untracked
`.pnpm-store/`. If the desktop proof required a code or test correction, stage
only the paths shown for that correction by `git diff --name-only`, then commit
it:

```bash
git commit -m "fix(gn): preserve runtime after Inbox removal"
```

If no correction was needed, create no empty commit.

## Completion record

At handoff, report:

```text
Feature registry and default route evidence
GN projection, completion, link, and desktop-notification evidence
Frontend and native residue scan results
Exact deleted development-data roots
Exact preserved Notes databases/assets and GN materialized Markdown
Final frontend and Rust gate results
Fresh bundle/process proof
Commit hashes
Any pre-existing failure or warning
```
