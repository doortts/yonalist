# Yonalist Architecture Review

분석 대상: `/Users/doortts/repos/yonalist`

## 한 줄 요약

Yonalist는 React/Vite/Tauri 기반의 offline-first GitHub inbox입니다. 원격 GitHub 이슈, PR, discussion, notification을 로컬 Markdown vault의 `ItemDocument`, `CommentDocument`, `OutboxOperationDocument` 모델로 정규화하고, 작성 작업은 outbox Markdown으로 먼저 저장한 뒤 온라인 상태에서 GitHub에 동기화합니다.

## 큰 구조

- `src/App.tsx`: 화면 모드, 인증 게이트, vault 로드, GitHub 데이터 병합, outbox 동기화, 설정/리셋을 조율하는 최상위 shell
- `src/components/*`: Sidebar, list, detail, notification, settings, outbox 등 순수 UI에 가까운 화면 조각
- `src/hooks/*`: GitHub 인증, work items, notifications, repository visibility, item thread, visible item prefetch 같은 app-state adapters
- `src/services/*`: GitHub transport/client, vault persistence, sync, cache, browser/native bridge, perf trace
- `src/domain/*`: Markdown front matter 기반의 typed document model, path strategy, merge/outbox rules
- `src-tauri/src/lib.rs`: vault file IO, app-local SQLite index/hash/avatar cache, OAuth loopback, image fetch proxy, keychain, browser opening

## 로컬 저장소 경계

- 앱 데이터: `notes/<vault-key>/notes.sqlite`, `indexes/<vault-key>/index.sqlite`, 아바타 캐시
- Markdown Vault: GitHub 문서, `.yonalist/outbox`, `.yonalist/notes-assets`
- `index.sqlite`와 아바타 캐시는 재생성 가능한 데이터이며 Vault를 이동하거나 동기화할 때 함께 전송하지 않습니다.
- 이전 버전이 Vault에 만든 `.yonalist/index.sqlite`와 `.yonalist/cache`는 앱이 더 이상 열거나 수정하지 않으며 비활성 백업으로 남깁니다.
- Vault 경로를 정규화한 해시를 `<vault-key>`로 사용하므로 서로 다른 Vault의 로컬 DB와 캐시가 섞이지 않습니다.

## 사용한 기법

- Offline-first local-first model: vault Markdown과 `.yonalist/outbox`가 원격 성공 여부와 독립적으로 사용자 작업을 보존합니다.
- Typed front matter contract: GitHub REST/GraphQL 응답을 `ItemDocument` 계열로 정규화해서 UI와 vault가 같은 모델을 씁니다.
- Cache layering: in-memory LRU, inflight request coalescing, smart TTL, localStorage snapshot, Tauri SQLite item index/hash cache가 함께 쓰입니다.
- Native boundary isolation: Tauri command에서 vault-relative path만 허용하고, sibling temp file rename으로 atomic write를 수행합니다.
- Optimistic auth gate: 저장된 credential이 있으면 앱을 먼저 띄우고, 네트워크가 되는 경우에만 뒤에서 검증합니다.
- Conditional notification polling: GitHub notifications는 1개짜리 conditional probe로 변경 여부를 확인한 뒤 필요할 때만 전체 페이지를 다시 받습니다.
- Viewport-aware prefetch: 화면에 머무른 row만 body/thread를 미리 가져오고, 동시성 제한과 eviction으로 캐시를 관리합니다.
- Retry-aware outbox sync: transient failure는 재시도/failed, definitive rejection은 blocked로 구분합니다.

## 개선 포인트

1. `App.tsx` 조율 책임을 나누기
   - 현재 `App.tsx`는 1705줄이며 auth, vault bootstrap, list/detail selection, notifications, outbox sync, settings reset이 모두 들어 있습니다.
   - 후보: `useAppMode`, `useVaultBootstrap`, `useOutboxSyncController`, `useNotificationViewModel`, `useSettingsResetController`.

2. Notification filtering을 한 곳으로 모으기
   - `useNotifications`는 이미 `isRepoVisible` 인자를 받을 수 있는데, `App.tsx`에서 다시 `filteredNotificationItems`, `filteredUnreadNotificationCount`, `notifications` wrapper를 만듭니다.
   - hook에 `notificationRepoFilter`를 넘기거나 별도 view-model hook으로 추출하면 중복과 badge count drift를 줄일 수 있습니다.

3. GitHub request policy를 중앙화하기
   - `PAGE_SIZE`, `MAX_REPO_PAGES`, `MAX_WATCHED_REPO_PAGES`, notification `MAX_PAGES`, `POLL_INTERVAL_MS`, smart TTL 등이 여러 파일에 흩어져 있습니다.
   - GitHub Enterprise host별 capability/rate budget이 다를 수 있으므로 `githubRequestPolicy.ts` 같은 설정 모듈이 유용합니다.

4. Tauri `lib.rs` 모듈 분리
   - 현재 2081줄에 vault IO, SQLite, OAuth, image proxy, keychain, browser opening, tests가 함께 있습니다.
   - 후보 모듈: `vault.rs`, `index_db.rs`, `oauth.rs`, `image_proxy.rs`, `tokens.rs`, `browser.rs`.

5. Vault store adapter를 명시적으로 분리
   - `vaultStore.ts`는 browser localStorage fallback과 Tauri invoke path를 같은 함수 내부에서 분기합니다.
   - `VaultBackend` 인터페이스를 두고 `tauriVaultBackend` / `browserVaultBackend`로 나누면 테스트와 향후 sync backend 확장이 쉬워집니다.

6. Outbox를 작은 상태 기계로 승격하기
   - 현재 상태 전이는 `App.tsx`, `domain/outbox.ts`, `services/sync.ts`, `vaultStore.ts`에 흩어져 있습니다.
   - `pending → syncing → synced | failed | blocked` 전이를 명시한 reducer/service로 모으면 재시도, conflict, partial success 처리가 더 읽기 쉬워집니다.

## 다이어그램

- `yonalist-overall-architecture.svg`
- `yonalist-runtime-data-flow.svg`
- `yonalist-outbox-sync-flow.svg`
- `yonalist-techniques-and-improvements.svg`

각 SVG는 같은 이름의 `.png` 파일로도 렌더링했습니다.
