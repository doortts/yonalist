# 시작·Notes 활성화 성능 기준선

## 목적

Notes 런타임을 코드 분할하기 전과 후를 같은 계측 경계로 비교하기 위한 기준선이다.
시작 시간은 `renderer_entry`부터 `app_mounted`까지, 기능 활성화 시간은 사용자가
기능을 선택한 순간의 `feature_activation_start`부터 pane이 그려진 다음 animation
frame의 `feature_activation_visible`까지다.

## 산출물과 격리 조건

| 항목 | 값 |
| --- | --- |
| 측정일 | 2026-07-19 (Asia/Seoul) |
| 소스 커밋 | `03ac7e4b9519e154388dfbbe20bc9929c92b5b7b` |
| 빌드 | `VITE_YONALIST_PERF=1 npm run tauri:build -- --config '{"productName":"YonalistPerf","identifier":"com.doortts.yonalist.perf"}' --bundles app` |
| 앱 | `src-tauri/target/release/bundle/macos/YonalistPerf.app` |
| 실행 파일 SHA-256 | `095087a0a87402fcdaafa9ecbf6fc2e69c26a7b22fe207fd838848a9decbac82` |
| 운영체제·CPU | macOS 26.5.1 (25F80), arm64 |
| Node·npm | Node 26.4.0, npm 11.17.0 |
| 앱 식별자 | `com.doortts.yonalist.perf` |
| Vault | `/tmp/yonalist-perf-vault.UZuXPS` |
| 시작 기능 | GitHub Inbox |

별도 앱 식별자와 빈 임시 Vault를 사용했다. 기존 Yonalist 앱 설정과 사용자 Vault는
측정 대상에서 제외했다. 매 표본은 앱을 완전히 종료한 뒤 새 프로세스로 실행했다.
각 실행에서 Notes 선택, Inbox 복귀, Notes 재선택을 같은 순서로 수행했다.

## 20회 원자료

단위는 밀리초다. 브라우저의 부동소수점 timestamp는 표에서 소수 첫째 자리까지
정규화했으며 통계값에는 동일한 원자료를 사용했다.

| 실행 | 시작 | 첫 Notes | Notes 재진입 |
| ---: | ---: | ---: | ---: |
| 1 | 151.0 | 13.0 | 8.0 |
| 2 | 149.0 | 12.0 | 8.0 |
| 3 | 142.0 | 12.0 | 8.0 |
| 4 | 155.0 | 11.0 | 8.0 |
| 5 | 67.0 | 12.0 | 8.0 |
| 6 | 159.0 | 12.0 | 8.0 |
| 7 | 154.0 | 12.0 | 9.0 |
| 8 | 151.0 | 11.0 | 10.0 |
| 9 | 152.0 | 11.0 | 8.0 |
| 10 | 161.0 | 11.0 | 8.0 |
| 11 | 151.0 | 12.0 | 8.0 |
| 12 | 153.0 | 12.0 | 8.0 |
| 13 | 152.0 | 12.0 | 8.0 |
| 14 | 150.0 | 12.0 | 8.0 |
| 15 | 151.0 | 12.0 | 8.0 |
| 16 | 159.0 | 11.0 | 8.0 |
| 17 | 142.0 | 11.0 | 9.0 |
| 18 | 150.0 | 12.0 | 7.0 |
| 19 | 148.0 | 13.0 | 9.0 |
| 20 | 137.0 | 11.0 | 8.0 |

실행 5의 `67.0 ms`를 포함해 유효 프로토콜에서 나온 값을 하나도 제외하지 않았다.

## 통계와 변경 후 통과선

표본 수는 각 20개다. p50은 정렬된 10번째와 11번째 값의 평균, p95는
nearest-rank 방식의 19번째 값으로 계산했다.

| 지표 | 평균 | p50 | p95 | 변경 후 필수 조건 |
| --- | ---: | ---: | ---: | --- |
| `renderer_entry → app_mounted` | 146.70 | 151.0 | 159.0 | p50 `≤128.35`, p95 `≤159.0` |
| 첫 Notes 활성화 | 11.75 | 12.0 | 13.0 | p50 `≤112.0` |
| Notes 재진입 | 8.20 | 8.0 | 9.0 | p50 `≤8.4` |

시작 p50 통과선은 기준선의 85%, 첫 Notes 통과선은 기준선 p50에 100ms를
더한 값, Notes 재진입 통과선은 기준선 p50의 105%다.

## 분리 후 시작 성능

분리 후 산출물은 소스 커밋
`37e4caec077458ae3bab0e498b47e1968e2085e0`, 실행 파일 SHA-256
`dfa21443452581787f06a83194530ad90b73d2000310f716aabe74f973a1b9fe`다.
기준선과 같은 앱 식별자, 임시 Vault, Inbox 설정을 사용했다. 매 실행은 새
프로세스였고 20개 표본을 제외 없이 사용했다.

| 실행 | 시작 |
| ---: | ---: |
| 1 | 117.0 |
| 2 | 107.0 |
| 3 | 107.0 |
| 4 | 106.0 |
| 5 | 100.0 |
| 6 | 106.0 |
| 7 | 107.0 |
| 8 | 108.0 |
| 9 | 109.0 |
| 10 | 108.0 |
| 11 | 112.0 |
| 12 | 108.0 |
| 13 | 107.0 |
| 14 | 106.0 |
| 15 | 113.0 |
| 16 | 108.0 |
| 17 | 111.0 |
| 18 | 110.0 |
| 19 | 111.0 |
| 20 | 108.0 |

| 지표 | 기준선 | 분리 후 | 비율 | 판정 |
| --- | ---: | ---: | ---: | --- |
| 시작 평균 | 146.70 | 108.45 | 0.739 | 참고값 |
| 시작 p50 | 151.0 | 108.0 | 0.715 | PASS (`≤0.85`) |
| 시작 p95 | 159.0 | 113.0 | 0.711 | PASS (`≤1.00`) |

따라서 p50은 `43 ms`, `28.5%` 감소했고 p95는 `46 ms`, `28.9%`
감소했다.

### 아직 판정하지 않은 runtime gate

이 세션에서 분리 후 앱은 `renderer_entry`, `app_mounted`, Vault load까지
정상 기록했지만 macOS 창 서비스가 해당 프로세스의 native window를 만들지 않았다.
`System Events`, LaunchServices, 화면 캡처 모두 창 0개를 확인했다. Tauri builder에
`visible(true)`를 명시한 일회성 진단 빌드도 같은 결과였고 해당 진단 변경은 즉시
되돌려 작업 트리에 남기지 않았다.

따라서 다음 값은 기준선과 같은 실제 클릭 프로토콜을 실행할 수 없어 미측정이다.

- 첫 Notes 활성화 p50과 `notes_first_delta_ms`
- Notes 재진입 p50과 `notes_reopen_ratio`
- release WebView의 Inbox 시작/첫 선택/재선택 network 요청 관찰

통합 테스트는 Inbox 시작 시 loader 0회, 첫 Notes 선택 시 1회, Inbox 왕복 뒤
추가 호출 0회, 실패 후 재시도를 검증한다. 이는 코드 계약의 증거지만 release
network 관찰이나 두 실행 시간 gate를 대체하지 않는다. 이 세 항목은 PASS로
처리하지 않는다.

## 번들 식별 정보

이 런타임 측정용 빌드는 성능 trace를 유지하도록 `VITE_YONALIST_PERF=1`로
만들었다. 이 산출물의 초기 정적 graph는 raw `1,283,352 bytes`, Node
`gzipSync` 기준 `384,732 bytes`이며 App chunk는 각각 `829,444 bytes`,
`238,347 bytes`다. 성능 trace가 제거되는 일반 production 분석 빌드의 번들
예산과 섞지 않는다. 일반 빌드의 분리 전 기준선과 변경 후 예산은 설계 문서에
고정된 raw `1,146,420 bytes` / gzip `346,049 bytes` 및 그 80%다.

분리 후 일반 production 분석 빌드는 다음과 같다.

| 지표 | 실제값 | 예산 | 판정 |
| --- | ---: | ---: | --- |
| 초기 정적 JavaScript raw | 744,567 | 917,136 | PASS |
| 초기 정적 JavaScript gzip | 232,593 | 276,839 | PASS |
| App chunk raw | 289,162 | `<500,000` | PASS |
| App chunk gzip | 84,844 | 150,000 | PASS |
| App sourcemap Notes source | 0 | 0 | PASS |
| App sourcemap `@dnd-kit` source | 0 | 0 | PASS |
| Notes feature chunk raw | 494,744 | `<500,000` | PASS |
| Notes feature sourcemap `@dnd-kit` source | 0 | 0 | PASS |

초기 정적 JavaScript는 분리 전보다 raw `401,853 bytes`(`35.1%`), gzip
`113,456 bytes`(`32.8%`) 감소했다. App chunk는 raw `403,284 bytes`
(`58.2%`), gzip `114,755 bytes`(`57.5%`) 감소했다. 이 값은
`npm run build:analyze`의 자동 gate가 실제 manifest, chunk bytes,
`gzipSync`, sourcemap sources를 읽어 판정한다.

후속 분석에서 Notes 지연 chunk가 Vite 표시 기준 raw `543.10 kB`, gzip
`156.64 kB`로 500 kB 경고를 냈다. `@dnd-kit`을 `notes-dnd` 지연 vendor
chunk(raw `48.46 kB`, gzip `15.85 kB`)로 분리한 뒤 Notes chunk는 raw
`494.74 kB`, gzip `140.82 kB`가 됐다. 각각 `48.36 kB`(`8.9%`),
`15.82 kB`(`10.1%`) 감소했고 build 경고가 사라졌다. 이 변경은 초기 정적
graph에 DnD를 되돌려 넣지 않으며, 실행 시간 개선으로 환산하지 않는다.

## 제외된 사전 시도

- 첫 사전 시도는 `app_mounted` 절대값만 저장해 `renderer_entry`와의 차이를
  복원할 수 없었으므로 기준선 후보가 아니었다.
- 두 번째 사전 시도는 임시 Vault 설정 전에 수행돼 최종 격리 조건과 달랐다.
- 기존 사용자 Vault에 닿은 Notes 시험은 스키마 불일치 오류를 확인한 즉시
  중단했고 어떤 활성화 시간도 채택하지 않았다.
- 실행 19·20은 원본 로그가 `elapsed_ms`를 기록했는데 보충용 파서가 `atMs`를
  찾는 오류가 있었다. 원본 로그의 두 event 차이인 `148 ms`, `137 ms`로
  바로잡았고 Notes 값은 원본 그대로 사용했다.

사전 시도는 최종 프로토콜을 확정하기 전에 폐기했으며, 빠르거나 느리다는 이유로
선택적으로 제외한 표본은 없다.
