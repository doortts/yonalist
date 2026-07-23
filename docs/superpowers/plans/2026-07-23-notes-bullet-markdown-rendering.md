# Notes 블릿 Markdown 렌더링 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes 블릿 제목에 안전한 Markdown 표시와 단독 HTTPS 이미지 resize를 추가하고 원격 이미지 너비를 블릿 메타데이터로 저장·동기화한다.

**Architecture:** 기존 네이티브 textarea와 표시 overlay를 유지하고, 원문 UTF-16 범위를 보존하는 Notes 전용 경량 파서를 추가한다. 텍스트 Markdown은 frontend 안에서 렌더링하고, 단독 원격 이미지는 재사용 가능한 이미지 resize 프레임에 연결한다. 이미지 너비는 `NoteNode.markdownImageWidth`로 SQLite·history·Notes topic 파일까지 왕복하며 로컬 첨부 이미지의 `ya` 메타데이터와는 분리한다.

**Tech Stack:** React 19, TypeScript, Vitest/Testing Library, Tauri 2, Rust, rusqlite, CSS

## Global Constraints

- 저장되는 제목은 사용자가 입력한 Markdown 원문 그대로여야 한다.
- 편집기는 네이티브 textarea를 유지하며 `contenteditable`로 교체하지 않는다.
- 포커스가 없으면 지원 문법의 기호를 숨기고, 편집 중에는 원문 기호를 표시한다.
- Header는 편집·휴식 상태에서 동일한 단계의 typography를 유지한다.
- 단독 Markdown 이미지는 `https://` URL만 허용하고 Notes assets로 복사하지 않는다.
- 원격 Markdown 이미지 너비는 블릿 메타데이터에 저장하고 기존 로컬 이미지 `ya` 메타데이터는 유지한다.
- 같은 줄의 canonical 순서는 `사용자 콘텐츠 → 이미지 메타데이터 → 블릿 메타데이터`이며 블릿 메타데이터가 항상 마지막이다.
- 기존 사용자 변경 `src/features/notes/outlineLayoutMotion.ts`와 `src/features/notes/outlineLayoutMotion.test.ts`를 수정하거나 포함하지 않는다.
- 개발 단계 DB migration은 추가하지 않는다. schema version을 올리고 이전 개발 DB에는 기존 초기화 안내를 사용한다.

---

## 파일 구조

### 새 파일

- `src/features/notes/noteMarkdown.ts`: 블록·inline 문법 파싱, 안전한 URL 판별, 표시 offset→원문 offset 매핑
- `src/features/notes/noteMarkdown.test.ts`: 문법·UTF-16·악성 URL 회귀 테스트
- `src/features/notes/NotesRemoteMarkdownImage.tsx`: 단독 HTTPS 이미지 로딩, 오류 표시, resize 연결
- `src/features/notes/NotesRemoteMarkdownImage.test.tsx`: 이미지 로드·오류·resize 테스트
- `src/features/notes/NotesResizableImageFrame.tsx`: 로컬·원격 이미지에서 공유하는 크기 측정과 포인터·키보드 resize 프레임
- `src/features/notes/NotesResizableImageFrame.test.tsx`: resize 상태 기계의 소유 테스트

### 기존 파일

- `src/features/notes/NoteTokenText.tsx`: 편집/휴식 표현과 Markdown 토큰 렌더링
- `src/features/notes/NoteTextField.tsx`: 파싱 결과, 편집 상태, pointer caret 매핑 전달
- `src/features/notes/OutlineNodeRow.tsx`: 블록 스타일과 원격 이미지 블릿 렌더링
- `src/features/notes/NotesPageHeader.tsx`: 확대 페이지의 동일 Markdown 표현
- `src/features/notes/NotesImageAttachment.tsx`: 공통 resize 프레임 사용
- `src/features/notes/notes.css`: Header, 인용문, 구분선, 링크 및 원격 이미지 스타일
- `src/features/notes/NoteTokenText.test.tsx`
- `src/features/notes/NoteTextField.test.tsx`
- `src/features/notes/NotesImageAttachment.test.tsx`
- `src/features/notes/NotesWorkspace.test.tsx`
- `src/features/notes/NotesPageHeader.test.tsx`
- `src/domain/notes.ts`, `src/domain/notes.test.ts`: frontend DTO
- `src/features/notes/notesWorkspaceTypes.ts`
- `src/features/notes/notesDraftEngine.ts`, `src/features/notes/notesDraftEngine.test.ts`
- `src/features/notes/useNotesDraftWorkflow.ts`: draft 저장 payload
- `src/services/notesStore.ts`, `src/services/notesStore.tauri.test.ts`: IPC 계약
- `src-tauri/src/notes/schema.rs`: schema version 4와 nullable width column
- `src-tauri/src/notes/types.rs`: Rust DTO와 검증
- `src-tauri/src/notes/repository.rs`: row mapping과 update
- `src-tauri/src/notes/history.rs`: snapshot/restore
- `src-tauri/src/notes/sync/topic_file.rs`: canonical metadata 출력
- `src-tauri/src/notes/sync/topic_parser.rs`: `miw`와 root width 파싱
- `src-tauri/src/notes/sync/exporter.rs`: DB→topic document
- `src-tauri/src/notes/sync/merger.rs`: topic document→DB merge
- 관련 Rust 모듈의 생성자와 golden test fixture

---

### Task 1: Notes Markdown 순수 파서

**Files:**
- Create: `src/features/notes/noteMarkdown.ts`
- Create: `src/features/notes/noteMarkdown.test.ts`

**Interfaces:**
- Produces:

```ts
export type NoteMarkdownBlock =
  | { readonly kind: "text"; readonly inline: readonly NoteMarkdownInline[] }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly markerEndUtf16: number; readonly inline: readonly NoteMarkdownInline[] }
  | { readonly kind: "quote"; readonly markerEndUtf16: number; readonly inline: readonly NoteMarkdownInline[] }
  | { readonly kind: "divider" }
  | { readonly kind: "remoteImage"; readonly alt: string; readonly url: string };

export interface NoteMarkdownInline {
  readonly kind: "text" | "strong" | "strike" | "link";
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly contentStartUtf16: number;
  readonly contentEndUtf16: number;
  readonly href?: string;
}

export function parseNoteMarkdown(source: string): NoteMarkdownBlock;
export function sourceOffsetFromPresentation(
  block: NoteMarkdownBlock,
  presentationOffsetUtf16: number
): number;
export function isStandaloneRemoteMarkdownImage(source: string): boolean;
```

- [ ] **Step 1: 지원 문법의 실패 테스트 작성**

`noteMarkdown.test.ts`에 H1/H2/H3, `--`, `> `, Markdown 링크, bold,
strike, 단독 HTTPS 이미지 및 `#tag` 비충돌을 표 기반 테스트로 작성한다.

```ts
it.each([
  ["# Heading", "heading", 1],
  ["## Heading", "heading", 2],
  ["### Heading", "heading", 3],
  ["--", "divider", undefined],
  ["> Quote", "quote", undefined]
] as const)("parses %s as %s", (source, kind, level) => {
  expect(parseNoteMarkdown(source)).toMatchObject({ kind, ...(level ? { level } : {}) });
});
```

- [ ] **Step 2: focused parser test가 올바르게 실패하는지 확인**

Run: `npm test -- src/features/notes/noteMarkdown.test.ts`

Expected: FAIL because `./noteMarkdown` does not exist.

- [ ] **Step 3: 최소 파서와 URL validation 구현**

블록 접두사를 먼저 파싱하고, non-recursive inline scanner가 source range를
보존하도록 구현한다. `new URL()` 결과의 protocol을 일반 링크는
`http:`/`https:`, 이미지는 `https:`로 제한한다. malformed 문법은 하나의
일반 text token으로 fallback한다.

- [ ] **Step 4: UTF-16 mapping과 악성 입력 테스트 추가**

한글, emoji surrogate pair, 빈 label, `javascript:`, `data:`, 혼합 이미지
문법 및 미완성 marker의 기대값을 추가한다.

```ts
expect(sourceOffsetFromPresentation(
  parseNoteMarkdown("## 한😀글 **굵게**"),
  5
)).toBeGreaterThanOrEqual(3);
expect(parseNoteMarkdown("[x](javascript:alert(1))").kind).toBe("text");
expect(parseNoteMarkdown("앞 ![x](https://e.test/x.png)").kind).not.toBe("remoteImage");
```

- [ ] **Step 5: parser test 통과 확인**

Run: `npm test -- src/features/notes/noteMarkdown.test.ts`

Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/features/notes/noteMarkdown.ts src/features/notes/noteMarkdown.test.ts
git commit -m "feat(notes): parse bullet markdown"
```

---

### Task 2: 텍스트 Markdown 표시와 편집 geometry

**Files:**
- Modify: `src/features/notes/NoteTokenText.tsx`
- Modify: `src/features/notes/NoteTextField.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/notes.css`
- Test: `src/features/notes/NoteTokenText.test.tsx`
- Test: `src/features/notes/NoteTextField.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`

**Interfaces:**
- Consumes: `parseNoteMarkdown`, `sourceOffsetFromPresentation`
- Produces: `NoteTextFieldProps.markdown?: boolean`
- Produces: `NoteTokenTextProps.markdownMode?: "source" | "rendered"`

- [ ] **Step 1: 휴식/편집 표시 실패 테스트 작성**

다음 계약을 먼저 테스트한다.

```tsx
expect(resting.querySelector(".notes-markdown-marker")).not.toBeInTheDocument();
fireEvent.pointerDown(resting);
expect(screen.getByRole("textbox")).toHaveValue("## **제목**");
expect(field).toHaveAttribute("data-markdown-block", "heading");
expect(field).toHaveAttribute("data-markdown-level", "2");
```

링크는 resting 상태에서 버튼으로 열리고, 편집 상태에서는 원문 문자가
보여야 한다. Header field의 computed modifier class는 편집 전후 동일해야
한다. `--` row의 textarea hit area와 `> ` 인용문 border도 테스트한다.

- [ ] **Step 2: owning tests의 예상 실패 확인**

Run:

```bash
npm test -- src/features/notes/NoteTokenText.test.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: FAIL because Markdown presentation props/classes do not exist.

- [ ] **Step 3: NoteTokenText에 source/rendered 표현 추가**

`rendered` 모드에서는 Header/quote prefix와 bold/strike marker를 DOM에서
제외하고 Markdown link label만 버튼으로 렌더링한다. `source` 모드는 현재
textarea overlay의 문자 수를 그대로 유지하면서 스타일만 적용한다.
기존 tag/date/raw URL 토큰은 겹치지 않는 구간에서 계속 동작한다.

- [ ] **Step 4: NoteTextField에 Markdown 상태와 caret mapping 연결**

`stablePresentation` 편집 중에는 `source`, 휴식 중에는 `rendered`를
사용한다. pointer hit test가 반환한 presentation offset을
`sourceOffsetFromPresentation`으로 변환한다. composition 중에는 파싱
결과를 이유로 focus/selection을 변경하지 않는다.

- [ ] **Step 5: row와 page Header typography/CSS 구현**

`data-markdown-block`/`data-markdown-level`을 field와 row에 적용한다.
Header 단계별 font size/weight/line-height는 CSS custom property로
textarea와 overlay가 공유한다. 인용문 border와 구분선을 콘텐츠 열 안에
표시하되 기존 블릿 marker/menu/guide 배치를 바꾸지 않는다.

- [ ] **Step 6: focused frontend tests 통과 확인**

Run:

```bash
npm test -- src/features/notes/NoteTokenText.test.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: PASS with existing tag/date/IME tests unchanged.

- [ ] **Step 7: 커밋**

```bash
git add src/features/notes/NoteTokenText.tsx src/features/notes/NoteTextField.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/notes.css src/features/notes/NoteTokenText.test.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "feat(notes): render bullet markdown"
```

---

### Task 3: 블릿 원격 이미지 너비 저장 경계

**Files:**
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/notesDraftEngine.test.ts`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts`
- Modify: `src-tauri/src/notes/schema.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Test: owning tests in the same modules

**Interfaces:**
- Adds `NoteNode.markdownImageWidth: number | null`
- Adds `UpdateNoteNodeInput.markdownImageWidth: number | null`
- Adds Rust `NoteNode.markdown_image_width: Option<i64>`
- Adds Rust `UpdateNodeInput.markdown_image_width: Option<i64>`
- Adds SQLite `notes_nodes.markdown_image_width INTEGER`

- [ ] **Step 1: DTO와 Rust repository 실패 테스트 작성**

Frontend validator가 필드 누락·0·소수·상한 초과를 거부하고 nullable 정수를
허용하는 테스트를 작성한다. Rust에서는 다음을 검증한다.

```rust
assert!(update_node(
    &mut connection,
    UpdateNodeInput {
        id: node_id.to_string(),
        title: "![Chart](https://example.com/chart.png)".to_string(),
        note: String::new(),
        image_offset_utf16: 0,
        marker_kind: NoteMarkerKind::Bullet,
        markdown_image_width: Some(320),
    },
).is_ok());
```

일반 제목으로 업데이트할 때 width가 `None`이어야 하며, 개발 schema
version 3 DB는 기존 초기화 안내로 거부되어야 한다.

- [ ] **Step 2: focused DTO/Rust tests의 예상 실패 확인**

Run:

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesDraftEngine.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::markdown_image_width
```

Expected: FAIL because field/schema do not exist.

- [ ] **Step 3: schema version 4와 DTO/row mapping 구현**

`CURRENT_NOTES_SCHEMA_VERSION`을 `4`로 올리고 nullable column을 현재 schema에
추가한다. 기존 migration SQL은 만들지 않는다. 모든 NoteNode SELECT,
INSERT, snapshot JSON 및 restore SQL에 동일한 field를 추가한다.

Backend validation:

```rust
const MAX_MARKDOWN_IMAGE_DISPLAY_WIDTH: i64 = 16_384;

fn validate_markdown_image_width(value: Option<i64>) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some(width) if (1..=MAX_MARKDOWN_IMAGE_DISPLAY_WIDTH).contains(&width) => Ok(()),
        Some(_) => Err("A Notes Markdown image width must be between 1 and 16384 pixels.".to_string()),
    }
}
```

- [ ] **Step 4: draft/IPC payload 연결**

`NotesNodeDraft`와 update draft payload에 nullable width를 넣는다. 제목이
단독 원격 이미지가 아니면 frontend가 `null`을 보내고 backend update가
그 값을 원자적으로 저장한다. resize도 기존 `updateNode` history 경계를
사용하므로 새 IPC command를 추가하지 않는다.

- [ ] **Step 5: focused 저장 경계 테스트 통과 확인**

Run:

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesDraftEngine.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::markdown_image_width
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::markdown_image_width
```

Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/domain/notes.ts src/domain/notes.test.ts src/services/notesStore.ts src/services/notesStore.tauri.test.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesDraftWorkflow.ts src-tauri/src/notes/schema.rs src-tauri/src/notes/types.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/history.rs
git commit -m "feat(notes): persist markdown image width"
```

---

### Task 4: Notes 파일 메타데이터와 canonical 순서

**Files:**
- Modify: `src-tauri/src/notes/sync/topic_file.rs`
- Modify: `src-tauri/src/notes/sync/topic_parser.rs`
- Modify: `src-tauri/src/notes/sync/exporter.rs`
- Modify: `src-tauri/src/notes/sync/merger.rs`
- Modify: `src-tauri/src/notes/sync/integration_tests.rs`

**Interfaces:**
- Adds `TopicRoot.markdown_image_width: Option<i64>`
- Adds `TopicNode.markdown_image_width: Option<i64>`
- Adds node comment token `miw:` followed by one canonical positive decimal integer
- Adds root front matter `root_markdown_image_width:` followed by a canonical
  positive decimal integer or an empty value

- [ ] **Step 1: canonical output과 round-trip 실패 테스트 작성**

다음 문자열 순서를 고정한다.

```rust
assert!(rendered.contains(
    "![Image](.yonalist/notes-assets/hash.png) <!-- ya: name: image.png w: 320 --> <!-- yid:"
));
assert!(rendered.contains(" miw: 480 -->"));
assert_eq!(rendered.matches("<!-- yid:").count(), expected_nodes);
```

`miw` 중복·누락값·0·음수·선행 0·상한 초과를 quarantine하고 format version
3 입력은 width `None`으로 읽는 테스트를 추가한다.

- [ ] **Step 2: sync module tests의 예상 실패 확인**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_file::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_parser::tests
```

Expected: FAIL because `miw`와 root width가 지원되지 않는다.

- [ ] **Step 3: writer/parser에 metadata field와 순서 구현**

topic format version을 올린다. `render_node_comment`는 `miw:`를 블릿
메타데이터 닫힘 직전에 기록한다. 로컬 image atom은 `ya`를 먼저 출력하고
`render_node_comment` 결과를 마지막에 출력한다. parser known token 목록에
`miw:`를 추가하고 canonical integer를 검증한다.

- [ ] **Step 4: exporter/merger round-trip 연결**

DB SELECT와 `TopicRoot`/`TopicNode` 구성에 width를 포함한다. merger는 remote
winner의 width를 INSERT/UPDATE하고 비교 digest와 HLC 판단에 포함한다.
로컬 첨부 `display_width`는 기존 `ya` 경로를 그대로 사용한다.

- [ ] **Step 5: sync owning tests 통과 확인**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_file::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::topic_parser::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::integration_tests
```

Expected: PASS including format version 3 input compatibility and canonical
metadata order.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/notes/sync/topic_file.rs src-tauri/src/notes/sync/topic_parser.rs src-tauri/src/notes/sync/exporter.rs src-tauri/src/notes/sync/merger.rs src-tauri/src/notes/sync/integration_tests.rs
git commit -m "feat(notes): sync markdown image width"
```

---

### Task 5: 재사용 resize 프레임과 원격 이미지

**Files:**
- Create: `src/features/notes/NotesResizableImageFrame.tsx`
- Create: `src/features/notes/NotesResizableImageFrame.test.tsx`
- Create: `src/features/notes/NotesRemoteMarkdownImage.tsx`
- Create: `src/features/notes/NotesRemoteMarkdownImage.test.tsx`
- Modify: `src/features/notes/NotesImageAttachment.tsx`
- Modify: `src/features/notes/NotesImageAttachment.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Produces:

```ts
export interface NotesResizableImageFrameProps {
  id: string;
  accessibleLabel: string;
  sourceUrl: string | null;
  sourceStatus: "loading" | "ready" | "error";
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
  persistedWidth: number | null;
  disabled?: boolean;
  onDisplayWidthCommit?: (width: number) => void;
  onSourceError?: () => void;
}

export interface NotesRemoteMarkdownImageProps {
  nodeId: string;
  alt: string;
  url: string;
  persistedWidth: number | null;
  disabled?: boolean;
  onDisplayWidthCommit: (width: number) => void;
  onEditRequest: () => void;
}
```

- [ ] **Step 1: resize frame 실패 테스트 작성**

기존 local image 계약에서 pointer move/up 한 번 commit, pointercancel 복원,
keyboard keyup 한 번 commit, container clamp 후 persisted target 복원을
새 소유 테스트에 복사해 고정한다.

- [ ] **Step 2: remote image 실패 테스트 작성**

`load`, `error`, alt fallback, HTTPS src, natural dimensions, persisted width
및 edit 요청을 테스트한다.

- [ ] **Step 3: focused image tests의 예상 실패 확인**

Run:

```bash
npm test -- src/features/notes/NotesResizableImageFrame.test.tsx src/features/notes/NotesRemoteMarkdownImage.test.tsx src/features/notes/NotesImageAttachment.test.tsx
```

Expected: FAIL because shared frame and remote component do not exist.

- [ ] **Step 4: 기존 resize 상태를 공통 프레임으로 추출**

`NotesImageAttachment`의 width limits, `ResizeObserver`, pointer/keyboard
interaction identity 및 commit 조건을 새 프레임으로 이동한다. 로컬 image의
byte lease, object URL, lightbox, menu와 오류 controller는 기존 컴포넌트에
남긴다.

- [ ] **Step 5: 원격 이미지 로더 구현**

DOM `<img src={httpsUrl}>`로 로드하고 `naturalWidth`/`naturalHeight`를
프레임에 전달한다. 다운로드·fetch·asset 생성은 하지 않는다. error
상태에서는 대체 문구와 “Edit Markdown” 버튼을 제공한다.

- [ ] **Step 6: image owning tests 통과 확인**

Run:

```bash
npm test -- src/features/notes/NotesResizableImageFrame.test.tsx src/features/notes/NotesRemoteMarkdownImage.test.tsx src/features/notes/NotesImageAttachment.test.tsx
```

Expected: PASS with existing local image resize behavior unchanged.

- [ ] **Step 7: 커밋**

```bash
git add src/features/notes/NotesResizableImageFrame.tsx src/features/notes/NotesResizableImageFrame.test.tsx src/features/notes/NotesRemoteMarkdownImage.tsx src/features/notes/NotesRemoteMarkdownImage.test.tsx src/features/notes/NotesImageAttachment.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): resize remote markdown images"
```

---

### Task 6: 원격 이미지 블릿 workspace 통합

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesPageHeader.test.tsx`
- Modify: `src/features/notes/useNotesWorkspace.operations.test.tsx`

**Interfaces:**
- Consumes: `NotesRemoteMarkdownImage`, `isStandaloneRemoteMarkdownImage`
- Consumes/produces: `actions.updateNode` with `markdownImageWidth`

- [ ] **Step 1: row/page 통합 실패 테스트 작성**

단독 이미지 title이 textarea 대신 resting image block으로 보이고, edit
요청 시 원문 textarea에 focus가 가는지 테스트한다. resize commit은 현재
node의 title/note/imageOffset/markerKind와 새 width를 한 update history
mutation으로 전달해야 한다.

```tsx
expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
  "/vault",
  expect.objectContaining({ id: node.id, markdownImageWidth: 320 }),
  expect.objectContaining({ commandKind: "updateNode" })
);
```

제목을 일반 텍스트로 바꾸면 같은 draft 저장에서
`markdownImageWidth: null`이 전달되어야 한다.

- [ ] **Step 2: integration tests의 예상 실패 확인**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx
```

Expected: FAIL because remote image row integration is absent.

- [ ] **Step 3: OutlineNodeRow와 NotesPageHeader에 원격 이미지 연결**

휴식 상태에서 remote image block을 렌더링하고 편집 요청 시 기존
`NoteTextField`를 reveal/focus한다. disabled/read-only 상태는 resize를
막되 이미지는 표시한다. 기존 bullet menu, collapse, selection, drag,
guide line 구조는 유지한다.

- [ ] **Step 4: resize 저장과 stale width 정리 연결**

resize commit은 draft flush와 workspace queue의 기존 직렬화 규칙을
따른다. title draft parser 결과가 remote image가 아니면 width를 `null`로
보내고 confirmed state에도 projection한다.

- [ ] **Step 5: integration tests 통과 확인**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx
```

Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/useNotesDraftWorkflow.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/useNotesWorkspace.operations.test.tsx
git commit -m "feat(notes): show markdown image bullets"
```

---

### Task 7: 최종 회귀 검증과 직접 smoke test

**Files:**
- Modify only when a verified regression requires a scoped fix.

- [ ] **Step 1: 최종 diff 검토**

Run:

```bash
git diff --check
git status --short
git diff --stat "$(git merge-base HEAD main)"..HEAD
```

Expected: no whitespace errors; only planned files changed.

- [ ] **Step 2: frontend 전체 gate 한 번 실행**

Run:

```bash
npm test
npm run lint
npm run build
```

Expected: all tests pass, ESLint exits 0, TypeScript/Vite build exits 0.

- [ ] **Step 3: Rust 전체 gate 한 번 실행**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected: all non-ignored tests pass and formatting check exits 0.

- [ ] **Step 4: fresh Tauri smoke test**

새 개발 DB 또는 격리 vault에서 fresh bundle/process를 실행한다.

확인 경로:

1. H1/H2/H3, quote, divider, link, bold, strike를 입력한다.
2. 포커스 이동 후 기호가 숨고 다시 편집하면 원문과 커서가 복원되는지 본다.
3. `![설명](https://...)` 단독 이미지가 로드되는지 본다.
4. pointer와 keyboard resize 후 Undo/Redo 및 재시작 너비 복원을 본다.
5. Notes 파일의 metadata 순서가 `콘텐츠 → ya → yid`이고 yid가 줄 마지막인지 본다.

- [ ] **Step 5: 최종 수정이 있었다면 해당 Task의 정확한 파일과 focused test로 재검증**

Task 1~6 중 회귀가 발생한 Task로 돌아가 그 Task에 열거된 파일만 수정하고,
그 Task의 focused test를 다시 통과시킨 뒤 해당 Task의 `git add` 목록과
커밋 메시지를 재사용한다. 최종 gate 중 새 범위를 추가하지 않는다.

- [ ] **Step 6: 완료 증거 기록**

최종 응답에 focused red/green 증거, frontend/Rust gate 결과, fresh Tauri
사용자 경로, 기존 baseline 경고 및 남은 원격 이미지 네트워크 위험을
간결하게 기록한다.
