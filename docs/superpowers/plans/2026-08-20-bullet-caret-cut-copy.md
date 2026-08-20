# 캐럿만 놓인 불릿의 잘라내기·복사

작성 2026-08-20. Fable 5 설계. 사용자 요청: 불릿에 캐럿만 있고 아무것도
선택하지 않았을 때 ⌘X가 그 불릿을 잘라내고 ⌘C가 복사해야 한다.

경로는 모두 `apps/desktop/src/` 기준이다.

## 지금 코드가 하는 일 (경로 확인)

- 불릿 행의 편집 표면은 `<textarea>`다 (`outline/OutlineTextField.tsx:395`).
- 밴드가 있으면 섹션의 클립보드 이벤트 핸들러가 받는다:
  `NotesOutline.tsx:454` `onCopy` → `selection.copy(event)`, `:461` `onCut`.
  둘 다 `selectedIds`가 비면 바로 물러난다
  (`outline/useOutlineSelection.ts:202`의 `WRITE_FAILED` 조기 반환,
  `NotesOutline.tsx:462`). 이 조기 반환은 행 안에서 글자를 선택한 native
  복사·잘라내기를 살려 두는 가드이기도 하다.
- 이미지 행은 textarea가 아니라서 클립보드 이벤트를 받지 못하고 keydown에서
  chord를 직접 읽는다: `outline/outlineKeyboard.ts:774-785`가
  `copyImage`/`cutImage` 인텐트를 내고 `outline/outlineSupport.ts:257-262`가
  밴드 유무에 따라 `selectionActions.copy/cut` 또는
  `onCopyImage`/`onCutImage`로 보낸다. 반복 입력은 `consume`으로 삼킨다.
- 행 메뉴는 이번 요청과 같은 대상 — 선택 없이 집은 행 하나 — 의 Copy·Cut을
  이미 구현해 두었고 단축키 힌트로 ⌘C·⌘X를 그려 준다
  (`outline/outlineMenuCommands.ts:317-355`). Copy는
  `buildOutlineClipboardFormats(store.getSnapshot(), [node.id])`로 서브트리
  전체를 직렬화해 `writeOutlineClipboard(formats, false)`로 쓰고
  (`:324-330`), Cut은 `rowCutRefusal`(`:134-144`)이 창 완결성과 클립보드
  한도를 거른 뒤 `writeOutlineClipboard(formats, true)`가 성공해야
  `deleteSubtree`를 부른다 (`:343-353`). 메뉴가 약속한 단축키를 키보드가
  아직 지키지 않는 상태다 — 이번 작업이 그 틈을 닫는다.

## 메커니즘 결정

keydown 인텐트 경로로 간다. 이미지 행이 이미 쓰는 길과 같은 모양이다.

1. WebKit이 접힌 캐럿에 native copy/cut 이벤트를 보내는지는 확신할 수 없다.
   Safari 계열은 선택이 없으면 Copy 커맨드 자체를 비활성으로 두는 것으로
   알려져 있고, 개발용 브라우저 pane은 Chromium이라 실앱(WKWebView)과 다르게
   움직일 수 있다. 이벤트 경로는 이 가정 위에 서지만 keydown 경로는 어느
   쪽이 참이어도 옳다: 인텐트가 잡히면 keydown에서 `preventDefault`하므로
   native 이벤트가 뒤따라 생겨도 이중 처리가 없고, 안 생겨도 기능은
   동작한다. 가정이 틀렸을 때의 비용이 0이라는 점이 결정적이다.
2. chord가 keydown에 도달한다는 것과 keydown 제스처 안에서 시작한
   `navigator.clipboard` 쓰기를 WKWebView가 허용한다는 것 둘 다 이미지 행
   경로가 실앱에서 이미 증명했다 (`outline/outlineClipboardActions.ts:117-136`
   `putImageOnClipboard`와 그 주석). 액션 바의 Copy/Cut 버튼도 같은
   `writeOutlineClipboard`를 쓴다.
3. 재사용도가 가장 높다. 쓰기·거절·삭제 순서는 행 메뉴의 Cut과
   `cutImageNode`(`outlineClipboardActions.ts:141-164`)가 이미 확정한 모양
   그대로이고, 이 설계는 거기에 캐럿 핸드오프와 상태 라인 피드백만 얹는다.
   새 직렬화도 새 포맷도 없다.

남는 위험: WebView가 `writeOutlineClipboard`의 ClipboardItem 경로를 거절하면
copy는 plain text로 강등되어 payload를 잃고 cut은 거절된다
(`outline/outlineClipboard.ts:376-404`). 밴드의 액션 바 Copy/Cut과 행 메뉴가
이미 같은 강등 규칙 위에 있으므로 새 위험이 아니다.

## 계약 (frozen)

| 항목 | 내용 |
| --- | --- |
| 목표 | 불릿 행에 캐럿만 있을 때(밴드 없음, 행 안 글자 선택 없음) ⌘C가 그 행의 서브트리 전체를 한 행짜리 선택과 같은 클립보드 포맷으로 복사하고, ⌘X는 같은 쓰기가 성공한 뒤에만 서브트리를 지우고 캐럿을 이웃 행에 넘긴다 |
| 완료 조건 | 아래 인수 조건 A1–A6 |
| 비대상 | 아래 비대상 절 |
| 영향 범위 | 프론트엔드만. IPC·Rust·SQLite 변경 없음 — 삭제는 기존 `deleteSubtrees` 커맨드를 탄다 |
| 데이터·Undo/Redo | 새 결정 없음. 잘라낸 서브트리는 기존 히스토리로 ⌘Z 복원 |
| 수동 확인 | 아래 수동 확인 절 |

### 비대상

- 밴드(여러 행 선택)의 키보드 복사·잘라내기: 섹션 이벤트 경로 그대로.
  인접 관찰 하나 — 키보드로만 만든 밴드는 문서 선택이 접혀 있어 WKWebView가
  copy 이벤트를 안 보낼 가능성이 있다. 사실이라면 이 변경 전부터 있던
  틈이고, 고치려면 아래 resolver의 `hasSelection` 가드를 풀어
  `selectionActions.copy/cut`로 보내는 라우팅 두 줄이면 된다. 다만 그 길은
  포인터 밴드가 실앱에서 검증된 이벤트 쓰기(`writeToEvent`)를 비동기
  `navigator.clipboard` 쓰기로 바꾸므로 이번 범위에서 뺀다. 수동 확인 때
  실앱에서 한 번 눌러 보고 결과만 기록한다.
- 페이지 제목 textarea와 supporting note 필드: native 그대로. 제목은
  `target: "page"`라 새 분기에 닿지 않고, note는 자체 resolver
  (`resolveSupportingNoteKey`)를 쓴다. note에 캐럿만 있을 때 ⌘C는 아무것도
  복사하지 않는다(현행 유지).
- 이미지 행: keydown 경로가 이미 있다. 손대지 않는다.
- 행 메뉴(`outlineMenuCommands.ts`): 손대지 않는다.
- 새 클립보드 포맷·한도·버전·마이그레이션 없음.

### 판단 기록

1. **서브트리 전체를 가져간다.** 한 행을 선택하면 서브트리가 함께 선택되는
   것이 밴드 경로의 규칙이고(`outlineClipboard.ts:16`
   `normalizeSelectedRoots` 이하), 행 메뉴의 ⌘C·⌘X 힌트가 가리키는 실행도
   `[node.id]` 서브트리 직렬화다. 키와 메뉴가 서로 다른 것을 집으면 안 된다.
2. **행 안 글자 선택은 native가 가져간다.** resolver가
   `selectionStart === selectionEnd`일 때만 인텐트를 내므로 스윕된
   선택에서는 null이 돌아오고, `handleOutlineKeyDown`은 인텐트가 없으면
   `preventDefault`에 도달하지 않는다 (`outlineSupport.ts:157-159`). 섹션
   onCopy/onCut의 기존 조기 반환이 두 번째 방어선으로 그대로 남는다.
3. **불릿 계열(textarea를 쓰는 모든 marker)만.** 페이지 제목·note는 비대상.
4. **거절 경로.** cut은 창이 불완전하면 `OUTLINE_WINDOW_INCOMPLETE`,
   서브트리가 한도를 넘으면 `CUT_OVER_CLIPBOARD_BOUNDS`를 상태 라인에 올리고
   아무것도 지우지 않는다. 쓰기가 거절되면 기존 문구 "Could not write the
   selected outline to the clipboard."를 올리고 지우지 않는다. 삭제는
   `writeOutlineClipboard(formats, true)`가 resolve한 뒤에만 실행한다.
   copy는 행 메뉴와 같은 규칙으로 창 완결성 게이트를 두지 않는다 — "Copy
   never deletes, so it loses nothing that was not already on screen"
   (`outlineMenuCommands.ts:321-323`). 못 쓰면 실패 문구만 올리고, 크기를
   이름 짓는 문구는 Cut의 것이라는 기존 규칙(`copySelection` 주석)도
   그대로다.
5. **캐럿과 피드백.** `handOffCaret([nodeId])`를 삭제 전에 캡처해 삭제 후
   실행한다 — 위 행의 끝, 없으면 아래 행의 처음, 다 없으면 페이지 제목
   (`outline/outlineCaretHandoff.ts:11-37`). 선택 상태는 비어 있던 그대로,
   `clearSelection()`으로 잔류 DOM range만 정리하고 "Cut selected outline."
   을 올린다. 문구는 밴드 경로의 것을 재사용한다 — 이 제스처의 정의가 "그
   행이 선택돼 있던 것처럼"이므로 상태 라인 어휘도 한 벌로 유지한다.
6. **키 반복.** 이미지 chord와 똑같이 `input.repeat`이면
   `{ kind: "consume" }` — 누르고 있어도 한 번만 실행되고 native로 새지도
   않는다 (`outlineKeyboard.ts:783` 형제).

### 인수 조건

| # | 조건 | 아이템 |
| --- | --- | --- |
| A1 | 캐럿만 있는 불릿에서 ⌘C(다른 플랫폼 Ctrl+C)는 `copyRow`, ⌘X는 `cutRow` 인텐트로 풀리고, 반복 입력은 `consume`이다. shift·alt가 붙은 chord, 반대 플랫폼의 modifier, `target: "page"`, 살아 있는 밴드(`hasSelection`)에서는 null이다 | 1 |
| A2 | 행 안에 스윕된 글자 선택이 있으면 resolver가 null을 돌려주고 keydown은 `preventDefault`하지 않는다 — native textarea 복사·잘라내기가 그대로 동작한다 | 1 |
| A3 | `handleOutlineKeyDown`이 `copyRow`를 `onCopyRow(node.id)`로, `cutRow`를 `onCutRow(node.id)`로 보낸다. `executeRowIntent`는 두 인텐트를 이미 라우팅된 것으로 취급한다(inert) | 3 |
| A4 | `copyRow(nodeId)`는 그 행의 서브트리 전체(자식·note·draft·marker 포함)를 `writeOutlineClipboard(formats, false)`로 쓰고 "Copied selected outline."을 올린다. 포맷이 안 만들어지거나 쓰기가 거절되면 "Could not write the selected outline to the clipboard."만 올리고 아무것도 바꾸지 않는다 | 2 |
| A5 | `cutRow(nodeId)`는 창이 불완전하면 `OUTLINE_WINDOW_INCOMPLETE`, 한도를 넘으면 `CUT_OVER_CLIPBOARD_BOUNDS`로 거절하고 쓰기도 삭제도 하지 않는다. 쓰기가 거절되면 실패 문구만 올리고 지우지 않는다. 쓰기가 성공하면 `deleteSubtrees([nodeId])` → `clearSelection()` → 캡처해 둔 `takeCaret()` → "Cut selected outline." 순서로 마친다. 쓰기 성공 후 삭제가 실패하면 "Copied, but couldn't remove the selected outline."을 올린다 | 2 |
| A6 | 마운트된 앱에서 캐럿만 있는 불릿에 Ctrl+X를 치면 `navigator.clipboard.write`가 그 행의 포맷("- Second thought")을 받고 `deleteSubtrees` 커맨드가 실행된다. Ctrl+C는 쓰기만 하고 execute를 부르지 않는다 | 3 |

## 아이템

각 아이템은 커밋 하나. 테스트를 먼저 써서 빨간 출력을 기록한 뒤 구현한다.

### 아이템 1 — resolver가 캐럿 전용 chord를 인텐트로 푼다

파일: `outline/outlineKeyboard.ts`

- `OutlineKeyIntent`에 `copyRow`/`cutRow`를 추가한다 (`:91-92`의
  `copyImage`/`cutImage` 옆). 주석 요지: 캐럿만 있는 불릿의 chord는 행의
  서브트리 전체를 집는다 — 한 행짜리 밴드가 쓰는 것과 같은 payload.
- `resolveOutlineKey`의 `target === "row"` 블록 안, ⌘A 사다리(`:364-382`)
  바로 뒤에 추가:

  ```ts
  // A caret with nothing around it: the chord takes the caret's own row, the
  // way the row menu's Copy and Cut already do. A swept span or a live band
  // stays out -- native text copy and the band's own event path own those.
  const clipboardKey = input.key.toLowerCase();
  if (
    (clipboardKey === "c" || clipboardKey === "x") &&
    !input.shiftKey &&
    !input.altKey &&
    primaryModifier(input) &&
    !input.hasSelection &&
    validSelection(input) &&
    input.selectionStart === input.selectionEnd
  ) {
    if (input.repeat) return { kind: "consume" };
    return { kind: clipboardKey === "c" ? "copyRow" : "cutRow" };
  }
  ```

  이미지 행 경로와 부딪히지 않는다: `handleImageNodeKeyDown`의 자체 chord
  블록(`:776-785`)이 fallthrough보다 먼저 chord를 집는다.

실패 테스트: `outline/outlineKeyboard.test.ts`의
"v2 outline keyboard intent resolver" describe에
`it("takes copy and cut off a caret-only bullet row")`.
처음 빨개지는 단정 —

```ts
expect(resolveOutlineKey(
  input({ key: "c", ctrlKey: true, selectionStart: 5, selectionEnd: 5 })
)).toEqual({ kind: "copyRow" });
```

지금은 null이 돌아온다. 같은 테스트가 함께 고정하는 것: `x` → `cutRow`,
mac의 `metaKey` 변형, `repeat: true` → `consume`, 기본 `input()`(5..8 스윕)
→ null (A2의 resolver 절반), `hasSelection: true` → null,
shift·alt·반대 플랫폼 modifier → null, `target: "page"` → null.

### 아이템 2 — 행 하나의 copy/cut 액션

파일: `outline/outlineClipboardActions.ts`

`outlineClipboardActions`의 반환에 `copyRow`와 `cutRow`를 추가한다. 골격은
`cutImageNode`(`:141-164`)와 행 메뉴의 Cut(`outlineMenuCommands.ts:343-353`)
이 확정한 순서 그대로다. 쓰기는 keydown 스택 안에서 동기로 시작하고
(`putImageOnClipboard`와 같은 이유), 뒤처리만 `runExclusive`가 가져간다.

```ts
// The caret's own row when nothing is selected: the same subtree serializer
// the row menu's Copy and Cut run, given the pane's feedback line and the
// caret handoff the menu never had.
const copyRow = (nodeId: string) => {
  if (!index.node(nodeId)) return;
  const formats = buildOutlineClipboardFormats(store.getSnapshot(), [nodeId]);
  if (!formats) return reportWriteFailure();
  const written = writeOutlineClipboard(formats, false)
    .then(() => true, () => false);
  runExclusive(async () => {
    if (!await written) return reportWriteFailure();
    setSelectionFeedback("Copied selected outline.");
  });
};
const cutRow = (nodeId: string) => {
  if (!index.node(nodeId)) return;
  // Same gate as cutImageNode: the payload is built from the loaded window
  // and the delete takes what the server holds, so the window must be whole.
  if (!structuralContextComplete) {
    setSelectionFeedback(OUTLINE_WINDOW_INCOMPLETE);
    return;
  }
  const formats = buildOutlineClipboardFormats(store.getSnapshot(), [nodeId]);
  if (!formats) {
    setSelectionFeedback(CUT_OVER_CLIPBOARD_BOUNDS);
    return;
  }
  const takeCaret = handOffCaret([nodeId]);
  const written = writeOutlineClipboard(formats, true)
    .then(() => true, () => false);
  runExclusive(async () => {
    if (!await written) return reportWriteFailure();
    try {
      await store.deleteSubtrees([nodeId]);
      clearSelection();
      takeCaret();
      setSelectionFeedback("Cut selected outline.");
    } catch {
      setSelectionFeedback("Copied, but couldn't remove the selected outline.");
    }
  });
};
```

문구는 전부 기존 것의 재사용이다: `reportWriteFailure`(`:79-81`)는 선택이
없으면 outline 쪽 문구를 내고, 성공·실패 문구는 `copySelection`/
`cutSelection`(`:82-116`)과 같은 것을 쓴다.

실패 테스트: `outline/outlineClipboardActions.test.ts`. 처음 빨개지는 단정
— `it("copies a caret row's subtree without a selection")`에서
`actions.copyRow("bullet-1")` 호출이 "copyRow is not a function"으로
터진다. 기존 harness(`:55-114`)를 그대로 쓰되 nodes에 `bullet-1`의 자식을
하나 심어 서브트리 포함을 확인한다.

| it | 고정하는 것 (인수 조건) |
| --- | --- |
| copies a caret row's subtree without a selection | write 1회, `written()`의 text/plain에 자식 줄 포함, feedback `["Copied selected outline."]`, `copyToSystem` 미호출 (A4) |
| names the outline when a caret row copy cannot write | write reject → 실패 문구, `deleteSubtrees` 미호출 (A4) |
| names the outline when a caret row outruns the format on copy | `OVERSIZED_CAPTION`류 자식 → write 미호출, 실패 문구 (A4) |
| refuses a caret row cut while the outline window is partial | `structuralContextComplete: false` → `[OUTLINE_WINDOW_INCOMPLETE]`, write·delete 미호출 (A5) |
| refuses a caret row cut whose subtree outruns the format | `[CUT_OVER_CLIPBOARD_BOUNDS]`, write·delete 미호출 (A5) |
| keeps the caret row when its cut write rejects | 실패 문구, delete·takeCaret 미호출 (A5) |
| cuts a caret row and hands the caret on after the delete | `handOffCaret(["bullet-1"])` 캡처, `deleteSubtrees(["bullet-1"])`, `clearSelection`, `takeCaret`, `["Cut selected outline."]` (A5) |
| blames the delete but keeps the copy when removal fails | delete reject → `["Copied, but couldn't remove the selected outline."]`, `takeCaret` 미호출 (A5) |

### 아이템 3 — 라우팅과 pane 배선

파일: `outline/outlineSupport.ts`, `outline/OutlineRow.tsx`,
`NotesOutline.tsx`

- `OutlineRowKeyOptions`(`outlineSupport.ts:87-90`)에 필수 필드
  `onCopyRow: (nodeId: string) => void`, `onCutRow: (nodeId: string) => void`
  추가. 이미지 쪽 `ImageRowKeyOptions`의 `onCopyImage`/`onCutImage`와 같은
  자리매김이다.
- `handleOutlineKeyDown`: 밴드 라우팅 블록(`:180-194`) 뒤,
  `executeRowIntent` 호출(`:195`) 앞에 —

  ```ts
  if (intent.kind === "copyRow") return options.onCopyRow(node.id);
  if (intent.kind === "cutRow") return options.onCutRow(node.id);
  ```

  resolver가 `hasSelection`이면 인텐트를 내지 않으므로 밴드 분기는 필요
  없다.
- `executeRowIntent`의 caller-routed 그룹(`:412-419`)에 `case "copyRow":`
  `case "cutRow":`를 `copyImage`/`cutImage` 옆에 추가.
- `OutlineRowRuntimeState`(`OutlineRow.tsx:86-88` 옆)에 같은 두 필드 추가,
  textarea의 `onKeyDown` 호출부(`:468-487`)에서
  `onCopyRow: current.onCopyRow, onCutRow: current.onCutRow` 전달.
- `NotesOutline.tsx`: `outlineClipboardActions` destructure(`:331-337`)에
  `copyRow, cutRow` 추가, `rowRuntime.state`(`:404-408`의
  `onCopyImage`/`onCutImage` 옆)에 `onCopyRow: copyRow, onCutRow: cutRow`.

세 파일이 한 커밋인 이유: 필드를 필수로 두면 호출부와 공급부가 같이
움직여야 컴파일된다. 선택적 콜백으로 쪼개는 것은 필수 동작을 선택 사항처럼
읽히게 하므로 하지 않는다.

실패 테스트 1 (A3): `outline/outlineSupport.test.tsx`의
"v2 outline row keys reach the collaborator they name" describe에
`it("routes the caret-only clipboard chords to the row's own callback")`.
`options()`(`:54-89`)에 `onCopyRow: vi.fn(), onCutRow: vi.fn()` 스파이를
추가하고 `mountRow`(캐럿을 끝에 접어 둔다, `:142`) 뒤 —

```ts
fireEvent.keyDown(mountRow(given), { key: "x", ctrlKey: true });
expect(given.onCutRow).toHaveBeenCalledWith("beta");
```

지금은 `handleOutlineKeyDown`이 그 옵션을 모르므로 빨갛다. 같은 테스트가
함께 고정: `c` → `onCopyRow("beta")`에 `onCutRow` 미호출, 밴드
(`options(store, true)`)면 둘 다 미호출, `field.setSelectionRange(0, 4)`로
스윕해 두면 둘 다 미호출에 `fireEvent.keyDown(...)`이 `true`를 돌려준다
(`preventDefault` 미실행 — A2의 keydown 절반).

실패 테스트 2 (A6): `outline/outlineClipboardIntegration.test.tsx`에
`it("cuts the caret's own row when nothing is selected")`. 기존 스텁
패턴(`:322-328`)으로 `ClipboardItem`과 `navigator.clipboard.write`를 세우고
—

```ts
render(<App api={notesApi} />);
const field = await screen.findByDisplayValue("Second thought");
fireEvent.keyDown(field, { key: "x", ctrlKey: true });
await waitFor(() => expect(write).toHaveBeenCalled());
// 쓰인 ClipboardItem의 text/plain Blob 텍스트가 "- Second thought"
await waitFor(() => expect(notesApi.execute).toHaveBeenCalledWith(
  expect.objectContaining({
    command: { kind: "deleteSubtrees", ids: ["bullet-2"] }
  })
));
```

처음 빨개지는 단정: `write`가 한 번도 불리지 않는다. 형제
`it("copies the caret's own row when nothing is selected")`는 `key: "c"`로
write 호출을 확인하고 `settled()` 뒤 `notesApi.execute` 미호출을 단정한다.
jsdom의 `navigator.platform`은 비어 있어 `outlinePlatform()`이 "other"를
돌려주므로 두 테스트 모두 `ctrlKey`를 쓴다.

## 수동 확인 (새로 빌드한 Tauri 앱, 최단 경로)

준비: 페이지에 행 세 개 — "A"(자식 "A1"), 형제 "B".

1. "A" 텍스트를 클릭해 캐럿만 둔다(글자 선택 없음). ⌘C → TextEdit에
   붙여넣어 `- A`와 들여쓴 `- A1`을 확인하고, 아웃라인에 다시 붙여넣어
   서브트리가 자식째 복원되는지 본다.
2. "A"에 캐럿만 두고 ⌘X → A와 A1이 사라지고 캐럿이 위 행 끝에 선다.
   붙여넣기로 복원하고, 한 번 더 잘라낸 뒤 ⌘Z로도 복원한다.
3. "B" 안에서 글자 몇 자를 선택하고 ⌘X → 그 글자만 잘리고 행은 남는다.
4. (기록용, 비대상 조사) Shift+↓로 밴드를 만들고 ⌘C가 실앱에서 동작하는지
   한 번 눌러 본다. 결과만 기록한다 — 이 변경과 무관한 인접 틈이다.

## 게이트 (diff 확정 후 1회)

프론트엔드 전용: `npm test`, `npm run lint`, `npm run test:bundle`,
`git diff --check`. Rust·IPC·persistence를 건드리지 않으므로 Cargo
테스트·포맷·Clippy는 건너뛴다.

## 후속 2026-08-21 — 남는 위험이 실제로 터졌다

위 "남는 위험"은 방향만 틀렸다. `writeOutlineClipboard`의 ClipboardItem
경로는 거절되지 않았다. 거절된 것은 payload를 실어 보낸 **HTML 주석**이다.

실앱에서 캐럿만 둔 불릿에 ⌘C를 누른 직후 macOS pasteboard를 그대로 읽은 결과:

```
public.utf8-plain-text, public.html, com.apple.WebKit.custom-pasteboard-data
- USIM 밤도깨비?
<head><meta charset="UTF-8"></head><ul style="caret-color: …">
  <li data-wf-layout="bullet">USIM 밤도깨비?</li></ul>
```

plain text는 행 직렬화(`- ` 접두사)라서 keydown 경로는 제대로 돌았다.
HTML도 올라갔다. 그런데 `data-wf-layout`은 살아 있고
`<!--yonalist-outline-clipboard:…-->`는 없다. WebView가 마크업을 다시 파싱해
내보내면서 주석을 버린 것이다. `com.apple.WebKit.custom-pasteboard-data`는
152바이트짜리 타입 목록(origin + text/plain·text/markdown·text/html)일 뿐
원본 값을 들고 있지 않다.

그래서 붙여넣기는 payload를 못 찾고 plain text로 떨어졌다 — 사용자가 본
"텍스트만 복사"가 이것이다. 비동기 쓰기를 쓰는 모든 호출자(액션 바 Copy·Cut,
행 메뉴, 캐럿 행)가 같이 걸려 있었다.

고친 곳은 공용 직렬화 한 곳이다. payload는 주석을 떠나 첫 리스트 요소의
`data-yonalist-outline-clipboard` 속성으로 간다. 같은 pasteboard 덤프가 리스트
요소의 `data-` 속성은 살아남는다는 증거다(`data-wf-layout`). 래퍼 `<div>`를
새로 씌우지 않은 이유는 밖으로 나가는 fragment를 그대로 두기 위해서다 — 바깥
앱이 읽는 것은 예전과 같은 리스트 구조이고, 늘어난 것은 첫 요소에 붙은 속성
하나뿐이다(payload 크기만큼 길어지므로 바이트가 같다는 뜻은 아니다).

읽는 쪽 `extractOutlinePayload`는 정규식을 버리고 `DOMParser`로 파싱해 속성을
찾는다. 마크업이 남의 엔진을 한 번 거쳐 돌아오므로 인용부호·속성 순서·속성이
붙는 요소는 그 엔진이 정하고, 행 본문은 escape되어 content로만 들어가니 텍스트로
속성을 위조할 수도 없다.

개발 단계라 주석을 읽는 호환 경로는 남기지 않았다. 이전 빌드로 복사해 둔
클립보드는 payload 없이 읽히고, 한 행짜리 복사라면 `parsePastedOutline`이
줄바꿈 없는 입력을 `null`로 돌려주므로 붙여넣기는 새 행이 아니라 캐럿 행에
`- A`라는 글자가 박히는 것으로 끝난다.

계약 테스트는 구현이 아니라 이 사실을 붙잡는다: WebView가 내보낸 마크업 —
`<head>`가 앞에 붙고, 시작 요소에 계산된 `style`이 찍히고, 주석은 전부 사라진
그 형태 — 에서도 payload가 돌아와야 한다(`outlineClipboard.test.ts`의
"round-trips the payload through the markup a WebView writes out").

## 실앱 증거 2026-08-21 — 쓰는 쪽 절반만, 그것도 폐기된 담체로

캐럿만 둔 불릿에 ⌘C를 누른 직후의 pasteboard `public.html`. **첫 번째 시도의
빌드**(래퍼 `<div>`를 쓰던 코드)에서 뜬 것이고, 지금 코드가 내보내는 `<ul>`
담체는 아직 한 번도 덤프하지 않았다:

```
<head><meta charset="UTF-8"></head><div data-yonalist-outline-clipboard="eyJraW5k…"
  style="caret-color: rgb(0, 0, 0); …"><ul><li data-wf-layout="bullet">[ ] …</li></ul></div>
```

여기서 확정된 사실은 하나다 — `data-` 속성은 WebView의 마크업 재작성을
살아남는다. base64는 `kind: yonalist-outline-clipboard`, `version: 1`,
`marker: "todo"`로 디코드됐다.

열려 있는 확인 두 개:

1. **쓰는 쪽, 새 담체.** 첫 `<ul>`/`<ol>`에 붙은 속성이 같은 재작성을
   살아남는지. ⌘C 한 번 뒤 pasteboard `public.html`을 다시 읽으면 끝난다.
2. **읽는 쪽.** 같은 클립보드를 아웃라인에 붙여넣어 행으로 들어오는지.
   WKWebView가 `getData("text/html")`에 무엇을 돌려주는지는 pasteboard 덤프가
   답하지 않는다 — `com.apple.WebKit.custom-pasteboard-data`가 `text/html`을
   타입 목록에 올려 두고도 값은 들고 있지 않다. 잎 행 하나를 ⌘C한 뒤 빈 행에
   ⌘V해서, 새 형제 행이 생기면 닫힌 것이고 `- A`라는 글자가 박히면 깨진 것이다.
