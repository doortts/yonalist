# 첫 실행 vault 선택 — 설계 (M1.7–M1.9)

- 작성: 2026-08-16. 기준: `main@00bbeed5` (설계 요청서의 `c21ea63a` 위에 M1.0의 복제 id 수리 커밋이 이미 얹혀 있다).
- 짝 문서: [구현 계획](2026-08-15-notes-sync-port-implementation-plan.md) §6 M1, [테스트 설계](2026-08-15-notes-sync-port-test-design.md) §2, [sync 스펙](../../v2/sync-spec.md) §1·§3·§6.
- 다루는 요구: **사용자가 첫 실행에서 vault 폴더를 고른다.** DB는 지금처럼 앱 안(`app_data_dir`, [lib.rs:505-508](../../../apps/desktop/src-tauri/src/lib.rs#L505))에 남는다. M1.5(vault IPC·영속)와 M1.6(설정 화면 절)은 "설정에서 고치는" 경로만 다루고 vault가 한 번도 선택되지 않은 상태와 그때의 outliner 동작은 다루지 않는다. 이 문서가 그 구멍을 항목 3개로 메운다.
- 항목 번호는 **M1.7–M1.9로 뒤에 붙인다.** 재번호를 하지 않는 이유: 계획과 테스트 설계가 이미 커밋된 문서이고 M1.0–M1.6을 절 번호로 서로 참조한다. 문서 두 벌을 고쳐 얻는 것이 없다.

## 1. 여섯 가지 결정

### D1. vault는 필수가 아니다 — 동기화는 opt-in

첫 실행은 outliner를 막지 않는다. vault 선택 카드가 보이되 "Later"로 미룰 수 있고 미룬 사용자는 설정 화면(M1.6)에서 언제든 고를 수 있다.

근거. 계획 §3의 Goal이 경계를 이미 그었다 — vault는 **기기 간** 진실 소스이고 `notes-v2.sqlite`는 **앱 로컬 런타임** 진실이다. 기기가 하나뿐인 사용자는 vault 없이 아무것도 잃지 않는다. 더구나 M1 시점에는 exporter도 파서도 없어서(M2·M4) 폴더를 골라도 실제로 일어나는 일이 없다. 아무 기능도 열어 주지 못하는 차단 화면은 비용만 남는다. 스펙 §1의 "DB를 잃어도 vault에서 돌아온다"는 내구성 이득은 카드의 안내 문구가 설득할 몫이지 강제할 몫이 아니다.

### D2. "첫 실행" = `app_data_dir/vault-path` 파일의 부재

기계적 판정은 하나다: M1.5가 영속에 쓰는 `app_data_dir/vault-path` 파일이 없으면 vault 미설정이고 `notes_sync_vault_get`이 `path: null`을 돌려준다. 카드 노출은 여기에 프런트 조건 하나를 더한다 — localStorage 키 `yonalist.vaultPromptDismissed.v1`(기존 관례 [useTheme.ts:17-21](../../../apps/desktop/src/useTheme.ts#L17)과 같은 꼴)이 없을 때만 보인다.

빈 DB는 신호로 쓰지 않는다. 새 DB는 온보딩 시드가 바로 채우므로([seed.rs:22-75](../../../crates/notes-sqlite/src/seed.rs#L22)) 비어 있는 순간이 사실상 없다. `notes_delete_all_data` 이후의 "첫 실행 같은 상태"는 D6이 vault-path 파일을 지우는 것으로 같은 판정에 합류한다. 별도 마커 파일도 두지 않는다. 파일 하나의 존재 여부가 이미 그 마커다.

### D3. 카드는 outliner 위에 뜨는 비차단 카드다

차단 화면(D1로 기각)도, 설정 화면 단독(첫 실행 요구를 못 채운다)도 아니다. `App.tsx`가 settings가 닫혀 있고 vault 미설정이며 dismissal이 없을 때 노트 영역 위에 카드 하나를 얹는다. 버튼은 둘: **Choose folder…**(폴더 picker → `notes_sync_vault_set` → 카드 종료)와 **Later**(localStorage 기록 → 카드 종료).

- **StrictMode**: 카드의 데이터 접촉은 effect 안의 `vaultGet` 읽기 1회뿐이라 이중 mount의 이중 호출이 무해하다. `store.bootstrap`의 idle 가드([notesStore.ts:121-122](../../../apps/desktop/src/notesStore.ts#L121))와 같은 계열의 걱정이지만 읽기 전용이라 가드조차 필요 없다.
- **StartupGate**: vault IPC는 gate를 기다리지 않는다(M1.5의 결정 — vault 경로는 어댑터 소유 파일이고 DB보다 먼저 필요하다). 그래서 DB 초기화가 느리거나 실패해도 카드는 뜬다. 기존 notes 명령이 전부 `gate.wait()`를 지나는 것([lib.rs:44-45](../../../apps/desktop/src-tauri/src/lib.rs#L44))과 대비되는, 이 카드가 기대는 성질이다.
- picker는 이미 있는 재료로 만든다: `tauri-plugin-dialog`는 등록돼 있고([lib.rs:493](../../../apps/desktop/src-tauri/src/lib.rs#L493)) `dialog:allow-open` 권한도 있다([capabilities/default.json:10](../../../apps/desktop/src-tauri/capabilities/default.json#L10)). 호출 모양은 [exportPicker.ts:9-19](../../../apps/desktop/src/exportPicker.ts#L9)의 관례(동적 import + `__TAURI_INTERNALS__` 가드)를 따른다.

### D4. vault 선택 전의 노트는 그대로 있고, 선택은 데이터를 옮기지 않는다

선택 전에 만든 노트는 SQLite에 그대로 남는다. `notes_sync_vault_set`은 경로를 기록할 뿐 DB를 읽지도 쓰지도 않고 고른 폴더 안에 파일 하나 만들지 않는다(M1.7이 테스트로 잠근다).

나중의 방출은 이미 설계된 경로가 처리한다: M1.4의 스탬핑 트리거가 편집마다 `sync_dirty_nodes`에 행을 남기고 그 행은 export가 지우기 전까지 쌓이므로, M4 exporter가 생기는 순간 밀린 노트 전부가 첫 방출로 나간다. vault 선택 시점은 이 backlog에 아무 영향이 없다.

**기존 vault(다른 기기의 문서) + 비어 있지 않은 로컬 DB는 병합이지 채택이 아니다.** 그 병합은 M5.3 bootstrap의 시작 조정 4분기가 소유한다(계획 §6 M5.3). 이 슬라이스는 그 상황을 **판별해서 알리기만** 하고(D5) 아무 동작도 하지 않는다. 판별을 지금 넣는 이유: 릴리스의 핵심 플로우가 "두 번째 기기에서 기존 vault 폴더를 고른다"이므로 거부는 나중에 되물러야 할 임시 정책이 되고 수용은 이미 설계된 안전망 위에 선다 — (a) 이 슬라이스는 쓰지 않고 (b) M4 exporter는 `exported_hash`와 다른 파일을 덮지 않으며(스펙 §6, 계획 M4.1) (c) 페이지 폴더 이름의 무조건 id 접미사가 이름 충돌 자체를 없앤다(스펙 §3.1).

### D5. 검증은 M1.5 그대로, 첫 실행이 더하는 것은 거부가 아니라 판별이다

M1.5의 구조 검증(절대 경로 · 생성 가능 디렉터리 · `app_data_dir` 내부 금지)은 그대로 두고, `notes_sync_vault_set`이 성공하면 폴더 상태를 판별해 돌려준다:

| 상태 | 판정 | 하는 일 |
|---|---|---|
| `empty` | 항목이 없거나 숨김 항목(`.`으로 시작)뿐. 존재하지 않던 폴더는 만들고 이 상태다 | 조용히 수용. 카드가 그냥 닫힌다 |
| `existingVault` | 루트 `README.md`의 첫 4KiB가 `---`로 시작하고 `kind: yonalist-`를 담거나, `.yonalist/` 디렉터리가 있다 | 수용. 카드가 다른 기기의 vault로 보이며 동기화가 켜지면 병합된다고 안내한다 |
| `nonEmpty` | 그 밖의 무관한 파일이 있다 (frontmatter 없는 `README.md` 포함 — git 저장소를 vault로 오인하지 않는다) | 수용 + 카드가 전용 폴더를 권하는 문구를 보인다 |

세 상태 모두 수용이다. 판별은 UI 안내용 **신호**이지 검증이 아니다 — 파일 내용의 진짜 검증과 격리는 M2 파서 소유(스펙 §5)이고, 판별이 틀려서 생길 수 있는 최악은 안내 문구가 어긋나는 것뿐이다. set이 하는 유일한 쓰기는 없던 폴더 자체를 만드는 것(M1.5의 "생성 가능" 검증)이며 폴더 **안**은 건드리지 않는다.

### D6. 데이터 전체 삭제는 vault 선택을 지우고, vault 폴더는 절대 건드리지 않는다

`apply_pending_data_deletion`([lib.rs:265-287](../../../apps/desktop/src-tauri/src/lib.rs#L265))의 삭제 목록에 `vault-path` 파일을 더한다. 재시작 후 백엔드는 D2의 판정 그대로 첫 실행 상태다.

- vault 폴더와 그 안의 파일은 코드가 경로를 읽지도 않는다 — 삭제 목록은 `data_directory` 안의 이름들뿐이고, vault는 검증상 `app_data_dir` 밖이다. "로컬 데이터 삭제"의 의미가 로컬(DB·이미지 캐시·선택)에서 끝난다.
- 선택을 지우는 이유: 남겨 두면 M5 이후 재시작 bootstrap이 vault를 통째로 다시 들여와 "전체 삭제"가 관찰상 아무 일도 안 한 것이 된다. 지우면 리셋은 리셋이고 같은 폴더를 다시 고르는 것이 곧 (M5의) 복원 경로다.
- "조용히 orphan"을 막는 것은 문구다: 설정의 삭제 안내([SettingsView.tsx:271-274](../../../apps/desktop/src/SettingsView.tsx#L271))에 sync 폴더와 그 안의 파일은 남는다는 한 문장을 더한다.
- 한계(의도된 것): localStorage의 dismissal은 데이터 삭제로 지워지지 않으므로, "Later"를 눌렀던 사용자가 전체 삭제를 하면 카드는 다시 뜨지 않고 설정 화면이 진입로다. dismissal을 백엔드에 영속해 이 구멍을 막는 것은 IPC 표면 하나 값이라 비대상으로 미룬다.
- 벌어질 수 있는 좁은 경합 하나를 기록한다: 삭제는 재시작 후 백그라운드 startup 스레드에서 실행되고([lib.rs:519-523](../../../apps/desktop/src-tauri/src/lib.rs#L519)) vault IPC는 gate를 안 기다리므로, 리셋 직후 첫 프레임의 `vaultGet`이 이론상 지워지기 직전의 경로를 볼 수 있다. 다음 조회부터 정상이고 최악이 표시 한 번이라 감수한다. 명령 핸들러(`notes_delete_all_data`)에서 지우면 경합이 없어지지만 순수 함수 테스트를 잃는다 — 테스트 가능성이 이긴다.

## 2. 계약

| 필드 | 내용 |
|---|---|
| Goal | 처음 켠 사용자가 outliner를 잃지 않은 채 vault 폴더를 고르거나 미룰 수 있고, 그 선택·리셋이 DB와 vault 어느 쪽 데이터도 옮기거나 지우지 않는다 |
| Acceptance | 아래 FV-1~FV-5. 각 행은 항목 하나에 대응한다 |
| Non-goals | §5 |
| Boundaries | React(App.tsx + 신규 카드 컴포넌트), IPC(M1.5 명령 2개의 페이로드 확장 — 명령 수 불변, ts-rs 계약 1타입 추가), Rust adapter(`sync_settings.rs`, `lib.rs`), 파일시스템(폴더 상태 판별은 읽기 전용, 삭제 목록에 파일 1개 추가), macOS(기존 dialog plugin) |
| Manual proof | `YONALIST_V2_DATA_DIR=$(mktemp -d) npm run tauri:dev` → ① 카드가 뜬 채로 노트 입력이 되는지 → ② 빈 임시 폴더 선택 → 카드가 닫히고 폴더는 빈 그대로 → ③ 재시작 → 카드 없음, 설정에 경로 표시 → ④ 설정에서 데이터 전체 삭제 → 재시작 후 카드가 다시 뜨고 아까 폴더는 무손상 |

| 행 | 관찰 가능한 합격 조건 | 항목 |
|---|---|---|
| FV-1 | vault 미설정으로 앱을 켜면 outliner가 정상 동작하는 채로 vault 카드가 보이고, 폴더를 고르면 경로가 저장되며 카드가 사라진다 | M1.9 |
| FV-2 | "Later"가 카드를 닫고 그 선택이 재마운트(재시작)를 견디며, 설정 화면의 vault 절은 계속 열려 있는 진입로다 | M1.9 |
| FV-3 | `notes_sync_vault_set`이 폴더 상태(`empty` \| `existingVault` \| `nonEmpty`)를 판별해 돌려주고, 그 폴더 안에는 아무 파일도 만들지 않는다 (무관한 `README.md`는 vault가 아니다) | M1.7 |
| FV-4 | 기존 vault 폴더를 고르면 카드가 병합 예정임을 알리고 무관한 파일이 있는 폴더면 전용 폴더를 권한다 | M1.9 |
| FV-5 | 데이터 전체 삭제 후 재시작하면 vault 선택이 지워져 첫 실행 상태로 돌아가고, vault 폴더의 파일은 그대로다 | M1.8 |

FV-1·FV-2·FV-4가 한 항목(M1.9)에 몰리는 것은 loop 규칙과 어긋나지 않는다 — 요구는 "행마다 항목이 정확히 하나"이지 그 역이 아니다.

## 3. 항목

의존 요약: M1.7 ← M1.5, M1.8 ← M1.5, M1.9 ← M1.6 + M1.7. M1.0–M1.4와는 셋 다 무관하다(파일도 계약도 겹치지 않는다).

### M1.7 — vault 폴더 상태 판별과 무간섭 set

- 바뀌는 것:
  - `apps/desktop/src-tauri/src/sync_settings.rs` (M1.5의 신규 파일을 확장) — set 성공 시 D5 표의 판별을 실행해 결과를 돌려준다. `README.md`는 첫 4KiB만 읽고, 판별 중 어떤 파일도 만들지 않는다.
  - `crates/notes-application/src/contracts.rs` — `SyncVaultFolderState` ts-rs enum(`empty`/`existingVault`/`nonEmpty`) 추가. `notes_sync_vault_set`의 반환 타입이 된다. `packages/contracts/generated/` 재생성 커밋.
- 무수정: `notes_sync_vault_get`의 모양(M1.5의 `SyncVaultStatus` 그대로 — 판별은 set 시점 1회다), 명령 수(2개 그대로 — `scripts/checkV2Architecture.mjs`·`permissions/main-window.toml`·`build.rs`는 M1.5가 갱신한 그대로), 워커와 DB(`sync_settings.rs`는 storage 의존이 없어 DB 무접촉이 구조로 보장된다).
- 커밋: `feat(sync): report the chosen vault folder's state without touching it`
- 소유 테스트 명령: `cargo test -p yonalist-v2-desktop sync_settings` + `npm run test:v2:contracts`
- **첫 red**: `choosing_a_folder_with_an_existing_vault_reports_it` — `apps/desktop/src-tauri/src/sync_settings.rs` `#[cfg(test)]`. tempdir에 `kind: yonalist-notes` frontmatter를 가진 `README.md`를 심고 set → `existingVault`. 반환 타입이 아직 없어 컴파일 red.
- 이어서: `an_unrelated_readme_is_not_a_vault`(frontmatter 없는 README.md → `nonEmpty`), `hidden_entries_leave_a_folder_empty`(`.DS_Store`·`.stfolder`만 있는 폴더 → `empty`), `vault_set_writes_nothing_inside_the_chosen_folder`(set 전후 디렉터리 목록 동일).
- 의존: M1.5.

### M1.8 — 데이터 전체 삭제가 vault 선택을 지운다

- 바뀌는 것:
  - `apps/desktop/src-tauri/src/lib.rs` — `apply_pending_data_deletion`([:265-287](../../../apps/desktop/src-tauri/src/lib.rs#L265))의 파일 삭제 목록에 vault-path 파일 추가. 파일 이름 상수는 `sync_settings.rs`가 `pub(crate)`로 내놓아 두 곳이 한 값을 쓴다.
  - `apps/desktop/src/SettingsView.tsx` — 삭제 안내 문구([:271-274](../../../apps/desktop/src/SettingsView.tsx#L271))에 sync 폴더와 그 안의 파일은 남는다는 한 문장.
- 무수정: `notes_delete_all_data`의 시그니처와 마커 방식([lib.rs:244-263](../../../apps/desktop/src-tauri/src/lib.rs#L244)), vault 폴더 자체(코드가 그 경로를 읽지 않는다), `images/`·`original-views/` 목록.
- 커밋: `feat(sync): clear the vault choice when all local data is deleted`
- 소유 테스트 명령: `cargo test -p yonalist-v2-desktop a_data_reset`
- **첫 red**: `a_data_reset_clears_the_stored_vault_path` — `apps/desktop/src-tauri/src/lib.rs` 기존 `#[cfg(test)]` 모듈([:552](../../../apps/desktop/src-tauri/src/lib.rs#L552)). tempdir에 마커와 vault-path 파일을 만들고 `apply_pending_data_deletion` 실행 → vault-path 부재, 목록 밖 파일은 생존. 삭제 목록에 없어 assert red.
- 문구 한 문장은 별도 테스트를 두지 않는다 — 상수 문자열이고, M1.9의 프런트 스위트가 SettingsView 렌더를 이미 지난다.
- 의존: M1.5 (파일 이름 상수).

### M1.9 — 첫 실행 vault 카드

- 바뀌는 것:
  - `apps/desktop/src/VaultSetupCard.tsx` 신규 + co-located `VaultSetupCard.test.tsx`. 카드가 스스로 `vaultGet`을 1회 읽어 노출을 정하고(D3) Choose folder…와 Later 버튼을 갖는다. set 결과가 `empty`가 아니면 D5의 안내 문구를 보인 뒤 닫힌다. dismissal은 `yonalist.vaultPromptDismissed.v1`에 기록하고 읽기·쓰기는 [useTheme.ts:23-37](../../../apps/desktop/src/useTheme.ts#L23)처럼 try/catch로 감싼다.
  - `apps/desktop/src/vaultPicker.ts` 신규 — `pickVaultFolder(): Promise<string | null>`. [exportPicker.ts:9-19](../../../apps/desktop/src/exportPicker.ts#L9) 관례대로 `@tauri-apps/plugin-dialog`의 `open({ directory: true })`을 동적 import로 부른다.
  - `apps/desktop/src/App.tsx` — settings가 닫혀 있을 때 노트 영역 위에 카드 렌더(레이아웃 구현은 자유, 계약은 노출 조건과 버튼 동작).
  - `apps/desktop/src/SettingsView.tsx` — M1.6이 인라인으로 넣은 picker 호출을 `vaultPicker` 공유 helper로 교체(동작 불변).
- 무수정: Rust 전부, `notesStore.ts`(vault는 노트 상태가 아니라 store 밖에 산다), StartupGate, `api.ts`의 invoke 표면(M1.6이 이미 추가한 2개를 쓴다).
- 커밋: `feat(sync): offer the vault folder choice on first launch`
- 소유 테스트 명령: `npm run test:v2:frontend`
- **첫 red**: `"vault가 없으면 카드가 뜨고 폴더를 고르면 사라진다"` — `apps/desktop/src/VaultSetupCard.test.tsx`. 컴포넌트가 없어 import red. (테스트 설계 §2.5가 프런트 테스트 이름을 한국어 문장으로 확정한 관례를 따른다 — 기존 스위트는 영어 이름이라 저장소 안에 두 관례가 공존하게 되는데, 이 문서는 짝 문서의 관례를 따랐다.)
- 이어서: `"Later가 dismissal을 저장해 다시 마운트해도 숨는다"`, `"기존 vault 폴더를 고르면 병합 안내가 보인다"`(FV-4), `App.test.tsx`에 1행 — `"vault가 없으면 outliner와 카드가 같이 보인다"`(FV-1의 배선 절반 — App fixture(`src/test/appApiFixture.ts`)는 M1.6이 NotesApi를 넓힐 때 함께 자란다).
- 의존: M1.6 (api invoke 2개·설정 절), M1.7 (`SyncVaultFolderState` 페이로드).

## 4. 최종 게이트

diff 동결 후 1회. Rust adapter + IPC 계약 + 프런트를 함께 만지는 슬라이스이므로 계획 §7 M1 행 그대로:

- `npm run test:v2` — cargo test --workspace · vitest · lint · architecture · contracts · bundle · scripts를 전부 포함한다([package.json:24](../../../package.json#L24))
- `cargo fmt --all -- --check`
- `git diff --check`

Clippy는 접촉 경계와 직접 관련될 때만 기준선 대비로 본다(스킬 규정).

## 5. 비대상

- **vault 채택·병합·재색인.** 기존 vault를 고른 뒤 실제로 문서를 들여오는 일은 M5.3 bootstrap의 시작 조정 4분기 소유다. 이 슬라이스의 선택은 기록일 뿐이다.
- **어떤 방출도 없다.** 선택 직후에도 폴더는 빈 그대로다(M4).
- **vault 내부 파일의 검증·격리.** M2 파서 소유. M1.7의 판별은 안내용 신호다.
- **폴더 상태의 지속 추적.** 판별은 set 시점 1회다. 이후 폴더가 변해도 M5의 watcher 전에는 보지 않는다.
- **dismissal의 백엔드 영속.** localStorage로 끝낸다. 데이터 전체 삭제가 dismissal을 되살리지 않는 한계는 D6에 기록했다.
- **설정 화면의 폴더 상태 안내.** 안내는 카드만 한다. 설정의 sync 절 확장은 M3.5(충돌 목록)가 어차피 다시 연다.
- **차단형 온보딩/웰컴 화면.** D1로 기각.
- **`notes_ui_state` 접촉.** 테이블은 있지만([schema.rs:260-263](../../../crates/notes-sqlite/src/schema.rs#L260)) IPC 표면이 없고, 이 슬라이스가 그 표면을 열 이유가 없다.

## 6. 코드 실측 노트 (계획·스펙과 어긋나거나 계획이 안 다룬 지점)

1. **HEAD가 계획서 기준보다 앞서 있다.** `00bbeed5`가 M1.0의 첫 총알(복제 자식 id의 uuid v5 파생)을 이미 커밋했다. M1.0의 나머지(온보딩 시드 uuid화 — [seed.rs:8](../../../crates/notes-sqlite/src/seed.rs#L8)의 `onboarding-page` 일가가 아직 문자열 id다 — 와 캡 검증)는 미착수.
2. **`checkV2Architecture.mjs`의 `expectedCommands`는 `lib.rs`만 스캔한다**([:150-156](../../../scripts/checkV2Architecture.mjs#L150)). M1.5가 명령을 `sync_settings.rs`에 정의하면 그 목록은 갱신할 필요가 없고(이미 `export_ipc::notes_export` 등이 같은 이유로 빠져 있다) 실제 red는 handler↔permissions/build.rs 대조([:168-189](../../../scripts/checkV2Architecture.mjs#L168))에서 난다. 테스트 설계 §2.4의 "expectedCommands 갱신이 없으면 red" 문구는 이 한도에서 부정확하다.
3. **프런트 테스트 이름 관례가 갈린다.** 테스트 설계 §2.5는 한국어 문장 이름을 확정했지만 기존 스위트(App.test.tsx, SettingsView.test.tsx)는 전부 영어다. 이 문서는 짝 문서를 따랐고 구현 때 하나로 정리할지는 리뷰 몫이다.
4. **capability 검사도 고정 목록이다**([:191-209](../../../scripts/checkV2Architecture.mjs#L191)). 이 슬라이스는 권한을 더하지 않아(`dialog:allow-open` 기존 보유) 무관하다. 다만 M1.5 구현자에게는 permissions 파일과 build.rs 두 곳 갱신이 필수이고 그것은 위 2번의 handler 대조가 강제한다.
5. **UI 문안은 전부 영어다** ("New page", "Delete all Yonalist data..."). 카드 문구도 영어로 간다 — acceptance 행은 문구를 고정하지 않고 역할·라벨만 잠근다.
