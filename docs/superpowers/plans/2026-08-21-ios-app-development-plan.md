# Yonalist iOS v1 — 개발 계획

2026-08-21 · 브랜치 `claude/yonalist-ios-design-mockup-0121a9`
기능 설계 [2026-08-21-ios-app-v1.md](2026-08-21-ios-app-v1.md) ·
시안 [2026-08-21-ios-app-mockup.html](../mockups/2026-08-21-ios-app-mockup.html) ·
아이콘 [icons.md](../../design/icons.md)

이 문서는 무엇을 어떤 순서로 만들고 각 단계에서 무엇으로 증명하는지를 정한다.
단계마다 계약을 새로 얼리고, 항목 하나가 커밋 하나이고, 항목마다 먼저 빨갛게
만든 테스트가 있다. `fable-opus-loop`의 역할 분담(Fable 설계·검토 / Opus 구현)을
그대로 따른다.

## 0. 조사로 확인한 것 — 계획을 바꾼 사실들

계획을 세우기 전에 코드를 읽었고, 예상과 다른 것이 네 개 나왔다. 전부 일을
줄이는 쪽이다.

**드래그는 이미 터치에서 돈다.** 데스크톱 재배치가 HTML5 drag-and-drop이 아니라
Pointer Events다. `useOutlineDrag.ts:153-158`이 `pointermove`/`pointerup`/
`pointercancel`을 window에 걸고, `:179`가 `setPointerCapture`를 잡는다. 결정적으로
불릿 손잡이에 `touch-action: none`이 이미 붙어 있다(`notes.css:2226-2228`,
`.notes-node-bullet[data-sortable-activator="true"]`). 이게 없으면 세로 드래그를
브라우저가 스크롤로 가져가면서 `pointercancel`로 드래그가 죽는데, 그 한 줄이
이미 있다. 게다가 낙하 지점 계산은 `outlineDragPlan.ts`의 순수 함수이고 이미
단위 테스트가 6개 붙어 있다. **드래그는 새로 만드는 게 아니라 손보는 것이다.**

**브라우저만으로 화면 전체를 만들 수 있다.** `NotesApi`가 인터페이스이고
(`api.ts:31-63`), 구현이 이미 둘이다 — Tauri용 `tauriNotesApi`와 인메모리
`previewNotesApi`(`preview/previewApi.ts:622`). `main.tsx:10-13`이 브라우저에서는
후자를 끼운다. 그래서 Xcode를 한 번도 열지 않고 393×852 브라우저 창에서 모바일
화면을 다 만들고, 시뮬레이터는 진짜 WKWebView와 소프트 키보드가 필요한 순간에만
쓴다. 빌드 왕복이 없는 만큼 이게 제일 빠른 길이다.

**스토어는 그대로 올라간다.** `notesStore.ts`와 `store/` 전부가 Tauri를 import
하지 않는다. 상태 라이브러리도 없고 `useSyncExternalStore` 위의 손수 만든
클래스라 플랫폼에 묶인 곳이 없다.

**iOS 설정은 하나도 없다.** `[lib] crate-type`도 `mobile_entry_point`도
`#[cfg(mobile)]`도 없고 `gen/apple`도 없다. `main.rs`/`lib.rs`가 갈려 있는
모양만 맞다. 0단계가 통째로 이 일이다.

## 1. 범위

드래그 재배치를 v1에 넣는다. 설계 문서의 비대상 목록에서 뺀다.

| 넣는 것 | 빼는 것 (v1 비대상) |
|---|---|
| 오늘 저널 편집, 저널 피드, 페이지 목록·상세, 검색 | GN 플러그인, GitHub 설정 |
| **불릿 드래그 재배치** (단일 + 다중 선택) | Markdown/PDF 내보내기 |
| 완료 3단계 전환, 들여쓰기·내어쓰기 | Trash 복원 |
| 이어받기(carry over) | 분할 창, 창 크롬, 페이지 확대 |
| iCloud vault 동기화 | 이미지 편집 (보기만) |
| 라이트·다크 테마 | iPad 레이아웃, 위젯, 잠금화면 |

## 2. 구조 결정

**한 앱, 네 플랫폼.** `apps/desktop`을 `apps/yonalist`로 바꿨다. Windows와 Linux는
새 셸이 아니라 데스크톱 셸의 새 빌드 타깃이고(`Cargo.toml`에 `cfg(windows)`
의존성이, single-instance에 `cfg(any(macos, windows, linux))`가 이미 있다), iOS는
같은 `src-tauri`에서 나온다. OS마다 폴더를 파면 `apps/windows`가 `apps/desktop`과
99% 같은 것이 된다. 진짜 갈리는 축은 데스크톱 셸 대 모바일 셸 하나뿐이다.

```
apps/yonalist/
  index.html          → src/main.tsx         (mac · windows · linux) → dist/
  index.mobile.html   → src/mobile/main.tsx  (ios)                   → dist-mobile/
  src/
    notesStore.ts  outline/  journal.ts  preview/  …   ← 공유. 옮기지 않는다
    mobile/                                            ← 모바일 셸만 새로
  src-tauri/          ← 하나. tauri.ios.conf.json이 iOS 값만 덮는다. gen/apple도 여기
```

**경계는 폴더가 아니라 진입점이다.** 데스크톱 진입점이 타고 들어가는 것이 데스크톱
번들이고, 번들러가 그것을 강제하고 예산 게이트가 증명한다. 그래서 데스크톱 전용
파일 25개를 `src/desktop/`으로 옮기지 않는다 — 얻는 것은 이름 정돈뿐인데 테스트
105개의 import가 따라 움직이고, Windows/Linux는 세 번째 셸을 가져오지 않으므로 그
압력도 오지 않는다.

**`dist`는 반드시 가른다.** `checkV2BundleBudget.mjs:120`이 `dist/assets/`의 모든
`.js`를 훑어 프리뷰 코드 유출을 잡으므로, 두 진입점이 같은 `dist`를 쓰면 이 검사가
남의 청크를 같이 본다. 모바일은 `dist-mobile`로 내보내고 예산 줄도 따로 둔다.

**버린 것:** ① 런타임 분기 하나로 한 번들 — 데스크톱이 357.2KB/358KB라 얹는 즉시
터진다. ② 공유 코드를 `packages/`로 추출 — 파일 100개를 옮기는 리팩터링이고 지금
얻는 것이 없다. ③ Tauri 프로젝트를 둘로 — 명령 33개 × 등록처 4곳이 통째로 복제된다.

**절대 안 바꾼 것:** `tauri.conf.json`의 `identifier`(`com.doortts.yonalist.v2`).
앱 데이터 디렉터리와 iCloud 컨테이너 이름이 여기서 나온다. 폴더 이름 정리하다 같이
손대면 기존 vault가 미아가 된다.

**Vault는 두 걸음으로 간다.** 먼저 앱의 로컬 `Documents/`로 앱 전체를 완성하고,
그 다음 iCloud 컨테이너로 옮긴다. 로컬 단계에서도 `UIFileSharingEnabled`와
`LSSupportsOpeningDocumentsInPlace`를 켜면 파일 앱에서 vault가 보이므로 손으로
넣고 빼며 확인할 수 있다.

**CI는 아직 한 플랫폼이다.** `.github/workflows/ci.yml`이 `ubuntu-latest` 단독이고
매트릭스가 없다. macOS 러너가 없으니 iOS 빌드는 지금 CI에서 돌지 못한다.
Windows/Linux를 붙일 때도 같은 작업이므로 플랫폼 매트릭스는 별도 항목으로 잡는다.

## 3. 검증 방식

| 층 | 무엇으로 | 언제 |
|---|---|---|
| 로직 | vitest + jsdom, `previewApi`/`appApiFixture` | 항목마다 |
| 화면·제스처 | 브라우저 393×852, `npm run dev` | 화면 만드는 내내 |
| 진짜 WKWebView·소프트 키보드·터치 | iPhone 15 Pro 시뮬레이터 | 단계 끝마다 |
| iCloud 수렴 | 실기기 + Mac 두 대 | 4단계에서만 |

시뮬레이터는 `iPhone-15-Pro` 기기 종류가 이 기계에 있고 런타임은 iOS 26.0이다.
Xcode 26.0.1, CocoaPods, tauri-cli 2.11.4는 설치돼 있고 Rust iOS 타깃만 없다.

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
```

```bash
xcrun simctl create "iPhone 15 Pro" com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro
```

## 4. 미리 아는 막다른 길

**iCloud 권한은 유료 개발자 계정이 필요하다 — 갖추고 있다.** 무료 Personal Team
프로비저닝은 iCloud·푸시 같은 권한에 서명하지 못하지만, 이 프로젝트는 Apple
Developer Program 계정이 있으므로 4단계가 막히지 않는다. 남는 것은 계정 쪽
준비물뿐이다: App ID에 iCloud 지원 켜기, iCloud 컨테이너
(`iCloud.com.doortts.yonalist.v2`) 만들기, 그 컨테이너를 App ID에 물리기.
0단계에서 서명이 되는지 먼저 확인해 두면 4단계에서 처음 부딪히지 않는다.

**`notify`는 iOS에서 kqueue로 떨어진다.** `notify-8.2.0/src/lib.rs:413-421`이
`target_os = "ios"`를 `KqueueWatcher`에 묶어 놨다. kqueue는 감시하는 파일마다
파일 서술자를 하나씩 쓰고 새 파일 생성을 제대로 알리지 못해서, 노트가 몇백 개인
vault에서는 못 쓴다. 다행히 `vault_watch.rs:30`에 이미 60초마다 폴더를 통째로
다시 읽는 `SWEEP`이 안전망으로 깔려 있다. iOS는 실시간 감시를 포기하고 이 sweep과
앱이 앞으로 올 때의 재검사에 기댄다. NSMetadataQuery는 4단계에서 iCloud 도착
알림용으로만 붙인다.

**Tauri 명령은 네 곳에 같이 등록해야 한다.** `generate_handler!`
(`lib.rs:971-1005`), `permissions/main-window.toml`, `capabilities/default.json`,
`build.rs`의 `APP_COMMANDS`. 어긋나면 `npm run test:architecture`가 잡는다.
모든 테스트 대역은 API 모양만 맞추므로 ACL 누락은 실기기에서만 드러난다.

**파일 500줄 예산은 경고일 뿐 실패가 아니다**(`checkV2Architecture.mjs:77-86`이
`console.warn`). 지켜야 하지만 게이트를 막지는 않는다.

## 5. 단계

각 항목은 커밋 하나, 실패 테스트 하나. 위험한 경계를 앞에 둔다.

---

### 0단계 — iOS에서 Rust가 도는가

이 단계가 실패하면 나머지 계획이 통째로 무의미하므로 제일 먼저 한다.

| # | 항목 | 바뀌는 곳 | 실패 증거 | 완료 조건 |
|---|---|---|---|---|
| 0.1 | iOS 타깃 추가 + 코어 크레이트 크로스 컴파일 — **통과 (아래 증거)** | 없음(도구) | `cargo build -p notes-sqlite --target aarch64-apple-ios-sim`이 `can't find crate for core`로 실패 | `rusqlite` bundled와 5개 코어 크레이트가 iOS 시뮬레이터 타깃으로 빌드된다 |
| 0.1b | `tauriV2.mjs`의 rustup 경로 탐지를 고친다 — **통과** | `scripts/rustupToolchain.mjs`(신규), `scripts/tauriV2.mjs` | 넘겨짚는 옛 로직이 rustup이 알려준 경로를 무시하고 `null`을 낸다 | rustup이 어디에 깔려 있든 고정 툴체인을 쓴다 |
| 0.2 | `[lib] crate-type` + `mobile_entry_point` | `src-tauri/Cargo.toml`, `src/lib.rs`, `src/main.rs` | `cargo build --target aarch64-apple-ios-sim` 링크 실패 | staticlib이 나오고 데스크톱 빌드가 그대로 통과한다 |
| 0.3 | 데스크톱 전용 코드 `cfg` 게이트 | `lib.rs`(창 생성·vault 선택·내보내기), `vault_watch.rs` | iOS 타깃 컴파일 오류 | iOS 타깃이 컴파일되고 `cargo test --workspace`가 데스크톱에서 그대로 통과한다 |
| 0.4 | `tauri ios init` + iOS 설정·아이콘 | `gen/apple/`, `tauri.ios.conf.json`, 아이콘 세트 | `tauri ios build --debug` 실패 | 빈 화면이라도 시뮬레이터에서 앱이 뜬다 |

**단계 증거:** iPhone 15 Pro 시뮬레이터에서 앱이 실행되고, Rust 쪽 `notes_bootstrap`
한 번이 응답한다. 이때 vault는 앱 로컬 `Documents/`다.

#### 0.1 결과 (2026-08-21)

**통과했다. 제일 큰 불확실성이 사라졌다.** `notes-core`·`notes-application`·
`notes-sqlite`·`notes-sync`·`notes-export` 다섯 개가 `aarch64-apple-ios-sim`과
`aarch64-apple-ios` 양쪽으로 빌드된다. `rusqlite`의 bundled SQLite C 코드도
iOS 타깃으로 같이 컴파일됐다. 크레이트 쪽 코드는 한 줄도 고치지 않았다.

가는 길에 이 기계의 툴체인 문제가 하나 드러났고, 이건 0.4에서 반드시 막는다.

**`rustup target add`만으로는 안 된다.** PATH의 `cargo`/`rustc`가 rustup이 아니라
Homebrew `rust` 포뮬러(`/opt/homebrew/bin`)이고, 그쪽 sysroot에는 호스트 타깃밖에
없다. rustup은 Homebrew로 깔려 있어서 `~/.cargo/bin`이 아예 없다. 그래서
`scripts/tauriV2.mjs:10`의 `existsSync(~/.cargo/bin/cargo)` 검사가 거짓이 되고,
PATH 보정 없이 Homebrew rust로 떨어진다. 데스크톱은 호스트 타깃만 있으면 되니
지금까지 티가 안 났지만, `tauri ios build`는 그 자리에서 죽는다. 0.1b가 이걸
`rustup which cargo`로 푸는 항목이다.

#### 0.1b 결과 (2026-08-21)

**고쳤다.** `scripts/rustupToolchain.mjs`가 `rustup which cargo`로 물어서 고정
툴체인의 bin 디렉터리를 받아 오고, `tauriV2.mjs`가 그것을 PATH 맨 앞에 둔다.
넘겨짚던 `~/.cargo/bin`은 rustup이 대답하지 못할 때의 뒷받침으로만 남았다.
자식 프로세스가 보는 것이 뒤집혔다:

| | `cargo` |
|---|---|
| 고치기 전 | `/opt/homebrew/bin/cargo` — Homebrew rust, 호스트 타깃뿐 |
| 고친 뒤 | `~/.rustup/toolchains/1.97.0-aarch64-apple-darwin/bin/cargo` — iOS 타깃 둘 다 있음 |

`rustc`도 같은 디렉터리에서 온다. 셰임 디렉터리 대신 툴체인 bin을 넘기는 이유가
이것이다 — 셰임은 앞에 다른 `rustc`가 있으면 다시 가려진다.

이 기계에서 직접 `cargo`를 칠 때는 여전히 Homebrew rust가 잡힌다. 저장소
명령(`npm run tauri …`)은 이제 안전하지만, 손으로 크로스 컴파일할 때는 툴체인을
절대 경로로 부르거나 Homebrew `rust` 포뮬러를 지워야 한다:

```bash
~/.rustup/toolchains/1.97.0-aarch64-apple-darwin/bin/cargo build -p notes-sqlite --target aarch64-apple-ios-sim
```

---

### 1단계 — 모바일 셸과 오늘 저널

브라우저에서 다 만들고 끝에 한 번 시뮬레이터로 확인한다.

| # | 항목 | 바뀌는 곳 | 실패 증거 | 완료 조건 |
|---|---|---|---|---|
| 1.1 | 모바일 진입점과 탭 셸 | `index.mobile.html`, `src/mobile/main.tsx`, `MobileApp.tsx`, `vite.config.ts` | 탭 네 개 렌더 테스트 실패 | 탭 네 개가 뜨고 누르면 화면이 바뀐다. 데스크톱 번들 크기는 그대로다 |
| 1.2 | Today 화면이 진짜 스토어에서 오늘 저널을 읽는다 | `mobile/MobileToday.tsx` | 오늘 날짜 페이지가 없을 때 빈 줄 하나를 그리는지 실패 | 설계 A2 — 아무것도 안 쓰면 아무것도 안 남고, 첫 글자에 페이지가 생긴다 |
| 1.3 | 줄 편집과 캐럿 | 기존 `NotesOutline` 재사용 + 모바일 CSS | 탭해서 캐럿이 서고 글자가 들어가는 테스트 실패 | 줄을 눌러 편집하고 Enter로 다음 줄이 생긴다 |
| 1.4 | 키보드 액세서리 바 | `mobile/MobileAccessoryBar.tsx` | 들여쓰기 버튼이 `indent`를 부르는지 실패 | 여섯 버튼이 각각 스토어의 해당 명령을 부른다 |
| 1.5 | 완료 3단계와 터치 타깃 | 모바일 CSS, `outlineTodo` 재사용 | 체크박스 탭 세 번이 세 상태를 도는지 실패 | ⌘↩ 3단계와 같은 순서로 돈다. 모든 탭 대상이 44pt 이상이다 |

**단계 증거:** 시뮬레이터에서 오늘 저널에 세 줄을 쓰고, 들여쓰고, 하나를 완료로
바꾼 뒤 앱을 껐다 켜서 그대로 있는 것을 확인한다. 소프트 키보드가 떴을 때
편집 중인 줄이 키보드에 가리지 않는지가 이 단계의 진짜 관문이다.

---

### 2단계 — 드래그 재배치 (터치)

기존 엔진을 그대로 쓰고 터치에서 깨지는 곳만 고친다. 새로 쓰는 코드는
자동 스크롤 하나뿐이다.

| # | 항목 | 바뀌는 곳 | 실패 증거 | 완료 조건 |
|---|---|---|---|---|
| 2.1 | 불릿 손잡이 터치 타깃 확대 | 모바일 CSS | 손잡이 히트 영역이 44pt 미만이라는 테스트 실패 | 보이는 점 크기는 그대로 두고 히트 영역만 44pt 이상 |
| 2.2 | 터치 탭과 드래그 구분 | `useOutlineDrag.ts`(임계값을 주입 가능하게) | 손가락 떨림 8px에 드래그가 시작되는 테스트 실패 | 터치 임계값은 별도 값이고, 탭은 여전히 zoom을 부른다 |
| 2.3 | 드래그 중 가장자리 자동 스크롤 | `mobile/useDragAutoscroll.ts`(신규) | 화면 밖 목표로 드래그할 때 스크롤이 안 되는 테스트 실패 | 위·아래 가장자리에서 목록이 스크롤되고 낙하 지점이 따라 갱신된다 |
| 2.4 | 손가락에 가리지 않는 고스트 | `OutlineDragPreview.tsx` 오프셋 | 모바일 오프셋이 데스크톱과 같다는 테스트 실패 | 고스트가 손가락 위로 비켜 뜬다 |
| 2.5 | 다중 선택 드래그 | 기존 경로 재사용 + 모바일 선택 진입 | 두 줄 선택 드래그가 한 명령으로 안 가는 테스트 실패 | 여러 줄이 한 `moveNodes`로 옮겨지고 되돌리기 한 번에 돌아온다 |

**단계 증거:** 시뮬레이터에서 ① 줄 하나를 아래로 끌어 순서를 바꾸고 ② 오른쪽으로
끌어 자식으로 넣고 ③ 화면 밖까지 끌어 자동 스크롤로 옮기고 ④ 되돌리기 한 번에
전부 제자리로 돌아오는 것을 확인한다.

**막힐 만한 곳:** iOS가 터치 뒤 합성하는 click이 `consumeDragHandleClick`의
억제 창을 벗어나면, 드래그를 끝낼 때마다 zoom이 같이 튄다. 2.2에서 이걸 먼저
확인하고, 억제를 시간이 아니라 포인터 id로 묶는 쪽으로 고친다.

---

### 3단계 — 나머지 화면

| # | 항목 | 완료 조건 |
|---|---|---|
| 3.1 | Journals 피드 | 날짜 내림차순, 맨 위 하루만 편집, 7일씩 더 보기 (설계 A5·A6) |
| 3.2 | Carry over | 앞선 7일의 안 끝난 To-do가 오늘 끝으로 오고, 없으면 버튼이 없다 (A6) |
| 3.3 | Pages 목록과 상세 | 저널 제외, 별표 우선, 페이지를 열면 편집된다 (A7) |
| 3.4 | zoom과 breadcrumb | 불릿 길게 눌러 zoom, breadcrumb으로 복귀 |
| 3.5 | 검색 | 본문·제목·`date:`·태그가 데스크톱과 같은 결과 (A8) |
| 3.6 | 다크 테마 | 시스템 설정을 따라간다 |

**단계 증거:** 시뮬레이터에서 저널 피드 → 날짜 이동 → 페이지 열기 → 검색 →
결과에서 줄로 이동까지 한 번에 통과한다.

---

### 4단계 — iCloud

계정 준비물(App ID의 iCloud 지원, 컨테이너 생성과 연결)이 먼저다.

| # | 항목 | 바뀌는 곳 | 완료 조건 |
|---|---|---|---|
| 4.1 | ubiquity 컨테이너를 vault로 | iOS 권한, `Info.plist`, vault 경로 결정 | 앱이 iCloud 컨테이너의 `Documents/`를 vault로 연다. Mac이 같은 폴더를 vault로 지정하면 같은 파일을 본다 (A1) |
| 4.2 | 내려받기 브리지 | Tauri iOS 플러그인 (Swift) | `startDownloadingUbiquitousItem`으로 받고 `NSMetadataQuery`로 도착을 안다 |
| 4.3 | 못 받은 파일 보호 | `notes-sync` iOS 분기 | 아직 안 온 파일 위에 절대 쓰지 않는다. 데스크톱 dataless 규칙과 같은 판정 (A10) |
| 4.4 | 앞으로 올 때 재검사 | 모바일 셸 생명주기 | 앱이 앞에 오면 vault를 한 번 훑고 바뀐 것을 반영한다 (A9) |
| 4.5 | 첫 실행 화면 | `mobile/MobileSetup.tsx` | iCloud 상태와 내려받기 진행률을 보여준다. iCloud가 꺼져 있으면 로컬 전용으로 시작한다 |

**단계 증거:** iPhone과 Mac에서 같은 vault를 열고, 한쪽에서 쓴 줄이 다른 쪽에
나타나고, 양쪽에서 같은 줄을 고쳤을 때 HLC 병합이 데스크톱과 같은 결과를 낸다.

---

### 5단계 — 출시 전

| # | 항목 |
|---|---|
| 5.1 | 서드파티 라이선스 고지 (Tabler MIT, lucide ISC — 지금 저장소에 아예 없다) |
| 5.2 | 앱 아이콘과 런치 화면 |
| 5.3 | 모바일 번들 예산을 `test:bundle`에 추가 |
| 5.4 | 큰 vault 첫 실행 성능 측정 |

## 6. 게이트

`delivering-yonalist-changes`의 표를 그대로 쓰되, 이 작업은 단계마다 경계가
움직이므로 매번 다시 고른다.

- 프런트엔드만 바뀐 항목: `npm test`, `npm run lint`, `npm run test:bundle`,
  `git diff --check`
- Rust·IPC·영속성이 바뀐 항목: 위에 더해
  `cargo test --manifest-path src-tauri/Cargo.toml`과 Rust 포맷
- 명령이 새로 생기거나 이름이 바뀐 항목: 위에 더해 `npm run test:architecture`

0단계와 4단계는 항상 Rust 행이다. 1~3단계는 대부분 프런트엔드 행이지만,
1.1이 Vite 설정을 건드리므로 그 항목만 번들 게이트를 반드시 돈다.

## 7. 지금 바로 다음에 할 일

0.1부터 시작한다. Rust iOS 타깃을 깔고 `notes-sqlite`를
`aarch64-apple-ios-sim`으로 빌드해 보는 것 — 이게 통과하지 못하면 다른 모든
계획이 의미 없고, 통과하면 제일 큰 불확실성이 하나 사라진다.
