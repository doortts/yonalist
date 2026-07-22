# Notes External Notifications Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes 안에 읽기 전용 `Notifications` 가상 페이지를 추가하고, 사용자가 명시적으로 완료할 때만 GitHub 알림을 읽음 처리하며, 기존 Notifications 화면의 동작은 그대로 보존한다.

**Architecture:** GitHub의 확인된 계정별로 하나의 `External Source Host`가 알림 스냅샷, 60초 폴링, 오프라인 캐시와 완료 요청을 소유한다. 기존 Notifications와 Notes는 같은 호스트 상태를 구독하지만 서로 다른 화면 규칙을 적용한다. Notes는 `NoteNode` 트리에 외부 데이터를 넣지 않고 페이지 라우터에서 별도의 읽기 전용 outline을 렌더하므로 SQLite, Undo/Redo, 검색, 휴지통, 내보내기와 구조적으로 분리된다. 제공자는 코드에 정적으로 등록하며 첫 구현은 GitHub Notifications 하나뿐이다.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, browser `localStorage`/Web Crypto, 기존 GitHub REST 서비스, Tauri 2 데스크톱 셸

## Global Constraints

- 승인 설계는 `docs/superpowers/specs/2026-07-22-notes-external-notifications-plugin-design.md`가 원본이다. 범위나 데이터 소유권을 바꿔야 하면 코드를 진행하기 전에 설계 승인을 다시 받는다.
- 기존 Notifications 행 선택, 검색, 날짜 그룹, `Only new`, 상세 화면, 댓글, 브라우저 열기 및 URL 기반 `viewedAt` 의미를 변경하지 않는다.
- 기존 Notifications에서 행을 선택하는 동작은 로컬 `viewedAt`만 기록하며 GitHub PATCH를 보내지 않는다.
- Notes에서 펼치기, 선택, `상세보기`는 완료를 만들지 않는다. 오직 사용자의 명시적 완료만 `PATCH /notifications/threads/{threadId}`를 보낸다.
- 성공 응답 전에는 완료 모양을 표시하지 않는다. 실패 또는 오프라인이면 미완료를 유지하고 재시도할 수 있어야 한다.
- Notes 완료 모양은 GitHub의 `unread`만 사용하며 기존 Notifications의 `viewedAt`을 참조하지 않는다.
- 외부 키를 `NoteId`로 캐스팅하거나 외부 행을 `state.rootIds`, `nodesById`, `notes.sqlite`, Vault Markdown, Notes history/search/export/trash에 넣지 않는다.
- 제공자는 Yonalist에 함께 빌드되는 정적 first-party 코드다. 동적 import 기반 마켓플레이스, 원격 JavaScript, 범용 네트워크 프록시를 추가하지 않는다.
- source connection ID는 정규화한 API 서버와 확인된 GitHub 사용자 ID로 만든다. 토큰과 토큰 digest는 외부 블릿 키나 스냅샷 키에 넣지 않는다.
- credential binding에는 토큰 원문 대신 SHA-256 digest만 저장한다. 서버 또는 token이 바뀌면 이전 계정 행을 즉시 비운 뒤 새 `/user` 검증 결과만 연결한다.
- 읽은 알림 표시 기간은 기본 30일, 허용 범위 1~365일이다. 읽지 않은 항목은 기간과 무관하게 유지한다.
- partial pagination 결과는 현재 화면에만 게시한다. 모든 페이지가 성공한 완전한 스냅샷만 영구 캐시에 저장한다.
- 프런트엔드 전용 변경이다. Rust, Tauri IPC payload, SQLite schema, 네이티브 capability 설정은 수정하지 않는다.
- 각 task는 먼저 실패 테스트를 보고 최소 구현으로 통과시킨 뒤 해당 task 파일만 커밋한다. 관련 없는 사용자 변경을 stage하지 않는다.

## Baseline and Manual Proof

- 기준 브랜치: `main`, 구현 시작 시 HEAD `3941c7c`.
- 기준 작업 트리: clean.
- 기준 집중 테스트:

```bash
npm test -- src/services/authGate.test.ts src/hooks/useAuthGate.test.tsx src/hooks/useNotifications.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx src/components/SettingsPage.test.tsx src/appSettings.test.ts
```

Expected baseline: 7 files, 58 tests PASS. 계획 작성 시 실제로 동일하게 통과했다.

- 첫 데스크톱 증명은 Task 9의 얇은 수직 경로가 완성된 직후 수행한다. `/private/tmp` 아래 새 테스트 Vault를 선택하고, 기존 개발 앱을 종료한 뒤 `npm run tauri:dev`로 새 bundle/process를 띄운다.
- 최종 수동 시나리오는 읽지 않은 알림 열기, `상세보기`, Notes 복귀, 명시적 완료 성공/실패, 오프라인 캐시, 기간 변경, 일반 Notes Undo/검색/내보내기 비오염까지 포함한다.

---

### Task 1: 확인된 GitHub 계정 identity를 credential에 안전하게 묶는다

**Files:**
- Create: `src/services/githubAccountIdentity.ts`
- Create: `src/services/githubAccountIdentity.test.ts`
- Modify: `src/services/authGate.ts`
- Modify: `src/services/authGate.test.ts`
- Modify: `src/hooks/useAuthGate.ts`
- Modify: `src/hooks/useAuthGate.test.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Produces: `GithubAccountIdentity { id, login }`
- Produces: `githubSourceConnectionId(apiBaseUrl, accountId)`
- Produces: credential digest와 server별 identity binding load/save/clear
- Extends: `useAuthGate()` result with `account: GithubAccountIdentity | null`
- Keeps: `checkConnection()` string result와 `validateConnection()` boolean wrapper for existing callers

- [ ] **Step 1: identity parsing, binding, account 전환 실패 테스트를 작성한다**

```ts
it("restores an account only when the current credential digest matches", async () => {
  const account = { id: "42", login: "octocat" };
  await persistGithubAccountBinding("https://api.github.com/", "token-a", account);

  await expect(
    loadGithubAccountBinding("https://api.github.com", "token-a")
  ).resolves.toEqual(account);
  await expect(
    loadGithubAccountBinding("https://api.github.com", "token-b")
  ).resolves.toBeNull();
  expect(window.localStorage.getItem("yonalist.github.accountBindings.v1"))
    .not.toContain("token-a");
});

it("normalizes whitespace and trailing slashes in the source connection", () => {
  expect(githubSourceConnectionId("  https://api.github.com///  ", "42"))
    .toBe(githubSourceConnectionId("https://api.github.com", "42"));
});

it("returns the verified account from the existing user request", async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200 })
  );
  await expect(checkConnectionWithIdentity(connection, fetchMock as typeof fetch))
    .resolves.toEqual({ status: "ok", account: { id: "42", login: "octocat" } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

`useAuthGate.test.tsx`에는 server/token props를 rerender한 바로 그 render에서, effect나 새 `/user` 응답을 기다리지 않고 `account === null`인지 확인한다. 이어 늦게 끝난 이전 `/user` 응답이 새 계정 상태를 덮지 않는 테스트, offline 시작에서 digest가 맞는 binding만 복원하는 테스트를 추가한다. online 시작에서도 같은 credential binding은 `/user` 검증 중 provisional account로 복원되고, 검증이 network/5xx로 unreachable이면 그대로 유지되지만 401/403이면 즉시 제거되는지 확인한다.

`App.test.tsx`의 `/user` 성공 fixture에는 실제 API shape처럼 고정 numeric `id`와 `login`을 함께 넣는다. identity parser를 약화해 body 없는 200이나 login-only 응답을 계정 ID로 가장하지 않는다.

- [ ] **Step 2: 새 API 부재로 RED인지 확인한다**

Run:

```bash
npm test -- src/services/githubAccountIdentity.test.ts src/services/authGate.test.ts src/hooks/useAuthGate.test.tsx src/App.test.tsx
```

Expected: 새 module/export 및 `account` 필드 부재로 FAIL.

- [ ] **Step 3: account identity와 credential binding을 구현한다**

```ts
export interface GithubAccountIdentity {
  readonly id: string;
  readonly login: string;
}

export function githubSourceConnectionId(
  apiBaseUrl: string,
  accountId: string
): string {
  return JSON.stringify([normalizeUrl(apiBaseUrl), accountId]);
}

export type ConnectionCheckWithIdentity =
  | { status: "ok"; account: GithubAccountIdentity }
  | { status: "invalid" | "unreachable"; account: null };
```

`githubAccountIdentity.ts`는 기존 `services/githubServers.ts`의 `normalizeUrl`을 connection ID와 binding key 양쪽에 재사용한다. `crypto.subtle.digest("SHA-256", ...)`로 token digest를 만들고, `yonalist.github.accountBindings.v1`에 `{ tokenDigest, account }`만 저장한다. `decodeGithubAccountIdentity`는 숫자 또는 문자열 `id`와 비어 있지 않은 `login`만 허용한다. `authGate.ts`의 기존 `/user` 요청은 응답 JSON을 한 번 읽어 `checkConnectionWithIdentity`로 반환하고, `checkConnection`과 `validateConnection`은 이 richer result를 감싸 하위 호환을 유지한다.

`useAuthGate`의 identity state는 `{ apiBaseUrl, token, account }`처럼 현재 in-memory credential scope를 함께 가진다. 반환하는 `account`는 이 scope가 현재 `auth.connection.apiBaseUrl/token`과 동기적으로 일치할 때만 account를 내보내고, props가 바뀐 render에서는 effect 전이라도 즉시 `null`을 반환한다. token 원문은 이미 auth runtime이 가진 메모리에만 머물고 localStorage에는 저장하지 않는다.

generation/ref guard로 늦은 응답을 무시한다. online/offline 모두 현재 token digest와 정확히 일치하는 저장 binding을 먼저 provisional scoped identity로 복원한다. online 성공 시 binding을 갱신하고 authoritative identity를 설정한다. network/5xx `unreachable`은 provisional account를 유지해 account-scoped cache를 표시할 수 있게 하고, 401/403 `invalid`, logout, token/server 변경은 binding과 현재 account를 제거한다. binding이 없는 credential은 새 `/user` 성공 전까지 account를 내보내지 않는다. 실제 검증을 위해 `/user`를 두 번 호출하지 않는다.

- [ ] **Step 4: identity 집중 테스트를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/services/githubAccountIdentity.test.ts src/services/authGate.test.ts src/hooks/useAuthGate.test.tsx src/App.test.tsx
```

Expected: account parse/binding/switch/offline 테스트와 기존 auth gate 테스트 모두 PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/services/githubAccountIdentity.ts src/services/githubAccountIdentity.test.ts src/services/authGate.ts src/services/authGate.test.ts src/hooks/useAuthGate.ts src/hooks/useAuthGate.test.tsx src/App.test.tsx
git commit -m "feat(auth): expose verified GitHub account identity"
```

---

### Task 2: 중립 외부 블릿 계약과 정적 provider registry를 고정한다

**Files:**
- Create: `src/domain/externalSources.ts`
- Create: `src/domain/externalSources.test.ts`
- Create: `src/ExternalSourcesContext.ts`
- Create: `src/services/externalSourceRegistry.ts`
- Create: `src/services/externalSourceRegistry.test.ts`

**Interfaces:**
- Produces: collision-safe `ExternalBulletKey`, `ExternalBullet`, capability, page snapshot 타입
- Produces: generic `ExternalSourceProvider<T>` contract
- Produces: `ExternalSourcesBoundary` consumed by Notes without GitHub imports
- Produces: static built-in registry containing only `github-notifications`

- [ ] **Step 1: key와 registry 계약 실패 테스트를 작성한다**

```ts
it("serializes every key dimension without collisions", () => {
  const left = serializeExternalBulletKey({
    providerId: "github-notifications",
    connectionId: "server-a/account-1",
    remoteId: "23"
  });
  const right = serializeExternalBulletKey({
    providerId: "github-notifications",
    connectionId: "server-a/account-2",
    remoteId: "23"
  });
  expect(left).not.toBe(right);
  expect(JSON.parse(left)).toEqual([
    "github-notifications",
    "server-a/account-1",
    "23"
  ]);
});

it("registers only bundled first-party providers", () => {
  expect(builtinExternalSourceDescriptors).toEqual([
    { id: "github-notifications", title: "Notifications" }
  ]);
});
```

- [ ] **Step 2: 계약 부재로 RED인지 확인한다**

Run:

```bash
npm test -- src/domain/externalSources.test.ts src/services/externalSourceRegistry.test.ts
```

Expected: 새 exports 부재로 FAIL.

- [ ] **Step 3: 최소 공통 타입과 안전한 빈 context를 구현한다**

```ts
export interface ExternalBulletKey {
  readonly providerId: string;
  readonly connectionId: string;
  readonly remoteId: string;
}

export interface ExternalBullet {
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

export type ExternalSourceAvailability =
  | "disconnected"
  | "authentication-required"
  | "connecting"
  | "online"
  | "offline";

export interface ExternalSourcePageSnapshot {
  readonly providerId: string;
  readonly connectionId: string | null;
  readonly title: string;
  readonly availability: ExternalSourceAvailability;
  readonly items: readonly ExternalBullet[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly syncedAt: string | null;
  readonly completingKeys: ReadonlySet<string>;
  readonly completionErrors: Readonly<Record<string, string>>;
}

export function serializeExternalBulletKey(key: ExternalBulletKey): string {
  return JSON.stringify([key.providerId, key.connectionId, key.remoteId]);
}

export interface ExternalSourceProjectionInput<T, TSettings> {
  readonly items: readonly T[];
  readonly connectionId: string;
  readonly settings: TSettings;
  readonly now: Date;
}

export interface ExternalSourceProvider<T, TSettings = unknown> {
  readonly id: string;
  readonly title: string;
  decodeItem(value: unknown): T | null;
  keyOf(item: T, connectionId: string): ExternalBulletKey;
  canComplete(item: T): boolean;
  normalizeSettings(value: unknown): TSettings;
  project(input: ExternalSourceProjectionInput<T, TSettings>): readonly ExternalBullet[];
  load(input: {
    signal: AbortSignal;
    publishPartial(items: readonly T[]): void;
  }): Promise<readonly T[]>;
  markComplete?(input: {
    key: ExternalBulletKey;
    item: T;
    signal: AbortSignal;
  }): Promise<T>;
  openDetails?(key: ExternalBulletKey): void;
}
```

`ExternalSourcesBoundary`는 `pages`, `activeProviderId`, `selectProvider(providerId | null)`, `refresh(providerId)`, `complete(key)`, `openDetails(key)`만 노출한다. 기본 context는 빈 pages와 안전한 no-op selection을 제공해 기존 Notes 단위 테스트가 App provider 없이도 그대로 렌더되게 한다. `refresh`와 `complete`의 빈 구현은 명확한 `External source is unavailable.` 오류로 reject한다.

provider contract가 raw item의 load/cache decoder뿐 아니라 provider별 settings 정규화, 공통 bullet projection과 선택적 detail action까지 소유하므로 Jira/Linear를 추가할 때 Notes나 generic host를 고치지 않는다. `externalSourceRegistry.ts`는 descriptor 상수만 정적으로 export한다. 파일시스템 탐색, 동적 module URL, 사용자 입력 코드를 registry에 넣지 않는다.

- [ ] **Step 4: 계약과 registry 테스트를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/domain/externalSources.test.ts src/services/externalSourceRegistry.test.ts
```

Expected: key/registry/context 타입 검사 PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/domain/externalSources.ts src/domain/externalSources.test.ts src/ExternalSourcesContext.ts src/services/externalSourceRegistry.ts src/services/externalSourceRegistry.test.ts
git commit -m "feat(external-sources): define static provider contract"
```

---

### Task 3: 계정별 완전 스냅샷 캐시를 만든다

**Files:**
- Create: `src/services/externalSourceSnapshotStore.ts`
- Create: `src/services/externalSourceSnapshotStore.test.ts`

**Interfaces:**
- Produces: `loadExternalSourceSnapshot`, `persistExternalSourceSnapshot`, `clearExternalSourceSnapshots`
- Leaves temporarily: host-only `loadCachedNotifications` and `persistCachedNotifications`, because the old hook still imports them until Task 7
- Keeps: existing `viewedAt`, hidden IDs and notification detail persistence unchanged

- [ ] **Step 1: account isolation, corruption, full-snapshot 실패 테스트를 작성한다**

```ts
it("isolates snapshots by provider and verified connection", () => {
  persistExternalSourceSnapshot("github-notifications", "server/account-a", [itemA], now);
  persistExternalSourceSnapshot("github-notifications", "server/account-b", [itemB], now);

  expect(loadExternalSourceSnapshot("github-notifications", "server/account-a", decodeItem))
    .toMatchObject({ items: [itemA] });
  expect(loadExternalSourceSnapshot("github-notifications", "server/account-b", decodeItem))
    .toMatchObject({ items: [itemB] });
});

it("rejects the complete entry when any stored item is invalid", () => {
  window.localStorage.setItem(
    "yonalist.externalSources.snapshots.v1",
    JSON.stringify({
      '["github-notifications","server/account-a"]': {
        version: 1,
        syncedAt: "2026-07-22T00:00:00.000Z",
        items: [itemA, { broken: true }]
      }
    })
  );
  expect(loadExternalSourceSnapshot("github-notifications", "server/account-a", decodeItem))
    .toBeNull();
});
```

- [ ] **Step 2: 새 store 부재로 RED인지 확인한다**

Run:

```bash
npm test -- src/services/externalSourceSnapshotStore.test.ts
```

Expected: 새 store export 부재로 FAIL.

- [ ] **Step 3: versioned generic store를 구현한다**

```ts
interface PersistedExternalSourceSnapshot {
  readonly version: 1;
  readonly syncedAt: string;
  readonly items: readonly unknown[];
}

function snapshotKey(providerId: string, connectionId: string): string {
  return JSON.stringify([providerId, connectionId]);
}
```

storage key는 `yonalist.externalSources.snapshots.v1`이다. load 시 object/version/date/items 배열을 검증하고 모든 item이 provider decoder를 통과할 때만 반환한다. persist는 완성된 배열 전체와 sync 시각을 한 번에 교체한다. 같은 서버의 계정을 구분할 수 없는 기존 `yonalist.notifications.cache.v1`은 새 계정 캐시로 migration하지 않는다. 다만 Task 7 전까지 현재 `useNotifications`가 컴파일되도록 legacy 함수는 그대로 두고, 새 host만 legacy cache를 절대 읽지 않는다. 기존 URL 기반 `viewedAt`과 detail cache 코드는 이동하거나 이름을 바꾸지 않는다.

- [ ] **Step 4: store 테스트와 기존 notification store 회귀를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/services/externalSourceSnapshotStore.test.ts src/services/notificationStores.test.ts
```

Expected: account/decoder/clear 테스트와 기존 viewed/detail 테스트 PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/services/externalSourceSnapshotStore.ts src/services/externalSourceSnapshotStore.test.ts
git commit -m "feat(external-sources): persist account scoped snapshots"
```

---

### Task 4: 한 번만 가져오는 External Source Host read path를 구현한다

**Files:**
- Create: `src/services/externalSourceHost.ts`
- Create: `src/services/externalSourceHost.test.ts`
- Create: `src/hooks/useExternalSource.ts`
- Create: `src/hooks/useExternalSource.test.tsx`

**Interfaces:**
- Consumes: `ExternalSourceProvider<T>` and account-scoped snapshot store
- Produces: ref-counted `ExternalSourceHandle<T>`
- Produces: `useExternalSource(handle, enabled)` via `useSyncExternalStore`
- Owns: one initial request, one 60-second timer, abort/generation, partial in-memory state

- [ ] **Step 1: shared lease, partial, stale response 실패 테스트를 작성한다**

```ts
it("shares one request and one poll timer across two leases", async () => {
  vi.useFakeTimers();
  const handle = createExternalSourceHost(provider, connectionId, {
    pollIntervalMs: 60_000,
    now: () => new Date("2026-07-22T00:00:00Z")
  });
  const releaseA = handle.acquire();
  const releaseB = handle.acquire();

  await vi.advanceTimersByTimeAsync(0);
  expect(provider.load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(provider.load).toHaveBeenCalledTimes(2);

  releaseA();
  releaseB();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(provider.load).toHaveBeenCalledTimes(2);
});

it("shows partial rows but preserves the previous complete cache on failure", async () => {
  persistExternalSourceSnapshot(provider.id, connectionId, [cached], syncedAt);
  provider.load.mockImplementation(async ({ publishPartial }) => {
    publishPartial([partial]);
    throw new Error("page 2 failed");
  });
  const handle = createExternalSourceHost(provider, connectionId);
  await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);
  expect(handle.getState().items).toEqual([partial]);
  expect(handle.getState().error).toBe(EXTERNAL_SOURCE_REFRESH_ERROR);
  expect(loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)?.items)
    .toEqual([cached]);
});

it("never exposes provider secrets through public load errors", async () => {
  provider.load.mockRejectedValue(
    new Error("ghp_secret: upstream body at /Users/alice/private/response.json")
  );
  const handle = createExternalSourceHost(provider, connectionId);

  await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);
  expect(handle.getState().error).toBe(EXTERNAL_SOURCE_REFRESH_ERROR);
  expect(JSON.stringify(handle.getState())).not.toMatch(
    /ghp_secret|upstream body|\/Users\/alice/
  );
});
```

late response test는 `dispose()` 또는 새 handle 전환 뒤 이전 promise가 resolve되어도 listener/state/cache를 갱신하지 않는지 확인한다. 별도 AbortError 테스트는 request 취소를 일반 실패로 공개하지 않고 기존 `error`를 유지하거나 `null`로 두며, unhandled rejection도 만들지 않는지 확인한다.

완전 snapshot replacement 테스트는 첫 성공 `[first, second]` 뒤 다음 성공이 `[first]`이면 `second`가 화면과 persisted cache에서 제거되는지 확인한다. remote 삭제를 merge가 되살리면 안 된다.

- [ ] **Step 2: host/hook 부재로 RED인지 확인한다**

Run:

```bash
npm test -- src/services/externalSourceHost.test.ts src/hooks/useExternalSource.test.tsx
```

Expected: 새 API 부재로 FAIL.

- [ ] **Step 3: stable snapshot host와 React subscriber를 구현한다**

```ts
export interface ExternalSourceState<T> {
  readonly items: readonly T[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly syncedAt: string | null;
  readonly completingKeys: ReadonlySet<string>;
  readonly completionErrors: Readonly<Record<string, string>>;
}

export interface ExternalSourceHandle<T> {
  getState(): ExternalSourceState<T>;
  subscribe(listener: () => void): () => void;
  acquire(): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}
```

첫 subscriber lease가 생길 때 즉시 load하고 timer를 하나 시작한다. 추가 lease는 같은 handle을 공유한다. 마지막 release는 timer와 현재 request를 중단하지만 캐시에서 복원한 state는 유지한다. 동시에 들어온 `refresh()`는 현재 in-flight promise를 재사용한다. host 내부에는 화면용 `state.items`와 별도로 `lastCompleteItems`를 보관한다. cache restore와 최종 load 성공만 `lastCompleteItems`를 교체한다. `publishPartial`은 화면용 `items/loading`만 갱신하며 persist하지 않는다. 최종 load 성공 때만 `syncedAt`을 설정하고 완전 snapshot을 persist한다. 실패하면 현재 표시 items를 유지하되 `lastCompleteItems`는 유지한다. `getState()`는 실제 변화가 없으면 같은 object reference를 반환해야 `useSyncExternalStore`가 무한 re-render하지 않는다.

host가 공용으로 사용하는 `toExternalSourcePublicError(kind, cause)`는 AbortError이면 `null`, 그 외에는 원인 문자열을 검사하거나 이어 붙이지 않고 고정 문구 `Unable to refresh external source.` 또는 `Unable to complete external item.`만 반환한다. `state.error`, `completionErrors`, public promise rejection에는 이 고정 문구만 사용하며 token, 응답 body, URL query, 로컬 경로를 console이나 state에 복사하지 않는다. 내부 원인은 메모리 state나 영구 cache에 저장하지 않는다.

`useExternalSource`는 handle이 있어도 `enabled === false`이면 lease를 얻지 않지만 현재 cached state는 구독해 표시할 수 있다. App은 offline일 때 `enabled`를 false로 전달해 네트워크/timer를 시작하지 않는다.

- [ ] **Step 4: host/hook 테스트를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/services/externalSourceHost.test.ts src/hooks/useExternalSource.test.tsx
```

Expected: single polling, release abort, partial/full persistence, late response, fixed safe error, stable snapshot 테스트 PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/services/externalSourceHost.ts src/services/externalSourceHost.test.ts src/hooks/useExternalSource.ts src/hooks/useExternalSource.test.tsx
git commit -m "feat(external-sources): add shared polling host"
```

---

### Task 5: 완료 요청을 성공 후 반영하는 host state machine을 추가한다

**Files:**
- Modify: `src/services/externalSourceHost.ts`
- Modify: `src/services/externalSourceHost.test.ts`

**Interfaces:**
- Consumes: optional provider `markComplete({ key, item, signal })`
- Adds: `complete(key: ExternalBulletKey): Promise<void>` to `ExternalSourceHandle<T>`
- Produces: per-key in-flight dedupe, pending/error state, success-only snapshot replacement
- Keeps: no generic uncomplete action

- [ ] **Step 1: exactly-once, no optimism, retry 실패 테스트를 작성한다**

```ts
it("coalesces duplicate completion and changes state only after success", async () => {
  const deferred = createDeferred<SourceItem>();
  provider.markComplete.mockReturnValue(deferred.promise);
  const handle = readyHandleWith([incompleteItem]);
  const key = provider.keyOf(incompleteItem, connectionId);

  const first = handle.complete(key);
  const second = handle.complete(key);
  expect(provider.markComplete).toHaveBeenCalledTimes(1);
  expect(handle.getState().items[0]).toEqual(incompleteItem);
  expect(handle.getState().completingKeys).toContain(serializeExternalBulletKey(key));

  deferred.resolve({ ...incompleteItem, complete: true });
  await Promise.all([first, second]);
  expect(handle.getState().items[0]).toMatchObject({ complete: true });
});
```

별도 테스트에서 첫 호출이 token/응답 body/로컬 경로를 포함한 원인으로 reject해도 원본이 incomplete로 남고 `completionErrors[serialized]`와 public rejection에는 `Unable to complete external item.`만 기록되는지 확인한다. 다음 호출은 새 remote request를 만들어 성공할 수 있어야 한다. `provider.canComplete(item) === false`이거나 provider가 `markComplete`를 제공하지 않는 key는 원격 호출 없이 같은 안전한 문구로 reject한다. AbortError는 사용자 오류로 남기지 않는다.

provider가 성공처럼 resolve해도 반환 item을 `provider.decodeItem`으로 다시 검증하고, 검증된 item의 serialized key가 요청 key와 정확히 같은지 확인한다. malformed item 또는 다른 remote ID가 오면 실패로 처리해 화면과 `lastCompleteItems`/cache를 전혀 바꾸지 않는 테스트를 추가한다.

partial page 실패 뒤 completion하는 회귀 테스트도 추가한다. 이전 complete cache가 `[first, second]`이고 화면 partial이 `[first]`일 때 `first` 완료 성공 후 persisted snapshot은 `[completedFirst, second]`여야 한다. 화면 partial에만 존재하고 `lastCompleteItems`에는 없는 새 item을 완료하면 truncated 배열을 persist하지 않고 이전 complete cache를 그대로 둔다.

GET/PATCH race 테스트는 completion 전에 시작한 load가 PATCH 성공 뒤 늦게 `incomplete` item을 반환해도 완료된 화면과 cache를 덮지 못하는지 확인한다. completion 진행 중 호출한 manual refresh/poll은 completion settlement 뒤 새 load를 시작해야 한다.

- [ ] **Step 2: optimistic/dedupe 미구현으로 RED인지 확인한다**

Run: `npm test -- src/services/externalSourceHost.test.ts`

Expected: complete state machine assertions FAIL.

- [ ] **Step 3: key별 promise map과 success-only replacement를 구현한다**

```ts
const completionInflight = new Map<string, Promise<void>>();

function complete(key: ExternalBulletKey): Promise<void> {
  const serialized = serializeExternalBulletKey(key);
  const running = completionInflight.get(serialized);
  if (running) return running;

  const request = completeOnce(key, serialized).finally(() => {
    completionInflight.delete(serialized);
  });
  completionInflight.set(serialized, request);
  return request;
}
```

`completeOnce`는 provider/connection/key/item과 `canComplete(item)`을 검증한다. completion 시작 시 현재 GET controller를 abort하고 load generation을 증가시켜 abort를 무시하는 늦은 응답도 commit하지 못하게 한 뒤 `completingKeys`를 갱신한다. completion promise가 하나라도 진행 중이면 새 manual refresh/poll은 그 settlement를 기다린 다음 새로운 generation의 GET을 시작한다.

provider 성공이 반환한 raw item은 `decodeItem`을 통과하고 `serializeExternalBulletKey(provider.keyOf(decoded, connectionId)) === serialized`일 때만 신뢰한다. 그 검증이 끝난 새 item으로 화면 배열의 해당 item을 교체한다. 같은 key가 `lastCompleteItems`에도 있으면 그 완전 배열도 교체해 persist한다. key가 partial 화면에만 있으면 in-memory 화면만 갱신하고 영구 cache는 다음 full load까지 유지한다. 실패하면 items를 바꾸지 않고 pending을 제거하며 `completionErrors[serialized]`에 Task 4의 고정된 사용자용 메시지만 기록한다. 성공 시 해당 error를 제거한다. dispose는 GET과 completion controller를 모두 abort한다.

- [ ] **Step 4: 완료 state machine 테스트를 GREEN으로 확인한다**

Run: `npm test -- src/services/externalSourceHost.test.ts`

Expected: duplicate/success/failure/retry, returned-item validation, safe error, dispose 테스트 PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/services/externalSourceHost.ts src/services/externalSourceHost.test.ts
git commit -m "feat(external-sources): complete remote bullets safely"
```

---

### Task 6: GitHub Notifications provider와 projection을 연결한다

**Files:**
- Create: `src/services/githubNotificationsProvider.ts`
- Create: `src/services/githubNotificationsProvider.test.ts`
- Modify: `src/services/notifications.ts`
- Modify: `src/services/notifications.test.ts`
- Modify: `src/appSettings.ts`
- Modify: `src/appSettings.test.ts`
- Modify: `src/components/NotificationsPane.test.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Produces: `createGithubNotificationsProvider(connection, account, now, openDetails?)`
- Produces: `projectGithubNotifications(items, connectionId, retentionDays, now)`
- Adds: optional transport `accountId` and `signal` fields to GitHub notification GET/PATCH options; the new provider always supplies both scope values
- Adds: exported `normalizeGithubNotificationsReadRetentionDays`, setting default 30, clamp 1..365

- [ ] **Step 1: adapter를 만들기 전에 기존 Notifications 회귀를 고정한다**

`App.test.tsx`에 기존 행 선택이 local `viewedAt`만 기록하고 PATCH를 보내지 않는 테스트를 추가한다. `NotificationsPane.test.tsx`에는 search가 title/repository를 필터하고, `Only new`가 현재 `isReadAndQuiet(viewedAt)` 의미를 유지하며, 행 선택 callback이 detail 대상으로 같은 thread를 전달하는 assertion을 명시한다.

```ts
it("keeps existing Notifications selection local-only", async () => {
  const expectedThreadId = "thread-17";
  const user = userEvent.setup();
  render(<App initialOnline />);
  await user.click(await screen.findByRole("button", { name: /Fix inline caret/ }));

  expect(JSON.parse(localStorage.getItem("yonalist.notifications.viewedAt.v1") ?? "{}"))
    .not.toEqual({});
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
    .toHaveLength(0);
  expect(notificationDetailInputs).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: expectedThreadId })
  );
});
```

- [ ] **Step 2: 기존 구현에서 회귀 고정 테스트가 GREEN인지 확인한다**

Run:

```bash
npm test -- src/components/NotificationsPane.test.tsx src/App.test.tsx
```

Expected: 새 regression assertions가 현재 동작 그대로 PASS. 실패하면 provider 작업 전에 baseline 원인을 조사하고 설계와 다른 기존 동작을 기록한다.

- [ ] **Step 3: mapping, retention, PATCH 성공 시각 실패 테스트를 작성한다**

```ts
it("projects GitHub unread state without consulting viewedAt", () => {
  const bullets = projectGithubNotifications(
    [unreadNotification, readNotification],
    connectionId,
    30,
    new Date("2026-07-22T12:00:00Z")
  );
  expect(bullets[0]).toMatchObject({
    parentKey: null,
    title: "Fix inline caret #17",
    completed: false,
    note: expect.stringContaining("Repository: acme/yonalist")
  });
  expect(bullets[1].completed).toBe(true);
});

it("keeps old unread rows and removes only old read rows", () => {
  const bullets = projectGithubNotifications(
    [oldUnread, oldRead, boundaryRead],
    connectionId,
    30,
    new Date("2026-07-22T00:00:00Z")
  );
  expect(bullets.map((bullet) => bullet.key.remoteId)).toEqual([
    boundaryRead.id,
    oldUnread.id
  ]);
});
```

provider completion test는 `markNotificationRead`가 thread ID로 정확히 한 번 호출되고 성공 뒤 반환 item만 `{ unread: false, last_read_at: now }`가 되는지 확인한다. `appSettings.test.ts`는 undefined/0/366/소수/NaN 입력이 각각 30/1/365/반올림/default로 정규화되는지 확인한다.

pagination race 테스트는 같은 thread ID가 두 page에 중복되고 `updated_at`이 다를 때 한 행만 남으며 더 최신 snapshot이 선택되는지 확인한다. projection 테스트는 provider가 돌려준 다음 완전 raw snapshot에서 빠진 ID가 Notes 목록에도 존재하지 않는지 확인한다.

real provider decoder 테스트는 malformed subject/repository/timestamp item이 `null`이 되고, 그 item이 섞인 `yonalist.externalSources.snapshots.v1` entry 전체가 거부되는지 확인한다. network partial/final payload에도 같은 decoder를 적용해 malformed item 하나가 load error로 격리되고 이전 complete cache를 보존하는지 확인한다. 이어 다음 정상 refresh가 성공하는지 검증해 malformed 응답이 service의 account memory cache를 오염시키지 않았음을 고정한다.

- [ ] **Step 4: provider/setting 부재로 RED인지 확인한다**

Run:

```bash
npm test -- src/services/githubNotificationsProvider.test.ts src/services/notifications.test.ts src/appSettings.test.ts
```

Expected: provider와 새 setting/API option 부재로 FAIL.

- [ ] **Step 5: GitHub adapter와 순수 projection을 구현한다**

```ts
export const GITHUB_NOTIFICATIONS_PROVIDER_ID = "github-notifications";

export function createGithubNotificationsProvider(input: {
  connection: GithubConnection;
  account: GithubAccountIdentity;
  now?: () => Date;
  openDetails?: (remoteId: string) => void;
}): ExternalSourceProvider<GitHubNotification, GithubNotificationsProviderSettings>;

export function projectGithubNotifications(
  items: readonly GitHubNotification[],
  connectionId: string,
  readRetentionDays: number,
  now: Date
): readonly ExternalBullet[];
```

`decodeItem`은 object 여부와 `id`, `unread`, `reason`, `updated_at`, nullable `last_read_at`, `subject.{title,url,type}`, `repository.{full_name,name,owner.login}`을 runtime에서 검증하고 유효한 날짜 문자열만 허용한다. unsafe `as GitHubNotification` cast로 cache/network 데이터를 통과시키지 않는다.

`load`는 `fetchNotifications({ token, apiBaseUrl, accountId: account.id, signal, onPartialResult })`를 호출한다. partial callback과 final result를 먼저 `decodeItem`으로 전부 검증하고 하나라도 invalid면 load를 reject한다. 현재 `fetchNotifications`는 `onPartialResult` 다음에 internal `cache.set`을 실행하므로 validation callback의 throw가 malformed snapshot의 cache 저장도 막는 순서를 유지한다. provider 내부 `dedupeNotificationsByThreadId`는 검증된 partial과 final 배열 모두를 ID로 합치고, 중복 ID에서는 더 최신 `updated_at` snapshot을 선택한다. `FetchNotificationsOptions.accountId`와 `signal`은 Task 7 전의 legacy hook 및 별도 unread-toast caller가 계속 컴파일되도록 optional transport field로 추가하지만, provider는 둘 다 항상 전달한다. service full-list memory cache key에는 `accountId ?? "legacy-unscoped"`를 포함하고 모든 page fetch에 signal을 전달한다. Task 7 뒤 production full-list fetch는 provider 경로만 남는다. `markComplete`는 기존 `markNotificationRead`를 호출한 뒤에만 새로운 `{ ...item, unread: false, last_read_at }`를 반환한다.

provider의 `canComplete(item)`은 `item.unread === true`일 때만 true다. 따라서 이미 GitHub read인 항목이나 completed snapshot에는 generic host가 PATCH를 보내지 않는다. `normalizeSettings`는 provider의 read-retention 값을 1~365로 정규화하고 `project`는 `projectGithubNotifications`를 호출한다. optional `openDetails(key)`는 provider/connection key를 검증한 뒤 주입된 stable callback에 `remoteId`만 전달한다.

projection 제목은 subject title 뒤에 번호가 있으면 ` #번호`를 붙인다. 모든 GitHub 항목의 `parentKey`는 provider 가상 root 직속을 뜻하는 `null`이다. note는 Repository, Reason, Updated, Type 네 줄이다. `completed`는 `!notification.unread`만 사용하고 `capabilities.uncomplete`는 `false`다. 읽지 않았거나 `updated_at >= now - retentionDays`인 항목만 유지하고 `updatedAt` 내림차순으로 정렬한다. URL 기반 `viewedAt` module은 import하지 않는다.

`appSettings.ts`에는 export된 별도의 1~365 정규화 helper를 사용하고 `normalizeSettings`와 `settingsNeedNormalization` 모두 새 field를 포함한다. 기존 image retention의 0 허용 helper를 재사용하면 안 된다.

- [ ] **Step 6: provider/service/settings와 고정 회귀를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/services/githubNotificationsProvider.test.ts src/services/notifications.test.ts src/appSettings.test.ts src/components/NotificationsPane.test.tsx src/App.test.tsx
```

Expected: mapping/key/retention/deduplication/deletion/PATCH/signal/account cache key/settings normalization PASS.

- [ ] **Step 7: 커밋한다**

```bash
git add src/services/githubNotificationsProvider.ts src/services/githubNotificationsProvider.test.ts src/services/notifications.ts src/services/notifications.test.ts src/appSettings.ts src/appSettings.test.ts src/components/NotificationsPane.test.tsx src/App.test.tsx
git commit -m "feat(external-sources): add GitHub notifications provider"
```

---

### Task 7: 기존 Notifications를 공용 host 소비자로 바꾼다

**Files:**
- Modify: `src/hooks/useNotifications.ts`
- Modify: `src/hooks/useNotifications.test.tsx`
- Modify: `src/services/notificationStores.ts`
- Modify: `src/services/notificationStores.test.ts`
- Modify: `src/components/NotificationsPane.tsx`
- Modify: `src/components/NotificationsPane.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- `useNotifications` consumes shared `ExternalSourceState<GitHubNotification>` and handle actions
- Keeps: `viewedAt`, `markNotificationViewed`, `openNotification`, demo mode, repo filtering and unread calculation
- App owns one account-bound provider/handle and disposes it on account/credential change

- [ ] **Step 1: shared-state adapter와 identity-pending 표시 실패 테스트를 작성한다**

```ts
it("does not flash a false empty state while account identity is pending", () => {
  renderNotificationsPane({
    ...baseState,
    notifications: [],
    loaded: false,
    loading: true
  });
  expect(screen.getByText("Loading notifications...")).toBeInTheDocument();
  expect(screen.queryByText("No notifications.")).not.toBeInTheDocument();
});
```

hook test는 같은 handle state가 갱신될 때 기존 Notifications 목록이 갱신되고 `markNotificationViewed`가 host complete를 호출하지 않는지 확인한다. App test는 token이 있지만 verified/provisional account가 아직 없는 동안 loading UI를 유지하다가 account가 확인되면 같은 pane에 rows가 나타나는지 확인한다. 기존 partial display, polling, abort 테스트는 host 테스트로 이동하고 `useNotifications`에는 UI adapter 계약만 남긴다.

- [ ] **Step 2: old hook ownership 때문에 RED인지 확인한다**

Run:

```bash
npm test -- src/hooks/useNotifications.test.tsx src/App.test.tsx
```

Expected: shared source 주입 API와 loaded-aware loading UI 부재로 FAIL. Task 6의 no-PATCH 회귀는 계속 PASS.

- [ ] **Step 3: App에서 provider/handle을 한 번 만들고 기존 UI adapter를 보존한다**

hook 입력을 다음처럼 명시해 네트워크 lifecycle을 다시 소유하지 못하게 한다.

```ts
export interface NotificationsSourceInput {
  readonly state: ExternalSourceState<GitHubNotification>;
  refresh(): Promise<void>;
}

export function useNotifications(
  connection: GithubConnection,
  source: NotificationsSourceInput | null,
  isRepoVisible?: (repositoryFullName: string) => boolean
): UseNotificationsResult;
```

```ts
const sourceConnectionId = authGate.account
  ? githubSourceConnectionId(
      auth.connection.apiBaseUrl,
      authGate.account.id
    )
  : null;
const notificationSourceActive =
  authGate.state === "passed" &&
  (inboxActive ||
    (activeFeatureId === "notes" &&
      activeExternalProviderId === GITHUB_NOTIFICATIONS_PROVIDER_ID));
```

account가 있을 때만 provider와 handle을 `useMemo`로 만들고 dependency가 바뀌면 이전 handle을 `dispose()`한다. `useExternalSource(handle, notificationSourceActive && online)`으로 raw shared state를 얻는다. Inbox 활성 조건은 현재처럼 전체 Inbox를 포함해 badge/repository 동작을 보존한다.

`useNotifications`에서 fetch/cache/timer state를 제거하고 shared raw items를 기존 `repoVisible`, `isReadAndQuiet(viewedAt)`, demo data 규칙에 연결한다. token이 비어 있으면 기존 sample demo를 유지한다. token은 있으나 account/source가 아직 없으면 sample을 노출하지 않은 채 `loaded: false`, `loading: true`, 빈 목록으로 둔다. `NotificationsPane`은 빈 groups에서 `state.loaded === false`일 때 `Loading notifications...`를, `state.loaded === true`일 때만 `No notifications.`를 렌더한다. 이미 한 번 load한 빈 목록의 background refresh는 기존 empty UI를 loading 문구로 되돌리지 않고 별도 spinner state만 사용한다. 기존 화면에서 선택하는 `selectNotification -> markNotificationViewed`는 그대로 두며 host `complete`를 연결하지 않는다.

이제 사용자가 없는 서버 단위 legacy list cache 함수 `loadCachedNotifications`/`persistCachedNotifications`와 관련 테스트를 `notificationStores.ts`에서 제거한다. 같은 파일의 `viewedAt`, hidden IDs, notification detail persistence는 그대로 둔다. 이전 localStorage key는 읽거나 migration하지 않으며 Settings Reset의 기존 `yonalist.*` 제거에서 정리된다.

- [ ] **Step 4: existing Notifications 집중 회귀를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/hooks/useNotifications.test.tsx src/services/notificationStores.test.ts src/components/NotificationsPane.test.tsx src/App.test.tsx
```

Expected: 기존 목록/선택/detail/viewedAt/demo/repo filter 테스트와 새 no-PATCH 테스트 PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/hooks/useNotifications.ts src/hooks/useNotifications.test.tsx src/services/notificationStores.ts src/services/notificationStores.test.ts src/components/NotificationsPane.tsx src/components/NotificationsPane.test.tsx src/App.tsx src/App.test.tsx
git commit -m "refactor(notifications): consume shared source host"
```

---

### Task 8: App의 중립 context와 `상세보기` 왕복을 연결한다

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/ExternalSourcesContext.ts`

**Interfaces:**
- App projects the raw GitHub state into one neutral `ExternalSourcePageSnapshot`
- `openDetails(key)` resolves raw thread and calls the existing Notifications navigation/selection path
- App preserves Notes external-page target and detail scroll only for this round trip

- [ ] **Step 1: neutral page, same-thread detail, scroll 복원 실패 테스트를 작성한다**

`App.test.tsx`에서 `notesFeatureRuntime.renderPanes`를 잠시 교체해 App이 제공한 실제 context를 읽는 test probe를 렌더한다. 이 방식은 Task 9의 UI를 미리 요구하지 않으면서 App boundary만 검증한다.

```ts
const expectedThreadId = "thread-17";

function ExternalSourcesProbe() {
  const sources = useExternalSources();
  const page = sources.pages[0];
  const first = page?.items[0];
  return (
    <div aria-label="External source probe">
      <button
        type="button"
        aria-pressed={sources.activeProviderId === page?.providerId}
        onClick={() => page && sources.selectProvider(page.providerId)}
      >
        Select source
      </button>
      <button
        type="button"
        disabled={!first}
        onClick={() => first && sources.openDetails(first.key)}
      >
        Open source details
      </button>
      <output>{page?.title ?? "missing"}</output>
    </div>
  );
}

const originalRenderPanes = notesFeatureRuntime.renderPanes;
notesFeatureRuntime.renderPanes = () => ({
  middle: <ExternalSourcesProbe />,
  detail: <div aria-label="External Notes detail" />
});
await user.click(screen.getByRole("button", { name: "Notes" }));
await user.click(await screen.findByRole("button", { name: "Select source" }));
const notesDetail = screen.getByLabelText("Detail").querySelector(".detail-scroll")!;
notesDetail.scrollTop = 240;
await user.click(screen.getByRole("button", { name: "Open source details" }));

expect(screen.getByLabelText("Notifications")).toBeInTheDocument();
expect(
  within(screen.getByLabelText("Detail")).getByRole("heading", {
    name: "Fix inline caret"
  })
).toBeInTheDocument();
expect(
  screen
    .getByRole("button", { name: /Fix inline caret/ })
    .closest(".notification-row")
).toHaveClass("selected");
expect(notificationDetailInputs).toHaveBeenLastCalledWith(
  expect.objectContaining({ id: expectedThreadId })
);
expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
  .toHaveLength(0);

await user.click(screen.getByRole("button", { name: "Notes" }));
expect(notesDetail.scrollTop).toBe(240);
expect(
  within(screen.getByLabelText("External source probe")).getByRole("button", {
    name: "Select source"
  })
).toHaveAttribute("aria-pressed", "true");

notesFeatureRuntime.renderPanes = originalRenderPanes;
```

복원은 `try/finally`에서 수행해 assertion 실패 때도 global runtime을 원복한다. Task 9에서 같은 acceptance를 실제 가상 root와 `상세보기` 버튼 경로로 추가한다.

fake timer/system-time 테스트를 하나 더 둔다. retention 경계 직전에는 cached read item이 projection에 보이고, 외부 page를 연 채 60초 coarse clock tick으로 경계를 지나면 source state/settings 변경이 없어도 사라져야 한다. Notes를 떠난 동안 경계를 넘긴 뒤 다시 external page를 활성화하는 경우에도 즉시 현재 시각으로 재계산되는지 확인한다. unread item은 두 경우 모두 남아야 한다.

- [ ] **Step 2: App boundary/navigation 부재로 RED인지 확인한다**

Run: `npm test -- src/App.test.tsx`

Expected: external source context page/action 및 scroll restore 부재로 FAIL.

- [ ] **Step 3: page snapshot과 existing navigation bridge를 구현한다**

```ts
const githubProjectionActive =
  activeFeatureId === "notes" &&
  activeExternalProviderId === GITHUB_NOTIFICATIONS_PROVIDER_ID;
const projectionNowMs = useProjectionClock(githubProjectionActive, 60_000);

const githubPage = useMemo<ExternalSourcePageSnapshot>(() => ({
  providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
  connectionId: sourceConnectionId,
  title: "Notifications",
  availability: authGate.state === "required" && Boolean(auth.connection.token)
    ? "authentication-required"
    : !auth.connection.token
      ? "disconnected"
      : !online
        ? "offline"
        : !authGate.account
          ? "connecting"
          : "online",
  items: sourceConnectionId && githubNotificationsProvider
    ? githubNotificationsProvider.project({
        items: notificationSourceState.items,
        connectionId: sourceConnectionId,
        settings: githubNotificationsProvider.normalizeSettings({
          readRetentionDays: normalizeGithubNotificationsReadRetentionDays(
            settings.githubNotificationsReadRetentionDays
          )
        }),
        now: new Date(projectionNowMs)
      })
    : [],
  loaded: notificationSourceState.loaded,
  loading: notificationSourceState.loading,
  error: notificationSourceState.error,
  syncedAt: notificationSourceState.syncedAt,
  completingKeys: notificationSourceState.completingKeys,
  completionErrors: notificationSourceState.completionErrors
}), [
  auth.connection.token,
  authGate.account,
  authGate.state,
  githubNotificationsProvider,
  notificationSourceState,
  online,
  projectionNowMs,
  settings.githubNotificationsReadRetentionDays,
  sourceConnectionId
]);
```

`useProjectionClock(active, 60_000)`는 활성화될 때 즉시 `Date.now()`로 갱신하고, 활성화된 동안에만 60초 timer를 유지하며 cleanup한다. 따라서 network poll이나 source snapshot 변화가 없어도 보관 경계를 통과한 read row가 사라지고, 비활성 상태에서는 불필요한 timer가 돌지 않는다.

`ExternalSourcesContext.Provider`는 feature providers 바깥의 App context stack에 추가한다. `refresh`는 provider ID와 online/handle을 검증하고, `complete`는 offline에서 local success를 만들지 않고 reject한다.

App은 최신 raw items와 기존 `openNotifications()`/`selectNotification(notification)`을 ref에 넣고, identity가 안정적인 `openGithubDetails(remoteId)` callback을 provider 생성 시 주입한다. callback은 현재 connection의 같은 remote ID를 찾은 경우에만 기존 navigation/selection을 호출한다. `ExternalSourcesBoundary.openDetails(key)`는 matching provider의 `openDetails(key)`에 위임한다. provider object/host는 poll마다 재생성하지 않으며, 기존 selection의 `markNotificationViewed`도 그대로 실행된다. App이 GitHub projection 규칙이나 key dispatch를 다시 구현하지 않는다.

`상세보기` 직전 shared `.detail-scroll`의 `scrollTop`과 restore flag를 ref에 저장한다. `detailScrollResetKey`가 다시 `notes`가 될 때 flag가 있으면 저장 위치를 복원하고 flag를 지운다. 일반 item/notification/settings 전환은 기존처럼 0으로 reset한다.

- [ ] **Step 4: App context/navigation 테스트를 GREEN으로 확인한다**

Run: `npm test -- src/App.test.tsx`

Expected: neutral snapshot, same thread selection, viewedAt, no PATCH, target/scroll restore, retention clock PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/App.tsx src/App.test.tsx src/ExternalSourcesContext.ts
git commit -m "feat(notes): bridge external notification details"
```

---

### Task 9: Notes에 가상 root와 완전히 분리된 read-only outline을 렌더한다

**Files:**
- Create: `src/features/notes/NotesDetailPane.tsx`
- Create: `src/features/notes/NotesExternalLibraryPageRow.tsx`
- Create: `src/features/notes/NotesExternalBulletRow.tsx`
- Create: `src/features/notes/NotesExternalBulletRow.test.tsx`
- Create: `src/features/notes/NotesExternalOutlinePane.tsx`
- Create: `src/features/notes/NotesExternalOutlinePane.test.tsx`
- Modify: `src/features/notes/NotesFeature.tsx`
- Modify: `src/features/notes/NotesFeature.test.tsx`
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/NotesLibraryPane.test.tsx`
- Modify: `src/features/notes/notes.css`
- Modify: `src/App.test.tsx`

**Interfaces:**
- `NotesDetailPane` routes between existing `NotesOutlinePane` and `NotesExternalOutlinePane`
- virtual root exists outside `state.rootIds`
- external rows use `data-external-bullet-key`, never `data-outline-id` or `NoteId`
- external completion calls only `ExternalSourcesBoundary.complete`

- [ ] **Step 1: virtual root, read-only, explicit-complete 실패 테스트를 작성한다**

`NotesLibraryPane.test.tsx`에 다음 acceptance를 추가한다.

- `All`에서만 `Notifications` root가 보인다.
- provider virtual roots는 registry 순서로 일반 `state.rootIds`보다 먼저 보인다.
- local root가 없어도 virtual root가 있으면 `No pages yet.`가 표시되지 않는다.
- virtual root에 rename, page-actions, star, archive, trash, duplicate, export가 없다.
- provider root를 열기 전에 `flushAllDrafts()`가 성공해야 하며 selection을 clear한다.
- New page, 일반 root, search result, library view, tag 선택은 `selectProvider(null)` 뒤 기존 Notes action을 호출한다.
- Notes search result에는 external title이 섞이지 않는다.

`NotesExternalBulletRow.test.tsx`에는 다음 핵심 테스트를 작성한다.

```ts
it("does not complete on selection, expansion, or details", async () => {
  const user = userEvent.setup();
  renderExternalRow({ bullet: unreadBullet });
  await user.click(screen.getByRole("button", { name: unreadBullet.title }));
  await user.click(screen.getByRole("button", { name: "상세보기" }));
  expect(complete).not.toHaveBeenCalled();
  expect(openDetails).toHaveBeenCalledWith(unreadBullet.key);
});

it("blocks duplicate completion and waits for the host snapshot", async () => {
  const user = userEvent.setup();
  const deferred = createDeferred<void>();
  complete.mockReturnValue(deferred.promise);
  renderExternalRow({ bullet: unreadBullet });
  const button = screen.getByRole("button", { name: `완료: ${unreadBullet.title}` });
  await user.dblClick(button);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(button).toHaveAttribute("aria-pressed", "false");
  deferred.resolve();
  await act(async () => deferred.promise);
  expect(button).toHaveAttribute("aria-pressed", "false");
});
```

그 뒤 parent가 `completed: true`인 새 page snapshot으로 rerender할 때만 completed 모양이 나타나는지 확인한다. 실패+재시도, completed row의 uncomplete 미노출, Ctrl/Meta+Enter 명시적 완료, note text가 textarea/contenteditable이 아닌지도 검증한다. `NotesExternalOutlinePane.test.tsx`는 input order 유지, stable external key로 poll/reorder 뒤 selection·expanded state 유지, disconnected/authentication-required/loading/offline-cache/error/retry 상태, Notes workspace action 0회, Notes detail에서 `상세 최대화` control이 정확히 하나 유지되는지를 검증한다. `App.test.tsx`의 실제 row acceptance는 펼친 항목에서 `상세보기` 후 Notes로 돌아왔을 때 같은 external root가 active이고 같은 행의 note가 계속 펼쳐져 있으며 저장했던 scroll이 복원되는지 확인한다.

- [ ] **Step 2: 새 Notes route/components 부재로 RED인지 확인한다**

Run:

```bash
npm test -- src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/App.test.tsx
```

Expected: virtual root/detail router/read-only row 부재로 FAIL.

- [ ] **Step 3: library virtual page와 detail router를 구현한다**

`NotesFeature.tsx`의 stable panes는 다음처럼 detail wrapper만 교체한다.

```tsx
const notesPanes: FeaturePanes = {
  middle: <NotesLibraryPane />,
  detail: <NotesDetailPane />
};
```

`NotesDetailPane`은 현재 `activeProviderId`와 matching page가 있을 때만 external pane을 렌더하고, 그 외에는 기존 `NotesOutlinePane`을 그대로 렌더한다. 외부 page가 active여도 `useNotesWorkspace` state를 수정하지 않는다.

`NotesLibraryPane`은 `libraryView === "all"`일 때 provider registry 순서의 가상 root를 `state.rootIds.map` 앞의 별도 block으로 렌더한다. external active일 때 일반 root의 active 표시를 끈다. provider open은 `await actions.flushAllDrafts()`가 true인 경우에만 `actions.clearSelection()`과 `selectProvider(providerId)`를 실행한다. 일반 Notes로 향하는 모든 handler는 먼저 `selectProvider(null)`을 실행한다.

- [ ] **Step 4: 외부 outline과 row를 기존 editor와 분리해 구현한다**

`NotesExternalOutlinePane`과 row에서는 다음 module/attribute를 사용하지 않는다.

- `OutlineNodeRow`, `NoteTextField`, `NotesBulletMenu`, `NotesChildComposer`
- `DndContext`, `SortableContext`, Notes selection/clipboard controller
- `NotesExportControllerProvider`, Notes workspace mutation action
- `data-outline-id`, `NoteId` cast

row title/note는 React text node로 렌더하고, local selected/expanded state만 가진다. 각 row의 React key는 배열 index가 아니라 `serializeExternalBulletKey(bullet.key)`여야 poll·정렬·Notes keep-mounted 왕복에서도 상태가 유지된다. `상세보기` label은 정확히 유지한다. 완료 button은 `bullet.capabilities.complete && !bullet.completed`일 때만 보인다. host의 `completingKeys`와 local synchronous ref guard로 같은 frame 중복을 막는다. 완료 성공 promise만으로 completed CSS를 바꾸지 않고 다음 page snapshot의 `bullet.completed`를 기다린다. 실패 시 inline alert와 `다시 시도`를 보인다. 이미 completed인 행에는 완료 취소 control을 렌더하지 않는다.

external outline header는 page title `Notifications`와 `PaneLayoutContext`의 기존 `상세 최대화` action을 렌더한다. App이 Notes의 titlebar maximize를 숨기는 현재 계약을 유지하므로 이 control을 생략하면 안 된다. export/sync/edit toolbar를 복제하지 않는다.

- [ ] **Step 5: Notes 집중 테스트를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/App.test.tsx
```

Expected: virtual page, read-only isolation, no incidental completion, exactly-once completion, navigation round-trip PASS.

- [ ] **Step 6: 첫 fresh desktop vertical slice를 확인한다**

1. 현재 Settings의 Vault folder 절대 경로를 기록하고 기존 dev 앱을 종료한다.
2. `mktemp -d /private/tmp/yonalist-notifications-smoke.XXXXXX`로 테스트 Vault를 만들고 출력된 정확한 절대 경로를 기록한다.
3. `npm run tauri:dev`로 새 bundle/process를 시작한다.
4. Settings에서 Vault folder를 테스트 Vault로 바꾼다.
5. Notes의 `Notifications`를 열어 한 개의 실제 알림 제목/note/완료 모양을 확인한다.
6. 펼치기와 선택이 GitHub 읽음을 만들지 않는지 확인한다.
7. `상세보기`로 기존 Notifications의 같은 thread가 선택되고 Notes 복귀 시 외부 page/scroll/expanded state가 유지되는지 확인한다.
8. 명시적 완료가 성공한 뒤에만 completed 모양이 되는지 확인한다.
9. 성공/실패와 무관하게 `finally` cleanup으로 원래 Vault folder를 다시 선택해 Save하고 실제로 복원됐는지 확인한 뒤 dev app/process를 종료한다.
10. 기록한 temp 경로가 `realpath` 기준 `/private/tmp/yonalist-notifications-smoke.` prefix의 directory와 정확히 일치하는지 확인한 경우에만 그 단일 경로를 제거한다. 검증이나 Vault 복원이 실패하면 삭제를 시도하지 말고 정확한 잔여 경로와 상태를 보고한다.

첫 runtime 이상에서는 Web Inspector 또는 앱 로그를 먼저 확인한다. 같은 증상을 두 번 추측 수정하지 않는다.

- [ ] **Step 7: 커밋한다**

```bash
git add src/features/notes/NotesDetailPane.tsx src/features/notes/NotesExternalLibraryPageRow.tsx src/features/notes/NotesExternalBulletRow.tsx src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/NotesExternalOutlinePane.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesFeature.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/notes.css src/App.test.tsx
git commit -m "feat(notes): show external notifications as read-only bullets"
```

---

### Task 10: Settings에 GitHub Notifications 표시 기간을 노출한다

**Files:**
- Modify: `src/components/SettingsCategoryPane.tsx`
- Modify: `src/components/SettingsCategoryPane.test.tsx`
- Modify: `src/components/SettingsPage.tsx`
- Modify: `src/components/SettingsPage.test.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Adds: `plugins` settings section with bundled `GitHub Notifications`
- Edits: `settings.githubNotificationsReadRetentionDays`
- Keeps: immediate in-memory projection update; persistence only through existing Save settings path

- [ ] **Step 1: category/input/persistence 실패 테스트를 작성한다**

```ts
it("edits the GitHub Notifications read retention", async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  renderSettings({ section: "plugins", onUpdate });
  const input = screen.getByRole("spinbutton", {
    name: "읽은 알림 표시 기간"
  });
  await user.clear(input);
  expect(onUpdate).not.toHaveBeenCalled();
  await user.type(input, "45");
  expect(onUpdate).toHaveBeenLastCalledWith(
    "githubNotificationsReadRetentionDays",
    45
  );
  fireEvent.change(input, { target: { value: "0" } });
  expect(onUpdate).toHaveBeenLastCalledWith(
    "githubNotificationsReadRetentionDays",
    1
  );
  fireEvent.change(input, { target: { value: "366" } });
  expect(onUpdate).toHaveBeenLastCalledWith(
    "githubNotificationsReadRetentionDays",
    365
  );
  fireEvent.change(input, { target: { value: "7.6" } });
  expect(onUpdate).toHaveBeenLastCalledWith(
    "githubNotificationsReadRetentionDays",
    8
  );
  await user.clear(input);
  fireEvent.blur(input);
  expect(onUpdate).toHaveBeenLastCalledWith(
    "githubNotificationsReadRetentionDays",
    30
  );
});
```

`App.test.tsx`는 Save 뒤 localStorage에 45가 저장되는지, 설정 state를 1일로 바꾸면 새 GET/PATCH 없이 오래된 read row만 즉시 사라지고 unread row는 남는지 확인한다.

`SettingsCategoryPane.test.tsx`는 `Plugins` tab이 `GitHub Notifications` 설명과 함께 존재하고 click/keyboard selection이 `onSelect("plugins")`를 호출하는지 명시적으로 확인한다.

- [ ] **Step 2: plugins section 부재로 RED인지 확인한다**

Run:

```bash
npm test -- src/components/SettingsCategoryPane.test.tsx src/components/SettingsPage.test.tsx src/App.test.tsx src/appSettings.test.ts
```

Expected: `plugins` section/input 부재로 FAIL.

- [ ] **Step 3: 정적 plugin 설정 UI를 구현한다**

`SettingsSection`에 `plugins`를 추가하고 `Plug` icon category를 등록한다. Settings page에는 다음 필드 하나만 둔다.

```tsx
const [githubRetentionDraft, setGithubRetentionDraft] = useState(() =>
  String(settings.githubNotificationsReadRetentionDays)
);

useEffect(() => {
  setGithubRetentionDraft(String(settings.githubNotificationsReadRetentionDays));
}, [settings.githubNotificationsReadRetentionDays]);

function updateGithubRetentionDraft(value: string) {
  setGithubRetentionDraft(value);
  if (value === "") return;
  onUpdate(
    "githubNotificationsReadRetentionDays",
    normalizeGithubNotificationsReadRetentionDays(Number(value))
  );
}

<label>
  읽은 알림 표시 기간
  <input
    type="number"
    min={1}
    max={365}
    step={1}
    required
    value={githubRetentionDraft}
    onChange={(event) => updateGithubRetentionDraft(event.target.value)}
    onBlur={() => {
      if (githubRetentionDraft === "") {
        const fallback = defaultSettings.githubNotificationsReadRetentionDays;
        setGithubRetentionDraft(String(fallback));
        onUpdate("githubNotificationsReadRetentionDays", fallback);
      }
    }}
  />
</label>
```

설명에는 읽지 않은 알림은 이 기간보다 오래되어도 유지된다고 명시한다. local string draft 덕분에 사용자는 빈칸에서 `45`를 정상 입력할 수 있다. 빈칸 blur는 30으로, 0/366은 1/365로, 소수는 가장 가까운 정수로 정규화한다. `required`이므로 빈 draft 상태의 form submit은 허용하지 않는다. footer Save 조건에 `plugins`를 추가한다. runtime plugin 설치, enable toggle, 임의 URL 입력은 만들지 않는다. App projection도 같은 helper를 방어적으로 사용하므로 committed 입력 변경 즉시 유효한 범위로 목록이 바뀌고, Save는 기존 `persistSettings`만 사용한다.

- [ ] **Step 4: settings와 retention 통합 테스트를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/components/SettingsCategoryPane.test.tsx src/components/SettingsPage.test.tsx src/App.test.tsx src/appSettings.test.ts
```

Expected: category/input/save/immediate retention/unread preservation PASS.

- [ ] **Step 5: 커밋한다**

```bash
git add src/components/SettingsCategoryPane.tsx src/components/SettingsCategoryPane.test.tsx src/components/SettingsPage.tsx src/components/SettingsPage.test.tsx src/App.test.tsx
git commit -m "feat(settings): configure notification retention"
```

---

### Task 11: offline, account switch, reset과 비오염 회귀를 닫는다

**Files:**
- Modify: `src/App.test.tsx`
- Modify: `src/services/appReset.test.ts`
- Modify: `src/features/notes/NotesExternalOutlinePane.test.tsx`
- Modify: `src/services/externalSourceHost.test.ts`
- Modify if an edge test fails: `src/App.tsx`
- Modify if an edge test fails: `src/features/notes/NotesExternalOutlinePane.tsx`
- Modify if an edge test fails: `src/services/externalSourceHost.ts`

**Interfaces:**
- Completes: cached/offline/no-cache/disconnected/error states
- Completes: account switch generation and cache isolation proof
- Completes: reset removal of external snapshots
- Proves: Notes persistence/history/search/export APIs never receive external keys

- [ ] **Step 1: acceptance matrix의 남은 실패 테스트를 작성한다**

다음 행을 각각 독립 테스트로 추가한다.

1. offline + matching cached account: cached rows와 `syncedAt`을 표시하고 refresh/complete는 원격 성공을 가장하지 않는다.
2. offline + no cache: 짧은 offline 안내를 표시하고 일반 Notes는 계속 편집 가능하다.
3. disconnected: GitHub 연결 안내만 표시하며 sample notifications를 Notes에 투영하지 않는다.
4. authentication-required: `/user`가 401/403이면 무한 connecting 대신 GitHub 재연결 안내를 표시하고 일반 Notes는 계속 사용 가능하다.
5. refresh 실패 + cache: 기존 rows를 유지하고 page-local error/retry를 표시한다.
6. account A request가 늦게 끝난 뒤 account B로 전환: A row가 B 화면/cache에 나타나지 않는다.
7. reset: `yonalist.externalSources.snapshots.v1`이 제거되고 Vault 문서는 보존된다.
8. external row의 선택/완료/details 후 Notes `updateNode`, `toggleComplete`, `applyBatch`, `searchNotes`, export callback 호출은 0회다.
9. GitHub가 같은 thread를 새 `updated_at`, `unread: true`로 반환하면 이전 completed projection이 다시 incomplete가 된다.

- [ ] **Step 2: 아직 닫히지 않은 edge가 RED인지 확인한다**

Run:

```bash
npm test -- src/App.test.tsx src/services/appReset.test.ts src/features/notes/NotesExternalOutlinePane.test.tsx src/services/externalSourceHost.test.ts
```

Expected: 아직 빠진 edge는 FAIL. Tasks 1~10 구현이 이미 모든 새 assertion을 만족하면 그 결과를 regression coverage로 기록하고 Step 3의 production 수정을 건너뛴다. RED를 만들기 위해 assertion을 강화하거나 정상 코드를 일부러 약화하지 않는다.

- [ ] **Step 3: 실제 실패가 있을 때만 owning boundary에서 최소 수정한다**

- offline 여부는 App의 provider-neutral `availability`로만 Notes에 전달한다.
- host refresh error는 last good items를 지우지 않는다.
- account dependency가 바뀌면 이전 handle을 dispose하고 page items를 즉시 빈 배열로 만든다.
- reset은 기존 `resetLocalStorage()`가 모든 `yonalist.*` key를 제거하므로 production 분기를 추가하지 않는다. 테스트로 새 key가 실제 제거됨만 고정한다.
- Notes isolation 실패는 external component에서 Notes workspace import/callback을 제거해 해결한다. 외부 key를 Notes command에서 검사하는 fallback으로 해결하지 않는다.

- [ ] **Step 4: edge 회귀를 GREEN으로 확인한다**

Run:

```bash
npm test -- src/App.test.tsx src/services/appReset.test.ts src/features/notes/NotesExternalOutlinePane.test.tsx src/services/externalSourceHost.test.ts
```

Expected: offline/account/reset/non-leak/new-activity tests PASS.

- [ ] **Step 5: 정적 경계 검사를 수행한다**

Run:

```bash
rg -n "GitHubNotification|useNotifications|markNotificationRead" src/features/notes --glob '!*.test.tsx'
rg -n "as NoteId|data-outline-id|OutlineNodeRow|DndContext|NotesExportController" src/features/notes --glob 'NotesExternal*.tsx' --glob '!*.test.tsx'
```

Expected: 두 명령 모두 match가 없어 `rg` exit 1. 이는 정적 경계가 지켜졌다는 뜻이며 테스트 실패로 취급하지 않는다.

- [ ] **Step 6: 커밋한다**

```bash
git add src/App.test.tsx src/services/appReset.test.ts src/features/notes/NotesExternalOutlinePane.test.tsx src/services/externalSourceHost.test.ts src/App.tsx src/features/notes/NotesExternalOutlinePane.tsx src/services/externalSourceHost.ts
git commit -m "test(notes): harden external notification boundaries"
```

`git add` 목록 중 production 파일은 실제 edge 수정이 생긴 파일만 stage한다.

---

### Task 12: 전체 검증, fresh desktop proof와 최종 diff review를 수행한다

**Files:**
- Review: all files changed by Tasks 1-11
- Do not modify without renewed approval: `docs/superpowers/specs/2026-07-22-notes-external-notifications-plugin-design.md`

구현이 승인 설계와 다르면 Task 12 정리로 spec을 맞춰 쓰지 않는다. 작업을 멈추고 차이, 이유, 사용자 영향과 선택지를 보고해 재승인을 받는다.

- [ ] **Step 1: acceptance별 집중 suite를 한 번 실행한다**

Run:

```bash
npm test -- src/domain/externalSources.test.ts src/services/authGate.test.ts src/services/githubAccountIdentity.test.ts src/services/externalSourceRegistry.test.ts src/services/externalSourceSnapshotStore.test.ts src/services/externalSourceHost.test.ts src/services/githubNotificationsProvider.test.ts src/services/notifications.test.ts src/services/notificationStores.test.ts src/services/appReset.test.ts src/hooks/useAuthGate.test.tsx src/hooks/useExternalSource.test.tsx src/hooks/useNotifications.test.tsx src/features/notes/NotesExternalBulletRow.test.tsx src/features/notes/NotesExternalOutlinePane.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesFeature.test.tsx src/components/NotificationsPane.test.tsx src/components/SettingsCategoryPane.test.tsx src/components/SettingsPage.test.tsx src/appSettings.test.ts src/App.test.tsx
```

Expected: all focused tests PASS. 이미 통과한 개별 테스트를 반복해서 유리한 결과를 만들지 않는다.

- [ ] **Step 2: fresh desktop 전체 사용자 흐름을 검증한다**

현재 Vault folder 절대 경로를 먼저 기록한 뒤, 새 `/private/tmp` 테스트 Vault와 새 `npm run tauri:dev` process에서 다음 순서로 확인한다.

1. Notes `Notifications` root와 newest-first direct children을 확인한다.
2. unread/read가 incomplete/completed 모양과 일치하는지 확인한다.
3. 선택/펼치기 후 GitHub가 unread인지 확인한다.
4. `상세보기` 후 기존 Notifications가 같은 thread를 선택하고 로컬 viewed 표시가 생기는지 확인한다.
5. Notes 복귀 후 명시적으로 완료하지 않은 row가 여전히 incomplete인지 확인한다.
6. 명시적 완료 성공 뒤에만 completed가 되고 GitHub에서도 read인지 확인한다.
7. offline 완료 실패가 incomplete와 retry를 유지하는지 확인한다.
8. 기간을 바꿔 오래된 read만 사라지고 unread는 남는지 확인한다.
9. 일반 Note를 만들고 Undo/Redo, 검색, export, trash를 사용해 외부 row가 섞이지 않는지 확인한다.
10. 기존 Notifications 검색, `Only new`, 날짜 그룹, detail, browser open이 그대로인지 확인한다.

성공/실패와 무관한 `finally` cleanup에서 원래 Vault folder를 다시 선택·저장하고 복원을 확인한 뒤 dev app/process를 종료한다. 그 다음 기록한 정확한 temp 경로가 `realpath` 기준 `/private/tmp/yonalist-notifications-smoke.` prefix의 directory인지 검증된 경우에만 그 단일 경로를 제거한다. 복원 또는 경로 검증 실패 시 삭제하지 않고 잔여 경로와 수동 복구 방법을 최종 보고한다.

- [ ] **Step 3: 전체 구현 diff를 기준 commit과 설계에 대조한다**

Run:

```bash
git status --short
git diff 3941c7c --stat
git diff --name-status 3941c7c
git diff 3941c7c -- src
git diff --exit-code 3941c7c -- src-tauri
```

Tasks 1~11이 각자 커밋되므로 plain `git diff`는 사용할 수 없다. 구현 시작 기준 `3941c7c`과 현재 working tree를 비교해 committed 및 uncommitted implementation을 함께 본다. `src` 전체를 읽어 계정 identity부터 기존 Notifications adapter, Notes projection, reset까지 빠짐없이 검토하고, `src-tauri` diff는 scope 위반으로 실패해야 한다.

Review checklist:

- 기존 Notifications selection에 PATCH가 추가되지 않았다.
- Notes projection은 `viewedAt`을 사용하지 않는다.
- 외부 ID가 Note ID나 Notes DB/history/search/export에 들어가지 않는다.
- success 전 optimistic completion이 없다.
- host/cache key는 provider + server/account identity이며 token은 없다.
- raw provider 오류와 completion 반환값은 안전한 고정 오류/decoder/key 검증 경계를 통과한다.
- read retention 범위와 unread 예외가 승인 설계와 일치한다.
- 활성 external page의 coarse clock이 offline cached read row의 retention 경계를 갱신한다.
- dynamic plugin loader나 범용 네트워크 capability가 없다.
- 임시 fixture, debug log, test Vault 경로가 diff에 없다.

- [ ] **Step 4: desktop/diff review에서 수정이 생기면 집중 테스트를 다시 확인한다**

실제 수정이 생긴 owning test만 다시 실행해 PASS를 확인한다. 수정이 없으면 Step 1의 suite를 반복하지 않는다. 이후 diff를 더 바꾸지 않고 final gates로 이동한다.

- [ ] **Step 5: frozen diff의 최종 frontend gates를 한 번 실행한다**

Run:

```bash
npm test
npm run lint
npm run build
npm run test:architecture
git diff --check 3941c7c
```

Expected: 모두 exit 0. Rust, IPC payload, SQLite, native config를 변경하지 않았으므로 Cargo test, rustfmt, Clippy는 명시적으로 생략한다. 이 뒤 코드가 바뀌면 관련 집중 테스트와 모든 final gate를 다시 실행해야 한다.

- [ ] **Step 6: final integration commit이 필요한 경우에만 커밋한다**

Task 12 검증 중 실제 수정이 생겼다면 `git status --short`로 그 파일을 확인하고, 해당 명시적 경로만 `git add`한 뒤 `git commit -m "feat(notes): integrate external notification bullets"`로 커밋한다. 수정이 없으면 빈 커밋을 만들지 않는다. 최종 보고에는 acceptance 결과, focused/full gate 결과, desktop proof, Cargo 생략 이유, 남은 위험과 마지막 commit hash를 포함한다.
