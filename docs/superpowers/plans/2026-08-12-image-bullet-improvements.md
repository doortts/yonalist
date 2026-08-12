# 이미지 블릿 개선 설계 (2026-08-12)

브랜치 `image-bullet-improvements`. 승인된 시안(스크래치패드 `image-bullet-improvements.html`) 기준으로 4개 항목과 라이트박스 드래그 패닝을 구현한다. 순수 UI 변경이며 스키마·마이그레이션은 건드리지 않는다.

## 배경과 범위

| 항목 | 내용 |
|---|---|
| 1 | 이미지 뒤 커서 정거장 — 방향키로 통과·정지, Enter로 아래에 새 노드, 오른쪽 여백 클릭으로 커서 이동 |
| 2 | 리사이즈 세로선을 호버에서만 표시 (3pt 반투명, 120ms 페이드, 드래그·키보드 포커스 중 유지) |
| 3 | 라이트박스 개선 — 상단 파일 이름·원본 크기 바, 원본 크기 스크롤, 드래그 패닝, 4px 미만 클릭만 닫힘 |
| 4 | 이미지 노드 포커스 아웃라인 복원 (`outline: 2px solid var(--accent)`, offset 2px) |

작업 규칙: 항목당 1커밋, TDD(red 증거 확보 후 구현), conventional commit + 영어 본문, 마지막 줄 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

구현 순서는 1 → 4 → 2 → 3. 항목 4의 아웃라인 의미가 항목 1이 세우는 포커스 모델 위에 서므로 둘을 붙여서 진행한다. 2와 3은 서로 독립이다.

## 현재 동작 (조사 결과)

### 키보드 — 이미 되는 것이 대부분이다

- **인접 행에서 방향키로 이미지 노드에 도착**: 이미 된다. `resolveOutlineKey`가 ArrowUp/Down에서 이웃 노드로 `focus` intent를 만들고(`outlineKeyboard.ts:332-360`), `focusOutlineEditor`의 `editorById`가 `data-outline-field === "image"`인 엘리먼트를 찾아 focus한다(`outlineFocus.ts:34-49`). 지금은 그 엘리먼트가 `ImageNodeContent`의 루트 div다(`ImageNodeContent.tsx:194-204`, `tabIndex=0`, `data-node-id`, `data-outline-field="image"`).
- **이미지 노드에서 방향키로 빠져나가기**: 이미 된다. 루트 div의 `onKeyDown` → `handleImagePrimaryKeyDown`(`OutlineRow.tsx:301-322`, `outlineSupport.tsx:208-279`) → `handleImageNodeKeyDown`(`outlineKeyboard.ts:458-499`)이 ArrowUp/Down을 `resolveOutlineKey`로 넘겨 이웃 행에 focus intent를 만든다.
- **Enter로 아래에 새 노드**: 이미 된다. `handleImageNodeKeyDown`이 plain Enter를 `createSibling`으로 바꾸고(`outlineKeyboard.ts:463-479`) `executeRowIntent`가 새 노드를 만들어 caret을 옮긴다(`outlineSupport.tsx:432-448`).
- **plain Backspace는 의도적으로 무시**(`outlineKeyboard.ts:481-489`). 삭제는 Shift+Cmd+Backspace(trash)와 메뉴로만.
- **mutation 후 caret 배치는 이미지 행을 건너뛴다**: `holdsCaret`이 `kind === "bullet"`만 참(`outlineModel.ts:53-63`). 방향키 내비게이션은 일부러 이미지에 정지한다 — 주석에 명시돼 있다.

즉 항목 1에서 진짜 없는 것은 **시각적 커서(정거장 표시)** 하나다. 포커스는 도착하는데 아무것도 안 보인다(메뉴 트리거만 `.notes-image-node-content:focus` 규칙으로 떠오른다, `notes.css:3132-3141`).

### 포커스·표시 관련 CSS

- `.notes-image-node-content:focus-visible { outline: 0 }` — `notes.css:3143-3145`. 항목 4가 대체할 규칙.
- `.notes-node :focus-visible { outline: 2px solid var(--accent); outline-offset: -1px }` — `notes.css:2779-2791`. 노드 안쪽 모든 focus-visible에 걸리는 일반 규칙. 새로 만드는 커서 정거장에도 걸리므로 꺼 줘야 한다.
- `.notes-image-atom-editor*` 계열(`notes.css:2626-2719`)은 어떤 TSX도 참조하지 않는 죽은 규칙이다(과거 atom 편집기 흔적). 재사용하지 않고, 이번 작업에서 지우지도 않는다.
- 선택 하이라이트는 별도 상태다: `.notes-node[data-range-selected="true"] > .notes-node-main`(`notes.css:1853`), ctrl-클릭 선택은 `useOutlinePointerSelection.ts:77-101`이 처리한다.

### 리사이즈 세로선

`ImageNodeContent.tsx:434-443`의 `resizeHandleLineStyle` 인라인 스타일이 항상 보이는 2px `var(--border-strong)` 선을 그린다. 핸들 div(`ImageNodeContent.tsx:240-307`)는 `role="separator"`, `tabIndex=0`, 포인터 드래그는 `pointerResize` ref로, 키보드 리사이즈는 ArrowLeft/Right로 처리한다. 드래그 여부를 알리는 상태(state)는 없다 — ref뿐이라 리렌더가 없다.

### 라이트박스

`ImageLightbox.tsx` 전체 77줄. 다이얼로그 div(grid, `place-items: center`, `padding: 48px`, `notes.css:3169-3181`)에 이미지가 `max-width/max-height: 100%`로 축소되어 들어간다(`notes.css:3183-3192`). 배경 클릭 닫기는 `event.target === event.currentTarget` 비교 하나다(`ImageLightbox.tsx:51-53`). Esc·포커스 트랩·반환은 `useEffect`의 document keydown 리스너(`ImageLightbox.tsx:25-42`). 파일 이름·픽셀 크기 표시는 없다(alt와 aria-label에만 존재).

### 포커스 스냅샷·언두 가드와의 관계

- `capturePane`은 textarea만 캡처한다(`appNavigation.ts:45-55`) — 이미지 포커스는 원래 스냅샷 대상이 아니다.
- App의 언두 가드도 INPUT/TEXTAREA만 본다(`App.tsx:109-113`).
- `outlineFocus.test.ts:137-147`이 "div + `data-outline-field="image"`를 focus한다"를 이미 계약으로 잡아 두었다. 이 계약은 그대로 유지된다 — 그 div가 무엇이냐만 바뀐다.

### 테스트 관례

- 컴포넌트 테스트: `ImageNodeContent.test.tsx` — `ImageResidency`에 read mock 주입, store는 필요한 메서드만 가진 객체를 `as unknown as NotesStore`로 캐스팅, `fireEvent.pointerDown/Move/Up`에 `pointerId` 명시.
- 통합 테스트: `imageStructuralIntegration.test.tsx` — `test/appApiFixture`의 `appApi()`/`snapshot`으로 App 전체를 렌더, 이미지 노드는 `findByRole("group", { name: "Image: cat.png" })`로 찾는다. 방향키 이동은 `App.test.tsx:400-424`처럼 `fireEvent.keyDown` 후 `toHaveFocus()`로 단언한다.
- CSS 계약 테스트: `notesCaret.test.ts` — `readFileSync("src/notes.css")` + 로컬 `rule()` 헬퍼로 특정 셀렉터 블록의 선언을 단언한다. jsdom은 외부 CSS를 적용하지 않으므로 hover/focus 시각 규칙은 이 방식으로 잡는다.

## 포커스/커서 상태 모델 (항목 1과 4의 관계)

핵심 결정: **상태 비트를 새로 만들지 않고, 포커스가 놓인 엘리먼트가 곧 상태가 되게 한다.** 이미지 노드에 포커스 가능한 엘리먼트를 두 개 둔다.

| 상태 | 엘리먼트 | 진입 경로 | 표시 |
|---|---|---|---|
| 커서(글 흐름 위의 위치) | 커서 정거장 `.notes-image-caret-stop` (`tabIndex=-1`, `data-node-id`, `data-outline-field="image"`) | 방향키 내비게이션(`focusOutlineEditor`), 이미지 오른쪽 여백 클릭, 이미지 붙여넣기 직후 포커스 | 이미지 오른쪽 2px 세로 바, `var(--accent)`, 깜빡임 |
| 노드 선택(메뉴·삭제·이동 대상) | 루트 div `.notes-image-node-content` (`tabIndex=0` 유지) | Tab, 이미지 프레임 직접 클릭 | `:focus-visible`에서 `outline: 2px solid var(--accent)` (항목 4) |
| 다중 선택 | `.notes-node[data-range-selected]` | ctrl/shift-클릭, Shift+방향키 | 행 배경 하이라이트 (기존, 무변경) |

- `data-node-id`/`data-outline-field="image"`를 루트 div에서 정거장으로 **옮긴다**. `editorById`(`outlineFocus.ts:44`)가 정거장을 찾게 되므로 모든 아웃라인 내비게이션 포커스가 자동으로 정거장에 착지한다. `outlineFocus.ts`는 한 줄도 안 바뀐다.
- 정거장은 `tabIndex=-1`이라 Tab 순서에 없다. Tab은 루트 div(노드 선택)로만 간다. 한 시점에 포커스는 한 엘리먼트에만 있으므로 **커서와 아웃라인이 동시에 켜질 수 없다** — 겹침 문제를 상태 배타성으로 푼다.
- 정거장에서 누른 키는 루트 div의 `onKeyDown`으로 버블되어 `handleImagePrimaryKeyDown`이 그대로 받는다. Enter·방향키·단축키 경로는 무변경.
- 루트 div가 포커스일 때(노드 선택 상태)의 Enter/방향키 동작도 기존 그대로다. 두 상태의 차이는 표시와 진입 경로이지 키 처리 분기가 아니다.
- `capturePane`·언두 가드는 textarea만 보므로 정거장 포커스는 스냅샷·언두에 영향이 없다.

## 항목별 설계

### 항목 1 — 이미지 뒤 커서 정거장

**이미 되는 것**: 방향키 통과·정지, Enter로 아래 노드 생성, 키 intent 전체(위 조사 결과 참조). 다시 만들지 않는다.

**바꾸는 것** (`ImageNodeContent.tsx`, `notes.css`):

1. 루트 div에서 `data-node-id`, `data-outline-field="image"`를 제거한다. `tabIndex=0`, `role="group"`, `aria-label`, `onKeyDown`, `onPaste`는 그대로.
2. 프레임을 flex 래퍼로 감싼다:
   ```tsx
   <div
     className="notes-image-frame-row"
     onClick={(event) => {
       if (event.target === event.currentTarget) caretStopRef.current?.focus();
     }}
   >
     {/* 기존 notes-image-attachment-frame 그대로 */}
     <div
       ref={caretStopRef}
       className="notes-image-caret-stop"
       tabIndex={-1}
       data-node-id={node.id}
       data-outline-field="image"
       aria-label={`Cursor after ${originalName}`}
     />
   </div>
   ```
   `caretStopRef`는 새 `useRef<HTMLDivElement>(null)`. 에러 배너와 라이트박스는 래퍼 밖, 루트 div 안 그대로 둔다.
3. CSS (`notes.css`, 이미지 섹션 3140줄대에 추가 — `.notes-node :focus-visible`(2779)보다 뒤라서 동순위 규칙이 이긴다):
   ```css
   .notes-image-frame-row {
     display: flex;
     width: 100%;
     min-width: 0;
     align-items: stretch;
   }

   .notes-image-caret-stop {
     flex: none;
     width: 2px;
     margin-inline-start: 6px;
     border-radius: 1px;
     outline: 0;
     background: transparent;
   }

   /* `.notes-node :focus-visible`(2779줄, 특이도 0,2,0)를 이기려면 같은
      특이도의 후행 규칙이 필요하다. 클래스 단독(0,1,0)으로는 진다. */
   .notes-image-caret-stop:focus-visible {
     outline: 0;
   }

   .notes-image-caret-stop:focus {
     background: var(--accent);
     animation: notes-image-caret-blink 1.06s steps(2, jump-none) infinite;
   }

   @keyframes notes-image-caret-blink {
     50% { opacity: 0; }
   }
   ```
   `align-items: stretch`로 바 높이가 프레임 높이와 정확히 일치한다(시안의 `align-self: stretch`와 같은 방식). reduced-motion은 기존 3202줄 블록 옆에 추가:
   ```css
   @media (prefers-reduced-motion: reduce) {
     .notes-image-caret-stop:focus { animation: none; }
   }
   ```
   `.notes-image-caret-stop:focus-visible { outline: 0 }`이 일반 링 규칙(`notes.css:2779`)과 같은 특이도(0,2,0)로 뒤에 놓여 이긴다. 정거장에는 링 대신 바 자체가 포커스 표시다.
4. 메뉴 트리거 표시 셀렉터에서 `.notes-image-node-content:focus`(`notes.css:3136`)를 `.notes-image-node-content:focus-within`으로 바꾼다. 정거장 포커스에서도 트리거가 떠오르고, 루트 포커스 동작은 focus-within이 포함하므로 그대로다.
5. 프레임 스타일의 `maxWidth: "100%"`(`ImageNodeContent.tsx:147`)는 flex 컨테이너 안에서도 유효하다. `maximumWidth()`가 읽는 `rootRef.current.clientWidth`도 루트 폭 기준이라 무변경.

**테스트 헬퍼 이동**: `notesCaret.test.ts`의 `rule()`(8-21줄)을 `src/test/cssRules.ts`로 옮기고 두 파일에서 import한다. 새 CSS 계약 테스트가 같은 헬퍼를 쓴다.

### 항목 4 — 포커스 아웃라인 (항목 1 직후 커밋)

**바꾸는 것**: `notes.css:3143-3145` 한 규칙의 교체가 전부다.

```css
.notes-image-node-content:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

일반 규칙(`notes.css:2779`)이 offset -1px을 주므로 이 규칙을 지우기만 해서는 안 되고, offset 2px로 명시해 덮는다. 마우스 클릭은 `:focus-visible`에 걸리지 않아 이미지 클릭 시 링이 번쩍이지 않고, Tab 진입에서만 보인다 — "노드 전체 선택" 상태의 표시라는 의미와 맞는다.

### 항목 2 — 리사이즈 세로선을 호버에서만

**바꾸는 것** (`ImageNodeContent.tsx`, `notes.css`):

1. `resizeHandleLineStyle` 상수를 지우고 선 span을 `className="notes-image-resize-line"`으로 바꾼다. 핸들 div에 `className="notes-image-resize-handle"`을 준다(인라인 `resizeHandleStyle`은 유지 — 위치·hit 영역은 상태와 무관).
2. 드래그 중 유지를 위해 `const [resizing, setResizing] = useState(false)` 하나를 추가하고 핸들에 `data-resizing={resizing ? "true" : undefined}`를 단다. `onPointerDown`(button 0 분기 안)에서 true, `finishPointerResize`와 `onPointerCancel`에서 false. `:hover`는 pointer capture 중 브라우저별 유지가 보장되지 않으므로 속성으로 고정한다.
3. CSS:
   ```css
   .notes-image-resize-line {
     position: absolute;
     top: 20%;
     right: 4px;
     width: 3pt;
     height: 60%;
     border-radius: 2px;
     background: color-mix(in srgb, var(--text-1) 40%, transparent);
     opacity: 0;
     transition: opacity 120ms ease;
     pointer-events: none;
   }

   .notes-image-attachment-frame:hover .notes-image-resize-line,
   .notes-image-resize-handle:focus-visible .notes-image-resize-line,
   .notes-image-resize-handle[data-resizing] .notes-image-resize-line {
     opacity: 1;
   }
   ```
   `width: 3pt`는 사용자가 pt로 명시한 값이라 그대로 적는다(브라우저 환산 4px). reduced-motion 블록(`notes.css:3202`)에 `.notes-image-resize-line { transition: none; }`을 추가한다.
4. 키보드 포커스 유지는 `:focus-visible`이 해결한다 — 핸들은 키보드로만 실질 포커스를 받으므로 별도 상태가 필요 없다.

**이미 되는 것**: 핸들의 드래그·키보드 리사이즈·undo 그룹핑 전부. 선의 표시 방식만 바뀐다.

### 항목 3 — 라이트박스 (파일 이름 바, 원본 크기 스크롤, 드래그 패닝)

**이미 되는 것**: Esc 닫기, 포커스 트랩(Tab을 close로 강제), 포커스 반환, close 버튼. 전부 무변경.

**바꾸는 것** (`ImageLightbox.tsx`, `notes.css`):

1. 구조를 다이얼로그 안에 스크롤 컨테이너를 두는 형태로 바꾼다:
   ```tsx
   <div className="notes-image-lightbox" role="dialog" aria-modal="true" aria-label={originalName}>
     <div className="notes-image-lightbox-bar">
       <span className="notes-image-lightbox-name">{originalName}</span>
       <span className="notes-image-lightbox-dims">{pixelWidth} × {pixelHeight}</span>
     </div>
     <div
       className="notes-image-lightbox-scroll"
       data-panning={panning ? "true" : undefined}
       onPointerDown={...} onPointerMove={...} onPointerUp={...} onPointerCancel={...}
       onClick={(event) => {
         if (event.target === event.currentTarget && movedRef.current < 4) onClose();
       }}
     >
       <img className="notes-image-lightbox-image" ... onClick={(event) => event.stopPropagation()} />
     </div>
     <button ... 기존 close 버튼 그대로 ... />
   </div>
   ```
   백드롭 div와 useEffect는 그대로.
2. 패닝 상태는 ref 하나 + state 하나:
   ```ts
   const panRef = useRef<{
     pointerId: number; startX: number; startY: number;
     startLeft: number; startTop: number;
   } | null>(null);
   const movedRef = useRef(0);
   const [panning, setPanning] = useState(false);
   ```
   - `onPointerDown`(button 0): `movedRef.current = 0`, panRef 기록, `setPanning(true)`, `event.currentTarget.setPointerCapture?.(event.pointerId)` (jsdom 가드는 `ImageNodeContent.tsx:260`과 같은 `?.` 관례), `event.preventDefault()`.
   - `onPointerMove`(pointerId 일치 시): `scrollLeft = startLeft - (clientX - startX)`, `scrollTop = startTop - (clientY - startY)`, `movedRef.current = Math.max(movedRef.current, Math.hypot(dx, dy))`.
   - `onPointerUp`/`onPointerCancel`: panRef 해제, `setPanning(false)`. `movedRef`는 클릭 판정을 위해 남긴다.
   - 이미지 위에서 시작한 드래그도 버블로 같은 경로를 탄다. 드래그 후 발생하는 click은 `movedRef >= 4`라 닫히지 않고, 이미지 위 click은 기존 `stopPropagation`이 막는다.
3. CSS (`notes.css:3169-3192` 교체 + 추가):
   ```css
   .notes-image-lightbox {
     position: fixed;
     z-index: 71;
     inset: 0;
     border: 0;
     outline: 0;
     background: transparent;
   }

   .notes-image-lightbox-scroll {
     position: absolute;
     inset: 0;
     display: flex;
     padding: 48px;
     overflow: auto;
     cursor: grab;
   }

   .notes-image-lightbox-scroll[data-panning] {
     cursor: grabbing;
   }

   .notes-image-lightbox-image {
     display: block;
     margin: auto;
     max-width: none;
     max-height: none;
     border-radius: 4px;
     box-shadow: var(--shadow-modal);
   }

   .notes-image-lightbox-bar {
     position: absolute;
     z-index: 2;
     inset: 0 0 auto;
     display: flex;
     align-items: center;
     gap: 10px;
     padding: 12px 56px 20px 16px;
     background: linear-gradient(rgb(12 15 20 / 70%), transparent);
     color: rgb(255 255 255 / 88%);
     font-size: 13px;
     pointer-events: none;
   }

   .notes-image-lightbox-name { font-weight: 600; }

   .notes-image-lightbox-dims {
     color: rgb(255 255 255 / 55%);
     font-size: 12px;
   }
   ```
   - `flex + margin: auto`가 두 요구를 한꺼번에 만족한다: 이미지가 뷰포트보다 작으면 auto 마진이 가운데 정렬하고, 크면 마진이 0으로 접혀 좌상단부터 스크롤로 전부 닿는다(`place-items: center`는 overflow 시 좌상단이 잘려서 못 쓴다). img의 `width`/`height` HTML 속성이 원본 픽셀 크기를 지정하므로 `max-*: none`만으로 원본 크기가 된다.
   - 바는 `pointer-events: none`이라 상단에서도 패닝·클릭이 통과한다. 색은 백드롭이 테마와 무관하게 어두우므로 고정 흰색 계열로 적는다(기존 백드롭 `notes.css:3162-3167`과 같은 방식).
   - 휠/트랙패드 스크롤은 `overflow: auto`가 그대로 제공한다.
   - 640px 미만 미디어쿼리(`notes.css:3215-3219`)의 패딩 조정은 `.notes-image-lightbox-scroll`로 셀렉터만 바꿔 유지한다.

## TDD 계획

각 테스트를 구현 전에 쓰고 실행해 red를 확인한 뒤 구현한다. 실패 메시지 한 줄을 커밋 보고에 남긴다.

### 항목 1 (커밋 1)

새 파일 `apps/desktop/src/imageCaretStation.test.tsx` (`appApiFixture` + `imageStructuralIntegration.test.tsx`의 `imageBoot` 패턴 재사용):

1. `"ArrowDown from the bullet above stops on the image caret station"` — First thought textarea에 focus 후 ArrowDown, `document.activeElement`가 `.notes-image-caret-stop`이고 `data-node-id="image"`인지 단언. **red 이유**: 정거장 엘리먼트가 없어서 포커스가 루트 div(`.notes-image-node-content`)에 앉는다 — classList 단언 실패.
2. `"ArrowDown from the station lands on the row below, ArrowUp goes back above"` — 정거장에 keyDown ArrowDown → Second thought에 focus, 다시 ArrowUp 두 번 → First thought. **red 이유**: `querySelector(".notes-image-caret-stop")`가 null이라 테스트가 시작부터 실패.
3. `"Enter at the station creates a bullet below the image"` — 정거장에 keyDown Enter → `notesApi.execute`가 `kind: "createNode"`(parent `page-1`, 이미지 다음 위치)로 불렸는지 단언. **red 이유**: 정거장이 없어 keyDown을 보낼 대상 조회가 실패.
4. `"clicking the margin right of the image parks the caret at the station"` — `.notes-image-frame-row`에 `fireEvent.click`(target = 래퍼 자신) → 정거장에 focus. **red 이유**: 래퍼도 정거장도 아직 없다.

새 파일 `apps/desktop/src/imageNodeStyles.test.ts` (`src/test/cssRules.ts`로 옮긴 `rule()` 사용):

5. `"blinks the caret bar on focus with the accent color"` — `rule(notesStyles, ".notes-image-caret-stop:focus")`에 `background: var(--accent);`와 `animation: notes-image-caret-blink`가 있는지, `rule(notesStyles, ".notes-image-caret-stop:focus-visible")`에 `outline: 0;`이 있는지. **red 이유**: 규칙이 없어 `rule()`이 `missing rule` 에러를 던진다.
6. `"keeps the caret bar still under reduced motion"` — notes.css 원문이 reduced-motion 블록 안에서 `.notes-image-caret-stop`을 언급하는지 정규식으로 단언. **red 이유**: 해당 문자열이 파일에 없다.

기존 `outlineFocus.test.ts:137`(이미지 필드 div focus 계약)과 `outlineCaretDestination.test.tsx`(이미지 행 건너뛰기)는 무변경으로 계속 green이어야 한다.

### 항목 4 (커밋 2)

`imageNodeStyles.test.ts`에 추가:

1. `"shows the node-selected outline on focus-visible"` — `rule(notesStyles, ".notes-image-node-content:focus-visible")`에 `outline: 2px solid var(--accent);`와 `outline-offset: 2px;`가 있는지. **red 이유**: 지금 그 블록의 내용은 `outline: 0;`이라 toContain이 실패.

### 항목 2 (커밋 3)

`ImageNodeContent.test.tsx`에 추가:

1. `"marks the handle while a pointer resize is in flight"` — pointerDown 후 핸들에 `data-resizing="true"`, pointerUp 후 속성 제거를 단언. **red 이유**: 속성을 다는 코드가 없어 첫 단언부터 실패.

`imageNodeStyles.test.ts`에 추가:

2. `"hides the resize line until hover, drag, or handle focus"` — `rule(notesStyles, ".notes-image-resize-line")`에 `opacity: 0;`, `width: 3pt;`, `color-mix(in srgb, var(--text-1) 40%, transparent)`, `transition: opacity 120ms ease;`가 있는지, 그리고 표시 셀렉터 3종(`:hover`/`:focus-visible`/`[data-resizing]`) 원문 존재를 단언. **red 이유**: 규칙이 없어 `missing rule` 에러.
3. `"keeps the resize line fade off under reduced motion"` — reduced-motion 블록에 `.notes-image-resize-line` 언급 단언. **red 이유**: 문자열 부재.

### 항목 3 (커밋 4)

`ImageLightbox.test.tsx`에 추가·수정:

1. `"shows the file name and pixel size above the image"` — `screen.getByText("cat.png")`(바의 이름 span)과 `getByText("640 × 480")` 단언. **red 이유**: 이름은 img의 alt 속성으로만 존재해 getByText가 못 찾는다.
2. `"pans the scroll area by pointer drag and stays open afterwards"` — `.notes-image-lightbox-scroll`에 pointerDown(200,200) → pointerMove(140,160) 후 `scrollLeft === 60`, `scrollTop === 40`, 드래그 중 `data-panning` 존재, pointerUp 후 click을 보내도 `onClose` 미호출 단언. **red 이유**: 스크롤 컨테이너가 없어 querySelector가 null.
3. `"still closes on a clean backdrop click"` — pointerDown/Up만(이동 0) 하고 스크롤 컨테이너 자신을 click → `onClose` 1회. **red 이유**: 동일하게 컨테이너 부재.
4. 기존 `"closes from the backdrop but not an image click"`의 클릭 대상을 `.notes-image-lightbox`에서 `.notes-image-lightbox-scroll`로 수정한다(닫기 핸들러가 스크롤 컨테이너로 이동하므로). 동작 계약은 동일하다.

`imageNodeStyles.test.ts`에 추가:

5. `"lets the lightbox image render at natural size"` — `rule(notesStyles, ".notes-image-lightbox-image")`에 `max-width: none;`과 `margin: auto;`가 있는지. **red 이유**: 지금은 `max-width: 100%`라 toContain 실패.

기존 라이트박스 테스트 중 Esc·포커스 반환·이미지 클릭 비닫힘은 무변경 green 유지가 회귀 기준이다.

## 회귀 위험과 완화책

1. **`data-outline-field="image"` 이동이 아웃라인 포커스 경로를 바꾼다** — 가장 큰 위험. `editorById`를 쓰는 모든 경로(방향키, 이미지 붙여넣기 직후 focus, 헤더로 zoom한 이미지의 ArrowUp 착지)가 루트 div 대신 정거장에 앉게 된다. 완화: `outlineFocus.test.ts:137`이 계약을 그대로 검증하고, `outlineCaretDestination.test.tsx`·`imageStructuralIntegration.test.tsx` 전체 green을 게이트로 삼는다. `capturePane`(`appNavigation.ts:48`)과 언두 가드(`App.tsx:111`)는 textarea만 봐서 영향이 없음을 조사로 확인했다.
2. **`.notes-node :focus-visible` 일반 링이 정거장에 겹친다** — `.notes-image-caret-stop:focus-visible { outline: 0 }`을 2779줄보다 뒤에 두어 같은 특이도(0,2,0)의 후행 규칙으로 이긴다(클래스 단독 규칙은 특이도가 낮아 못 이긴다). CSS 계약 테스트가 규칙 존재를 고정한다.
3. **OutlineHeader의 이미지(zoom 표면, `OutlineHeader.tsx:269`)에도 정거장이 생긴다** — 헤더 쪽은 `onKeyDown`이 없어 정거장에서 키가 동작하지 않지만, 지금도 루트 div 포커스에서 아무 키도 동작하지 않으므로 동작 저하가 아니다. ArrowUp으로 헤더에 닿을 때 커서 바가 보이게 되는 것은 개선 쪽 변화다.
4. **flex 래퍼가 프레임 폭 계산을 흔들 수 있다** — 프레임은 `width: previewWidth; maxWidth: 100%` 인라인 스타일을 유지하고 정거장은 `flex: none`이라 셈에 거의 안 낀다(2px + 6px 마진만큼 최대 폭이 줄 수 있는데 여유 범위). 기존 리사이즈 테스트 4종이 green이면 통과.
5. **라이트박스 구조 변경으로 배경 클릭 닫기가 깨질 수 있다** — 닫기 판정을 스크롤 컨테이너로 옮기면서 기존 테스트 1건을 수정한다. 드래그 후 닫힘 방지는 새 테스트 2가 고정한다. Esc·트랩·반환 테스트는 무변경 green.
6. **jsdom의 CSS 한계** — hover/focus 시각 규칙은 jsdom에서 검증 불가라 CSS 계약 테스트(파일 원문 단언)로 대체한다. 이미 `notesCaret.test.ts`가 쓰는 방식이라 새 관례가 아니다.
7. **pointer capture 부재(jsdom)** — `setPointerCapture?.()` 옵셔널 호출 관례(`ImageNodeContent.tsx:260`)를 그대로 따른다.

## 검증 게이트

각 커밋마다 리포 루트에서:

```
npm run test:v2:frontend
npm run lint:v2
npx tsc -p apps/desktop/tsconfig.json --noEmit
```

마지막 커밋 후 세 게이트 전부 green + 기존 이미지·캐럿 테스트(`ImageNodeContent.test.tsx`, `ImageLightbox.test.tsx`, `outlineCaretDestination.test.tsx`, `imageStructuralIntegration.test.tsx`, `outlineFocus.test.ts`) 무변경 통과를 확인한다.
