# Monaco 노트·이미지 상세 설계 (Phase 0)

- 작성: 2026-08-08, Fable 5
- 상위 계획: [2026-08-06-monaco-notes-and-images-plan.md](../plans/2026-08-06-monaco-notes-and-images-plan.md)
- 지위: 구현 착수 기준 문서. 계획 §3의 미정 항목을 여기서 확정한다.

## 0. 확정된 정책 (레거시 oracle 실측)

v2 React 표면의 `resolveSupportingNoteKey`(outlineKeyboard.ts:453)가 노트
키 계약의 oracle이다. 실측 결과:

| 노트 안 입력 | 동작 | 근거 |
|---|---|---|
| Enter | **노트 안 줄바꿈** (핸들러가 null 반환 → textarea 기본 동작) | outlineKeyboard.ts:467-477 |
| Shift+Enter | 다음 제목으로 이동, 다음 행이 없으면 생성 (`nextTitleOrCreate`) | :457-466 |
| Escape | 자기 제목으로 복귀 (`currentTitle`) | :470 |
| ArrowUp, 캐럿이 맨 앞 | 자기 제목으로 (`currentTitle`) | :471-473 |
| ArrowDown, 캐럿이 맨 끝 | 다음 제목으로 (`nextTitle`) | :474-476 |
| IME 조합 중 | 전부 무시 (null) | :456 |

**결정 D1 — 노트는 여러 모델 줄이다.** 노트가 줄바꿈을 담을 수 있으므로
(위 Enter 정책), Monaco 모델에서 한 노드의 노트는 `note.split("\n")` 개수
만큼의 연속된 note 줄로 표현한다. 저장 시에는 그 줄들을 `"\n"`으로 다시
합쳐 하나의 `updateNote`로 보낸다.

## 1. 메타데이터 모델

```ts
interface OutlineLineMetadata {
  readonly nodeId: string;
  readonly parentId: string;
  readonly depth: number;
  readonly kind: "text" | "note" | "image";   // 확장
  readonly collapsed: boolean;
  readonly completed: boolean;
}
```

- `text` 줄: 기존과 동일. 불릿 노드의 제목.
- `note` 줄: 소유 노드의 nodeId·parentId·depth를 **그대로 복제**한다.
  같은 노드의 note 줄이 여러 개일 수 있다(D1).
- `image` 줄: 이미지 노드 하나당 정확히 한 줄. 모델 텍스트 = 캡션(node.text).
  이미지 자체는 view zone(§4)이 그린다.

### 1a. 불변식 (validateOutlineMetadata 확장)

| # | 불변식 |
|---|---|
| V1 | 기존 preorder 규칙(부모 선행, depth +1 제한)은 **text·image 줄에만** 적용된다. note 줄은 preorder 부모 체인 계산에 불참한다 |
| V2 | note 줄은 같은 nodeId의 text 줄 바로 뒤, 또는 같은 nodeId의 다른 note 줄 바로 뒤에만 온다 (연속 run) |
| V3 | note 줄의 parentId·depth·collapsed·completed는 소유 text 줄과 항상 같다 |
| V4 | image 줄의 nodeId는 kind "image"인 백엔드 노드다. image 노드는 자식을 갖지 않는다(레거시 불변식 유지) |
| V5 | 첫 줄은 depth 0의 text 또는 image 줄이다 (note가 첫 줄일 수 없음) |

### 1b. 인덱스 의미 변경

`lineByNodeId`는 "노드의 **제목** 줄 번호"로 의미를 고정하고 이름을
`titleLineByNodeId`로 바꾼다. note 줄 조회용으로
`noteRangeByNodeId: Map<string, [start, end]>`를 추가한다. 전 사용처
스윕은 Phase 1 첫 커밋에서 컴파일 오류로 강제된다(이름 변경 먼저).

### 1c. 하이드레이션

`NoteView` 순회 시:
- `kind === "bullet"`: text 줄 1개 + `note.length > 0`이면
  `note.split("\n")` 만큼 note 줄.
- `kind === "image"`: image 줄 1개 (모델 텍스트 = node.text 캡션).
- `session.ts`의 "text-only" 거부(`hydrateLines` throw)와
  `storeMonaco.assertPageSupported`의 rich-node 거부는 Phase 5에서 함께
  제거한다. 그 전까지 새 kind 경로는 테스트로만 도달한다.

## 2. 편집 규칙 확정 (계획 §3c의 미정 칸 포함)

### 2a. 키 → 구조 변화 표

| 입력 위치 | Enter | Shift+Enter | Tab/Shift+Tab | Backspace(1열) | Delete(줄 끝) |
|---|---|---|---|---|---|
| text 줄 | 기존 분할 규칙 유지 | 노트 run 생성(없으면) 후 첫 note 줄 시작으로 캐럿 (N1) | 기존 | 기존 병합(이전 줄이 note면 §2b-4) | 다음 줄이 note면 저지 |
| note 줄 | note 줄 분할 = 노트 안 줄바꿈 (D1) | 다음 제목으로 이동/생성 (oracle) | **저지** (노트는 구조 없음) | §2b 참조 | run 내부면 note 줄 병합, run 끝이면 저지 |
| image 줄(캡션) | 아래에 새 형제 불릿 생성 (분할 아님 — 캡션은 쪼개지 않는다) | 저지 (이미지 노드에 노트 없음 — 레거시 동일) | 노드 단위 indent/outdent | 캡션 비어 있으면 **저지** (노드 삭제는 명시적 삭제 흐름만) | 저지 |

Escape·화살표 이동은 §0 표를 plugin 커맨드로 그대로 옮긴다. 이동은 구조
변경이 아니므로 커서 재배치 + 캐럿 재정렬만 수행한다.

### 2b. 분할·병합 계획 (structuralReplacement 확장)

1. **note 줄 Enter (run 내 분할)**: 모델 분할은 Monaco 네이티브. 해석은
   "note run의 재구성" — forward는 `updateNote { id, note: 재조립 }` 하나.
   노드 생성 없음. 메타데이터는 note 줄 1개 증가.
2. **note 줄 텍스트 편집**: 텍스트 전용 변경도 해당 줄이 note면
   `updateText`가 아니라 소유 노드의 `updateNote`(전체 재조립)로 매핑.
3. **note run 마지막 줄이 비었을 때 Backspace**: note 줄 제거.
   run이 비면 노트 자체 제거(`updateNote { note: "" }`) 후 제목 끝으로
   캐럿 (N4).
4. **text↔note 경계 병합 금지**: 제목 1열 Backspace로 위 노드의 note와
   합쳐지는 경로, note 1열 Backspace로 제목과 합쳐지는 경로 모두
   `canApplyNativeBoundaryEdit`에서 저지. 단 note 첫 줄 1열 Backspace는
   "저지 + 제목 끝으로 캐럿"으로 처리(레거시 감각 유지).
5. **다중 줄 치환(붙여넣기 등)이 kind 경계를 걸치면 저지**:
   `assertReplaceableSiblings`에 kind 동질성 조건 추가. 이월: 경계 걸친
   붙여넣기의 관대한 처리.
6. **image 줄은 어떤 분할·병합에도 불참**: oldLines에 image가 포함된
   구조 치환은 저지.

### 2c. 커맨드 계약 확장 (Rust)

- `IpcEditorCommand::UpdateNote { id, note }` 추가 → `NotesCommand::UpdateNote`
  매핑(이미 존재). 레시피는 setCollapsed와 동일. 마이그레이션 없음 —
  스키마 변경이 아니다.
- 이미지 관련 에디터 커맨드는 추가하지 않는다. 이미지 쓰기는 §5.

## 3. 렌더링

### 3a. note 줄

- decoration: 불릿·셰브론 injected text를 **만들지 않는다**. 대신 인덴트
  전용 before 주입(`NBSP × (4·depth + 슬롯 폭)`)으로 제목 본문 x좌표에
  정렬 (N7).
- 스타일: 줄 전체 inlineClassName `yonalist-outline-note-line` —
  `color: var(--text-3)`, 크기 14px 상당(줄 높이는 25px 유지 — Monaco
  단일 lineHeight 제약. 레거시와의 시각 차이는 수용하고 기록).
- CSS 층위 규칙 준수: `.notes-monaco-outline .monaco-editor …` (0,3,0).

### 3b. image 줄

- 이미지 본체: 캡션 줄 **위**에 `changeViewZones`로 zone 삽입.
  `afterLineNumber = 캡션 줄 - 1`, `heightInPx = 표시 폭/비율`.
- 캡션 줄 decoration: 불릿 + 캡션 placeholder. 셰브론 슬롯은 leaf 동일.
- zone DOM: `<img src=blob>` + 리사이즈 핸들 + 클릭=라이트박스.
  기존 `ImageResidency`(최대 blob 8개, imageResidency.ts:47)를 그대로
  사용해 가시 zone만 URL을 임대한다 (I8).
- zone 수명: decorationWindow와 같은 가시 윈도에 종속. 윈도 밖 zone은
  제거(높이 placeholder 유지를 위해 zone 자체는 남기고 img만 해제 —
  스크롤 점프 방지). hidden area(접기·완료 숨김·줌)에 들어간 캡션 줄의
  zone은 제거. 재계산 지점은 기존 동기화 지점 `handleMetadataChange` 하나.

## 4. 캐럿·포커스 규칙

- 기존 불변식 유지: 캐럿 재정렬은 `realignCaretWithInjectedText` 단일
  연산, 모든 구조 변경은 `handleMetadataChange` 경유.
- note 줄도 injected 인덴트가 있으므로 재정렬 대상이다 — 변경 불필요
  (이미 모든 줄에 적용됨).
- Shift+Enter로 노트 생성 시: 모델 편집(줄 삽입) → 메타데이터 기록 →
  캐럿을 새 note 줄 1열(재정렬로 인덴트 뒤)로. `createFirstChild`가
  선례(모델 편집 억제 + 수동 기록).

## 5. 이미지 쓰기 경로 직렬화 (단일 기록자)

이미지 ingest/replace/resize는 기존 IPC(`notes_import_image_*`,
`notes_replace_image_*`, `resizeImage` notes 커맨드)를 재사용한다. 세션
소유 배치와 리비전이 경합하므로 다음 시퀀스를 강제한다.

```
사용자 제스처(드롭/붙여넣기/픽커/리사이즈 커밋)
  → session.flush("blur")                  // 큐 비우기, 리비전 확정
    // (구현 노트: flush 사유 enum은 "blur"|"navigation"|"close"뿐이다.
    //  초안의 "structural" 라벨은 오기였고 Phase 3부터 "blur"를 쓴다.)
  → 이미지 IPC 호출 (base_revision = 확정 리비전)
  → 성공: MutationReceipt의 changedNodes로
      세션 메타데이터·모델에 이미지 줄 삽입/갱신 (suppress listener,
      applyMetadataEdit 계열로 undo 1단계 기록)
  → 실패(revision_conflict): 재시도 1회(flush 후), 그래도 실패면
      persistenceQueue conflict 상태로 표면화
  → 실패(검증): 사용자 안내(기존 imageIngest 오류 문구 재사용), 상태 불변
```

| 실패 케이스 | 동작 |
|---|---|
| flush 중 conflict/fatal | 제스처 자체를 거부 (canAcceptStructuralEdit 게이트) |
| IPC 성공 후 세션 반영 전 앱 종료 | 재시작 하이드레이션이 백엔드 상태로 복원 — 손실 없음 |
| 동시 두 제스처(양 페인) | flush가 큐를 직렬화. IPC는 세션당 순차 실행을 storeImages 큐로 보장 |
| undo | 이미지 생성의 inverse는 deleteSubtree… 에디터 배치에 없음 → **이미지 생성/삭제는 Rust 세션 히스토리 소유로 남긴다**. Monaco 메타데이터 undo 스택에는 넣지 않고, ⌘Z 라우팅은 기존 앱 히스토리로 위임(경계는 Phase 4 테스트로 고정) |

리사이즈만 예외적으로 단순하다: `resizeImage`는 텍스트 모델을 건드리지
않으므로 flush → IPC → zone 폭 갱신이면 된다. undo 1단계는 Rust 히스토리.

## 6. 성능 예산

혼합 픽스처(5,000노드 = 텍스트 4,000 + 노트 700(평균 2줄) + 이미지 300)
기준, 기존 게이트 유지:

- 전체 모델 교체 0회, 편집당 데코레이션 재계산 ≤ 3줄
- view zone 동시 생존 수 ≤ 가시 윈도 + 여유(구현 상수, 기본 24)
- blob URL 동시 생존 ≤ 8 (ImageResidency 기존 상한)
- note run 재조립은 O(run 길이), 페이지 전체 순회 금지

## 7. 이월 (이번 범위에서 하지 않음)

- 본문 중간 이미지 원자(atom) — 독립 이미지 행만 지원 (계획 §2b 주의와 동일)
- kind 경계를 걸치는 관대한 붙여넣기 (§2b-5는 저지가 기본)
- 노트 안 태그·날짜 하이라이트 (태그/날짜 계획에서 일괄)
- 이미지 undo의 Monaco 스택 통합 (§5 표의 결정 유지)
- 50k 초과 페이지 (계획 비목표)

## 8. Phase 1 테스트 설계 (TDD 착수 목록)

구현 전 작성한다. 파일별:

`metadata.test.ts`
1. note run 2줄 스냅샷 정상 / note가 text 앞에 오면 throw (V2)
2. note 줄 depth·parentId가 제목과 다르면 throw (V3)
3. image 줄이 자식을 가지면 throw (V4)
4. `titleLineByNodeId`가 note 줄을 가리키지 않는다 / `noteRangeByNodeId` 정확성
5. 첫 줄이 note면 throw (V5)

`session.test.ts`
6. bullet+note("a\nb")+image 페이지 하이드레이션 → kind 배열 [text,note,note,image], 모델 텍스트 [제목,"a","b",캡션]
7. 노트 생성(Shift+Enter 경로 세션 API) → 모델 줄 삽입 + updateNote("") 큐잉 + undo 1단계
8. 빈 노트 제거 → updateNote("") … 제거 후 줄 수 복원

`structuralChanges.test.ts`
9. note 줄 텍스트 편집 → updateNote(재조립) 커맨드, updateText 없음
10. note 줄 Enter → 줄 증가 + updateNote 하나 (노드 생성 없음)
11. 제목 1열 Backspace, 위가 note 줄 → 저지 (canApplyNativeBoundaryEdit false)
12. image 줄 포함 다중 줄 치환 → 저지
13. Rust: UpdateNote conversion 단위 테스트 + 계약 재생성 확인

이 문서가 승인 기준이다. Phase 1 구현(Opus 5)은 위 13개 테스트를 먼저
작성해 red 상태를 확인한 뒤 시작한다.

## 9. 구현 중 확정된 설계 수정 (Phase 6 기록)

- **이미지 undo는 Monaco 전이에 붙는 외부 단계로 구현했다.** Monaco undo
  스택은 바이트 오프셋으로 역편집을 재생하므로 스택 밖에서 모델을 고치면
  기존 요소가 전부 오염된다. 그래서 ingest 삽입은 전이에 `external
  {undo, redo}`를 실어 ⌘Z 한 번에 모델·메타데이터·백엔드가 함께 되돌아
  간다. 외부 단계는 Rust 히스토리 undo가 아니라 정방향 커맨드
  (`deleteSubtrees`/`restoreSubtree`)로 표현한다 — 휴지통을 타므로 I6
  (바이트 보존)도 함께 성립한다.
- **뷰 존은 윈도를 벗어나면 통째로 제거한다.** 초안의 "zone은 남기고
  img만 해제"보다 단순하고, 높이 자리표시가 필요해지면 그때 되살린다.
- **폭 규칙은 스펙(I3)을 따른다: 원본 픽셀 위로 확대하지 않는다.**
  React 표면의 리사이즈 핸들은 원본 초과 확대를 허용하는데, 이는 레거시
  스펙("작은 이미지는 확대하지 않는다")과 어긋난다. Monaco 표면은 스펙
  쪽을 따르고, 두 표면의 차이는 React 표면 은퇴 시 함께 정리한다.
- **재시도 앵커는 재flush 후 재계산한다.** 리비전 충돌 재시도는 이전
  시도 전에 잡아둔 앵커를 재사용하면 안 된다(충돌 원인이 앵커를 옮겼을
  수 있다). `insertImageNodes`는 사라진 beforeId를 만나면 부모 블록 끝
  으로 폴백한다.
