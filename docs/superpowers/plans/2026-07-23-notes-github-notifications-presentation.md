# Notes Github Notifications Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes의 `Github Notifications` 가상 루트에서 GitHub 알림을 갱신 가능한 날짜 부모 아래 항상 펼쳐진 읽기 전용 블릿으로 표시하고, Type 아이콘·Notifications 부제·외부 웹 열기를 제공한다.

**Architecture:** 기존 `ExternalBullet.parentKey`로 날짜와 알림의 2단계 투영을 만들고, 매 원본 스냅샷에서 `groupNotificationsByDate`를 다시 호출한다. 기존 Notifications 부제와 URL 열기 경로를 공유하며 Notes UI는 제공자 중립적인 `icon`, `parentKey`, capability만 렌더링한다. 범용 재귀 트리, 새 상태 머신, 새 의존성은 만들지 않는다.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, Lucide React, Vite 8, Tauri 2

## Global Constraints

- Notes 가상 루트 이름은 정확히 `Github Notifications`다. 기존 좌측 전역 `Notifications` pane 이름은 바꾸지 않는다.
- 날짜 부모는 `Today`, `Yesterday`, `MM.DD`, `YYYY.MM.DD` 규칙을 쓰고 항상 펼쳐 둔다.
- 자동 폴링, 수동 새로고침, 부분 결과, 완료 스냅샷 갱신 때마다 최신 `updated_at`과 현재 로컬 날짜로 그룹과 순서를 다시 만든다.
- 외부 알림은 `notes.sqlite`, Notes 검색, 태그, Undo/Redo, 휴지통, 저장, 내보내기에 넣지 않는다.
- GitHub `unread`만 완료 상태의 원본이며 웹 열기나 행 선택은 PATCH를 보내지 않는다.
- 기존 완료 중복 방어, 성공 후 표시, 실패 재시도, 오프라인 캐시, 계정 격리를 유지한다.
- 기존 `groupNotificationsByDate`, `notificationWebUrl`, `timeAgo`, `openExternal`과 설치된 Lucide 아이콘을 재사용한다.
- 새 패키지, 범용 트리 추상화, 설치형 플러그인 계약을 추가하지 않는다.
- 기존 `.superpowers/sdd/*.md` 변경은 다른 작업 소유이므로 스테이징하거나 수정하지 않는다.
- 구체 구현은 사용자가 요청한 5.6 Luna xHigh 실행 모드로 수행한다.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/domain/notifications.ts`, `src/components/NotificationsPane.tsx` | 두 화면이 공유할 부제를 계산하고 기존 Notifications 표현을 유지한다. |
| `src/domain/externalSources.ts` | 제공자 중립적인 선택적 Type 아이콘을 선언한다. |
| `src/services/githubNotificationsProvider.ts` | 최신 raw snapshot을 날짜 부모와 알림 자식으로 다시 투영한다. |
| `src/features/notes/NotesExternalOutlinePane.tsx` | `parentKey`로 2단계 계층을 항상 펼쳐 렌더링한다. |
| `src/features/notes/NotesExternalBulletRow.tsx`, `src/features/notes/notes.css` | Type 아이콘, 상시 note, 웹 아이콘과 들여쓰기를 표시한다. |
| `src/services/externalSourceRegistry.ts`, `src/App.tsx` | 새 이름, `viewedAt`, 외부 브라우저 열기와 갱신 재투영을 연결한다. |
| 대응 `*.test.*` 파일 | 각 작업의 RED/GREEN과 회귀를 고정한다. |

---

### Task 1: Share the Existing Notification Subtitle

**Files:**
- Modify: `src/domain/notifications.ts:1-92`
- Modify: `src/domain/notifications.test.ts:1-95`
- Modify: `src/components/NotificationsPane.tsx:19-81, 139-145`

**Interfaces:**
- Consumes: `timeAgo(iso: string, now?: Date): string` and `GitHubNotification`.
- Produces: `notificationSubtitle(notification, viewedAt?, now?): string`.

- [ ] **Step 1: Write failing tests**

Add `notificationSubtitle` to the domain test imports and add:

```ts
describe("notificationSubtitle", () => {
  const now = new Date("2026-07-03T12:00:00Z");

  it("uses repository, activity, and local seen first", () => {
    expect(notificationSubtitle(
      notification({
        updated_at: "2026-07-03T03:00:00Z",
        last_read_at: "2026-07-03T04:00:00Z"
      }),
      "2026-07-03T06:00:00Z",
      now
    )).toBe("Home, 9h ago, seen 6h ago");
  });

  it("falls back to last_read_at and omits missing seen", () => {
    expect(notificationSubtitle(
      notification({ last_read_at: "2026-07-03T04:00:00Z" }),
      undefined,
      now
    )).toBe("Home, 1d ago, seen 8h ago");
    expect(notificationSubtitle(
      notification({ last_read_at: null }),
      undefined,
      now
    )).toBe("Home, 1d ago");
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/domain/notifications.test.ts
```

Expected: FAIL because `notificationSubtitle` is not exported.

- [ ] **Step 3: Implement the shared helper**

Import `timeAgo` in `src/domain/notifications.ts` and add:

```ts
export function notificationSubtitle(
  notification: GitHubNotification,
  viewedAt?: string,
  now: Date = new Date()
): string {
  const parts = [notification.repository.name];
  const updated = timeAgo(notification.updated_at, now);
  if (updated) parts.push(updated);
  const seenAt = viewedAt ?? notification.last_read_at;
  const seen = seenAt ? timeAgo(seenAt, now) : "";
  if (seen) parts.push("seen " + seen);
  return parts.join(", ");
}
```

Delete the private `subtitle` function and direct `timeAgo` import from `NotificationsPane.tsx`. Import the helper and render:

```tsx
<span className="notification-subtitle">
  {notificationSubtitle(notification, viewedAtValue)}
</span>
```

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- src/domain/notifications.test.ts src/components/NotificationsPane.test.tsx
```

Expected: both files PASS and existing Notifications copy is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/domain/notifications.ts src/domain/notifications.test.ts src/components/NotificationsPane.tsx
git commit -m "refactor(notifications): share row subtitle"
```

---

### Task 2: Project Refreshable Date Parents and Typed Children

**Files:**
- Modify: `src/domain/externalSources.ts:1-24`
- Modify: `src/services/githubNotificationsProvider.ts:1-255`
- Modify: `src/services/githubNotificationsProvider.test.ts:1-370`

**Interfaces:**
- Consumes: `groupNotificationsByDate`, `notificationSubtitle`, `notificationWebUrl` and `subjectNumber`.
- Produces: `ExternalBulletIcon`, `GITHUB_NOTIFICATIONS_PROVIDER_TITLE` and ordered date-root/notification-child bullets.

- [ ] **Step 1: Write failing projection tests**

Add local-time fixtures and assert the exact hierarchy:

```ts
it("projects date parents and typed children", () => {
  const projected = projectGithubNotifications(
    [
      notification("today-pr", {
        updated_at: "2026-07-22T10:00:00",
        last_read_at: "2026-07-22T06:00:00",
        subject: {
          title: "Review the patch",
          url: "https://api.github.com/repos/acme/yonalist/pulls/21",
          type: "PullRequest"
        }
      }),
      notification("yesterday", {
        updated_at: "2026-07-21T10:00:00"
      })
    ],
    connectionId,
    30,
    new Date("2026-07-22T12:00:00"),
    connection.webBaseUrl,
    {
      "https://github.com/acme/yonalist/pull/21":
        "2026-07-22T06:00:00"
    }
  );

  expect(projected.map((bullet) => bullet.title)).toEqual([
    "Today",
    "Review the patch #21",
    "Yesterday",
    "Fix inline caret #17"
  ]);
  expect(projected[0]).toMatchObject({
    key: { remoteId: "date:2026.07.22" },
    parentKey: null,
    note: "",
    capabilities: {
      expand: false,
      openDetails: false,
      complete: false
    }
  });
  expect(projected[1]).toMatchObject({
    parentKey: projected[0].key,
    icon: "pull-request",
    note: "yonalist, 2h ago, seen 6h ago",
    capabilities: {
      expand: false,
      openDetails: true,
      complete: true
    }
  });
});
```

Add the refresh and local-date boundary tests:

```ts
it("rebuilds membership and removes an empty group after refresh", () => {
  const before = notification("moving", {
    updated_at: "2026-07-21T10:00:00"
  });
  const after = {
    ...before,
    updated_at: "2026-07-22T11:00:00"
  };
  const first = projectGithubNotifications(
    [before], connectionId, 30,
    new Date("2026-07-22T12:00:00"),
    connection.webBaseUrl
  );
  const second = projectGithubNotifications(
    [after], connectionId, 30,
    new Date("2026-07-22T12:00:00"),
    connection.webBaseUrl
  );

  expect(first.map((bullet) => bullet.title)).toEqual([
    "Yesterday", "Fix inline caret #17"
  ]);
  expect(second.map((bullet) => bullet.title)).toEqual([
    "Today", "Fix inline caret #17"
  ]);
  expect(second[1].parentKey).toEqual(second[0].key);
  expect(second.some(
    (bullet) => bullet.key.remoteId === "date:2026.07.21"
  )).toBe(false);
});

it("relabels parents at the next local-date projection", () => {
  const item = notification("boundary", {
    updated_at: "2026-07-22T10:00:00"
  });
  const today = projectGithubNotifications(
    [item], connectionId, 30,
    new Date("2026-07-22T23:59:00"),
    connection.webBaseUrl
  );
  const tomorrow = projectGithubNotifications(
    [item], connectionId, 30,
    new Date("2026-07-23T00:01:00"),
    connection.webBaseUrl
  );

  expect(today[0].title).toBe("Today");
  expect(tomorrow[0].title).toBe("Yesterday");
  expect(tomorrow[1].parentKey).toEqual(tomorrow[0].key);
});
```

Update retention expectations to inspect children only:

```ts
const ids = bullets
  .filter((bullet) => bullet.parentKey !== null)
  .map((bullet) => bullet.key.remoteId);
expect(ids).toEqual([boundaryRead.id, oldUnread.id]);
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/services/githubNotificationsProvider.test.ts
```

Expected: FAIL because the current projection is flat and has no icon or compact note.

- [ ] **Step 3: Add the minimal icon contract**

In `src/domain/externalSources.ts`:

```ts
export type ExternalBulletIcon =
  | "issue"
  | "pull-request"
  | "discussion"
  | "release"
  | "notification";

export interface ExternalBullet {
  readonly icon?: ExternalBulletIcon;
  readonly key: ExternalBulletKey;
  readonly parentKey: ExternalBulletKey | null;
  readonly title: string;
  readonly note: string;
  readonly updatedAt: string;
  readonly completed: boolean;
  readonly capabilities: {
    readonly expand: boolean;
    readonly openDetails: boolean;
    readonly complete: boolean;
    readonly uncomplete: boolean;
    readonly edit: false;
    readonly move: false;
    readonly delete: false;
    readonly createChild: false;
  };
}
```

- [ ] **Step 4: Rebuild the projection from each snapshot**

Export:

```ts
export const GITHUB_NOTIFICATIONS_PROVIDER_ID =
  "github-notifications";
export const GITHUB_NOTIFICATIONS_PROVIDER_TITLE =
  "Github Notifications";
```

Extend settings and validate local-storage input with the existing guards:

```ts
export interface GithubNotificationsProviderSettings {
  readonly readRetentionDays: number;
  readonly viewedAt: Readonly<Record<string, string>>;
}

function normalizedViewedAt(
  value: unknown
): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        isDateString(entry[1])
    )
  );
}
```

Use this signature so existing direct tests remain source-compatible while the provider supplies its real server base:

```ts
export function projectGithubNotifications(
  items: readonly GitHubNotification[],
  connectionId: string,
  readRetentionDays: number,
  now: Date,
  webBaseUrl = "https://github.com",
  viewedAt: Readonly<Record<string, string>> = {}
): readonly ExternalBullet[]
```

Replace the projection body with this algorithm:

```ts
const visible = items.filter(
  (item) =>
    item.unread ||
    Date.parse(item.updated_at) >= cutoff
);
const projected: ExternalBullet[] = [];

for (const group of groupNotificationsByDate([...visible], now)) {
  const groupKey: ExternalBulletKey = {
    providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
    connectionId,
    remoteId: "date:" + group.key
  };
  projected.push({
    key: groupKey,
    parentKey: null,
    title: group.label,
    note: "",
    updatedAt: group.notifications[0]?.updated_at ??
      now.toISOString(),
    completed: false,
    capabilities: {
      expand: false,
      openDetails: false,
      complete: false,
      uncomplete: false,
      edit: false,
      move: false,
      delete: false,
      createChild: false
    }
  });

  for (const item of group.notifications) {
    const number = subjectNumber(item.subject);
    const url = notificationWebUrl(item, webBaseUrl);
    projected.push({
      key: {
        providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
        connectionId,
        remoteId: item.id
      },
      parentKey: groupKey,
      icon: notificationIcon(item.subject.type),
      title: item.subject.title +
        (number === null ? "" : " #" + number),
      note: notificationSubtitle(item, viewedAt[url], now),
      updatedAt: item.updated_at,
      completed: !item.unread,
      capabilities: {
        expand: false,
        openDetails: true,
        complete: item.unread,
        uncomplete: false,
        edit: false,
        move: false,
        delete: false,
        createChild: false
      }
    });
  }
}
return projected;
```

`notificationIcon` maps Issue, PullRequest, Discussion, Release to the matching enum and unknown types to `notification`. `projectGithubNotifications` accepts `webBaseUrl` and optional `viewedAt = {}`. The provider passes its connection web base and normalized settings. Set provider `title` to the exported title constant.

- [ ] **Step 5: Verify GREEN**

```bash
npm test -- src/services/githubNotificationsProvider.test.ts src/services/externalSourceHost.test.ts
```

Expected: PASS. Host tests retain raw partial/failure behavior while pure projection tests prove every snapshot rebuilds grouping.

- [ ] **Step 6: Commit**

```bash
git add src/domain/externalSources.ts src/services/githubNotificationsProvider.ts src/services/githubNotificationsProvider.test.ts
git commit -m "feat(notes): group GitHub notifications by date"
```

---

### Task 3: Render Always-Open Groups, Typed Rows and Web Icon

**Files:**
- Modify: `src/features/notes/NotesExternalOutlinePane.tsx:1-134`
- Modify: `src/features/notes/NotesExternalBulletRow.tsx:1-142`
- Modify: `src/features/notes/notes.css:503-647, 2465-2505`
- Modify: `src/features/notes/NotesExternalOutlinePane.test.tsx:1-290`
- Modify: `src/features/notes/NotesExternalBulletRow.test.tsx:1-245`

**Interfaces:**
- Consumes: ordered bullets, `parentKey`, optional `icon`, `complete` and `openDetails`.
- Produces: a 2-level list with non-collapsible date parents and actionable children.

- [ ] **Step 1: Write failing UI tests**

Create a `Today` parent fixture with no capabilities and notification fixtures whose `parentKey` equals its key. Assert:

```ts
const group = screen.getByRole("group", {
  name: "Notifications for Today"
});
expect(within(group).getByText("Today"))
  .toBeInTheDocument();
expect(within(group).getByRole("button", {
  name: first.title
})).toBeInTheDocument();
expect(within(group).queryByRole("button", {
  name: /펼치기|접기/
})).toBeNull();
```

In row fixtures set `expand: false`, `icon: "pull-request"` and `note: "app, 2h ago, seen 1h ago"`. Assert the note is immediately visible, the accessible `Pull Request` icon exists, no disclosure button exists, and:

```ts
await user.click(screen.getByRole("button", {
  name: "웹에서 열기: " + unreadBullet.title
}));
expect(openDetails).toHaveBeenCalledWith(unreadBullet.key);
expect(complete).not.toHaveBeenCalled();
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx
```

Expected: FAIL because the list is flat, note is hidden, icon is missing and the action says `상세보기`.

- [ ] **Step 3: Render only two levels**

Build `childrenByParent` from serialized `parentKey` and `roots` from `parentKey === null`. For roots with children render:

```tsx
<li className="notes-external-group" key={rootKey}>
  <section aria-label={"Notifications for " + root.title}>
    <div className="notes-external-group-title">
      <span className="notes-external-bullet"
        aria-hidden="true" />
      <h3>{root.title}</h3>
    </div>
    <ol className="notes-external-children">
      {children.map((child) => (
        <NotesExternalBulletRow
          key={serializeExternalBulletKey(child.key)}
          bullet={child}
          completing={page.completingKeys.has(
            serializeExternalBulletKey(child.key)
          )}
          completionError={
            page.completionErrors[
              serializeExternalBulletKey(child.key)
            ] ?? null
          }
        />
      ))}
    </ol>
  </section>
</li>
```

Roots without children still use `NotesExternalBulletRow` so current empty/standalone behavior is not discarded.

- [ ] **Step 4: Render icons, inline note and web action**

Add `ExternalBulletLead` using existing `CircleDot`, `GitPullRequest`, `MessagesSquare`, `Tag` and `Bell`. Give each icon `role="img"` and labels `Issue`, `Pull Request`, `Discussion`, `Release`, `Notification`.

Keep generic expand support, but render a note when either the bullet is non-expandable or currently expanded:

```tsx
{bullet.note &&
  (!bullet.capabilities.expand || expanded) && (
    <div className="notes-external-note">{bullet.note}</div>
  )}
```

Replace the text action with:

```tsx
<IconTooltip label="웹에서 열기">
  <button
    className="notes-external-details"
    type="button"
    aria-label={"웹에서 열기: " + bullet.title}
    onClick={() => externalSources.openDetails(bullet.key)}
  >
    <Globe2 size={15} aria-hidden="true" />
  </button>
</IconTooltip>
```

- [ ] **Step 5: Apply minimal CSS**

Add these rules and replace the old note margin with the shown value:

```css
.notes-external-group,
.notes-external-children {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notes-external-group-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 3px 4px;
}

.notes-external-group-title h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.notes-external-children {
  margin-left: 28px;
}

.notes-external-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.notes-external-note {
  margin: 0 66px 7px 45px;
  color: var(--text-3);
  font-size: 14px;
  line-height: 20px;
}
```

In the existing mobile block, keep its right margin and change only the note's left margin to `45px`; add no breakpoint or JS measurement.

- [ ] **Step 6: Verify GREEN**

```bash
npm test -- src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx
```

Expected: PASS. Date groups are always open, child note is visible, Type icon is accessible and web click never completes.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/NotesExternalOutlinePane.tsx src/features/notes/NotesExternalBulletRow.tsx src/features/notes/notes.css src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx
git commit -m "feat(notes): render grouped notification bullets"
```

---

### Task 4: Wire Root Name, Seen State, Refresh Regrouping and Browser Open

**Files:**
- Modify: `src/services/externalSourceRegistry.ts:1-3`
- Modify: `src/App.tsx:410-594, 596-622, 820-840, 1315-1344, 1460-1490`
- Modify: `src/App.test.tsx:1-165, 330-730, 1070-1450`
- Modify: `src/features/notes/NotesLibraryPane.test.tsx:125-265`
- Modify: `src/features/notes/NotesFeature.test.tsx:90-135`

**Interfaces:**
- Consumes: `GITHUB_NOTIFICATIONS_PROVIDER_TITLE`, provider `viewedAt` settings and `UseNotificationsResult.openNotification`.
- Produces: visible renamed root, local seen update, browser open and reprojection on raw source changes.

- [ ] **Step 1: Write failing integration tests**

Use `GITHUB_NOTIFICATIONS_PROVIDER_TITLE` in Notes fixtures/assertions. Keep global navigation assertions matching `Notifications`.

In the existing authenticated external-thread test, keep its account and fetch setup, use notification id `17`, and replace the internal-navigation action/assertions with:

```ts
const open = vi.spyOn(window, "open")
  .mockImplementation(() => null);
const outline = await screen.findByLabelText(
  `${GITHUB_NOTIFICATIONS_PROVIDER_TITLE} outline`
);
await user.click(within(outline).getByRole("button", {
  name: "웹에서 열기: Fix inline caret #17"
}));

expect(open).toHaveBeenCalledWith(
  "https://oss.navercorp.com/acme/app/issues/17",
  "_blank",
  "noopener,noreferrer"
);
expect(screen.getByLabelText(
  `${GITHUB_NOTIFICATIONS_PROVIDER_TITLE} outline`
)).toBeInTheDocument();
expect(JSON.parse(
  window.localStorage.getItem(
    "yonalist.notifications.viewedAt.v1"
  ) ?? "{}"
)).not.toEqual({});
expect(fetchMock.mock.calls.filter(
  ([, init]) => init?.method === "PATCH"
)).toHaveLength(0);
```

The fixture's existing enterprise server resolves to `https://oss.navercorp.com`; keep this exact expected URL.

Add a refresh regroup test using `ExternalRefreshProbe`:

```ts
await waitFor(() =>
  expect(within(outline).getByText("Yesterday"))
    .toBeInTheDocument()
);
currentNotification = {
  ...currentNotification,
  updated_at: new Date().toISOString()
};
await probedExternalRefresh!(
  GITHUB_NOTIFICATIONS_PROVIDER_ID
);
await waitFor(() => {
  expect(within(outline).getByText("Today"))
    .toBeInTheDocument();
  expect(within(outline).queryByText("Yesterday"))
    .toBeNull();
});
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/App.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx
```

Expected: FAIL on old root name, internal navigation, missing viewedAt projection input and refresh regroup assertions.

- [ ] **Step 3: Use one title source**

Update `externalSourceRegistry.ts`:

```ts
import {
  GITHUB_NOTIFICATIONS_PROVIDER_ID,
  GITHUB_NOTIFICATIONS_PROVIDER_TITLE
} from "./githubNotificationsProvider";

export const builtinExternalSourceDescriptors = [{
  id: GITHUB_NOTIFICATIONS_PROVIDER_ID,
  title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
}] as const;
```

Use the same title constant for `githubPage.title` and provider `title`.

- [ ] **Step 4: Feed viewedAt into projection**

Move the unconditional hook call immediately after `notificationSource`, before `githubPage`:

```ts
const unfilteredNotifications = useNotifications(
  auth.connection,
  notificationSource
);
```

Remove its old call. Add `viewedAt: unfilteredNotifications.viewedAt` to normalized projection settings and to the memo dependency list.

- [ ] **Step 5: Replace internal navigation with browser bridge**

Replace `githubDetailsBridgeRef` with:

```ts
const githubWebBridgeRef = useRef<{
  items: readonly GitHubNotification[];
  openNotification(notification: GitHubNotification): void;
}>({
  items: [],
  openNotification: () => undefined
});

const openGithubDetails = useCallback((remoteId: string) => {
  const bridge = githubWebBridgeRef.current;
  const notification = bridge.items.find(
    (item) => item.id === remoteId
  );
  if (notification) bridge.openNotification(notification);
}, []);
```

Assign:

```ts
githubWebBridgeRef.current = {
  items: notificationSourceState.items,
  openNotification: unfilteredNotifications.openNotification
};
```

Delete `notesExternalReturnRef`, `preserveNotesReturn` and special Notes scroll restore. Leaving Notes simply clears the provider:

```ts
if (activeFeatureId === "notes" &&
    nextFeatureId !== "notes") {
  setActiveExternalProviderId(null);
}
```

- [ ] **Step 6: Verify GREEN**

```bash
npm test -- src/App.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx
```

Expected: PASS. The renamed root is visible, refresh moves rows, web open stays in Notes, seen updates and no PATCH occurs.

- [ ] **Step 7: Commit**

```bash
git add src/services/externalSourceRegistry.ts src/App.tsx src/App.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx
git commit -m "feat(notes): open grouped notifications on the web"
```

---

### Task 5: Full Verification and Development Build

**Files:**
- Verify only; change production files only for a regression proven by a new failing test in this scope.

**Interfaces:**
- Consumes: Tasks 1-4 commits.
- Produces: passing evidence and a running development desktop build.

- [ ] **Step 1: Run all focused tests**

```bash
npm test -- src/domain/notifications.test.ts src/services/githubNotificationsProvider.test.ts src/services/externalSourceHost.test.ts src/components/NotificationsPane.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx src/App.test.tsx
```

Expected: all listed files PASS.

- [ ] **Step 2: Run repository verification**

```bash
npm test
npm run lint
npm run test:architecture
npm run build
```

Expected: every command exits 0 using fresh output.

- [ ] **Step 3: Inspect ownership and whitespace**

```bash
git status --short
git diff --check HEAD~4..HEAD
git diff --stat HEAD~4..HEAD
```

Expected: no whitespace errors. Only intended code/tests/docs plus pre-existing unstaged `.superpowers/sdd/*.md` appear.

- [ ] **Step 4: Start the development desktop build**

Stop only prior Yonalist dev processes started for this task, then run:

```bash
npm run tauri:dev
```

Expected: Vite serves `http://127.0.0.1:1420/`, the Tauri debug app opens, and the process remains running.

- [ ] **Step 5: Manual acceptance**

1. Notes `All` shows `Github Notifications` before local roots.
2. Date parents remain open and children show Type icons.
3. Child note matches `repository, time ago, seen time ago` with no false disclosure.
4. Web icon opens the exact target without leaving Notes.
5. Completion waits for remote success and retries failures.
6. Refresh moves an updated thread to the correct date parent and removes an empty old group.

- [ ] **Step 6: Commit only if verification found a scoped regression**

Write its failing test first, stage only that regression's exact test and implementation files, and commit with `fix(notes): resolve notification presentation regression`. If no fix is needed, create no commit.
