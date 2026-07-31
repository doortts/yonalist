# Monaco 권위형 아웃라이너 실험 보고서

이 문서는 `codex/monaco-outline-spike` 브랜치에서 진행한 전체 블릿
페이지 Monaco 전환 결과를 기록한다. 비교 기준은 React 아웃라이너를
사용한 `codex/yonalist-v2-core@c693979`이다.

## 결론

텍스트 전용 페이지에서는 Monaco 모델을 편집 세션의 단일 권위로
사용하도록 전환했다. 한 블릿마다 에디터를 만들지 않으며, 한 페이지에
하나의 canonical `ITextModel`을 만들고 분할 뷰의 두 에디터가 이를
공유한다.

이 구조는 다음 문제를 제거한다.

- React store 갱신 뒤 Monaco 전체 텍스트를 다시 투영하지 않는다.
- Enter, Backspace, Delete, 좌우·상하 커서 이동, 같은 줄 편집과
  Undo/Redo는 Monaco의 기본 편집 경로를 사용한다.
- 블릿 문자는 모델 텍스트가 아니라 injected decoration이므로 검색,
  선택, 복사 결과에 섞이지 않는다.
- 모델 변경을 안정적인 node ID 메타데이터와 저장 명령으로 변환하고,
  SQLite에는 300ms coalescing 또는 구조 변경 직후 원자적으로 저장한다.
- 두 분할 뷰는 같은 모델을 공유하지만 줌, 접힘, 완료 항목 표시와
  scroll/view state는 pane-local로 유지한다.

이미지, 첨부 메모 등 Monaco 텍스트 모델로 안전하게 표현할 수 없는
페이지는 기존 React 아웃라이너로 명시적으로 fallback한다. 서로 다른
두 편집 권위가 같은 페이지를 동시에 수정하는 구조는 허용하지 않는다.

## 구현 구조

| 계층 | 책임 |
|---|---|
| `MonacoOutlineSession` | canonical 모델, node 메타데이터, 저장 큐, native Undo/Redo |
| `OutlineMetadataTimeline` | 모델 버전별 line↔node ID, depth, 상태 복원 |
| structural change interpreter | Monaco edit를 생성·텍스트 수정·삭제·이동 명령으로 변환 |
| persistence queue | 텍스트 coalescing, 구조 즉시 저장, 동일 request ID 재시도 |
| editor contribution | Tab/Shift+Tab과 구조 경계만 확장하고 나머지는 Monaco 기본 동작 유지 |
| pane adapter | 분할 뷰별 hidden area, 줌, 완료/접힘 표시, view state |
| session registry | 페이지당 한 모델, 참조 수명, 마지막 pane 종료 시 flush |

구형 projection/controller/reconciliation/caret/keyboard 계층은 삭제했다.
React 컴포넌트는 세션을 임대하고 Monaco editor 및 pane adapter 수명만
관리한다.

## 동작 검증

자동 테스트는 다음을 확인한다.

- 글자 중간 Enter가 앞/뒤 텍스트를 정확히 분리하고 새 node ID를 만든다.
- Enter 20회 후 Backspace 20회를 연속 적용해도 줄과 메타데이터가
  한 줄로 정확히 돌아온다.
- 연속 한글 텍스트 입력은 300ms 뒤 한 저장 명령으로 합쳐진다.
- 블릿 decoration은 모델 검색 및 복사 텍스트에 포함되지 않는다.
- Tab/Shift+Tab 메타데이터 변경도 Monaco native Undo/Redo로 복원된다.
- 분할 뷰는 같은 모델 URI를 공유하며 한 pane의 편집과 Undo가 같은
  turn에 다른 pane에 반영된다.
- 블릿 클릭은 같은 pane의 서브 페이지로 이동하고 Shift+클릭은
  secondary pane을 연다.
- 서브 페이지 제목으로 표시한 root 블릿은 본문에서 다시 중복 표시하지
  않는다.
- 줌된 제목도 React draft가 아니라 같은 canonical Monaco model을
  수정하므로 두 pane 사이에 별도 편집 권위가 생기지 않는다.
- 자식이 없는 서브 페이지의 제목에서 Enter를 누르면 session-owned
  첫 자식이 원자적으로 생성되고 Monaco caret이 그 빈 블릿으로 이동한다.

2026-07-31 실제 개발 미리보기에서도 다음을 확인했다.

- Enter, 텍스트 편집, native Undo, reload 복원
- 블릿 클릭 줌 및 뒤로가기
- Shift+블릿 클릭으로 분할 뷰 열기
- 두 pane의 즉시 동기화와 공유 Undo
- 빈 서브 페이지에서 제목과 root 블릿의 중복 제거
- `Press Enter to add another thought.` placeholder가 표시되지 않음

## 빠른 성능 표본

### 5,000개 노드 모델

실제 `ITextModel`과 메타데이터 timeline을 사용하는 deterministic
테스트에서 5,000개 노드에 다음 작업을 수행했다.

| 작업 | 결과 |
|---|---:|
| 같은 줄 텍스트 수정 | 200회 |
| 중간 줄 분할 | 100회 |
| 최종 모델 줄 수 | 5,100 |
| 전체 모델 교체 | 0회 |
| 한 edit에서 decoration 재계산한 최대 줄 | 3줄 |
| 해당 테스트 실행 시간 | 약 1.7초 |

이 테스트는 300번의 편집에 대해 전체 텍스트 재생성이나 `setValue`가
없음을 보장한다. 다만 standalone editor, keyboard pipeline, layout,
paint를 거치지 않고 `ITextModel`에 직접 edit를 적용하는 core 회귀
테스트다. 테스트 시간에는 Windows 개발 환경의 Monaco 모듈 로딩과
renderer 비용이 포함되지 않는다.

### 실제 미리보기 입력

개발 전용 probe로 Monaco의 50회 연속 좌측 커서 이동을 표본 추출했다.
측정값은 키 이벤트부터 다음 animation frame까지의 시간이다.

| 지표 | 결과 |
|---|---:|
| p50 | 약 0.6ms |
| p95 | 약 15.3ms |
| 50ms 이상 long task | 0회 |
| 전체 모델 교체 | 0회 |

이 값은 현재 Windows 개발 장비의 빠른 표본이며 정식 장비군 벤치마크나
콜드 스타트 수치는 아니다. 1개 노드 페이지에서 cursor pipeline을
표본 추출한 값이며, 5,000개 노드 renderer·scroll·memory·secondary
pane p95 승인 근거는 아직 아니다. 반복 가능한 deterministic core
테스트와 실제 renderer 표본을 함께 사용해 퇴행을 감시한다. 계측
모듈은 개발 서버의 virtual module에서만 연결되며 production asset과
loader graph에는 포함되지 않는다.

## 번들 비교

Production Vite build 기준이다.

| Asset | React 기준 | 권위형 Monaco |
|---|---:|---:|
| query-free 초기 editable JS | 295.93KB raw / 89.99KB gzip | 288.7KB raw / 88.0KB gzip |
| Monaco lazy JS | 없음 | 2,519.05KB raw / 646.00KB gzip |
| Monaco CSS | 없음 | 74.22KB raw / 11.68KB gzip |
| editor worker | 없음 | 281.29KB raw |
| 개발 성능 probe | 없음 | production graph에 없음 |

초기 editable graph는 300KB raw / 90KB gzip 예산 검사를 통과한다.
Monaco와 worker는 텍스트 아웃라이너를 실제로 열 때만 로드된다.
React fallback row와 내보내기 UI도 실제 사용 시점에 지연 로드된다.
따라서 shell 초기 실행 비용은 거의 유지되지만, 첫 Monaco 진입에는
큰 lazy chunk의 다운로드·parse·메모리 비용이 추가된다.

## 현재 React 아웃라이너와의 차이

| 영역 | React 아웃라이너 | Monaco 권위형 텍스트 페이지 |
|---|---|---|
| 편집 권위 | store draft와 row textarea | 한 페이지의 canonical Monaco model |
| 렌더링 | visible node별 React row | Monaco 가상화 line renderer |
| Enter/Backspace/커서 | 제품 key handler | Monaco native 편집 |
| Undo/Redo | Yonalist interaction history | 텍스트·구조는 Monaco native stack |
| 분할 뷰 | pane별 row tree | 두 editor가 같은 모델을 공유 |
| 줌 | zoom root 아래 React row만 표시 | hidden area로 같은 모델의 subtree만 표시 |
| 블릿 | 제품 DOM | 모델 밖 injected decoration |
| 이미지·첨부 메모 | 지원 | 해당 페이지 전체를 React로 fallback |
| 멀티 블릿 선택·이동 | 지원 | 아직 React fallback 경로에서만 지원 |
| cross-pane drag/drop | 지원 | 아직 React fallback 경로에서만 지원 |
| 접근성 DOM | list/row semantics | Monaco code editor semantics |
| 초기 번들 | 작은 custom editor | shell은 유사, 첫 편집 때 Monaco lazy 비용 |

바깥 shell, 레이아웃 수치, 글꼴, 색, 제목과 블릿 간격은 기존 CSS
토큰을 유지했고 본문 font/line-height도 React row와 같은 16px/25px로
맞췄다. 다만 caret, selection, IME 보조 DOM과 줄 wrapping은 Monaco
renderer가 소유하므로 내부 DOM까지 React 버전과 동일하지는 않다.

## 후속 판단

텍스트 편집의 지연과 상태 경합을 줄이는 목적에는 권위형 Monaco 구조가
유효하다. 다음 우선순위는 Monaco 안에 별도 가짜 편집 권위를 만들지
않는 조건으로 멀티 블릿 선택·이동과 cross-pane drag/drop을 editor
contribution으로 확장하는 것이다.

5,000개 노드 실제 renderer p95와 격리된 Tauri IME/close-failure 수동
증명은 이번 빠른 완료 범위에서 남은 승인 증거다. 위 수치만으로 해당
승인 조건을 충족했다고 해석하지 않는다.

이미지 노드는 Monaco model line으로 억지로 직렬화하지 않는다. overlay
widget과 view zone으로 제품 수준 편집 경험을 만들 수 있을 때까지는
페이지 단위 React fallback이 더 안전하다.
