# Outline 애니메이션 정련 — 상세 작업 설계 (bb16e1a 후속)

- 작성: 2026-07-22 (Fable). 구현: Opus 4.8. 리뷰 게이트: 웨이브별 Fable 적대 리뷰.
- 대상 코드: `src/features/notes/outlineLayoutMotion.ts`, `useOutlineLayoutMotion.ts`(+각 테스트), 필요 시 `notes.css`, `NotesOutlinePane.tsx` 최소.
- 배경: bb16e1a의 FLIP 애니메이션 적대 리뷰 결과 — 수정 3건(M1~M3) + 폴리시 5건(P1~P5). 리뷰 finding 5(조합 상태 중복)·6(cancel 스냅)은 무동작 결함이라 **의도적 제외**.

## TDD 규율 (필수 — 전 웨이브 공통)
- 항목마다 **테스트 먼저**: 설계 명시 테스트를 작성 → 실행해 red 확인(실패 assertion 라인 기록) → 구현 → green. red 증거는 웨이브 보고에 항목별로 포함한다.
- red가 나오지 않는 테스트(구현 없이도 통과)는 결함을 안 잡는 테스트 — 재작성.
- 테스트+구현은 항목당 1커밋에 함께.

## 커밋 규율 (필수)
- **항목당 정확히 1커밋**, 아래 커밋 메시지 제목 그대로 사용. 나중에 항목 단위로 `git revert` 가능해야 함 — 항목 간 같은 줄 수정을 피하도록 상수/분기/함수를 항목별로 분리해 작성.
- 순서 고정: M1 → M2 → M3 → P4 → P2 → P1 → P3 → P5. (정확성 기반 먼저, 리스크 큰 것 마지막.)
- 각 커밋은 자체 테스트 포함, 커밋 시점마다 `npx vitest run src/features/notes/outlineLayoutMotion.test.ts src/features/notes/useOutlineLayoutMotion.test.tsx` green.
- 작업 브랜치: `outline-motion-refinement` (전용 worktree — 메인 워킹트리는 다른 세션이 사용 중이라 접근 금지).

## Wave 1 — 정확성 수정

### M1. 스크롤 불변 좌표 — `fix(notes): make outline motion rects scroll-invariant`
- 문제: rect가 viewport 기준이라 스크롤 후 첫 구조 변경에서 전체 행이 스크롤량만큼 가짜 슬라이드.
- 설계: `motionRect(element, origin)` — origin = root(`<ol>`)의 `getBoundingClientRect()` left/top. `captureOutlineMotionRects(root)`/`collectOutlineMotionTargets(root, before)`가 origin을 한 번 계산해 빼고 저장. 델타 계산은 무변경(양변 상쇄).
- 테스트: 동일 레이아웃 + root/행 rect를 동시에 +200px 이동(스크롤 모사) → 델타 0, 애니메이션 0건.

### M2. 부패 baseline 방어 — `fix(notes): clamp stale outline motion deltas and rebaseline after resize`
- 문제 2개: (a) 렌더 없는 reflow(행 높이 성장·이미지 로드) 후 첫 구조 변경에서 비정상 델타. (b) 리사이즈 종료 후 재캡처 없음.
- 설계:
  - (a) `animateOutlineMotion`에서 이동 대상의 `|delta.y| > clampLimitY` 또는 `|delta.x| > clampLimitX` 시 그 행만 애니메이션 생략(텔레포트). 한계값은 옵션으로 주입: `clampLimit: { x: window.innerWidth, y: window.innerHeight }` — **root(`<ol>`)의 client 치수 금지**: ol은 콘텐츠 전체 높이라 긴 아웃라인에서 클램프가 영원히 발동하지 않음(1차 리뷰 적발). 뷰포트 경계는 부패 방어 겸 "한 화면을 넘는 이동은 텔레포트가 더 읽기 좋다"는 모션 원칙도 충족. 축 한계 ≤ 0이면 그 축 클램프 비활성(jsdom 가드). 진입 행에는 미적용.
  - (b) 리사이즈 rAF 정리 콜백(`clearResizeState`)에서 baseline 재캡처: root 존재+행수 상한 내이면 `priorRectsRef = capture(...)`, `hasMotionBaselineRef = true`. 기존 effect 구조 유지, 콜백만 추가.
- 테스트: (a) 한 행에 root 높이 초과 델타 주입 → 그 행만 생략, 다른 행은 애니메이션. (b) resize 발화 → rAF 후 캡처 함수 재호출됨(스파이).

### M3. 장면 전환 감지 — `fix(notes): treat mass-enter outline changes as scene changes`
- 문제: zoom 등으로 대부분 행이 진입이면 최대 120행 동시 fade → 깜빡임.
- 설계: 대상 수집 후 `enteringCount / targets.length >= 0.5 && targets.length >= 8` 이면 애니메이션 전부 생략(baseline은 정상 갱신). 상수 `SCENE_CHANGE_ENTER_RATIO = 0.5`, `SCENE_CHANGE_MIN_ROWS = 8` — `outlineLayoutMotion.ts`에 export(테스트용).
- 테스트: 10행 중 6행 진입 → 0건. 10행 중 4행 진입 → 진입 애니메이션 실행. 6행 중 4행 진입(소규모) → 실행.

## Wave 2 — 폴리시

### P4. easing 분리 + 스프링 — `feat(notes): spring easing for outline motion`
- 이동: `linear()` 스프링 근사 상수 `OUTLINE_MOTION_SPRING_EASING`(제공값 사용, 아래) + 지원 감지 `supportsLinearEasing()` (`CSS.supports("animation-timing-function", "linear(0, 1)")`, 예외 시 false) → 미지원이면 기존 `cubic-bezier(0.2, 0, 0, 1)` 폴백. 감지는 모듈 로드 시 1회 lazy 캐시.
- 진입: `cubic-bezier(0, 0, 0.2, 1)` (decelerate) — 이동 커브와 분리.
- 스프링 상수(질량1·강성170·감쇠26 근사, 오버슈트 ~1.3%):
  `linear(0, 0.3407, 0.7371, 0.9823, 1.0868, 1.1046, 1.0796, 1.0417, 1.0093, 0.9888, 0.9793, 0.9772, 0.9791, 0.9825, 0.9858, 0.9885, 0.9905, 0.9928, 0.9959, 1)`
  duration은 이동 220ms로 상향(스프링은 감속 꼬리가 길어야 자연스러움), 진입/증감 180ms 유지. 폴백 경로는 기존 140/180 유지.
- 테스트: 지원 시 이동 easing이 스프링 문자열, 미지원 모킹 시 cubic-bezier 폴백. 진입 easing 분리 확인.

### P2. 스태거 — `feat(notes): stagger outline motion cascades`
- 설계: 애니메이션 대상(생략분 제외)을 `after.top` 오름차순 정렬 후 `delay = min(order * 8, 80)`ms. **진입 행은 `fill: "backwards"` 필수**(지연 중 opacity 0 유지 — 없으면 지연 동안 완성 상태로 번쩍임). 이동 행은 fill 불필요(지연 중 델타 위치? 아님 — 이동 행도 delay 중엔 최종 위치에 보였다가 뒤늦게 되돌아가면 어색함 → 이동 행에도 `fill: "backwards"` 적용해 지연 중 시작 keyframe(이전 위치) 고정).
- 대상 2건 이하이면 스태거 생략(delay 0).
- 테스트: 5행 이동 → delay 0,8,16,24,32 & fill backwards. 2행 → delay 0.

### P1. 부모에서 unfold — `feat(notes): unfold entering outline rows from their parent`
- 설계: 진입 행의 시작 y-offset을 `-4px` 대신 `clamp(parentAfterTop - ownAfterTop, -160, 0)px`로. 부모 = rows 배열에서 해당 행보다 앞이며 depth가 정확히 1 작은 가장 가까운 행(hook이 rows로 부모 id 맵 계산해 target에 `parentId` 전달; 화면에 부모가 없거나(루트 진입) 부모 자체도 진입 중이면 `-4px` 폴백).
- x는 0 유지(수평 이탈 금지). opacity 0→1 동일.
- 테스트: 부모 아래 진입 → 시작 offset = 부모y−자기y(클램프 확인 포함). 루트 진입/부모 부재 → -4px 폴백. 부모도 진입 중 → -4px.

### P3. 이동 주체 lift — `feat(notes): lift moved outline rows above the flow`
- 주체 판정: 이전/현재 서명의 **공통 id 시퀀스**에 LCS(O(n²), n≤120) — LCS에 속하지 않은 공통 id = "이동 주체". `outlineLayoutMotion.ts`에 순수함수 `identifyMovedRowIds(beforeIds, afterIds): ReadonlySet<string>` 신설 + 단독 테스트.
- 표현: 주체 행에 클래스 `notes-outline-item--motion-lift`를 애니메이션 시작 시 부여, `finished`/cancel 시 제거(retain 경로에 정리 연결). CSS(notes.css):
  ```css
  .notes-outline-item--motion-lift { position: relative; z-index: 3; }
  .notes-outline-item--motion-lift .notes-node { box-shadow: 0 6px 16px rgba(15, 23, 42, 0.14); transition: box-shadow 120ms ease-out; }
  @media (prefers-color-scheme: dark) { .notes-outline-item--motion-lift .notes-node { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45); } }
  ```
  (앱이 자체 테마 클래스를 쓰면 해당 셀렉터 관례를 따를 것 — notes.css 기존 다크 처리 방식 확인 후 동일하게.)
- 테스트: LCS 함수 케이스(단순 이동/블록 이동/무이동/전부 교체), 클래스 부여·해제(finished mock).

## Wave 3 — 퇴장 (최고 리스크, 마지막)

### P5. collapse fade-out — `feat(notes): fade out collapsing outline rows`
- 목표: 접힘 시 자식이 즉시 증발하지 않고 ~90ms fade-out 후 제거. 펼침(unfold)과 대칭.
- 설계(조사 후 구현): `NotesOutlinePane`의 `bodyRows` 렌더를 얇은 훅 `useOutlineExitRows(bodyRows)`로 래핑 — 직전 렌더 대비 사라진 행을 **직전 렌더의 row 객체 스냅샷 그대로** 최대 90ms 유지, `data-outline-exiting="true"` 부여(CSS: opacity 0 전이, pointer-events none, aria-hidden). 90ms 후 상태 정리로 실제 제거. FLIP hook은 exiting 행을 대상에서 제외(`data-outline-exiting` 셀렉터 제외).
- **안전 조건(위반 시 축소 구현)**: row 객체가 렌더에 필요한 데이터를 자체 보유하지 않고 workspace 조회에 의존한다면, **삭제된 노드의 stale 렌더는 crash 위험** — 그 경우 collapse로 인한 소멸(노드 데이터 잔존)만 exit 적용하고 삭제/이동 소멸은 즉시 제거 유지. 판별이 렌더 경로에서 불가능하면 P5 전체를 "구현 불가, 사유" 보고로 종료해도 됨 — 억지 구현 금지.
- exiting 행 위 사용자 입력·포커스 문제 금지(pointer-events none + 포커스 이동 없음 확인).
- 테스트: collapse 모사(행 제거) → 한 사이클 유지+exiting 마킹 → 타이머 후 제거. 삭제 케이스 crash 없음.

## 게이트 (웨이브별)
```
npx tsc --noEmit && npm run lint && npm run test:architecture && npx vitest run
```
- 신규 테스트에 `toHaveBeenNthCalledWith`/`invocationCallOrder`/`mock.calls[` 금지 (order-observation 예산 283/283 만석).
- `NotesOutlinePane.tsx` 수정은 최소(훅 호출·클래스 연결·li 속성 수준). budget 파일들(notesWorkspaceRuntime 등) 수정 금지.
- reduced-motion 경로는 모든 항목에서 기존처럼 완전 무동작이어야 함(스태거·lift·exit 포함).
