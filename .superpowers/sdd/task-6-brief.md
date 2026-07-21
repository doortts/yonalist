### Task 6 — Phase 6: 통합, 장애 주입, 성능

- 요구사항: §1, §8, §9, §10, §11 Phase 6, §12 전체.
- 목표: 두 개의 독립 Vault/SQLite 장치가 파일 교환·장애·정리 뒤에도 안전하게
  수렴하고, 손상 파일이 기존 유효 상태를 잃지 않도록 자동화한다.
- 수용 기준: §12의 10개 시나리오를 자동화한다. 기능을 막는 개인 노트북 기준은
  10k-node bootstrap <15s 및 1k-node 단일-topic merge <1s다. 같은 실행에서 20k
  bootstrap 및 100ms merge는 참고값으로만 기록하며 실패해도 기능 게이트를 막지
  않는다. truncate quarantine/recovery, 두 장치 수렴과 purge 전파를 포함한다.
- 비대상: 필드별 병합으로의 의미론 변경, 새 파일 포맷, 성능 벤치마크 구현은
  기능 시나리오 GREEN 뒤 별도 단계에서 수행한다.
- 범위: production 수정은 테스트가 드러낸 최소 결함에 한정한다. 전체 프런트/Rust/
  architecture gate와 격리된 임시 vault desktop smoke까지 완료한다.

### 기능 시나리오 실행 계약

| 행 | 자동 검증 소유처 |
| --- | --- |
| 1–4 | `notes::sync::integration_tests`의 두 장치 파일 교환 테스트 |
| 5–6 | 같은 모듈의 trash/restore/purge/90일 만료 테스트 |
| 7 | 같은 모듈의 strict-prefix 손상 복구 테스트 |
| 8 | `watcher::tests::successful_bounced_copy_merge_removes_only_the_copy` (Phase 4 직접 경로) |
| 9 | 같은 모듈의 unstamped external bullet write-back 테스트 |
| 10 | `merger::tests::concurrent_two_device_cycle_parks_the_same_global_lowest_hlc_edge` (Phase 2 직접 경로) |

### RED/GREEN 및 성능 결과

- 90일 purge 증거 정리는 API 부재로 RED였고, HLC millisecond 기준의 결정적
  정리와 `trash.md` 재출력 marker를 시작 조정 및 60초 유지보수 tick에 연결한 뒤
  GREEN이 되었다.
- strict-prefix tail truncation은 처음에는 계속 격리되어 RED였다. 현재는 SQLite로
  재구성한 canonical hash가 마지막 `exported_hash`와 같고 손상 바이트가 그
  canonical의 진부분일 때만 복원한다. 파싱 가능한 root-only truncation도 파싱 전에
  검출한다. 원본은 exact held-file 검증 후 hidden non-Markdown 이름으로 no-replace
  분리하고, 원래 경로가 비었을 때만 canonical을 게시한다. 임의 손상과 읽기 이후
  교체·변경된 경로는 덮어쓰지 않고 격리 상태로 남긴다. 분리본은 cloud writer가
  기존 inode를 계속 쓸 수 있어 보존한다.
- 복구 전에는 quarantine clear와 dirty recovery marker를 한 transaction으로 먼저
  commit한다. 따라서 기존 quarantine 재시도 중 분리 직후 프로세스가 종료되어도,
  다른 정상 topic 파일이 존재하는 시작 경로에서도 다음 시작이 canonical을
  재출력한다. 성공 뒤에는 한 번의 observable quarantine status를 보낸 다음 watcher
  retry가 상태를 해제한다. process-stop 및 runtime status 회귀 테스트가 이를 고정한다.
- root 검토에서 시작 직후 정리한 오래된 purge 증거가 기존 `trash.md`로 곧바로
  재수입되는 결함을 RED로 확인했다. 외부 trash 병합 시에도 현재 시간 기준으로
  만료 증거를 제외하고 dirty rewrite를 예약하도록 수정했으며, 같은 파일의 지연된
  오래된 trash 노드는 다시 나타날 수 있음을 GREEN으로 확인했다.
- 시나리오 1, 5, 6은 준비된 Markdown 직접 작성에 머물지 않도록 강화했다. 실제
  repository 편집/삭제/복원/empty-trash가 dirty marker를 만들고, `flush_pending`이
  내보낸 파일을 상대 Vault에 전달해 병합하는 전체 경로를 검증한다.
- 시나리오 3은 양쪽 `sync_conflict_log=0`을 직접 확인하고, 시나리오 8은 bounced
  사본 삭제뿐 아니라 병합된 제목이 SQLite에 남았는지도 확인한다. source isolation
  뒤 경쟁 pathname이 생기는 경우도 새 바이트 보존과 quarantine을 검증한다.
- 잔여 경계: cloud provider가 분리된 inode를 계속 연 채 final validation 이후에
  쓰는 극단 경합에서는 그 후속 바이트가 hidden recovery 파일에 무손실 보존되지만
  UI로 자동 재병합되지는 않는다. 일반적인 temp+rename writer 경로와 다르며,
  Phase 6에서는 자동 반영보다 데이터 보존을 우선하는 명시적 경계로 둔다.
- 기능 검증: `notes::sync::integration_tests` 11 passed, 성능 테스트 1 ignored.
  전체 sync 소유 테스트는 296 passed, 1 ignored다.
- release 전용 성능 게이트 결과: 10k bootstrap **2.268s**(<15s), 1k single-topic
  merge **538.913ms**(<1s). 참고 측정은 20k bootstrap **4.672s**, 1k merge의
  100ms 목표는 **miss**였다. 최초 release 컴파일 2분 18초는 측정에서 제외되었고,
  최신 테스트 본체는 준비 실행을 포함해 9.15초였다.
- 전용 실행 명령:
  `cargo test --release --manifest-path src-tauri/Cargo.toml notes_file_sync_performance_contract -- --ignored --test-threads=1 --nocapture`
- 격리 데스크톱 검증: 고유 bundle ID
  `com.doortts.yonalist.phase6final1784656718`, 별도 WebKit profile/Cargo target,
  임시 Vault로 최신 production 후보를 실행했다. 온보딩 Markdown 생성 후 파일 제목을
  외부에서 `Phase6 외부 동기화 확인`으로 바꾸자 watcher가 이를 감지해 노트 목록과
  편집 화면에 반영했다. 기존 개발 앱 프로세스와 데이터는 건드리지 않았다.
- 최종 전체 게이트: frontend lint/TypeScript, Vitest 3,876 passed(184 files,
  27 skipped), Notes architecture budget, production build가 통과했다. Rust는 개인
  노트북의 시간 기반 오탐을 줄이기 위해 단일 스레드로 실행해 1,077 passed,
  0 failed, release/대용량 전용 4 ignored였고 formatting/diff check도 통과했다.
