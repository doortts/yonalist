# 균일 커서: 스트럿 글꼴 설계 (2026-08-12)

## 배경

블릿이 줄바꿈되면 둘째 줄 커서가 첫 줄보다 크다(WebKit이 둘째 줄 선택 높이를 앞 줄 바닥까지 확장하고, 커서가 그 높이를 물려받음). 사용자 결정: 커서 높이 통일이 우선. 앞서 시도한 line-height 축소(970c81af)는 줄 간격이 좁아져 revert됨(86a8db49). 이번에는 **줄 간격을 유지한 채** 커서를 통일한다.

## 원리

커서 높이 = 그 줄의 콘텐츠 영역(글자 상자) 높이. 글자 상자가 줄 상자(line-height)와 같아지면 leading이 0이 되어 첫 줄·둘째 줄 커서가 똑같이 25px가 되고, 선택 영역도 줄 사이 틈 없이 이어진다. 글자 상자는 폰트 파일의 ascent+descent 메트릭에서 나온다.

CSS `ascent-override`는 WebKit 미지원(caniuse 확인, 2026-08). 대신 **메트릭 전용 스트럿 글꼴**을 쓴다: 글리프는 공백(U+0020) 하나뿐이고 ascent+descent = 156.25% em(16px 기준 25px)인 초소형 폰트를 fontBuilder로 처음부터 생성해(라이선스 이슈 없음) 필드 글꼴 스택 맨 앞에 둔다. CSS Fonts 스펙의 "first available font" 규칙에 따라 줄의 스트럿(기준 메트릭)은 첫 폰트에서 오고, 실제 글자는 다음 폰트(Inter/시스템/한글 폴백)가 지금처럼 그린다.

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | 16px 블릿 행에서 줄바꿈 여부와 무관하게 커서 높이 25px 균일. 줄 간격·행 높이·글자 렌더링은 현재와 동일 |
| 비대상 | 마크다운 제목 행(H1–H3), 페이지 제목, 노트 필드 — line-height 비율이 달라 스트럿 비율 하나로 못 덮음. 현행 유지, 후속 판단 |
| 경계 | 프론트엔드만(글꼴 자산 + CSS). Rust/IPC 없음 |
| 수동 증명 | 프리뷰: 줄바꿈 블릿에서 두 줄 커서 높이 측정 + 두 줄 드래그 선택 연속성 + 글자 위치 이동 없음. 데스크톱 앱(WebKit) 확인은 사용자 육안 확인 1회 |

## 완료 조건

1. 자산 `apps/desktop/src/assets/yonalist-caret-strut.woff2`(공백 1글리프) + 생성 스크립트 `scripts/buildCaretStrutFont.py`(fonttools, venv 사용법 주석 포함) 커밋. 재실행하면 같은 자산이 재생성된다.
2. `@font-face { font-family: "Yonalist Caret Strut" }` 등록, `.notes-node-title-field`(과 그 textarea/token 상속 경로)의 font-family 맨 앞에 추가. `[data-markdown-level]` 변형은 기존 스택으로 되돌린다(제목 행 제외).
3. 실측(프리뷰, 16px 행): 줄바꿈 블릿의 줄 상자 간격 25px, 각 줄 콘텐츠 상자 25px(±0.5), 즉 커서 차이 0. 한 줄 블릿 높이 28px 불변, 두 줄 블릿 높이 불변.
4. 글자 기준선 이동 |Δ| ≤ 1px (before/after 글리프 rect 비교). ascent/descent 분배로 튜닝: ascent ≈ 현재 half-leading(3px)+현재 ascent, descent = 25px − ascent (em 단위 환산).
5. 공백 폭 보존: 스트럿 폰트의 space advance를 현재 렌더링 폰트의 space 폭에 맞춘다(실측 후 결정). before/after 같은 문장의 줄바꿈 지점이 동일.
6. 표시 레이어와 textarea의 rect 동일(레이어 기하 계약) — 둘 다 같은 스택을 쓰므로 자동이나 실측으로 확인.
7. 폰트 로드 실패 시 현재 동작으로 자연 폴백(스트럿만 사라짐, 렌더링 무변화).
8. 게이트: `npm run test:v2:frontend`, `lint:v2`, `v2:build`(자산 포함 빌드), `git diff --check`.
9. 회귀 가드: notesCaret.test.ts에 @font-face 존재·필드 스택 첫 항목·markdown-level 제외를 소스 단정으로 추가.

## 리스크

- **WebKit 스트럿 해석**: 스펙상 first available font가 스트럿을 정하지만, 커서 rect가 이를 따르는지는 데스크톱 앱에서 최종 확인 필요. Chromium 프리뷰로 레이아웃은 검증되며, WebKit이 다르게 나오면 커밋 1개 revert로 원복.
- **공백 글리프 강탈**: U+0020은 스트럿 폰트가 그리므로 advance 불일치 시 줄바꿈 지점이 미세 이동. 완료 조건 5로 통제.
- **IME**: 조합 문자는 폴백 폰트가 그리므로 무관. 조합 중 커서는 엔진 소관 그대로.

## 실행

Opus 5 xHigh 단일 에이전트, 1커밋(`feat(desktop)`), TDD(9번 가드 red 먼저). 스파이크 우선: 폰트 생성 → 프리뷰에서 스트럿 동작(상자 25) 확인 후 나머지 진행. Fable 적대 리뷰 후 게이트.
