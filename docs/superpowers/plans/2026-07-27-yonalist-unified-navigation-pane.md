# Yonalist Unified Navigation Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes에서는 통합 탐색 패널과 편집 화면만 보이는 2단 구조를 만들고, Settings를 열었을 때만 설정 카테고리 패널을 더해 3단 구조로 전환한다.

**Architecture:** Notes 런타임은 통합 탐색 패널에 넣을 헤더 동작과 탐색 내용을 제공하고, 앱 셸은 이 내용을 `YonalistNavigationPane` 안에 계속 마운트한다. 활성 기능이 `middle` 패널을 제공할 때만 가운데 패널과 두 번째 리사이저를 렌더링하므로 Notes에는 빈 열이 남지 않고 Settings에서만 카테고리 패널이 나타난다.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library, CSS Grid, Tauri 2

## Global Constraints

- 승인된 설계: `docs/superpowers/specs/2026-07-27-yonalist-unified-navigation-pane-design.md`
- 통합 탐색 패널 기본 너비는 `336px`, 허용 범위는 `320px–480px`이다.
- 기존 `yonalist.paneWidths.v1`의 `sidebar` 값을 그대로 읽고 `320px`보다 작으면 보정한다. 새 저장 키, 마이그레이션, 호환 판독기는 추가하지 않는다.
- Notes의 데이터 모델, GitHub Notifications 동기화, Rust, IPC, SQLite, 파일 형식, Undo/Redo 동작은 바꾸지 않는다.
- `NotesWorkspaceProvider`, Notes 편집 세션, 검색어, 탐색 보기, 현재 페이지와 분할 편집 상태는 Settings 전환 중에도 유지한다.
- Notes 탐색 내용은 한 영역에서만 스크롤한다. 제목과 Settings는 각각 위와 아래에 고정한다.
- Notes에서는 가운데 패널과 두 번째 리사이저를 DOM에 렌더링하지 않는다.
- Settings에서는 통합 탐색, 설정 카테고리, 설정 세부 화면을 모두 렌더링한다.
- 숨은 빈 패널, 새 기능 레지스트리, 범용 패널 프레임워크는 만들지 않는다.
- 현재 작업 트리의 `src/services/notesSyncListener.ts`, `src/services/notesSyncListener.test.ts`, `.pnpm-store/`는 수정하거나 커밋하지 않는다.

## Delivery Contract

| 구분 | 내용 |
| --- | --- |
| 목표 | Notes 화면에서 중복된 첫 번째·두 번째 패널을 하나의 통합 탐색 패널로 합친다. |
| 완료 조건 1 | Notes 활성 상태에서 `Navigation`, Notes 세부 화면, 그 사이 리사이저 하나만 나타난다. |
| 완료 조건 2 | Settings 활성 상태에서 `Navigation`, `Settings sections`, Settings 세부 화면과 리사이저 두 개가 나타난다. |
| 완료 조건 3 | Settings를 열고 닫아도 Notes 검색어, 현재 페이지, 초안과 분할 편집 세션이 유지된다. |
| 완료 조건 4 | Settings가 열린 상태에서 Library 보기, 페이지, 태그 또는 검색 결과를 선택하면 Notes로 돌아간 뒤 요청한 동작을 실행한다. |
| 완료 조건 5 | 새 페이지, 검색, All, Starred, Recent, Tags, Archive, Trash, 페이지 메뉴, GitHub Notifications, 데이터 설정, 로그인 안내, 온라인 전환과 Settings가 모두 남아 있다. |
| 비대상 | Notes 저장소, 동기화, 알림 데이터, Rust 명령, 데이터베이스, Undo/Redo 변경 |
| 경계 | React 컴포넌트 구성, 앱 탐색 Context, 기능 패널 계약, 패널 너비 훅, TitleBar 위치 계산, CSS와 반응형 배치 |
| 직접 확인 | 새로 빌드한 macOS 앱과 별도 Vault에서 Notes 2단, Settings 3단, 상태 복귀, 패널 접기, 최대화와 세 반응형 구간을 확인한다. |

## File Map

| 파일 | 책임 |
| --- | --- |
| `src/components/YonalistNavigationPane.tsx` | 앱 수준 제목, 연결 상태, Notes 런타임 상태, 고정 Settings와 Notes 탐색 슬롯 |
| `src/components/YonalistNavigationPane.test.tsx` | Navigation 랜드마크, 고정 영역, 상태 동작과 접근성 계약 |
| `src/features/notes/NotesNavigationContent.tsx` | 기존 `NotesLibraryPane`의 검색, 보기, 태그, 페이지, 메뉴, 내보내기와 데이터 설정 동작 |
| `src/features/notes/NotesNavigationContent.test.tsx` | Notes 탐색 동작과 Settings에서 Notes로 돌아가는 순서 |
| `src/features/core/featureTypes.ts` | 선택적인 `navigation`과 `middle`을 포함하는 기능 패널 계약 |
| `src/features/notes/NotesFeature.tsx` | 안정된 Notes navigation/detail 노드와 Provider 수명 |
| `src/AppNavigationContext.ts` | Notes 탐색 동작이 Settings를 닫을 수 있는 `openNotes()` 명령 |
| `src/App.tsx` | 통합 탐색 패널 고정, 선택적인 가운데 패널, 런타임 준비·오류 상태와 기능 전환 |
| `src/hooks/usePaneResize.ts` | 통합 패널 기본 너비와 기존 저장값 보정 |
| `src/components/TitleBar.tsx` | 가운데 패널 유무에 따른 접기 버튼 위치 |
| `src/styles.css` | 2단·3단 그리드, 접기·최대화, 980px·720px 반응형 배치 |
| `src/features/notes/notes.css` | 기능별 구역, 단일 스크롤, 보기·페이지 선택 강도 |
| `src/App*.test.tsx`, `src/features/core/*.test.tsx` | 새 기능 패널 형태, 수명, 런타임과 앱 셸 계약 |
| `src/hooks/usePaneResize.test.tsx` | 기본 너비, 최소·최대 보정과 기존 저장 키 사용 |
| `src/components/TitleBar.test.tsx` | Notes·Settings에서 접기 버튼 위치 계산 |
| `src/components/Sidebar.tsx`, `src/components/Sidebar.test.tsx` | 통합 패널 연결이 끝나면 삭제할 기존 중복 패널 |

---

### Task 1: 통합 탐색 패널의 세로 구조와 선택적 가운데 패널 연결

**Files:**
- Create: `src/components/YonalistNavigationPane.tsx`
- Create: `src/components/YonalistNavigationPane.test.tsx`
- Rename: `src/features/notes/NotesLibraryPane.tsx` → `src/features/notes/NotesNavigationContent.tsx`
- Rename: `src/features/notes/NotesLibraryPane.test.tsx` → `src/features/notes/NotesNavigationContent.test.tsx`
- Modify: `src/features/core/featureTypes.ts:8-15`
- Modify: `src/features/notes/NotesFeature.tsx:13,264-279`
- Modify: `src/features/notes/NotesFeature.test.tsx:175-216,468-485`
- Modify: `src/features/core/featureRegistry.test.tsx:38-79`
- Modify: `src/features/core/useFeatureRuntimeHost.test.tsx:16-23`
- Modify: `src/App.tsx:382-585`
- Modify: `src/App.test.tsx:75-109,136-206`
- Modify: `src/App.lazyFeatureRuntime.test.tsx:24-45,67-112`
- Modify: `src/App.featurePaneMemo.test.tsx:5-72`
- Modify: `src/features/notes/notes.css:1-273`
- Modify: `src/styles.css:571-672,946-1050,1200-1207`
- Delete: `src/components/Sidebar.tsx`
- Delete: `src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: 기존 Notes Context, `FeatureRuntimeHost.readyRuntimes`, Settings의 `renderSettingsPanes()`
- Produces: `FeatureNavigationContent`, 선택적인 `FeaturePanes.navigation`, 선택적인 `FeaturePanes.middle`, `YonalistNavigationPane`

- [ ] **Step 1: 기능 패널 형태를 검증하는 실패 테스트 작성**

`src/features/core/featureRegistry.test.tsx`의 Notes 구조 테스트를 다음 계약으로 바꾼다.

```tsx
it("loads retained Notes navigation and detail without a middle pane", async () => {
  const notes = getFeatureDefinition("notes");
  if (!notes.loadRuntime) {
    throw new Error("Notes runtime must be lazy.");
  }
  const runtime = await notes.loadRuntime();
  const panes = runtime.renderPanes({
    renderSettingsPanes: vi.fn()
  });
  const NotesProvider = runtime.Provider;

  expect(panes.middle).toBeUndefined();
  expect(panes.navigation).toBeDefined();

  render(
    <VaultRootContext.Provider value="/registry-vault">
      <NotesProvider>
        {panes.navigation?.headerActions}
        {panes.navigation?.content}
        {panes.detail}
      </NotesProvider>
    </VaultRootContext.Provider>
  );

  expect(screen.getByLabelText("Yonalist library")).toBeInTheDocument();
  expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
});
```

같은 파일의 Settings 테스트에는 다음 단언을 추가한다.

```tsx
expect(panes.navigation).toBeUndefined();
expect(panes.middle).toBeDefined();
```

- [ ] **Step 2: 새 패널 계약 테스트가 먼저 실패하는지 확인**

Run:

```bash
npm test -- src/features/core/featureRegistry.test.tsx
```

Expected: `FeaturePanes`에 `navigation`이 없고 Notes가 여전히 `middle`을 반환하므로 타입 검사 또는 단언이 실패한다.

- [ ] **Step 3: 기능 패널 타입과 Notes의 안정된 노드 정의**

`src/features/core/featureTypes.ts`에서 패널 타입을 다음과 같이 바꾼다.

```ts
export interface FeatureNavigationContent {
  headerActions: ReactNode;
  content: ReactNode;
}

export interface FeaturePanes {
  navigation?: FeatureNavigationContent;
  middle?: ReactNode;
  detail: ReactNode;
}
```

`src/features/notes/NotesFeature.tsx`에서는 Notes 노드를 모듈 수준에서 한 번만 만든다.

```tsx
const notesPanes: FeaturePanes = {
  navigation: {
    headerActions: <NotesNavigationHeaderActions />,
    content: <NotesNavigationContent />
  },
  detail: <NotesDetailSplitHost />
};
```

`NotesLibraryPane` import는 다음 두 export를 가져오도록 바꾼다.

```ts
import {
  NotesNavigationContent,
  NotesNavigationHeaderActions
} from "./NotesNavigationContent";
```

`useFeatureRuntimeHost.test.tsx`의 범용 테스트 준비 코드는 `middle`을 계속 제공한다. Settings 같은 기능의 선택적인 가운데 패널을 검증하므로 다음 형태를 유지한다.

```tsx
renderPanes: () => ({
  middle: <div>{label} middle</div>,
  detail: <div>{label} detail</div>
})
```

`NotesFeature.test.tsx`의 두 렌더 위치에서는 기존 `{panes.middle}{panes.detail}` 블록을 다음 세 노드로 바꾼다.

```tsx
{panes.navigation?.headerActions}
{panes.navigation?.content}
{panes.detail}
```

첫 구조 테스트의 class 단언은 패널 외곽 class 대신 내용 컨테이너를 확인한다.

```tsx
expect(screen.getByLabelText("Yonalist library")).toHaveClass(
  "notes-navigation-content"
);
expect(panes.middle).toBeUndefined();
```

- [ ] **Step 4: 기존 Notes 탐색 파일을 내용과 헤더 동작으로 분리**

파일과 테스트 이름부터 바꾼다.

```bash
mv src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesNavigationContent.tsx
mv src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesNavigationContent.test.tsx
```

`NotesNavigationContent.tsx`에서 `dataSettingsOpen` 상태와 데이터 설정 버튼을 `NotesNavigationHeaderActions`로 옮긴다.

```tsx
export function NotesNavigationHeaderActions() {
  const { deletingNotesData } = useNotesState();
  const [dataSettingsOpen, setDataSettingsOpen] = useState(false);

  return (
    <>
      <IconTooltip label="Yonalist data settings" side="bottom">
        <button
          className="notes-library-icon-button"
          type="button"
          aria-label="Yonalist data settings"
          disabled={deletingNotesData}
          onClick={() => setDataSettingsOpen(true)}
        >
          <Settings2 size={16} aria-hidden="true" />
        </button>
      </IconTooltip>
      <NotesDataSettingsDialog
        open={dataSettingsOpen}
        onOpenChange={setDataSettingsOpen}
      />
    </>
  );
}
```

기존 `NotesLibraryPaneContent`는 `NotesNavigationBody`로 이름을 바꾸고 바깥 요소를 패널이 아닌 내용 컨테이너로 바꾼다.

```tsx
<div
  className="notes-navigation-content"
  aria-label="Yonalist library"
  aria-busy={state.status === "loading" || deletingNotesData}
  data-transient-workspace-busy={
    transientWorkspaceBusy ? "true" : undefined
  }
>
```

기존 제목 헤더와 `pane-titlebar-spacer`는 삭제한다. 새 페이지와 검색 아래에는 Library 구역 제목을, 페이지 목록 앞에는 Pages 구역 제목을 넣는다.

```tsx
<section
  className="notes-navigation-section"
  aria-labelledby="notes-library-section-title"
>
  <h2 id="notes-library-section-title" className="eyebrow">
    Library
  </h2>
  <div
    className="notes-library-views"
    role="group"
    aria-label="Yonalist library views"
  >
    {libraryViews.map(({ id, icon: Icon, label }) => (
      <button
        key={id}
        type="button"
        aria-pressed={libraryView === id}
        disabled={deletingNotesData}
        onClick={() => void actions.selectLibraryView(id)}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{label}</span>
      </button>
    ))}
  </div>
</section>
```

기존 `{!choosingTag && (...)}` 블록의 바깥 `div.notes-library-list`를 아래 `section`과 제목으로 감싼다. `initialLoading`부터 `visibleRootIds.map(...)` 끝까지의 기존 JSX는 `div.notes-library-list` 안에서 순서와 내용을 바꾸지 않는다.

```tsx
{!choosingTag && (
  <section
    className="notes-navigation-section notes-navigation-pages"
    aria-labelledby="notes-pages-section-title"
  >
    <h2 id="notes-pages-section-title" className="eyebrow">
      Pages
    </h2>
    <div className="notes-library-list">
```

`visibleRootIds.map(...)`을 닫는 `})}` 바로 뒤에는 다음 태그를 둔다.

```tsx
    </div>
  </section>
)}
```

검색 결과, 태그 선택, 페이지 메뉴, 내보내기와 GitHub Notifications 핸들러의 본문은 이 단계에서 바꾸지 않는다.

마지막 export는 다음 이름으로 바꾼다.

```tsx
export function NotesNavigationContent() {
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
  const lifecycleReadOnly =
    libraryView === "archive" || libraryView === "trash";

  return (
    <NotesExportControllerProvider
      available={!lifecycleReadOnly && visibleRootCount > 0}
      disabled={deletingNotesData || lifecycleReadOnly}
      loading={state.status === "loading"}
      onFlushDrafts={actions.flushAllDrafts}
    >
      <NotesNavigationBody
        githubNotificationsVisible={githubNotificationsVisible}
      />
    </NotesExportControllerProvider>
  );
}
```

- [ ] **Step 5: 통합 탐색 패널 컴포넌트 테스트 작성**

`src/components/YonalistNavigationPane.test.tsx`에 다음 네 동작을 작성한다.

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { YonalistNavigationPane } from "./YonalistNavigationPane";

function renderPane(
  overrides: Partial<ComponentProps<typeof YonalistNavigationPane>> = {}
) {
  const props: ComponentProps<typeof YonalistNavigationPane> = {
    activeFeatureId: "notes",
    online: true,
    loginRequired: false,
    notesStatus: "ready",
    onOpenNotes: vi.fn(),
    onOpenSettings: vi.fn(),
    onRetryNotes: vi.fn(),
    onToggleOnline: vi.fn(),
    headerActions: <button type="button">Data settings</button>,
    children: <div aria-label="Yonalist library">Notes navigation</div>,
    ...overrides
  };
  return { ...render(<YonalistNavigationPane {...props} />), props };
}

describe("YonalistNavigationPane", () => {
  it("renders one navigation landmark with fixed app and Notes controls", () => {
    renderPane();

    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Yonalist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Yonalist library")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("marks only Settings as the app-level selection", () => {
    renderPane({ activeFeatureId: "settings" });

    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("keeps connectivity and login controls available", async () => {
    const onOpenSettings = vi.fn();
    const onToggleOnline = vi.fn();
    renderPane({
      online: false,
      loginRequired: true,
      onOpenSettings,
      onToggleOnline
    });

    expect(screen.getByText("Offline")).toBeInTheDocument();
    await userEvent.setup().click(
      screen.getByRole("button", { name: "Login required" })
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();

    await userEvent.setup().click(
      screen.getByRole("button", { name: "Go online" })
    );
    expect(onToggleOnline).toHaveBeenCalledOnce();
  });

  it("keeps Settings available while Notes is loading or failed", async () => {
    const onRetryNotes = vi.fn();
    const { rerender, props } = renderPane({
      notesStatus: "loading",
      headerActions: null,
      children: null,
      onRetryNotes
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading Yonalist");
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();

    rerender(
      <YonalistNavigationPane
        {...props}
        notesStatus="failed"
        headerActions={null}
      >
        {null}
      </YonalistNavigationPane>
    );
    await userEvent.setup().click(
      screen.getByRole("button", { name: "다시 시도" })
    );
    expect(onRetryNotes).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 6: 통합 탐색 패널 구현**

`src/components/YonalistNavigationPane.tsx`에 앱 수준 UI만 둔다. Notes Context나 Notes 컴포넌트를 import하지 않는다.

```tsx
import { LogIn, Settings, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import type { FeatureId } from "../features/core/featureTypes";
import { IconTooltip, TooltipProvider } from "./ui/Tooltip";

export type NotesNavigationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "failed";

export interface YonalistNavigationPaneProps {
  activeFeatureId: FeatureId;
  online: boolean;
  loginRequired: boolean;
  notesStatus: NotesNavigationStatus;
  headerActions: ReactNode;
  children: ReactNode;
  onOpenNotes: () => void;
  onOpenSettings: () => void;
  onRetryNotes: () => void;
  onToggleOnline: () => void;
}

export function YonalistNavigationPane({
  activeFeatureId,
  online,
  loginRequired,
  notesStatus,
  headerActions,
  children,
  onOpenNotes,
  onOpenSettings,
  onRetryNotes,
  onToggleOnline
}: YonalistNavigationPaneProps) {
  return (
    <TooltipProvider>
      <nav
        className="yonalist-navigation-pane"
        aria-label="Navigation"
        data-active-feature={activeFeatureId}
      >
        <div className="pane-titlebar-spacer" />
        <header className="yonalist-navigation-header">
          <h1>Yonalist</h1>
          <div className="yonalist-navigation-header-actions">
            {notesStatus === "ready" ? headerActions : null}
            {loginRequired && (
              <IconTooltip label="Sign in required">
                <button
                  className="icon-button login-required-button"
                  type="button"
                  aria-label="Login required"
                  onClick={onOpenSettings}
                >
                  <LogIn size={17} />
                </button>
              </IconTooltip>
            )}
            {!online && (
              <IconTooltip label="오프라인 - 클릭하면 온라인으로 전환">
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Go online"
                  onClick={onToggleOnline}
                >
                  <WifiOff size={18} />
                </button>
              </IconTooltip>
            )}
          </div>
        </header>

        <div className="yonalist-navigation-scroll">
          {!online && <span className="offline-badge">Offline</span>}
          {notesStatus === "ready" && children}
          {notesStatus === "idle" && (
            <button
              className="text-button notes-runtime-open"
              type="button"
              onClick={onOpenNotes}
            >
              Yonalist 열기
            </button>
          )}
          {notesStatus === "loading" && (
            <p className="feature-runtime-loading" role="status">
              Loading Yonalist…
            </p>
          )}
          {notesStatus === "failed" && (
            <div className="feature-runtime-error" role="alert">
              <p>Yonalist를 열 수 없습니다.</p>
              <button type="button" onClick={onRetryNotes}>
                다시 시도
              </button>
            </div>
          )}
        </div>

        <footer className="yonalist-navigation-footer">
          <button
            className={
              activeFeatureId === "settings"
                ? "nav-item active"
                : "nav-item"
            }
            type="button"
            aria-pressed={activeFeatureId === "settings"}
            onClick={onOpenSettings}
          >
            <Settings size={16} aria-hidden="true" />
            <span>Settings</span>
          </button>
        </footer>
      </nav>
    </TooltipProvider>
  );
}
```

- [ ] **Step 7: App 셸이 Notes 2단, Settings 3단 DOM을 만들도록 연결**

`src/App.tsx`에서 `Sidebar` import와 렌더링을 삭제하고 `YonalistNavigationPane`을 import한다.

기능별 패널 배열을 만든 다음 아래 파생값을 계산한다.

```tsx
const notesFeaturePanes = featurePanes.find(
  ({ id }) => id === "notes"
)?.panes;
const activeFeaturePanes = featurePanes.find(({ active }) => active)?.panes;
const hasMiddlePane = activeFeaturePanes?.middle !== undefined;
const notesRuntimeReady =
  featureRuntimeHost.readyRuntimes.has("notes");
const notesStatus =
  notesRuntimeReady
    ? "ready"
    : activeFeatureId === "notes"
      ? featureRuntimeHost.active.status
      : "idle";
```

`featureRuntimeHost.active.status !== "ready"` fallback에서는 Notes가 활성화됐을 때 `middle`을 만들지 않는다.

```tsx
panes: {
  middle:
    activeFeatureId === "notes"
      ? undefined
      : loading
        ? (
            <div className="feature-runtime-loading" role="status">
              Loading {activeFeature.label}…
            </div>
          )
        : (
            <div className="feature-runtime-error" role="alert">
              <p>{activeFeature.label}를 열 수 없습니다.</p>
              <button type="button" onClick={featureRuntimeHost.retry}>
                다시 시도
              </button>
            </div>
          ),
  detail: <div className="detail-loading" aria-hidden="true" />
}
```

`main.app-shell`에 가운데 패널 유무를 표시한다.

```tsx
data-has-middle-pane={hasMiddlePane ? "true" : undefined}
```

`withFeatureProviders(...)` 안의 렌더 순서는 다음으로 고정한다.

```tsx
<YonalistNavigationPane
  activeFeatureId={activeFeatureId}
  online={online}
  loginRequired={!auth.signedIn}
  notesStatus={notesStatus}
  headerActions={notesFeaturePanes?.navigation?.headerActions ?? null}
  onOpenNotes={() => changeActiveFeature("notes")}
  onOpenSettings={() => openSettings()}
  onRetryNotes={featureRuntimeHost.retry}
  onToggleOnline={toggleOnline}
>
  {notesFeaturePanes?.navigation?.content ?? null}
</YonalistNavigationPane>

<div
  className="pane-resizer sidebar-list-resizer"
  role="separator"
  aria-label="Resize navigation pane"
  aria-orientation="vertical"
  aria-valuemin={paneWidthLimits.sidebar.min}
  aria-valuemax={paneWidthLimits.sidebar.max}
  aria-valuenow={paneWidths.sidebar}
  tabIndex={0}
  onPointerDown={(event) => startResize("sidebar", event)}
  onKeyDown={(event) => resizeWithKeyboard("sidebar", event)}
/>

{hasMiddlePane && (
  <>
    <div className="feature-pane-slot">
      {activeFeaturePanes?.middle}
    </div>
    <div
      className="pane-resizer list-detail-resizer"
      role="separator"
      aria-label="Resize item list pane"
      aria-orientation="vertical"
      aria-valuemin={paneWidthLimits.list.min}
      aria-valuemax={paneWidthLimits.list.max}
      aria-valuenow={paneWidths.list}
      tabIndex={0}
      onPointerDown={(event) => startResize("list", event)}
      onKeyDown={(event) => resizeWithKeyboard("list", event)}
    />
  </>
)}
```

기존 detail의 `featurePanes.map(...)`은 그대로 유지해서 Notes detail을 Settings 전환 중에도 마운트한 채 `hidden`으로 보존한다.

- [ ] **Step 8: 앱 셸 구조 테스트와 테스트 준비 코드 갱신**

`App.test.tsx`, `App.lazyFeatureRuntime.test.tsx`, `App.featurePaneMemo.test.tsx`의 Notes 런타임 테스트 준비 코드에서 `middle`을 `navigation`으로 바꾼다.

```tsx
renderPanes: () => ({
  navigation: {
    headerActions: null,
    content: <NotesLibraryProbe />
  },
  detail: <section aria-label="Notes outline" />
})
```

`App.featurePaneMemo.test.tsx`의 모듈 mock도 새 파일과 두 export를 그대로 제공해야 한다.

```tsx
vi.mock("./features/notes/NotesNavigationContent", () => ({
  NotesNavigationHeaderActions: () => null,
  NotesNavigationContent: () => {
    libraryRenders.count += 1;
    return <div aria-label="Yonalist library" />;
  }
}));
```

`App.test.tsx`에는 다음 구조 테스트를 추가한다.

```tsx
it("renders Notes with no middle pane or item-list resizer", async () => {
  const { container } = render(<App />);

  await screen.findByLabelText("Yonalist library");

  const shell = container.querySelector(".app-shell");
  expect(shell).not.toHaveAttribute("data-has-middle-pane");
  expect(screen.getAllByRole("navigation")).toHaveLength(1);
  expect(
    screen.queryByRole("separator", { name: "Resize item list pane" })
  ).toBeNull();
  expect(screen.getByRole("separator", {
    name: "Resize navigation pane"
  })).toBeInTheDocument();
});

it("adds the Settings category pane without replacing navigation", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  const navigation = await screen.findByRole("navigation", {
    name: "Navigation"
  });

  await user.click(screen.getByRole("button", { name: "Settings" }));

  expect(container.querySelector(".app-shell")).toHaveAttribute(
    "data-has-middle-pane",
    "true"
  );
  expect(navigation).toBeInTheDocument();
  expect(await screen.findByLabelText("Settings sections")).toBeInTheDocument();
  expect(screen.getByRole("separator", {
    name: "Resize item list pane"
  })).toBeInTheDocument();
});
```

`NotesNavigationContent.test.tsx`의 import와 describe 이름을 새 이름으로 바꾼다.

```tsx
import {
  NotesNavigationContent,
  NotesNavigationHeaderActions
} from "./NotesNavigationContent";
```

기존 렌더링 도우미의 `<NotesLibraryPane />`는 다음 두 노드로 바꿔 데이터 설정과 탐색 내용을 함께 검증한다.

```tsx
<>
  <NotesNavigationHeaderActions />
  <NotesNavigationContent />
</>
```

첫 표시 테스트는 중복 제목 대신 기능별 구역을 검증한다.

```tsx
expect(screen.getByLabelText("Yonalist library")).toBeInTheDocument();
expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
expect(screen.getByRole("heading", { name: "Pages" })).toBeInTheDocument();
expect(
  screen.getByRole("searchbox", { name: "Search Yonalist" })
).toBeInTheDocument();
```

- [ ] **Step 9: 새 구조에 필요한 최소 스타일 적용**

`src/styles.css`에 패널의 고정 헤더·스크롤·고정 푸터를 추가한다.

```css
.yonalist-navigation-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  grid-row: 1;
  margin-top: var(--pane-top);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-list);
  box-shadow: 0 12px 32px rgb(50 39 31 / 7%);
}

.yonalist-navigation-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 54px;
  padding: 8px 14px 8px 18px;
  border-bottom: 1px solid var(--border);
}

.yonalist-navigation-header h1 {
  min-width: 0;
  overflow: hidden;
  font-size: 21px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.yonalist-navigation-header-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
}

.yonalist-navigation-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.yonalist-navigation-footer {
  flex: 0 0 auto;
  padding: 10px;
  border-top: 1px solid var(--border);
}
```

`src/features/notes/notes.css`에서는 `.notes-library-pane` 선택자를 `.notes-navigation-content`로 바꾸고 중첩 스크롤을 없앤다.

```css
.notes-navigation-content {
  color: var(--text-1);
}

.notes-navigation-section {
  padding: 10px;
}

.notes-navigation-section > .eyebrow {
  margin: 0 8px 6px;
}

.notes-navigation-pages {
  border-top: 1px solid var(--border);
}

.notes-library-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
```

기존 `.notes-library-list`의 `flex: 1`, `overflow-y: auto`, `padding: 10px`는 삭제한다. 페이지 안쪽 여백은 `.notes-navigation-pages`가 맡는다. 기존 검색, 태그, 페이지 행, 메뉴와 내보내기 스타일은 유지한다.

- [ ] **Step 10: Task 1 집중 테스트 실행**

Run:

```bash
npm test -- src/components/YonalistNavigationPane.test.tsx src/features/notes/NotesNavigationContent.test.tsx src/features/notes/NotesFeature.test.tsx src/features/core/featureRegistry.test.tsx src/features/core/useFeatureRuntimeHost.test.tsx src/App.test.tsx src/App.lazyFeatureRuntime.test.tsx src/App.featurePaneMemo.test.tsx
```

Expected: 모든 테스트 PASS. Notes App 테스트에서는 두 번째 리사이저가 없고 Settings App 테스트에서는 나타난다.

- [ ] **Step 11: 구조 변경 커밋**

```bash
git add src/App.tsx src/App.test.tsx src/App.lazyFeatureRuntime.test.tsx src/App.featurePaneMemo.test.tsx src/components/YonalistNavigationPane.tsx src/components/YonalistNavigationPane.test.tsx src/components/Sidebar.tsx src/components/Sidebar.test.tsx src/features/core/featureTypes.ts src/features/core/featureRegistry.test.tsx src/features/core/useFeatureRuntimeHost.test.tsx src/features/notes/NotesFeature.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesNavigationContent.tsx src/features/notes/NotesNavigationContent.test.tsx src/features/notes/notes.css src/styles.css
git commit -m "feat: unify Yonalist navigation pane"
```

커밋 전에 `git diff --cached --name-only`로 `notesSyncListener` 두 파일과 `.pnpm-store/`가 포함되지 않았는지 확인한다.

---

### Task 2: Settings 전환 중 Notes 상태와 명령 순서 보존

**Files:**
- Modify: `src/AppNavigationContext.ts:1-18`
- Modify: `src/App.tsx:109-197,382-585`
- Modify: `src/features/notes/NotesNavigationContent.tsx`
- Modify: `src/features/notes/NotesNavigationContent.test.tsx`
- Modify: `src/features/notes/NotesAttachmentList.test.tsx:570-586`
- Modify: `src/features/notes/NotesImageAttachment.test.tsx:220-235,559-574,2249-2259`
- Modify: `src/App.test.tsx`
- Modify: `src/App.lazyFeatureRuntime.test.tsx`
- Modify: `src/App.featurePaneMemo.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: Task 1의 `FeaturePanes.navigation`, `YonalistNavigationPane`
- Produces: 안정된 `AppNavigation.openNotes()`, Notes 명령 전환 순서와 선택 표시 계약

- [ ] **Step 1: Settings에서 Notes 항목을 선택하는 실패 테스트 작성**

`NotesNavigationContent.test.tsx`의 렌더링 도우미가 `AppNavigationContext.Provider`를 포함하도록 바꾼다.

```tsx
import {
  AppNavigationContext,
  type AppNavigation
} from "../../AppNavigationContext";
import {
  NotesNavigationContent,
  NotesNavigationHeaderActions
} from "./NotesNavigationContent";
```

```tsx
function renderNavigationWithExternal(
  workspace: UseNotesWorkspaceResult,
  boundary = externalBoundary(),
  navigation: AppNavigation = {
    openNotes: vi.fn(),
    openSettings: vi.fn()
  }
) {
  const rendered = render(
    <AppNavigationContext.Provider value={navigation}>
      <VaultRootContext.Provider value="/vault">
        <ExternalSourcesContext.Provider value={boundary}>
          <NotesWorkspaceContext.Provider value={workspace}>
            <NotesNavigationHeaderActions />
            <NotesNavigationContent />
          </NotesWorkspaceContext.Provider>
        </ExternalSourcesContext.Provider>
      </VaultRootContext.Provider>
    </AppNavigationContext.Provider>
  );
  return { ...rendered, boundary, navigation };
}
```

기존 `renderLibraryWithExternal(...)` 호출은 모두 `renderNavigationWithExternal(...)`로 이름을 맞춘다.

Settings가 활성화된 상태에서 기능 전환이 Notes 동작보다 먼저 일어나는지 검증한다.

```tsx
it("returns to Notes before running navigation selected from Settings", async () => {
  const user = userEvent.setup();
  const workspace = activeWorkspace();
  const events: string[] = [];
  const navigation: AppNavigation = {
    openNotes: vi.fn(() => events.push("open notes")),
    openSettings: vi.fn()
  };
  vi.mocked(workspace.actions.selectLibraryView).mockImplementation(
    async () => {
      events.push("select starred");
    }
  );
  renderNavigationWithExternal(
    workspace,
    externalBoundary(),
    navigation
  );

  await user.click(screen.getByRole("button", { name: "Starred" }));

  expect(events).toEqual(["open notes", "select starred"]);
});
```

기존 `runs local navigation` 테스트에는 `openNotes`가 `events` 배열에 값을 남기게 하고 새 페이지, 일반 페이지, Library 보기 각각에서 전환이 먼저 일어나는지 확인한다.

```tsx
const navigation: AppNavigation = {
  openNotes: vi.fn(() => events.push("open notes")),
  openSettings: vi.fn()
};
renderNavigationWithExternal(workspace, boundary, navigation);

await user.click(screen.getByRole("button", { name: "New page" }));
await user.click(screen.getByRole("button", { name: "Project" }));
await user.click(screen.getByRole("button", { name: "Starred" }));

expect(events).toEqual([
  "open notes",
  "local action",
  "open notes",
  "local action",
  "open notes",
  "local action"
]);
```

기존 GitHub Notifications 테스트의 `events` 기대값 맨 앞, 검색 결과와 태그 테스트의 Notes 동작 앞에도 각각 `"open notes"`를 추가한다.

```tsx
expect(events).toEqual([
  "open notes",
  "flush drafts",
  "clear selection",
  `zoom ${GITHUB_NOTIFICATIONS_ROOT_ID}`
]);
```

```tsx
expect(events).toEqual(["open notes", "open search result"]);
```

```tsx
it("opens Notes before selecting a local tag", async () => {
  const user = userEvent.setup();
  const workspace = activeWorkspace({ libraryView: "tags" });
  workspace.tagSummaries = [
    { prefix: "#", normalizedTag: "local", displayTag: "local", count: 1 }
  ];
  const events: string[] = [];
  const navigation: AppNavigation = {
    openNotes: vi.fn(() => events.push("open notes")),
    openSettings: vi.fn()
  };
  vi.mocked(workspace.actions.toggleTagFilter).mockImplementation(async () => {
    events.push("toggle tag");
  });
  renderNavigationWithExternal(
    workspace,
    externalBoundary(),
    navigation
  );

  await user.click(screen.getByRole("button", { name: "#local, 1 note" }));

  expect(events).toEqual(["open notes", "toggle tag"]);
});
```

- [ ] **Step 2: AppNavigation Context 테스트가 실패하는지 확인**

Run:

```bash
npm test -- src/features/notes/NotesNavigationContent.test.tsx
```

Expected: `AppNavigation`에 `openNotes`가 없거나 Notes 동작 전에 `openNotes`가 호출되지 않아 실패한다.

- [ ] **Step 3: 앱 탐색 Context에 Notes 복귀 명령 추가**

`src/AppNavigationContext.ts`를 다음 계약으로 바꾼다.

```ts
import { createContext, useContext } from "react";
import type { SettingsSection } from "./components/SettingsCategoryPane";

export type SettingsTarget = "images";

export interface AppNavigation {
  openNotes: () => void;
  openSettings: (
    section: SettingsSection,
    target?: SettingsTarget
  ) => void;
}
```

`src/App.tsx`에서 참조가 바뀌지 않는 Notes 복귀 함수를 만들고 Context 값에 넣는다.

```tsx
const openNotes = useCallback(() => {
  changeActiveFeatureRef.current("notes");
}, []);

const appNavigation = useMemo<AppNavigation>(
  () => ({
    openNotes,
    openSettings
  }),
  [openNotes, openSettings]
);
```

`YonalistNavigationPane.onOpenNotes`에는 인라인 함수 대신 `openNotes`를 전달한다.

- [ ] **Step 4: Notes 탐색 명령 앞에 기능 전환을 넣기**

`NotesNavigationBody`에서 안정된 명령을 읽는다.

```tsx
const { openNotes } = useAppNavigation();
```

다음 사용자 동작에서 기존 Notes 동작 바로 앞에 `openNotes()`를 호출한다. Notes가 이미 활성화되어 있으면 App의 `changeActiveFeature`가 아무 상태도 바꾸지 않으므로 같은 경로를 안전하게 쓸 수 있다.

```tsx
onClick={() => {
  openNotes();
  void actions.createRoot();
}}
```

```tsx
onClick={() => {
  openNotes();
  void actions.selectLibraryView(id);
}}
```

```tsx
const openResult = async (nodeId: string) => {
  openNotes();
  await actions.openSearchResult(nodeId);
  searchRequestRef.current += 1;
  resultOptionRefs.current = [];
  setQuery("");
  setResults([]);
  setActiveResultIndex(-1);
};
```

```tsx
onClick={() => {
  openNotes();
  void actions.toggleTagFilter(summary);
}}
```

```tsx
onOpen={() => {
  openNotes();
  void actions.zoomTo(nodeId);
}}
```

```tsx
const openGithubNotifications = async () => {
  openNotes();
  if (!(await actions.flushAllDrafts())) {
    return;
  }
  actions.clearSelection();
  await actions.zoomTo(GITHUB_NOTIFICATIONS_ROOT_ID);
};
```

활성 태그 칩을 제거하는 동작과 페이지 메뉴의 Star, Archive, Trash, Export, Rename은 현재 Notes 화면을 여는 탐색이 아니므로 기능 전환을 추가하지 않는다.

일반 페이지와 외부 페이지에는 기존처럼 `active={state.zoomRootId === nodeId}`를 전달한다. 현재 페이지라는 접근성 정보와 내부 상태는 Settings 중에도 보존하고, 강한 시각 강조만 다음 단계의 바깥 `data-active-feature` 선택자로 낮춘다.

`AppNavigationContext.Provider` 값을 직접 만드는 기존 테스트에는 아무 일도 하지 않는 `openNotes`를 추가한다.

```tsx
const openNotes = vi.fn();

<AppNavigationContext.Provider
  value={{ openNotes, openSettings }}
>
```

이 변경을 `NotesAttachmentList.test.tsx`의 한 provider와 `NotesImageAttachment.test.tsx`의 세 provider에 모두 적용한다.

- [ ] **Step 5: Settings 선택 중 Library 강조를 낮추고 복귀 시 되살리기**

`YonalistNavigationPane`가 이미 `data-active-feature`를 제공하므로 `notes.css`에 시각 상태만 제한한다. 실제 `libraryView`와 `aria-pressed` 값은 보존한다.

```css
.yonalist-navigation-pane[data-active-feature="settings"]
  .notes-library-views
  button[aria-pressed="true"] {
  background: transparent;
  color: var(--text-3);
}

.yonalist-navigation-pane[data-active-feature="settings"]
  .notes-library-page-row[data-active="true"] {
  background: transparent;
  box-shadow: none;
}
```

`aria-pressed`와 `aria-current`는 각각 저장된 Library 보기와 현재 페이지를 계속 전달한다. Settings 행도 선택 상태를 전달하므로 보조 기술 사용자는 앱 화면과 보존된 Notes 위치를 모두 알 수 있다. Notes로 돌아오면 바깥 `data-active-feature` 값만 바뀌어 기존 강조가 복원된다.

- [ ] **Step 6: 검색어와 Notes 마운트 수명 테스트 갱신**

`App.lazyFeatureRuntime.test.tsx`의 `RetainedNotesPane`을 navigation content로 두고 다음 전환을 검증한다.

```tsx
it("retains Notes navigation state and detail mounts across Settings", async () => {
  const pending = deferred<FeatureRuntime>();
  const loadRuntime = notesLoader().mockReturnValue(pending.promise);
  const user = userEvent.setup();
  render(<App initialOnline={false} />);

  await user.click(screen.getByRole("button", { name: "Yonalist 열기" }));
  pending.resolve(notesRuntime);

  const query = await screen.findByRole("textbox", { name: "Notes draft" });
  await user.type(query, "keep me");
  await user.click(screen.getByRole("button", { name: "Settings" }));

  expect(screen.getByRole("textbox", { name: "Notes draft" })).toHaveValue(
    "keep me"
  );

  await user.click(
    screen.getByRole("button", { name: "Open retained note" })
  );

  expect(screen.queryByLabelText("Settings sections")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Notes draft" })).toHaveValue(
    "keep me"
  );
  expect(loadRuntime).toHaveBeenCalledOnce();
});
```

`RetainedNotesPane` 안의 `Open retained note` 버튼은 `useAppNavigation().openNotes()`를 호출하도록 만든다. 이 테스트 준비 코드는 검색어 보존과 전환만 검증하고 Notes 저장 동작을 흉내 내지 않는다.

`App.featurePaneMemo.test.tsx`는 App 수준 온라인 상태 변경 뒤 Notes 탐색 내용과 세부 화면의 렌더링 횟수가 늘지 않는 기존 단언을 유지한다. `FeaturePanes.navigation` 테스트 준비 코드만 새 형태로 바꾼다.

- [ ] **Step 7: Task 2 집중 테스트 실행**

Run:

```bash
npm test -- src/features/notes/NotesNavigationContent.test.tsx src/App.test.tsx src/App.lazyFeatureRuntime.test.tsx src/App.featurePaneMemo.test.tsx src/AppNavigationContext.test.tsx
```

Expected: 모든 테스트 PASS. Settings에서 Notes 항목을 선택하면 `openNotes`가 Notes action보다 먼저 호출되고 검색어는 유지된다.

- [ ] **Step 8: 상태 보존 변경 커밋**

```bash
git add src/App.tsx src/App.test.tsx src/App.lazyFeatureRuntime.test.tsx src/App.featurePaneMemo.test.tsx src/AppNavigationContext.ts src/AppNavigationContext.test.tsx src/features/notes/NotesNavigationContent.tsx src/features/notes/NotesNavigationContent.test.tsx src/features/notes/notes.css
git commit -m "feat: preserve Notes state across settings"
```

---

### Task 3: 패널 너비, 접기·최대화와 반응형 배치

**Files:**
- Create: `src/hooks/usePaneResize.test.tsx`
- Create: `src/components/TitleBar.test.tsx`
- Modify: `src/hooks/usePaneResize.ts:10-59`
- Modify: `src/components/TitleBar.tsx:7-19,63-100`
- Modify: `src/App.tsx:473-585`
- Modify: `src/styles.css:571-860,1200-1237,2407-2484`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `data-has-middle-pane`, `paneWidths.sidebar`, `paneWidths.list`
- Produces: `336px` 기본 너비, 기존 값 보정, Notes 2단·Settings 3단 CSS Grid, 가운데 패널을 아는 TitleBar 위치

- [ ] **Step 1: 기존 저장값 보정 실패 테스트 작성**

`src/hooks/usePaneResize.test.tsx`를 만든다.

```tsx
import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultPaneWidths,
  paneWidthLimits,
  usePaneResize
} from "./usePaneResize";

describe("usePaneResize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses the unified navigation default and limits", () => {
    expect(defaultPaneWidths.sidebar).toBe(336);
    expect(paneWidthLimits.sidebar).toEqual({ min: 320, max: 480 });
  });

  it("clamps a stored legacy sidebar width without changing the storage key", () => {
    localStorage.setItem(
      "yonalist.paneWidths.v1",
      JSON.stringify({ sidebar: 240, list: 500 })
    );

    const { result } = renderHook(() => usePaneResize());

    expect(result.current.paneWidths).toEqual({
      sidebar: 320,
      list: 500
    });
  });

  it("keeps keyboard resizing inside the unified limits", () => {
    const { result } = renderHook(() => usePaneResize());
    const preventDefault = vi.fn();

    act(() => {
      result.current.resizeWithKeyboard(
        "sidebar",
        {
          key: "ArrowRight",
          shiftKey: true,
          preventDefault
        } as unknown as ReactKeyboardEvent<HTMLDivElement>
      );
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.paneWidths.sidebar).toBe(384);
  });
});
```

- [ ] **Step 2: 너비 테스트가 먼저 실패하는지 확인**

Run:

```bash
npm test -- src/hooks/usePaneResize.test.tsx
```

Expected: 현재 기본값 `240`, 제한 `220–420` 때문에 실패한다.

- [ ] **Step 3: 통합 탐색 패널 너비 적용**

`src/hooks/usePaneResize.ts`의 값만 바꾼다.

```ts
export const defaultPaneWidths: PaneWidths = {
  sidebar: 336,
  list: 340
};

export const paneWidthLimits: Record<
  ResizablePane,
  { min: number; max: number }
> = {
  sidebar: { min: 320, max: 480 },
  list: { min: 320, max: 640 }
};
```

`paneWidthStorageKey`와 JSON 형태는 바꾸지 않는다. 기존 `sanitizePaneWidths`가 저장된 `240`을 `320`으로 보정하게 둔다.

- [ ] **Step 4: 가운데 패널 유무에 따른 TitleBar 위치 테스트 작성**

`src/components/TitleBar.test.tsx`에 다음 테스트를 만든다.

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TitleBar, type PaneToggleControls } from "./TitleBar";

const baseControls: PaneToggleControls = {
  sidebarCollapsed: true,
  detailMaximized: false,
  middlePaneVisible: false,
  onToggleSidebar: vi.fn(),
  onToggleMaximize: vi.fn(),
  showDetailMaximizeToggle: true
};

describe("TitleBar", () => {
  it("places the collapsed navigation toggle after traffic lights in Notes", () => {
    render(<TitleBar paneToggles={baseControls} />);

    expect(screen.getByRole("group", { name: "Pane layout" })).toHaveStyle({
      left: "86px"
    });
  });

  it("places the collapsed navigation toggle at the Settings middle edge", () => {
    render(
      <TitleBar
        paneToggles={{ ...baseControls, middlePaneVisible: true }}
      />
    );

    expect(screen.getByRole("group", { name: "Pane layout" })).toHaveStyle({
      left:
        "max(86px, calc(var(--shell-inset, 8px) + var(--list-width, 340px) - 36px))"
    });
  });
});
```

- [ ] **Step 5: TitleBar와 App 연결**

`PaneToggleControls`에 다음 값을 추가한다.

```ts
middlePaneVisible: boolean;
```

접힌 상태의 `left` 계산을 다음과 같이 바꾼다.

```tsx
left: paneToggles.sidebarCollapsed
  ? paneToggles.middlePaneVisible
    ? "max(86px, calc(var(--shell-inset, 8px) + var(--list-width, 340px) - 36px))"
    : "86px"
  : "calc(var(--shell-inset, 8px) + var(--sidebar-width, 336px) - 36px)"
```

`App.tsx`의 `TitleBar` 호출에 현재 파생값을 넘긴다.

```tsx
middlePaneVisible: hasMiddlePane,
```

- [ ] **Step 6: 데스크톱 2단·3단 CSS Grid 구현**

`src/styles.css`의 기본 grid는 Notes의 세 열로 만든다.

```css
.app-shell {
  --shell-inset: 8px;
  --pane-gap: 10px;
  --pane-top: 8px;
  --sidebar-resizer-width: var(--pane-gap);
  --list-resizer-width: var(--pane-gap);
  display: grid;
  grid-template-columns:
    var(--sidebar-width, 336px)
    var(--sidebar-resizer-width, 10px)
    minmax(520px, 1fr);
  grid-template-rows: minmax(0, 1fr) var(--statusbar-height);
  height: 100vh;
  padding-inline: var(--shell-inset);
  overflow: hidden;
  background: var(--bg-app);
}

.app-shell[data-has-middle-pane="true"] {
  grid-template-columns:
    var(--sidebar-width, 336px)
    var(--sidebar-resizer-width, 10px)
    var(--list-width, 340px)
    var(--list-resizer-width, 10px)
    minmax(520px, 1fr);
}
```

TitleBar 변수 fallback의 `240px`을 `336px`로 바꾼다.

상세 최대화는 마지막 열이라는 관계로 표현해 Notes와 Settings에 함께 적용한다.

```css
.app-shell[data-detail-maximized="true"] {
  --sidebar-resizer-width: 0px;
  --list-resizer-width: 0px;
  grid-template-columns: 0 0 minmax(0, 1fr);
}

.app-shell[data-has-middle-pane="true"][data-detail-maximized="true"] {
  grid-template-columns: 0 0 0 0 minmax(0, 1fr);
}

.app-shell[data-detail-maximized="true"] > .yonalist-navigation-pane,
.app-shell[data-detail-maximized="true"] > .sidebar-list-resizer,
.app-shell[data-detail-maximized="true"]
  > .feature-pane-slot
  > .list-pane,
.app-shell[data-detail-maximized="true"] > .list-detail-resizer {
  visibility: hidden;
  overflow: hidden;
  min-width: 0;
}

.app-shell[data-detail-maximized="true"] > .detail-pane {
  display: flex;
  grid-column: -2 / -1;
  height: 100%;
  overflow: hidden;
}
```

데스크톱 접기 규칙에서 `.sidebar`를 `.yonalist-navigation-pane`으로 바꾼다. 가운데 패널이 없는 Notes에서는 `data-list-collapsed`가 레이아웃에 영향을 주지 않게 선택자를 `data-has-middle-pane="true"`와 함께 쓴다.

```css
@media (min-width: 981px) {
  .app-shell[data-sidebar-collapsed="true"] {
    --sidebar-resizer-width: 0px;
  }

  .app-shell[data-has-middle-pane="true"][data-list-collapsed="true"] {
    --list-resizer-width: 0px;
  }

  .app-shell[data-sidebar-collapsed="true"]
    > .yonalist-navigation-pane,
  .app-shell[data-sidebar-collapsed="true"]
    > .sidebar-list-resizer,
  .app-shell[data-has-middle-pane="true"][data-list-collapsed="true"]
    > .feature-pane-slot
    > .list-pane,
  .app-shell[data-has-middle-pane="true"][data-list-collapsed="true"]
    > .list-detail-resizer {
    visibility: hidden;
    overflow: hidden;
    min-width: 0;
  }

  .app-shell[data-sidebar-collapsed="true"]:not(
      [data-has-middle-pane="true"]
    )
    > .detail-pane
    > .pane-titlebar-spacer,
  .app-shell[data-sidebar-collapsed="true"][data-has-middle-pane="true"]
    > .feature-pane-slot
    > .list-pane
    > .pane-titlebar-spacer {
    flex-basis: var(--titlebar-height);
  }
}
```

- [ ] **Step 7: 980px 이하와 720px 이하 반응형 배치 구현**

`@media (max-width: 980px)`에서 Notes는 가로 2단을 유지하고 Settings만 오른쪽을 위아래로 나눈다.

```css
@media (max-width: 980px) {
  .app-shell {
    grid-template-columns:
      minmax(320px, var(--sidebar-width, 336px))
      var(--sidebar-resizer-width, var(--pane-gap))
      minmax(280px, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .yonalist-navigation-pane,
  .sidebar-list-resizer {
    grid-row: 1;
  }

  .detail-pane {
    grid-row: 1;
    grid-column: 3;
  }

  .app-shell[data-has-middle-pane="true"] {
    grid-template-rows: minmax(0, 42%) minmax(0, 1fr) auto;
  }

  .app-shell[data-has-middle-pane="true"]
    > .yonalist-navigation-pane,
  .app-shell[data-has-middle-pane="true"]
    > .sidebar-list-resizer {
    grid-row: 1 / 3;
  }

  .app-shell[data-has-middle-pane="true"]
    > .feature-pane-slot
    > .list-pane {
    grid-row: 1;
    grid-column: 3;
  }

  .list-detail-resizer {
    display: none;
  }

  .app-shell[data-has-middle-pane="true"] > .detail-pane {
    grid-row: 2;
    grid-column: 3;
  }

  .app-statusbar {
    grid-row: -2;
  }

  .pane-toggle-group {
    display: none;
  }
}
```

`@media (max-width: 720px)`에서는 DOM 순서대로 세로로 쌓는다.

```css
@media (max-width: 720px) {
  .app-shell,
  .app-shell[data-has-middle-pane="true"] {
    grid-template-columns: 1fr;
    grid-template-rows: none;
    height: auto;
    padding: 8px;
    overflow: visible;
  }

  .pane-resizer {
    display: none;
  }

  .yonalist-navigation-pane,
  .list-pane,
  .detail-pane,
  .app-statusbar,
  .app-shell[data-has-middle-pane="true"] > .yonalist-navigation-pane,
  .app-shell[data-has-middle-pane="true"]
    > .feature-pane-slot
    > .list-pane,
  .app-shell[data-has-middle-pane="true"] > .detail-pane {
    grid-row: auto;
    grid-column: auto;
  }

  .yonalist-navigation-pane,
  .list-pane,
  .detail-pane {
    height: auto;
    min-height: auto;
    margin-top: 8px;
    overflow: visible;
  }

  .app-titlebar,
  .app-content-drag-strip,
  .pane-titlebar-spacer {
    display: none;
  }

  .settings-header {
    padding-top: 20px;
  }
}
```

상세 최대화 규칙은 두 반응형 `@media` 블록 뒤에 둔다. 같은 구체성을 가진 모바일 Settings 규칙보다 나중에 적용되어야 창이 좁아도 상세 화면만 남는다.

- [ ] **Step 8: App의 리사이저 값과 가운데 패널 DOM 테스트 보강**

`App.test.tsx`의 Notes 구조 테스트에 다음 단언을 추가한다.

```tsx
expect(
  screen.getByRole("separator", { name: "Resize navigation pane" })
).toHaveAttribute("aria-valuemin", "320");
expect(
  screen.getByRole("separator", { name: "Resize navigation pane" })
).toHaveAttribute("aria-valuemax", "480");
expect(
  screen.getByRole("separator", { name: "Resize navigation pane" })
).toHaveAttribute("aria-valuenow", "336");
```

Settings 구조 테스트에서는 `Settings sections`와 두 리사이저가 모두 같은 `main.app-shell` 아래에 있는지 확인한다.

```tsx
const shell = container.querySelector("main.app-shell");
const settingsSections = await screen.findByLabelText("Settings sections");
expect(shell).toContainElement(settingsSections);
expect(shell).toContainElement(
  screen.getByRole("separator", { name: "Resize item list pane" })
);
```

- [ ] **Step 9: Task 3 집중 테스트와 빌드 실행**

Run:

```bash
npm test -- src/hooks/usePaneResize.test.tsx src/components/TitleBar.test.tsx src/App.test.tsx
npm run build
```

Expected: 테스트와 TypeScript/Vite 빌드 모두 PASS.

- [ ] **Step 10: 레이아웃 변경 커밋**

```bash
git add src/App.tsx src/App.test.tsx src/components/TitleBar.tsx src/components/TitleBar.test.tsx src/hooks/usePaneResize.ts src/hooks/usePaneResize.test.tsx src/styles.css
git commit -m "feat: adapt pane layout for unified navigation"
```

---

### Task 4: 전체 검증과 macOS 직접 확인

**Files:**
- Verify: `src/**`
- Verify: `docs/superpowers/specs/2026-07-27-yonalist-unified-navigation-pane-design.md`
- Verify: `docs/superpowers/plans/2026-07-27-yonalist-unified-navigation-pane.md`

**Interfaces:**
- Consumes: Tasks 1–3에서 완성한 프런트엔드 변경
- Produces: 자동 검사 결과, 새 번들과 프로세스에서 얻은 사용자 경로 증거

- [ ] **Step 1: 최종 변경 범위 확인**

Run:

```bash
git status --short
git diff --stat HEAD~3..HEAD
git diff --name-only HEAD~3..HEAD
```

Expected: 통합 탐색과 관련된 프런트엔드, 테스트, 문서만 포함된다. `src/services/notesSyncListener.ts`, `src/services/notesSyncListener.test.ts`, `.pnpm-store/`는 세 커밋에 포함되지 않는다.

- [ ] **Step 2: 설계 요구사항 대조**

다음 항목을 변경 내용에서 한 번씩 확인한다.

```text
Notes: navigation + detail, middle 없음
Settings: navigation + category middle + detail
Settings 전환 중 Notes navigation/detail 노드 유지
Notes 명령 전에 openNotes 호출
검색어 유지
sidebar 336px, 320px–480px
기존 yonalist.paneWidths.v1 사용
980px 이하 Settings만 오른쪽 상하 배치
720px 이하 전체 세로 배치
Navigation 랜드마크 하나
Notes에서 숨은 middle/resizer 없음
```

- [ ] **Step 3: 프런트엔드 최종 검사 한 번 실행**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected:

```text
npm test: PASS
npm run lint: PASS
npm run build: PASS
git diff --check: 출력 없이 종료 코드 0
```

Rust, IPC payload, persistence와 native 설정을 바꾸지 않았으므로 Cargo test, Rustfmt와 Clippy는 실행하지 않는다.

- [ ] **Step 4: 새 Tauri 번들과 별도 Vault 준비**

기존 Yonalist 개발 앱을 정상 종료한 다음 별도 Vault 경로를 만든다.

```bash
test_vault_dir="$(mktemp -d /tmp/yonalist-unified-navigation.XXXXXX)"
printf '%s\n' "$test_vault_dir"
npm run tauri:dev
```

Expected: 새 프런트엔드 번들이 빌드되고 새 Tauri 프로세스가 열린다. Settings → Vault and sync에서 출력된 임시 경로를 선택한다.

- [ ] **Step 5: Notes 2단 사용자 경로 확인**

새 앱에서 다음 순서로 확인한다.

```text
1. Navigation과 Notes 세부 화면만 가로로 보인다.
2. Navigation과 본문 사이에는 리사이저가 하나만 있다.
3. New page로 제목이 긴 페이지를 만들고 말줄임과 페이지 메뉴를 확인한다.
4. All, Starred, Recent, Tags, Archive, Trash를 차례로 연다.
5. 검색어를 입력하고 검색 결과를 연다.
6. GitHub Notifications가 활성화된 환경이면 페이지 행을 열어 기존 플러그인 화면을 확인한다.
7. Yonalist data settings, Login required와 오프라인 전환 동작이 기존 위치에서 작동하는지 확인한다.
```

- [ ] **Step 6: Settings 3단과 상태 복귀 확인**

```text
1. 페이지 제목이나 블릿에 저장되지 않은 입력을 남긴다.
2. 검색어도 입력한 채 Settings를 연다.
3. Navigation, Settings categories, Settings detail의 3단 구조를 확인한다.
4. Appearance, GitHub 서버, Vault and sync, Yonalist, Plugins, Reset을 차례로 선택한다.
5. Close settings를 누르고 이전 페이지, 초안, 검색어와 분할 편집 상태가 남아 있는지 확인한다.
6. Settings를 다시 열고 Navigation의 Starred를 눌러 Notes로 즉시 돌아오는지 확인한다.
7. Settings를 다시 열고 페이지, 태그, 검색 결과와 GitHub Notifications도 같은 방식으로 확인한다.
```

- [ ] **Step 7: 접기·최대화와 반응형 구간 확인**

창 너비를 각각 약 `1100px`, `850px`, `680px`로 바꾸며 확인한다.

```text
1100px Notes: 통합 탐색 + detail 가로 배치
1100px Settings: 통합 탐색 + categories + detail 가로 배치
850px Notes: 통합 탐색 + detail 가로 배치
850px Settings: 왼쪽 통합 탐색, 오른쪽 categories/detail 상하 배치
680px Notes: 통합 탐색과 detail 세로 배치
680px Settings: 통합 탐색, categories, detail 세로 배치
```

`1100px`에서 통합 탐색 패널 접기와 상세 최대화를 각각 켰다가 해제한다. Notes에서는 통합 탐색만, Settings 상세 최대화에서는 통합 탐색과 설정 카테고리가 함께 숨는지 확인한다.

- [ ] **Step 8: 최종 결과 기록**

구현을 맡은 작업자는 다음 형식으로 결과를 남긴다.

```text
자동 검사:
- npm test:
- npm run lint:
- npm run build:
- git diff --check:

macOS 직접 확인:
- 새 번들/새 프로세스:
- 별도 Vault:
- Notes 2단:
- Settings 3단:
- 상태 복귀:
- 접기/최대화:
- 1100px / 850px / 680px:

기존 문제:
- 작업 전부터 있던 실패나 경고:

남은 위험:
- 직접 확인하지 못한 항목:
```

모든 항목이 통과하고 추가 수정이 없다면 별도 커밋을 만들지 않는다. 직접 확인 중 코드를 고쳤다면 해당 집중 테스트와 프런트엔드 최종 검사를 다시 한 번 실행한 뒤 수정 목적에 맞는 커밋을 추가한다.
