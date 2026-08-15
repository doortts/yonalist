# Notes 파일 SSOT 동기화 v2 이식 — TDD 테스트 설계

- 작성: 2026-08-15. 짝 문서: [구현 계획](2026-08-15-notes-sync-port-implementation-plan.md). 계획의 각 항목이 여기 정의된 테스트를 소유하고, M0·M1 항목은 먼저 red가 되는 테스트의 이름과 경로까지 이 문서가 확정한다.
- 원칙: 테스트는 **계약**을 잠근다. 구현을 비추는 거울 테스트는 받지 않는다. v1 테스트 494개는 이식 시 계약 단위로 골라 옮기고, 아래는 그중 새 v2 접합이 요구하는 최소 골격이다.
- 금지: 시간 측정 단언(flaky — §9에서 카운터로 대체), `toHaveBeenNthCalledWith`/`invocationCallOrder`(저장소 규칙), 실사용 Vault·실 `app_data_dir` 접촉(§11).

## 레이어 지도

| § | 레이어 | 위치 | 러너 |
|---|---|---|---|
| 2 | M1 골격 단위 | `crates/notes-sync/src/*.rs` `#[cfg(test)]`, adapter, 프런트 | 아래 항목별 |
| 3 | 스키마·트리거 | `crates/notes-sqlite/tests/sync_stamping.rs` | `cargo test -p notes-sqlite --test sync_stamping` |
| 4 | 결정성·golden 왕복 | `crates/notes-sync/src/topic_file.rs`·`topic_parser.rs` 테스트 + `crates/notes-sync/fixtures/` | `cargo test -p notes-sync topic_` |
| 5 | 파서 관대함·보존 | `crates/notes-sync/src/topic_parser.rs` 테스트 | `cargo test -p notes-sync topic_parser` |
| 6 | 병합 대수·워커 seam·충돌 IPC | notes-sync property + `crates/notes-sqlite/tests/sync_merge_seam.rs` | `cargo test -p notes-sync merger` · `cargo test -p notes-sqlite --test sync_merge_seam` |
| 7 | undo 배리어 | `crates/notes-application/tests/merge_barrier.rs` | `cargo test -p notes-application --test merge_barrier` |
| 8 | 방출·감시·이벤트 | notes-sync exporter/watcher 테스트 + adapter + 프런트 | 항목별 |
| 9 | 성능 계약 | `crates/notes-sync/tests/` + 기존 `notes-sqlite/tests/performance.rs` | `cargo test -p notes-sync --test perf_contracts` · `npm run test:v2:performance` |
| 10 | 멀티 디바이스 통합 (M6) | `crates/notes-sync/tests/multi_device.rs` | `cargo test -p notes-sync --test multi_device` |

설계 테스트 수: §2 13 · §3 6 · §4 7 · §5 12 · §6 19(property 4 포함) · §7 4 · §8 17 · §9 3(+기존 7 무회귀) · §10 14 = **신규 95개** (v1에서 계약 단위로 추가 이식되는 단위 테스트는 별도).

## 1. M0 — red 테스트 없음 (명시)

M0.1은 문서다. 게이트는 적대적 리뷰이고 이 스펙이 확정하는 계약은 아래에서 red 테스트가 된다: v5 문법 → §4 golden, 관대함 표 → §5, 리스크 정책 → §10.2. M0의 golden 초안(부록)이 §4가 커밋할 fixture의 원본이다.

## 2. M1 골격 — 항목별 첫 red 테스트

### 2.1 M1.1 크레이트 골격

- **테스트**: `npm run test:v2:architecture` (`scripts/checkV2Architecture.mjs`).
- **red 만들기**: 스크립트의 `expectedDependencies`(`:7-11`)에 `["notes-sync", ["notes-application", "notes-core"]]`를 먼저 넣는다 → `missing v2 workspace package: notes-sync`로 실패 → 크레이트 생성으로 green. 스크립트 편집이 곧 실패하는 테스트다.
- 잠그는 계약: notes-sync의 워크스페이스 편입과 의존 방향(notes-application·notes-core만).

### 2.2 M1.2 HLC

- **파일**: `crates/notes-sync/src/hlc.rs` `#[cfg(test)]`.
- **첫 red**: `encoding_orders_lexicographically_like_time` — millis/counter가 커질수록 인코딩 문자열의 사전순도 커진다(모듈이 없으므로 컴파일 red).
- 이어서: `encode_decode_round_trips_canonically`(비정규 인코딩 거부 포함), `now_is_monotonic_across_clock_regression`(시스템 시계 역행 주입), `observe_makes_the_next_now_beat_the_remote`, v1의 8개 테스트 이식.
- **property** (proptest — `crates/notes-core`가 이미 dev-dep로 쓰는 1.9.0을 notes-sync dev-deps에 추가. 근거: 워크스페이스 기존 의존 + 실패 시 축소 재현이 quickcheck보다 좋고 손제작 시드 케이스보다 공간을 넓게 덮는다):
  - `prop_hlc_string_order_equals_component_order`: 임의 (millis ≤ 36^9-1, counter ≤ 1295, device 4 hex) 두 개에 대해 `encode(a) < encode(b) ⇔ (a.millis, a.counter, a.device) < (b.millis, b.counter, b.device)`. 17자 고정폭도 함께 단언.
- 러너: `cargo test -p notes-sync hlc`.

### 2.3 M1.3 file_io

- **파일**: `crates/notes-sync/src/file_io.rs` `#[cfg(test)]`.
- **첫 red**: `write_atomic_file_round_trips_bytes_without_leaving_temp_files` — tempdir에 쓰고 재읽기 일치 + 디렉터리에 임시 파일 잔존 0.
- 이어서 v1 41개 중 이식 표면의 계약 테스트: symlink/비정규 파일 거부, no-replace 이동의 identity 검증, bounded read 상한(16MiB 캡).
- 러너: `cargo test -p notes-sync file_io`.

### 2.4 M1.4 스키마·트리거 / M1.5 vault 영속

- M1.4는 §3이 소유한다. **첫 red**: §3.1의 `a_command_commit_stamps_hlc_and_marks_dirty`(테이블·트리거가 없으므로 SQL 오류로 red).
- M1.5 **파일**: `apps/desktop/src-tauri/src/sync_settings.rs` `#[cfg(test)]`.
  - **첫 red**: `vault_path_round_trips_through_the_settings_file` — tempdir를 data dir 삼아 set→get 왕복.
  - 이어서: `a_relative_or_data_dir_path_is_rejected`.
  - 러너: `cargo test -p yonalist-v2-desktop sync_settings`. 명령 표면은 `npm run test:v2:architecture`(expectedCommands 갱신이 없으면 그 스크립트가 red), 계약은 `npm run test:v2:contracts`.

### 2.5 M1.6 설정 화면

- **파일**: `apps/desktop/src/SettingsView.test.tsx` (기존 파일에 추가, co-located 관례).
- **첫 red**: `"vault 폴더를 고르면 선택 경로가 저장되고 표시된다"` — dialog picker mock → invoke 호출 payload와 표시 문자열 단언. 러너: `npm run test:v2:frontend`.

## 3. 스키마·트리거 (M1.4)

**파일**: `crates/notes-sqlite/tests/sync_stamping.rs`. `SqliteStorage::open_in_memory` 또는 raw `Connection` + `schema::initialize`.

| 테스트 | 잠그는 계약 |
|---|---|
| `a_command_commit_stamps_hlc_and_marks_dirty` | 기존 `mutations::commit` 경로가 무수정으로 hlc 스탬프 + `sync_dirty_nodes` 행을 남긴다 (M1-4의 절반) |
| `an_explicit_hlc_survives_a_merge_style_upsert` | hlc를 명시한 INSERT/UPDATE는 재스탬프되지 않는다 — 불변 규칙 6의 트리거 WHEN 가드 |
| `an_hlc_stamp_does_not_touch_the_fts_index` | 스탬핑 UPDATE가 `notes_fts` 트리거(text, note 한정)를 발화시키지 않는다 |
| `a_delete_marks_the_dirty_row` | AD 트리거 |
| `sync_meta_is_seeded_once_with_a_stable_device_id` | 재기동해도 device_id/vault_uuid 불변 |
| `user_version_stays_one` | 스키마 창이 버전을 올리지 않는다 (마이그레이션 금지 결정의 기계 증거) |

기존 스위트(`vertical_slice.rs`, `viewport_queries.rs` 등) 전체 green 유지가 이 항목의 두 번째 합격 조건이다.

## 4. 결정성·golden 왕복 (M2)

**fixture**: `crates/notes-sync/fixtures/topic_golden_v5.md`, `topic_images_golden_v5.md`, `trash_golden_v5.md` — M0 부록에서 확정한 v5 판. 원본은 v1의 `src-tauri/src/notes/sync/fixtures/topic_golden.md`(format_version 4), `github_notifications_golden.md`, `TRASH_GOLDEN`(`topic_parser.rs:1325`)이다.

| 테스트 (`topic_file.rs`/`topic_parser.rs` 테스트 모듈) | 계약 |
|---|---|
| `rendering_the_same_state_twice_is_byte_identical` | 결정성 — 불변 규칙 3. 같은 문서 구조 2회 렌더 = 동일 Vec<u8> |
| `golden_topic_renders_byte_identical` (3 fixture 각각) | 스펙의 문법이 곧 렌더러의 출력이다. include_str! 바이트 비교 |
| `render_parse_render_reaches_a_fixpoint` | `render(parse(render(s))) == render(s)` — v1 §7.4 계승 |
| `sibling_order_is_the_file_line_order` | sort_key는 파일에 없고 줄 순서가 형제 순서 |
| `keys_serialize_in_the_specified_order` | frontmatter 키 순서 고정(HashMap 순회 금지의 관찰 가능면) |

M2.1의 첫 red: `golden_topic_renders_byte_identical`(fixture는 있는데 렌더러가 없다).

## 5. 파서 관대함·보존 (M2)

**파일**: `crates/notes-sync/src/topic_parser.rs` 테스트 모듈. v1 관대함 표(스펙 §7.3) 전 행을 케이스로.

### 5.1 수용 (행마다 1테스트)

`a_bullet_without_yid_is_accepted_for_id_issue`(발급은 병합 몫 — 파서는 None id로 통과), `an_unparsable_hlc_becomes_empty_and_loses_lww`(v1의 `t: too-new` 케이스 계승, `topic_parser.rs:1724`), `odd_indent_and_tabs_normalize_to_two_spaces`, `a_bare_dash_line_is_a_plain_bullet`(**체크박스가 없으면 할 일이 아니다** — marker=bullet, completed=false), `a_checkbox_line_is_always_a_todo`(`- [ ]`·`- [x]` 둘 다 marker=todo), `a_completed_plain_bullet_round_trips_through_the_done_token`(프리픽스가 아니라 주석이 싣는다), `a_v4_completed_bullet_becomes_done_on_write_back`(v4의 `- [x]` + todo 토큰 없음 → `- ` + `done`, `needs_write_back`), `missing_frontmatter_keys_take_defaults`, `crlf_normalizes_to_lf`, `a_v4_golden_parses_with_v5_semantics`(v1/v4 vault 수용 — 결정 6).

### 5.2 격리 (부분 적용 금지)

`a_future_format_version_quarantines`(`format_version > 5`), `a_missing_topic_id_quarantines`, `an_oversized_file_quarantines`(16MiB 캡), `a_git_conflict_marker_quarantines`(`<<<<<<<`, 결정 1의 "git 미보증"이 안전한 이유). 격리는 문서 전체 거부다. 절반만 파싱된 결과가 나오면 실패다.

### 5.3 미지 필드 보존 (M2.3 — 첫 red)

`unknown_fields_survive_a_parse_render_round_trip` — v4 golden의 `plugin:`·`root_readonly:`·`miw:` 등 v5가 모르는 키·토큰이 parse→render 왕복 후 원문 그대로 남는다. 재방출 위치는 스펙이 고정한 결정적 규칙을 따른다(같은 입력 2회 렌더 바이트 동일까지 함께 단언).

## 6. 병합 (M3)

### 6.1 병합 대수 — property (M3.1 소유)

**파일**: `crates/notes-sync/src/merger.rs` 테스트 모듈(+ 전략 helper). **크레이트: proptest 1.9.0** (§2.2의 근거). 전략: 깊이 ≤ 4, 노드 ≤ 30의 canonical 문서(전 노드 yid/hlc 보유 — 불변 규칙 2의 멱등 계약은 canonical 문서부터 적용된다), HLC는 좁은 값 폭 + 기기 2개로 충돌 밀도를 올린다.

| property | 계약 |
|---|---|
| `prop_merging_the_same_canonical_doc_twice_is_a_noop` | 멱등 — 2회째 병합 후 DB 덤프 불변 **그리고 revision 불변**(no-op은 revision을 올리지 않는다) |
| `prop_merge_order_of_two_docs_does_not_change_the_state` | 교환 — DB₁에 A→B, DB₂에 B→A 병합 후 정규화 덤프 동일 |
| `prop_two_dbs_converge_by_exchanging_exports` | 수렴 — 서로의 render를 병합하면 동일 상태 (M4 이후 render 사용, M3 시점엔 문서 구조 교환으로 선행) |
| §2.2의 `prop_hlc_string_order_equals_component_order` | HLC 전순서가 위 셋의 전제 |

단위 테스트(발췌): `a_hand_edit_with_equal_hlc_is_adopted_under_a_fresh_hlc`(A4), `a_cycle_parks_the_same_node_for_the_same_input`(결정성), `a_future_hlc_beyond_drift_is_restamped_and_logged`(신규 정책, 24h), `a_loser_is_recorded_once_in_the_conflict_log`(중복 금지), `unknown_extras_are_upserted_with_the_node`.

**부재 ≠ 삭제와 이중 증거** (불변 규칙 1):

| 테스트 | 계약 |
|---|---|
| `a_node_missing_from_the_file_is_never_deleted` | 파일에 없는 로컬 노드는 병합 후에도 산다 |
| `deletion_needs_trash_evidence` | trash.md의 LWW 이동만이 soft delete를 전파한다 |
| `a_purge_tombstone_removes_only_older_nodes` | tombstone hlc보다 새 노드는 산다(부활 경로) |
| `an_older_snapshot_cannot_resurrect_a_purged_node` | 두 증거 중 tombstone이 이긴다 |

### 6.2 워커 seam (M3.2 — 통합)

**파일**: `crates/notes-sqlite/tests/sync_merge_seam.rs`. `SqliteStorage::open`(tempdir 파일 DB — 우회 검증에 파일이 필요).

| 테스트 | 계약 |
|---|---|
| `a_merge_through_the_worker_bumps_the_revision_once` | `Request::MergeTopic` 1회 = revision +1, `SqliteStorage::revision()`으로 관찰 |
| `a_commit_with_the_pre_merge_revision_is_rejected` | 병합 후 낡은 revision의 `commit`이 `RevisionConflict`로 죽는다. **이 테스트가 우회 경로를 잡는다.** 병합이 워커·revision 규약을 우회하면(별도 Connection으로 직접 쓰면) revision이 그대로라 이 commit이 성공해 버리고 테스트가 실패한다 |
| `an_identical_merge_replay_keeps_the_revision` | no-op 병합은 revision을 올리지 않는다(멱등의 seam 판) |

### 6.3 충돌 IPC (M3.4)

`crates/notes-sqlite/tests/sync_merge_seam.rs` 이어서: `conflicts_page_returns_recorded_losers`(읽기 + 페이로드 직렬화 — camelCase wire 모양은 adapter `lib.rs` 테스트 관례처럼 serde_json으로 고정), `restoring_a_conflict_reapplies_the_loser_as_a_new_edit`(복구 = 새 편집, LWW로 전파), `the_log_is_pruned_past_its_retention_caps`(1,000건 또는 180일 중 먼저 닿는 쪽 — 계획 결정 8. 두 상한을 각각 넘기는 케이스 2개로 나눈다).

### 6.4 충돌 UI (M3.5)

`apps/desktop/src/SettingsView.test.tsx`: `"충돌 목록이 표시되고 복구 버튼이 명령을 보낸다"`. 러너: `npm run test:v2:frontend`.

## 7. undo 배리어 (M3.3) — Rust 단독으로 검증 가능

**파일**: `crates/notes-application/tests/merge_barrier.rs`. `NotesService` + 기존 테스트들이 쓰는 storage 대역. 프런트가 필요 없는 근거: 배리어의 관찰면은 영수증의 `HistoryState`(can_undo/undo_depth)와 undo 시도의 결과뿐이고 둘 다 서비스 API다. 프런트는 can_undo를 그리기만 하므로(M5 수동 증거에서 눈으로 한 번 확인) vitest 몫이 없다.

| 테스트 | 계약 |
|---|---|
| `undo_stops_at_an_entry_touching_a_merged_node` | 편집 e1(노드 X)→e2(노드 Y) 후 X를 바꾼 병합 absorb → undo 1회(e2)는 성공, 다음 undo는 거부되고 can_undo=false |
| `entries_above_the_barrier_still_undo` | 병합과 교차하지 않는 위쪽 항목은 전부 되돌아간다. 전체 절단 대안과의 차이를 잠근다 |
| `a_merge_with_no_overlap_leaves_history_alone` | 교차 없으면 floor 불변, undo_depth 불변 |
| `redo_clears_when_the_merge_touches_a_redone_node` | undo 후 X를 바꾼 병합 → redo 불가 |

첫 red: `undo_stops_at_an_entry_touching_a_merged_node`(absorb_external이 없어 컴파일 red).

## 8. 방출·감시·이벤트 (M4·M5)

### 8.1 exporter 코어 (M4.1)

`crates/notes-sync/src/exporter.rs` 테스트 모듈: `self_validation_failure_leaves_the_file_untouched`(불변 규칙 4 — 파스백 불일치 주입 시 기존 바이트 보존 + dirty 유지), `an_export_clears_only_the_exported_dirty_rows`, `deleted_nodes_emit_into_trash_md`, `a_purge_emits_a_tombstone_line`, `exported_hash_records_the_written_bytes`(에코 skip의 근거).

### 8.2 자산 방출 (M4.2)

`a_dirty_image_node_copies_its_bytes_to_the_vault`(정규 경로 `<sha256>.<ext>`, 이미 있으면 복사 0회), `a_path_escaping_link_is_rejected`(불변 규칙 7).

### 8.3 SyncRuntime 디바운스 (M4.3)

디바운스 계산은 순수 함수로 분리해 단위 테스트: `a_topic_exports_after_3s_idle_or_30s_total`(가짜 시계 주입, 실제 sleep 금지), `flush_ignores_the_debounce`. 스레드 자체는 M6 통합이 돌린다.

### 8.4 watcher (M5.1)

v1 방식대로 notify를 우회해 콜백을 직접 호출한다: `an_echo_of_our_own_write_is_skipped`(sha256 == exported_hash), `a_conflicted_copy_merges_and_retires`(`* (conflicted copy)*.md` 병합 → canonical 재작성 → `sync-cleanup` 이동), `an_unreadable_placeholder_is_retried_not_fatal`(v1 `watcher.rs:2104` 계승), `events_coalesce_within_the_window`.

### 8.5 자산 인입 (M5.2)

`an_arriving_asset_fills_the_local_cache_and_notifies`(notes-assets에 파일 생성 → `images/` 복사 + 변경 통지).

### 8.6 이벤트·listener (M5.4)

- Rust: `a_merge_emits_sync_changed_with_the_receipt_shape` — 페이로드 serde_json 직렬화를 camelCase wire로 고정(adapter `lib.rs:565` 테스트 관례).
- 프런트(신규 listener 파일의 co-located `.test.ts`): `"이벤트 수신이 coalesce 후 반영 콜백을 한 번 부른다"`, `"StrictMode 이중 mount에서 등록·해제가 멱등이다"`. 러너: `npm run test:v2:frontend`.

## 9. 성능 계약 (M5.3·M6.3) — 카운터로, 시간으로 하지 않는다

시간 단언은 CI·노트북 편차로 flaky하다. 두 계약 모두 결정적 카운터로 잠근다. 벽시계는 기존 `test:v2:performance`(release + bench-fixtures 옵트인)에만 남긴다.

### 9.1 부트스트랩 = 변경분만 (M5.3)

**파일**: `crates/notes-sync/tests/perf_contracts.rs`. `reconcile` 보고서 `{ parsed_files, skipped_files }`가 관찰면이다.
- `bootstrap_reparses_only_changed_files`: 파일 10개 조정 → 전부 skip. 1개의 mtime을 바꾸면 parsed_files == 1.
- `the_gate_is_mtime_and_size_not_content`: mtime·size를 보존한 채 내용만 바꾼 파일은 skip된다 — 게이트가 정말 mtime+size임을 증거로 잠근다(내용 훼손은 다음 mtime 변경 때 해시 확인이 잡는다는 한계도 이 테스트가 문서화한다).

### 9.2 exporter 질의 수 상한 (M6.3, M4.1이 예비 실행)

**방법**: rusqlite `trace` feature를 워크스페이스 의존(`Cargo.toml:22`)에 추가하고 테스트가 `Connection::trace`로 실행 SQL을 센다. 근거: 프로덕션 코드는 trace를 호출하지 않고 bundled SQLite라 feature 추가 비용이 없으며 질의 수는 입력이 같으면 결정적이다.
- `pending_export_resolution_runs_a_constant_number_of_queries`: topic 10개에 dirty 노드 1,000개 → dirty→대상 해석의 질의 수 ≤ 고정 상수(노드 수와 무관). v1 방식이라면 2,000~3,000회가 나와 red가 된다. N+1 수리의 직접 증거다.

### 9.3 기존 계약 무회귀

`npm run test:v2:performance` 7계약 green 유지. `docs/v2/performance.md`의 50k 부트스트랩 계약은 M6.3에서 "파일 스캔 포함" 문구로 재정의한다(감사 §6의 예고).

## 10. 멀티 디바이스 통합 (M6)

**파일**: `crates/notes-sync/tests/multi_device.rs`. 구성: tempdir 셋 — vaultA·vaultB(파일 복사 = transport 모사, v1 §12 방식. 부분 전파·지연을 테스트가 결정적으로 제어하기 위해 공유 폴더 하나가 아니라 복사를 쓴다) + DB 2개. 파이프라인(파스→병합→방출)은 스레드 없이 동기 호출로 돌린다 — watcher·디바운스는 §8이 검증했고 여기서는 수렴만 본다.

### 10.1 v1 §12 매트릭스 재현 (10)

1. `edits_propagate_a_to_b` 2. `concurrent_edits_converge_with_a_logged_loser` 3. `disjoint_edits_merge_without_conflict` 4. `a_move_and_a_rename_of_the_same_node_converge`(X는 한 topic에 1개, 제목은 hlc 승자) 5. `trash_and_restore_round_trip_between_devices` 6. `a_purge_propagates_and_a_late_old_node_lands_in_trash`(90일 GC 후 도착 = trash 부활, 허용 동작 문서화) 7. `a_truncated_file_quarantines_without_data_loss_then_reexports` 8. `a_bounced_copy_is_digested_and_retired` 9. `a_hand_edited_bullet_gets_an_id_and_writes_back` 10. `a_concurrent_move_cycle_parks_the_same_node_on_both_devices`

### 10.2 신규 시나리오 (4)

| 테스트 | 계약 (계획 §6 M6.2) |
|---|---|
| `a_snapshot_older_than_the_tombstone_window_is_isolated` | 기기별 마지막 병합 HLC 대비 90일 초과 스냅샷 → 자동 병합 대신 격리 + 상태 통지 |
| `a_far_future_clock_is_restamped_on_merge` | 24h 드리프트 초과 HLC가 fresh HLC로 재스탬프되어 이후 정상 편집을 영구히 이기지 못한다 |
| `conflicted_copies_from_transport_converge_to_one_canonical_file` | `.sync-conflict-*`/`(conflicted copy)` 병합 승격 후 canonical 1개 + 두 DB 동일 |
| `same_node_concurrent_edits_keep_the_loser_recoverable` | LWW 패자가 conflict log에 남고 복구가 전파된다(결정 2·5의 끝점) |

## 11. fixture와 격리

- **Rust**: 전 테스트 `tempfile::tempdir`(notes-sqlite·notes-sync dev-dep). DB는 tempdir 안 파일 또는 `open_in_memory`. 홈 디렉터리·실 vault 접촉 금지 — 경로는 항상 tempdir에서 파생한다.
- **HLC 전역 클록**: v1처럼 프로세스 전역 Mutex다. 병렬 테스트 간 간섭은 클록의 단조성 때문에 무해하지만 순서를 단언하는 테스트는 자기 device 문자열을 고유하게 쓰고 절대 시각을 단언하지 않는다.
- **golden**: `crates/notes-sync/fixtures/*.md` — include_str!로 컴파일에 묶여 이동·누락이 빌드 오류가 된다.
- **desktop 수동 증거**: `YONALIST_V2_DATA_DIR=<임시 디렉터리> npm run tauri:dev`(`apps/desktop/src-tauri/src/lib.rs:505-508`) + 임시 vault 폴더. 사용자 실데이터(`~/Library/Application Support/com.doortts.yonalist.v2/`)에 닿지 않는다. 확인 후 임시 디렉터리 폐기 — 리셋 절차 불필요.
- **정리**: tempdir는 drop이 지운다. 테스트에 명시 정리를 두지 않는다(panic 시에도 안전).
