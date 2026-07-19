# 지연 기능 런타임과 시작 성능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Yonalist workflow:** REQUIRED PROJECT SKILL: Read and apply `.agents/skills/delivering-yonalist-changes/SKILL.md` before implementation.

**Goal:** Inbox로 시작할 때 Notes와 `@dnd-kit` 코드를 내려받거나 초기화하지 않도록 기능 런타임을 지연 로딩하고, 확인된 no-op을 제거하며, 번들·실행 시간 회귀를 수치로 차단한다.

**Architecture:** 기능 레지스트리에는 항상 작은 메타데이터만 둔다. Inbox와 Settings 런타임은 즉시 제공하고, Notes 런타임은 최초 선택 시 한 번만 동적 import한다. `useFeatureRuntimeHost`가 `idle/loading/ready/failed` 상태와 이미 로드된 런타임을 소유하고, `App`은 준비된 Provider와 pane만 렌더링한다. 별도 플러그인 프레임워크나 외부 상태 라이브러리는 추가하지 않는다.

**Tech Stack:** Tauri 2, React 19, TypeScript 6, Vite 8, Vitest 4, Node 표준 라이브러리

## 현재 진행 상태 (2026-07-19)

- 시작 p50 `151 → 108 ms`(`-28.5%`), p95 `159 → 113 ms`(`-28.9%`)
- 초기 정적 JS raw `1,146,420 → 744,567 bytes`(`-35.1%`)
- 초기 정적 JS gzip `346,049 → 232,593 bytes`(`-32.8%`)
- App chunk raw `692,446 → 289,162 bytes`(`-58.2%`)
- Notes 지연 chunk raw `543.10 → 494.74 kB`(`-8.9%`), build 경고 제거
- 첫 Notes/재진입 release 시간과 network 관찰은 macOS native window 0개로 미측정

미측정 항목은 통합 테스트 결과로 대체해 PASS 처리하지 않는다.

## Delivery Contract

| Field | Contract |
| --- | --- |
| Goal | Inbox 시작에서 Notes와 `@dnd-kit`을 요청·초기화하지 않고 확인된 TypeScript no-op을 제거한다. |
| Acceptance | bundle의 raw/gzip/source 예산, 20회 release p50/p95, Notes 최초·재활성화 시간, frontend gate가 모두 통과한다. |
| Non-goals | Rust style/API 정리, Notes unload, idle prefetch, 외부 plugin framework 도입은 하지 않는다. |
| Boundaries | React feature registry/Provider, Vite chunk graph, 기존 Tauri 성능 event 경계. IPC payload, SQLite, filesystem schema는 바꾸지 않는다. |
| Manual proof | fresh release 앱을 Inbox로 시작해 Notes 요청 0회를 확인하고, Notes 최초 진입·Inbox 왕복·재진입에서 상태 보존과 추가 요청 0회를 확인한다. |

## Global Constraints

- 새 런타임 의존성을 추가하지 않는다.
- Notes는 Inbox 시작 경로에서 정적 import되지 않아야 한다.
- Notes 런타임은 최초 성공 후 같은 앱 세션에서 다시 요청하지 않는다.
- Notes가 한 번 준비되면 다른 기능으로 이동해도 Provider와 pane을 유지한다.
- 현재 사용자 동작, 인증 게이트, Notes draft/scroll/focus 보존 동작을 바꾸지 않는다.
- 초기 정적 JS는 raw `917,136 bytes` 이하, gzip `276,839 bytes` 이하여야 한다.
- App chunk는 raw `500,000 bytes` 미만, gzip `150,000 bytes` 이하여야 한다.
- 초기 App sourcemap의 `/features/notes/` 및 `/node_modules/@dnd-kit/` source 수는 각각 `0`이어야 한다.
- `renderer_entry → app_mounted` 20회 release 측정의 p50은 기준값의 `85%` 이하, p95는 기준값보다 느려지지 않아야 한다.
- 최초 Notes 활성화 p50은 분리 전 기준값 `+100 ms` 이내, 재활성화 p50은 기준값 대비 `5%` 이내여야 한다.

---

### Task 1: 기능 활성화 시간을 분리 전·후 동일한 방식으로 기록한다

**Files:**

- Create: `src/features/core/featureActivationTiming.ts`
- Create: `src/features/core/featureActivationTiming.test.ts`
- Modify: `src/App.tsx`
- Create: `docs/superpowers/reports/2026-07-19-startup-performance.md`

- [x] **Step 1: 순수 타이밍 계약의 실패 테스트를 작성한다**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  beginFeatureActivation,
  finishFeatureActivation
} from "./featureActivationTiming";

describe("feature activation timing", () => {
  it("같은 activation id로 start와 visible을 기록한다", () => {
    const record = vi.fn();
    const sample = beginFeatureActivation(4, "notes", 120, record);

    finishFeatureActivation(sample, 205, record);

    expect(record).toHaveBeenCalledWith("feature_activation_start", {
      activationId: 4,
      featureId: "notes"
    });
    expect(record).toHaveBeenCalledWith("feature_activation_visible", {
      activationId: 4,
      featureId: "notes",
      durationMs: 85
    });
  });
});
```

- [x] **Step 2: 테스트가 구현 부재로 실패하는지 확인한다**

Run: `npx vitest run src/features/core/featureActivationTiming.test.ts`

Expected: `Cannot find module './featureActivationTiming'`로 실패.

- [x] **Step 3: 최소 순수 함수를 구현한다**

```ts
import type { FeatureId } from "./featureTypes";

export type FeatureTimingRecorder = (
  name: string,
  detail: Record<string, unknown>
) => void;

export interface FeatureActivationSample {
  activationId: number;
  featureId: FeatureId;
  startedAt: number;
}

export function beginFeatureActivation(
  activationId: number,
  featureId: FeatureId,
  startedAt: number,
  record: FeatureTimingRecorder
): FeatureActivationSample {
  record("feature_activation_start", { activationId, featureId });
  return { activationId, featureId, startedAt };
}

export function finishFeatureActivation(
  sample: FeatureActivationSample,
  visibleAt: number,
  record: FeatureTimingRecorder
) {
  record("feature_activation_visible", {
    activationId: sample.activationId,
    featureId: sample.featureId,
    durationMs: visibleAt - sample.startedAt
  });
}
```

- [x] **Step 4: `App`의 기능 변경과 실제 pane 준비 시점에 계측을 연결한다**

`changeActiveFeature`에서 `beginFeatureActivation`을 호출한다. 활성 기능의 런타임과 pane이 준비된 다음 `requestAnimationFrame` 한 번 뒤 `finishFeatureActivation`을 호출한다. 같은 `activationId`는 한 번만 완료되도록 ref로 막는다. 성능 기록 함수는 기존 `tracePerf`를 그대로 사용한다.

- [x] **Step 5: 분리 전 release 기준값을 20회 측정해 보고서에 고정한다**

Run: `VITE_YONALIST_PERF=1 npm run tauri:build`

동일 기기·전원 연결·Inbox 고정 조건에서 앱을 20회 완전 종료 후 실행한다. 각 실행에서 `app_mounted`, 최초 Notes의 `feature_activation_visible`, Inbox 복귀 후 Notes 재활성화의 `feature_activation_visible`을 수집한다. 보고서 표에는 20개 원자료, p50, p95, 실행 commit SHA를 기록한다. 이 단계에서 결과를 좋게 보이게 하는 warm-up 제외는 허용하지 않는다.

- [x] **Step 6: 테스트와 타입 검사를 실행한다**

Run: `npx vitest run src/features/core/featureActivationTiming.test.ts && npx tsc --noEmit`

Expected: PASS.

- [x] **Step 7: 계측 기준점을 커밋한다**

```bash
git add src/features/core/featureActivationTiming.ts src/features/core/featureActivationTiming.test.ts src/App.tsx docs/superpowers/reports/2026-07-19-startup-performance.md
git commit -m "perf: record feature activation timing"
```

### Task 2: 컴파일러로 확인된 no-op과 불필요한 타입 우회를 제거한다

**Files:**

- Modify: `tsconfig.json`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/NotesFeature.tsx`
- Modify: `src/hooks/useScrollbarHover.ts`
- Modify: `src/services/githubItems.ts`
- Modify: `src/App.featurePaneMemo.test.tsx`
- Modify: `src/App.preload.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- Modify: `src/services/githubItems.test.ts`
- Modify: `src/services/notifications.test.ts`

- [x] **Step 1: unused 검사를 켜서 현재 17개 오류를 재현한다**

`tsconfig.json`에 다음 두 옵션을 추가한다.

```json
"noUnusedLocals": true,
"noUnusedParameters": true
```

Run: `npx tsc --noEmit`

Expected: production 9개, test 8개 unused 오류로 실패.

- [x] **Step 2: production의 실제 no-op만 삭제한다**

다음 항목만 제거한다.

- `notesDraftEngine.ts`: `NotesWorkspace`, `NotesWorkspaceScope` import
- `NotesOutlinePane.tsx`: `NotesSelectionActionSnapshot` import
- `useNotesWorkspace.ts`: `createNoteId`, `NotesWriteQueue`, `buildNotesMoveNodeInput`, `flushDraftBeforeStructural`
- `useScrollbarHover.ts`: 사용하지 않는 Map key 변수
- `githubItems.ts`: `openItemCount`

`useScrollbarHover.ts` cleanup은 의미를 바꾸지 않고 다음처럼 value만 순회한다.

```ts
for (const timer of activeTimers.values()) {
  window.clearTimeout(timer);
}
```

- [x] **Step 3: 테스트의 unused 변수·import를 삭제한다**

테스트 동작과 assertion은 바꾸지 않고 확인된 React import, `user`, `useNotesState`, `init`, `url` 선언만 제거한다.

- [x] **Step 4: Notes hook 반환 타입을 실제 불변조건과 일치시킨다**

```ts
export interface UseNotesWorkspaceHookResult extends UseNotesWorkspaceResult {
  stateSlice: NotesStateSlice;
  draftsSlice: NotesDraftsSlice;
  actionsSlice: NotesActionsSlice;
}
```

`useNotesWorkspace`의 반환 타입을 위 타입으로 바꾸고 `NotesFeature.tsx`의 `workspace.stateSlice ?? workspace` 세 곳을 직접 slice 접근으로 교체한다.

- [x] **Step 5: 컴파일러·lint·관련 테스트를 실행한다**

Run: `npx tsc --noEmit && npx vitest run src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/hooks/useScrollbarHover.test.ts src/services/githubItems.test.ts src/services/notifications.test.ts`

Expected: unused 진단 0, 전체 명령 PASS.

- [x] **Step 6: no-op 정리를 커밋한다**

```bash
git add tsconfig.json \
  src/features/notes/notesDraftEngine.ts \
  src/features/notes/NotesOutlinePane.tsx \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/NotesFeature.tsx \
  src/hooks/useScrollbarHover.ts \
  src/services/githubItems.ts \
  src/App.featurePaneMemo.test.tsx \
  src/App.preload.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/services/githubItems.test.ts \
  src/services/notifications.test.ts
git commit -m "refactor: remove verified TypeScript no-ops"
```

### Task 3: 기능 메타데이터와 실행 런타임을 분리한다

**Files:**

- Modify: `src/features/core/featureTypes.ts`
- Modify: `src/features/core/featureRegistry.tsx`
- Modify: `src/features/core/featureRegistry.test.tsx`
- Modify: `src/features/inbox/InboxFeature.tsx`
- Modify: `src/features/settings/SettingsFeature.tsx`
- Modify: `src/features/notes/NotesFeature.tsx`

- [x] **Step 1: 레지스트리의 지연 로딩 계약 테스트를 먼저 작성한다**

```ts
it("Notes 메타데이터는 runtime 대신 loader만 가진다", () => {
  const notes = getFeatureDefinition("notes");

  expect(notes.id).toBe("notes");
  expect("runtime" in notes).toBe(false);
  expect("loadRuntime" in notes).toBe(true);
});

it("Inbox와 Settings는 eager runtime을 가진다", () => {
  expect("runtime" in getFeatureDefinition("inbox")).toBe(true);
  expect("runtime" in getFeatureDefinition("settings")).toBe(true);
});
```

- [x] **Step 2: 현재 타입에서 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/features/core/featureRegistry.test.tsx`

Expected: `loadRuntime` 계약 부재로 FAIL.

- [x] **Step 3: 타입을 최소 discriminated union으로 바꾼다**

```ts
export interface FeatureMetadata {
  id: FeatureId;
  label: string;
  icon: LucideIcon;
  section: FeatureNavigationSection;
  order: number;
  requiresGithubAuth: boolean;
  keepMounted: boolean;
}

export interface FeatureRuntime {
  Provider: ComponentType<PropsWithChildren>;
  renderPanes: (context: FeatureRenderContext) => FeaturePanes;
}

export type FeatureDefinition = FeatureMetadata &
  (
    | { runtime: FeatureRuntime; loadRuntime?: never }
    | { runtime?: never; loadRuntime: () => Promise<FeatureRuntime> }
  );
```

- [x] **Step 4: 기존 기능 export를 런타임 형태로 정리한다**

Inbox와 Settings는 기존 `Provider`/`renderPanes`를 `runtime` 객체 안으로 옮긴다. Notes는 메타데이터를 export하지 않고 다음 런타임만 export한다.

```ts
export const notesFeatureRuntime: FeatureRuntime = {
  Provider: NotesFeatureProvider,
  renderPanes: () => notesPanes
};
```

- [x] **Step 5: 레지스트리에서 Notes 정적 import를 제거한다**

```ts
const notesFeature: FeatureDefinition = {
  id: "notes",
  label: "Notes",
  icon: NotebookPen,
  section: "workspace",
  order: 20,
  requiresGithubAuth: false,
  keepMounted: true,
  loadRuntime: () =>
    import("../notes/NotesFeature").then(
      ({ notesFeatureRuntime }) => notesFeatureRuntime
    )
};
```

`featureRegistry.tsx`에는 Notes의 어떤 값 import도 남기지 않는다. `NotebookPen` 아이콘만 `lucide-react`에서 직접 import한다.

- [x] **Step 6: 레지스트리 단위 테스트를 실행한다**

Run: `npx vitest run src/features/core/featureRegistry.test.tsx`

Expected: PASS. 이 시점에는 `App.tsx`가 구 계약을 읽고 있으므로 전체 typecheck는
Task 5 통합 직후 실행한다.

- [x] **Step 7: 변경을 유지하고 Runtime Host 구현으로 이어간다**

Task 3~5는 하나의 compile-safe 변경 단위다. 아직 commit하지 않는다.

### Task 4: 한 번만 로드하고 유지하는 Feature Runtime Host를 구현한다

**Files:**

- Create: `src/features/core/useFeatureRuntimeHost.ts`
- Create: `src/features/core/useFeatureRuntimeHost.test.tsx`

- [x] **Step 1: 상태 전이와 캐시 동작을 표현하는 hook 테스트를 작성한다**

필수 사례는 네 가지다.

1. eager 기능은 첫 render부터 `ready`
2. lazy 기능은 `idle → loading → ready`
3. 한 번 준비된 Notes는 Inbox 왕복 후 loader를 다시 호출하지 않음
4. reject 시 `failed`, retry 시 새 Promise로 `ready`

```ts
expect(result.current.active.status).toBe("loading");
await act(() => deferred.resolve(runtime));
expect(result.current.active).toMatchObject({ status: "ready", runtime });

rerender({ activeFeatureId: "inbox" });
rerender({ activeFeatureId: "notes" });
expect(loadRuntime).toHaveBeenCalledTimes(1);
```

- [x] **Step 2: 구현 전 실패를 확인한다**

Run: `npx vitest run src/features/core/useFeatureRuntimeHost.test.tsx`

Expected: module 부재로 FAIL.

- [x] **Step 3: 상태 타입과 공개 API를 구현한다**

```ts
export type FeatureRuntimeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; runtime: FeatureRuntime }
  | { status: "failed"; error: Error };

export interface FeatureRuntimeHost {
  active: FeatureRuntimeState;
  readyRuntimes: ReadonlyMap<FeatureId, FeatureRuntime>;
  retry: () => void;
}

export function useFeatureRuntimeHost(
  activeFeatureId: FeatureId,
  definitions: readonly FeatureDefinition[] = featureRegistry
): FeatureRuntimeHost;
```

hook 내부 Map은 eager runtime으로 한 번 초기화한다. lazy Promise는 feature id별로 하나만 추적한다. resolve 후 runtime을 Map에 보존하고, reject 후에는 in-flight 항목을 지워 retry가 새 호출을 만들 수 있게 한다. unmount 뒤 완료된 Promise가 setState하지 않도록 cleanup boolean을 둔다.

- [x] **Step 4: 레이스 테스트를 추가한다**

Notes 로딩 중 Inbox로 이동한 뒤 Notes Promise가 resolve되어도 현재 Inbox 상태는 `ready`이고 Notes runtime은 `readyRuntimes`에 저장되는지 검증한다. 느린 이전 Promise가 retry의 최신 결과를 덮지 못하도록 요청 세대 번호를 검증한다.

- [x] **Step 5: hook 단위 테스트를 실행한다**

Run: `npx vitest run src/features/core/useFeatureRuntimeHost.test.tsx`

Expected: PASS, loader 재호출 수 1. 전체 typecheck는 Task 5의 App 계약 변경 후 실행한다.

- [x] **Step 6: 변경을 유지하고 App 통합으로 이어간다**

Task 3의 registry 변경과 함께 아직 commit하지 않는다.

### Task 5: App을 Runtime Host에 연결하고 실패를 국소화한다

**Files:**

- Create: `src/features/core/FeatureRuntimeBoundary.tsx`
- Create: `src/features/core/FeatureRuntimeBoundary.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.featurePaneMemo.test.tsx`
- Modify: `src/App.preload.test.tsx`
- Create: `src/App.lazyFeatureRuntime.test.tsx`

- [x] **Step 1: App 통합의 실패 테스트를 작성한다**

다음 사용자 관찰만 검증한다.

- Inbox 시작 시 Notes loader 호출 0회
- Notes 선택 직후 `Loading Notes…` 표시
- resolve 후 Notes pane 표시
- Inbox 왕복 후 Notes pane 상태 유지 및 loader 총 1회
- reject 후 `Notes를 열 수 없습니다`와 `다시 시도` 버튼 표시
- retry resolve 후 Notes pane 표시

테스트는 `featureRegistry`의 Notes loader를 제어 가능한 deferred Promise로 대체한다. module import 순서나 `mock.calls[n]`은 assertion하지 않는다.

- [x] **Step 2: 현 App에서 실패하는지 확인한다**

Run: `npx vitest run src/App.lazyFeatureRuntime.test.tsx`

Expected: Notes가 시작부터 정적 mount되거나 loading/error UI가 없어 FAIL.

- [x] **Step 3: Provider와 pane 계산을 준비된 runtime 기준으로 바꾼다**

`App`에서 `useFeatureRuntimeHost(activeFeatureId)`를 호출한다. Provider reduce와 pane map은 `readyRuntimes`에 있는 기능만 대상으로 한다. 활성 기능이 `loading`이면 동일한 middle/detail slot에 loading pane을, `failed`면 오류와 retry를 렌더링한다. 인증 게이트의 `onOpenNotes`는 기존처럼 기능만 변경하고 loader 수명은 Host가 관리한다.

- [x] **Step 4: render 오류 전용 경계를 최소 class component로 추가한다**

`FeatureRuntimeBoundary`는 활성 기능 id가 바뀌면 error를 초기화하고, 오류 UI와 `onRetry`만 제공한다. 로딩 상태·데이터 fetch·전역 오류는 맡기지 않는다.

```tsx
<FeatureRuntimeBoundary featureId={feature.id} onRetry={runtimeHost.retry}>
  <FeatureProvider>{wrapped}</FeatureProvider>
</FeatureRuntimeBoundary>
```

- [x] **Step 5: 기존 pane memoization 계약을 지연 로딩 방식으로 갱신한다**

`App.featurePaneMemo.test.tsx`는 Notes module을 직접 정적 import했다고 가정하지 않도록 변경한다. Notes가 준비된 뒤 App 전용 상태 변화가 발생해도 `NotesLibraryPane`과 `NotesOutlinePane` render 횟수가 늘지 않는 기존 계약은 유지한다.

- [x] **Step 6: App 관련 테스트를 실행한다**

Run: `npx vitest run src/App.lazyFeatureRuntime.test.tsx src/App.featurePaneMemo.test.tsx src/App.preload.test.tsx src/features/core/featureRegistry.test.tsx src/features/core/useFeatureRuntimeHost.test.tsx src/features/core/FeatureRuntimeBoundary.test.tsx && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 7: 첫 runtime slice를 fresh Tauri 앱에서 즉시 확인한다**

실행 중인 Yonalist를 UI에서 완전히 종료하고, test 전용 Vault를 만든 뒤 release bundle을
새로 만든다.

```bash
SMOKE_VAULT=$(mktemp -d /tmp/yonalist-lazy-runtime-smoke.XXXXXX)
VITE_YONALIST_PERF=1 npm run tauri:build
shasum -a 256 src-tauri/target/release/bundle/macos/Yonalist.app/Contents/MacOS/Yonalist
open -n src-tauri/target/release/bundle/macos/Yonalist.app
```

앱 설정에서 `SMOKE_VAULT` 출력 경로를 Vault로 사용한다. Inbox 시작에서 Notes chunk
요청 0회, Notes 최초 진입 성공, Inbox 왕복 뒤 draft 보존과 추가 chunk 요청 0회를
확인한다. 기존 Vault 설정을 복원하고 test Vault는 Finder의 휴지통으로 이동한다.
첫 unexplained runtime 실패에서는 Web Inspector 또는 Tauri log를 먼저 확인한다.
같은 증상을 두 번 수정해도 실패하면 추가 patch를 멈추고 새 증거를 수집한다.

- [x] **Step 8: Task 3~5의 compile-safe 통합을 한 번에 커밋한다**

```bash
git add \
  src/App.tsx \
  src/App.lazyFeatureRuntime.test.tsx \
  src/App.featurePaneMemo.test.tsx \
  src/App.preload.test.tsx \
  src/features/core/featureTypes.ts \
  src/features/core/featureRegistry.tsx \
  src/features/core/featureRegistry.test.tsx \
  src/features/core/useFeatureRuntimeHost.ts \
  src/features/core/useFeatureRuntimeHost.test.tsx \
  src/features/core/FeatureRuntimeBoundary.tsx \
  src/features/core/FeatureRuntimeBoundary.test.tsx \
  src/features/inbox/InboxFeature.tsx \
  src/features/settings/SettingsFeature.tsx \
  src/features/notes/NotesFeature.tsx
git commit -m "feat: lazy load and retain feature runtimes"
```

### Task 6: 번들 예산을 자동 검사한다

**Files:**

- Create: `scripts/checkBundleBudget.mjs`
- Create: `scripts/checkBundleBudget.test.ts`
- Modify: `package.json`

- [x] **Step 1: 예산 초과 fixture가 실패하는 테스트를 작성한다**

검사 함수 입력은 Vite manifest, 파일 크기, sourcemap sources의 plain object로 한정한다. 다음 각 위반을 독립적으로 검사한다.

- 초기 정적 graph raw > `917136`
- 초기 정적 graph gzip > `276839`
- App raw >= `500000`
- App gzip > `150000`
- App sourcemap에 Notes source 존재
- App sourcemap에 `@dnd-kit` source 존재

오류 메시지에는 실제값, 예산, 초과 bytes/source 수를 포함한다.

- [x] **Step 2: 검사기 부재로 실패하는지 확인한다**

Run: `npx vitest run scripts/checkBundleBudget.test.ts`

Expected: module 부재로 FAIL.

- [x] **Step 3: Node 표준 라이브러리만 사용해 검사기를 구현한다**

`dist/.vite/manifest.json`에서 `index.html`과 `src/App.tsx` entry의 정적 `imports`를 재귀 순회하고 JS 파일을 중복 없이 합산한다. gzip은 `node:zlib`의 `gzipSync`로 실제 산출물을 압축해 잰다. App chunk의 `.map`에서 source 경로를 검사한다. dynamic import는 초기 graph 합계에 포함하지 않는다.

- [x] **Step 4: 분석 build script를 추가한다**

```json
"build:analyze": "tsc && vite build --manifest --sourcemap && node scripts/checkBundleBudget.mjs"
```

- [x] **Step 5: 실제 production bundle을 검사한다**

Run: `npm run build:analyze`

Expected 출력 형식:

```text
initial-js raw=<bytes>/917136 gzip=<bytes>/276839
app-chunk raw=<bytes>/<500000 gzip=<bytes>/150000
app-map notes=0 dnd-kit=0
bundle budget PASS
```

- [x] **Step 6: bundle 검사기를 커밋한다**

```bash
git add scripts/checkBundleBudget.mjs scripts/checkBundleBudget.test.ts package.json
git commit -m "build: enforce startup bundle budgets"
```

### Task 7: 실행 시간 수치와 전체 회귀를 검증한다

**Files:**

- Modify: `docs/superpowers/reports/2026-07-19-startup-performance.md`

- [ ] **Step 1: 분리 후 release 실행을 동일 조건으로 20회 측정한다**

Run: `VITE_YONALIST_PERF=1 npm run tauri:build`

Task 1과 같은 기기·전원·Inbox·완전 종료 조건을 사용한다. 원자료 20개를 보고서에 추가하고 p50/p95를 계산한다.

- [ ] **Step 2: 성능 gate를 숫자로 판정한다**

보고서에 다음 계산식과 PASS/FAIL을 명시한다.

```text
startup_p50_ratio = after_app_mounted_p50 / before_app_mounted_p50
startup_p95_ratio = after_app_mounted_p95 / before_app_mounted_p95
notes_first_delta_ms = after_first_notes_p50 - before_first_notes_p50
notes_reopen_ratio = after_reopen_p50 / before_reopen_p50
```

PASS 조건은 각각 `≤0.85`, `≤1.00`, `≤100`, `≤1.05`다. 하나라도 실패하면 완료 처리하지 않고 원인과 다음 실험을 기록한다.

- [ ] **Step 3: 네트워크 관찰 계약을 검증한다**

Tauri release 앱을 Inbox로 시작했을 때 Notes chunk 요청 0회인지 확인한다. Notes 최초 선택 시 chunk 요청 1회, Inbox 왕복 뒤 Notes 재선택 시 추가 요청 0회인지 보고서에 기록한다.

- [x] **Step 4: 전체 frontend 검증을 실행한다**

Run: `npm run lint && npm test && npm run build:analyze`

Expected: lint PASS, 기존 skipped를 제외한 test PASS, bundle budget PASS.

- [x] **Step 5: 변경 경계 밖의 native gate를 명시적으로 제외한다**

이 diff는 Rust, IPC payload, persistence, native configuration을 바꾸지 않는다.
따라서 Cargo test, Rust formatting, Clippy는 실행하지 않고 보고서의 `Skipped gates`
항목에 그 이유를 기록한다.

- [ ] **Step 6: 최종 수치를 커밋한다**

```bash
git add docs/superpowers/reports/2026-07-19-startup-performance.md
git commit -m "docs: record lazy runtime performance results"
```

## 완료 판정

- [x] Notes 및 `@dnd-kit` source가 초기 App sourcemap에 0개다.
- [x] 모든 raw/gzip 번들 예산이 자동 검사에서 통과한다.
- [ ] 20회 release 측정의 네 실행 시간 gate가 모두 통과한다.
- [ ] Inbox 시작의 Notes 요청 0회, 최초 선택 1회, 재선택 추가 0회다.
- [x] 컴파일러 unused 진단이 0개다.
- [x] frontend lint/test/build가 통과하고, native gate 제외 이유가 기록된다.
