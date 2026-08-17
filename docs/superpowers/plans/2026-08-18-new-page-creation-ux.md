# 새 페이지는 쓰기 시작할 때 태어난다

- 작성: 2026-08-18
- 기준: `main@8ae7f36f`, 작업 worktree `claude/new-page-creation-ux-8bcfd0`
- 설계·구현·리뷰 모두 Opus 5. Fable 5 한도 소진으로 `fable-opus-loop`의 모델 분리를 지키지 못했다

## 1. 제공 계약

| 항목 | 내용 |
|---|---|
| 목표 | New page를 누르면 빈 제목 줄에 커서가 놓이고, 아무것도 쓰지 않은 페이지는 어디에도 남지 않는다 |
| 비대상 | 기존 페이지 이름 바꾸기, 사이드바의 `Untitled page` 표시 대체 문구, Home/root 동작, Rust 명령 추가, 스키마 변경 |
| 영향 경계 | 프런트엔드만. `notesStore.ts`, `store/storeCommands.ts`, `optimisticOutline.ts`, `App.tsx`, `NotesOutline.tsx` |
| 데이터·Undo/Redo 결정 | 새 페이지는 첫 명령이 나갈 때 비로소 `createNode`로 태어난다. 그때까지는 이 창의 상태에만 있으므로 undo 스택도 vault도 건드리지 않는다. New page 클릭은 mutation이 아니라 navigation 한 칸이고, ⌘Z는 이전 페이지로 돌아간다 |
| 직접 확인할 사용자 시나리오 | 새로 빌드한 앱에서 New page → 제목이 비어 있고 커서가 거기 있는지 → 아무것도 입력하지 않고 Home → Pages 목록과 Trash 둘 다 그대로인지. 다시 New page → `a` 입력 → 목록에 나타나고 재시작 후에도 남는지 |

### 완료 조건

| ID | 사용자에게 보이는 결과 | 기계적 완료 조건 |
|---|---|---|
| A1 | 새 페이지 제목이 비어 있다 | `createPage()`가 어떤 명령도 보내지 않는다. `Page title` 필드 값이 `""`다 |
| A2 | 커서가 제목 줄에 있다 | New page 직후 `aria-label="Page title"` textarea가 `document.activeElement`다 |
| A3 | `No outline yet.`이 없다 | 열린 페이지의 본문이 비어도 그 문구가 렌더되지 않는다 |
| A4 | 안 쓴 페이지는 남지 않는다 | New page 후 다른 페이지를 열면 `execute`가 한 번도 불리지 않고 `pages`가 그대로다 |
| A5 | 무엇이든 쓰면 정식 페이지가 된다 | 제목 타이핑·자식 불릿·이미지 중 무엇이든 첫 명령 앞에 페이지의 `createNode`가 먼저 나간다 |

A1·A4·A5는 항목 1, A2는 항목 2, A3은 항목 3이 잠근다.

## 2. 왜 만들어두고 지우지 않는가

대안은 지금처럼 즉시 `createNode`를 보내고, 빈 채로 떠날 때 `removeEmptyNode`로 되돌리는 것이다. 진단해보니 그쪽은 계약을 세 군데서 어긴다. 클릭하는 순간 사이드바에 빈 행이 들어왔다 나가고, vault에 파일이 생겼다 지워지며 그 왕복이 다른 기기까지 전파되고, undo 스택에 생성·삭제 두 칸이 남는다. 사용자가 말한 "편입하지 말고"는 결과만이 아니라 그 사이 상태까지 가리킨다.

그래서 페이지 노드는 첫 명령 직전에 태어난다. 태어나기 전 페이지는 `state.pageNode` 하나로만 존재한다. 이 코드베이스가 이미 쓰는 낙관적 투영(`optimisticOutline.ts`)과 같은 모양이고, 다른 점은 뒤따르는 명령이 아직 없다는 것뿐이다.

## 3. 항목

### 항목 1 — 스토어: 쓰기 전까지는 이 창에만 있는 페이지

`NotesStore.createPage()`는 IPC를 보내지 않는다. `provisionalPageId`를 세우고 빈 `pageNode`를 투영한 뒤 그 페이지를 연다. `StoreCommands`는 `execute`·`executeExternal` 첫 줄에서 host의 `materializePage()`를 부르고, 그 안에서 페이지의 `createNode`가 큐의 앞자리를 먼저 가져간다.

제목·노트 초안은 생성 명령이 데려간다. 초안을 남겨두면 뒤이어 도는 `flushDrafts`가 아직 없는 행에 `updateText`를 먼저 보내 실패한다 — `storeCommands.ts`의 주석이 말하는 그 앞자리다. 생성 명령은 `flushTitle`과 같은 history group을 달아, 같은 타이핑에서 나온 중복 `updateText`가 undo 한 칸으로 접힌다.

떠날 때는 지울 것이 없다. `openPage`가 다른 페이지로 가면 표식만 사라진다. 다른 기기의 변경이 도착해도 아직 백엔드가 모르는 페이지를 다시 읽지는 않는다.

- 실패 테스트: `apps/desktop/src/notesStore.test.ts` — "쓰기 전에는 아무것도 보내지 않는다", "안 쓴 페이지는 남지 않는다", "자식 불릿보다 페이지가 먼저 태어난다"

### 항목 2 — 앱: 목록에 없는 페이지를 열고, 커서를 제목에 둔다

`App`의 열린 페이지 조회는 `state.pages`에서 못 찾으면 `activePageId`로 빈 제목의 페이지를 세운다. 제목은 어차피 `useNotesNode`가 노드에서 읽는다. New page는 `emptyPaneLocation`에 `primaryFocus`(제목 필드)를 얹어 기존 복원 경로로 커서를 보낸다. 그리고 이제 생성은 mutation이 아니므로 `recordMutationNavigation`이 아니라 `recordNavigation`으로 기록한다 — 전자는 스토어가 방금 밀어 넣은 mutation 칸을 뽑아내는데, 이제 그 칸은 남의 것이다.

- 실패 테스트: `apps/desktop/src/navigationHistoryIntegration.test.tsx` — "New page는 빈 제목에 커서만 두고 아무것도 쓰지 않는다"

### 항목 3 — 아웃라인: 빈 본문에 문구를 두지 않는다

본문이 없는 페이지의 `No outline yet.`을 지운다. 자식 추가 버튼이 이미 그 자리에 있다. 페이지 자체가 없을 때의 문구(`NotesOutline.tsx:299`)는 다른 상태이므로 그대로 둔다.

- 실패 테스트: `apps/desktop/src/navigationHistoryIntegration.test.tsx` — 같은 테스트에서 문구 부재를 함께 잠근다

## 4. 남는 위험

- 첫 내용을 쓴 직후 ⌘Z를 누르면 페이지 생성까지 함께 물러난다. 그 순간 열려 있는 페이지는 백엔드에 없는 상태가 되고, 한 번 더 ⌘Z를 누르면 이전 페이지로 돌아간다. 되돌릴 수 없는 손실은 없다.
- 마지막 자식을 지워 빈 페이지가 되는 것은 이 설계가 다루지 않는다. 한 번이라도 내용이 있었던 페이지는 정식 페이지다.
