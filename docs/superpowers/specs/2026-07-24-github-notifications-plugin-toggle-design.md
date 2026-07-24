# GitHub Notifications 플러그인 켜기/끄기 설계

## 상태

- 날짜: 2026-07-24
- 상태: 승인됨

## 목표

Settings의 Plugins 화면에서 GitHub Notifications를 켜거나 끌 수 있게 한다.
플러그인을 끄면 Notes에서 GitHub Notifications 페이지를 숨기고 Notes가 요청한
알림 가져오기를 중단한다. 기존 Inbox는 계속 작동한다.

기존에 Notes와 로컬 캐시에 저장된 알림은 지우지 않는다. 플러그인을 다시 켜면
저장된 내용을 그대로 보여 주고 최신 알림을 다시 가져온다.

## 범위

### 포함

- `AppSettings`에 `githubNotificationsPluginEnabled: boolean` 추가
- 기존 사용자에게는 기본값 `true` 적용
- Settings → Plugins에 `GitHub Notifications 사용` 체크박스 추가
- 플러그인을 끈 동안 읽은 알림 보관 기간 입력란 비활성화
- Notes 목록과 Notes 외부 소스 화면에서 GitHub Notifications 숨김
- GitHub Notifications 페이지를 열어 둔 상태에서 끄면 Notes 전체 목록으로 이동
- Notes가 요청한 GitHub 알림 가져오기와 주기 실행 중단

### 제외

- Inbox의 GitHub Notifications 동작 변경
- GitHub 로그인 상태 변경
- 저장된 Notes 노드나 외부 소스 캐시 삭제
- 여러 플러그인을 위한 범용 설정 체계
- Rust 저장소 스키마 변경

## 설정 저장

`AppSettings`와 `defaultSettings`에 `githubNotificationsPluginEnabled`를 추가한다.
기존 저장값에 필드가 없으면 `true`로 보정한다. `settingsNeedNormalization`도 이
필드를 검사하므로 다음 저장 때 현재 형식으로 정리된다.

체크박스는 다른 앱 설정과 같은 흐름을 사용한다. 사용자가 값을 바꾸면 현재
세션에 바로 반영하고 `Save settings`를 누르면 `yonalist.settings.v1`에 저장한다.

## 실행 흐름

`App`은 설정이 켜진 경우에만 GitHub 외부 소스 페이지를
`ExternalSourcesContext.pages`에 넣는다. Notes는 이미 이 목록에서 GitHub
페이지를 찾고 있으므로 별도 플러그인 레지스트리나 새 컨텍스트 필드는 만들지
않는다.

Notes가 GitHub 알림을 가져오는 조건에도 설정값을 추가한다.

```text
GitHub 인증 완료
AND 온라인
AND Notes가 GitHub 페이지를 요청함
AND 플러그인 사용
```

Inbox 활성 조건은 그대로 둔다. 따라서 플러그인을 꺼도 사용자가 Inbox를 열면
Inbox에 필요한 GitHub 알림은 기존 경로로 가져온다.

Notes에서 쓰는 `refreshExternalProvider`와 `completeExternalBullet`도 설정이
꺼진 동안 요청을 거절한다. 화면이 바뀌는 순간 들어온 오래된 요청이 알림
가져오기나 완료 처리를 다시 시작하지 못하게 한다. Inbox는 이 콜백을 쓰지
않으므로 영향을 받지 않는다.

## Notes 화면 동작

Notes 목록은 외부 소스 목록에 GitHub 페이지가 있을 때만 저장된
`GitHub Notifications` 루트 행을 보여 준다. 루트 노드와 자식 노드는 저장소에
그대로 남는다.

플러그인을 끌 때 GitHub Notifications 페이지가 열려 있으면 `zoomRootId`를
전체 목록으로 돌린다. 숨긴 페이지에 머무르거나 빈 화면을 보여 주지 않는다.
다시 켜면 저장된 루트 행이 목록에 나타나며 사용자가 열었을 때 가져오기를
다시 시작한다.

## 오류 처리

새 네트워크 호출이나 저장소 작업은 추가하지 않는다. 설정을 끄고 Inbox도
열려 있지 않으면 `useExternalSource`가 외부 소스 사용을 끝낸다. 진행 중인
Notes 알림 요청은 취소되고 주기 실행도 중단된다. Inbox가 열려 있으면 기존
활성 조건이 유지되므로 Inbox에 필요한 요청은 계속 처리한다.

브라우저 저장소에 설정을 쓰지 못할 때는 기존 설정 저장 동작을 따른다. 현재
세션의 선택은 유지되지만 다음 실행에는 저장되지 않는다.

## 검증

- 설정 기본값과 이전 저장값 보정
- 설정 저장과 다시 불러오기
- Plugins 체크박스가 설정 변경 콜백을 호출하는지 확인
- 플러그인을 끄면 보관 기간 입력란이 비활성화되는지 확인
- 플러그인을 끄면 Notes 외부 소스 목록에서 GitHub 페이지가 빠지는지 확인
- Notes에서 GitHub 루트 행을 숨기고 열린 페이지를 전체 목록으로 돌리는지 확인
- Notes 플러그인이 꺼져도 Inbox의 GitHub 알림 활성 조건이 유지되는지 확인
