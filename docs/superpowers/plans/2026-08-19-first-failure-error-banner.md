# state.error, 한 실행 안에서는 첫 실패가 이긴다

작성 2026-08-19. 설계는 이 문서까지, 구현은 Opus 5 xHigh가 `fable-opus-loop`
루프로 이어간다.

## 배경

`beginCreateNode`(`apps/desktop/src/store/storeOutlineMutations.ts:104`)는
`createNode`와 뒤이은 `setMarker`를 같은 history group으로 묶어 큐에 나란히
넣는다. `createNode`가 실패해도 큐는 멈추지 않고 `setMarker`를 마저 돌리며
(`storeCommands.ts`의 큐는 앞선 명령의 실패를 삼키고 다음 명령으로 넘어가도록
설계돼 있다), 존재하지 않는 행을 대상으로 한 `setMarker`도 제 나름의 사유로
실패한다. 두 실패가 같은 `state.error`에 차례로 쓰이므로 화면에는 나중 실패,
즉 "그 행이 없다"는 문구만 남고 진짜 원인인 `createNode`의 실패는 지워진다.
`pending.committed`가 던지는 사유는 이미 맞고 낙관적 롤백도 이미 맞다. 틀린
것은 배너 문구 하나뿐이다.

## 지금 코드가 하는 일

`state.error`를 쓰는 곳은 `storeCommands.ts`의 private `enqueue`
(63~203행) 한 곳뿐이다. `execute`, `executeExternal`, `executeHistory`
세 공개 메서드가 전부 이 `enqueue`를 거쳐 큐에 들어가므로, 여기가 모든 호출자가
지나는 하나의 길목이다.

```
private enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const queued = this.commandQueue.then(async () => {
    const state = this.host.read();
    this.host.write({
      pendingWrites: state.pendingWrites + 1,
      error: null                              // 매 명령 시작마다 지운다
    }, { shell: true });
    try {
      return await operation();
    } catch (cause) {
      this.host.write({ error: messageFrom(cause) }, { shell: true }); // 무조건 덮어쓴다
      throw cause;
    } finally {
      this.host.write({
        pendingWrites: Math.max(0, this.host.read().pendingWrites - 1)
      }, { shell: true });
    }
  });
  this.commandQueue = queued.then(() => undefined, () => undefined);
  return queued;
}
```

두 가지가 겹쳐 지금의 버그를 만든다.

- 큐에 들어오는 **모든** 명령이 자기 차례가 오면 `error: null`부터 쓴다. 그래서
  `createNode`가 남긴 실패 문구를 `setMarker`가 자기 차례를 시작하며 지운다.
- `catch`도 조건 없이 쓴다. 그래서 `setMarker`의 실패가 다시 그 자리를
  차지한다.

다른 쓰기·읽기 자리도 확인했다. `storeState.ts`의 `viewportState`가
`error: null`을 한 번 더 쓰지만 이건 페이지 뷰포트를 성공적으로 읽었을 때
뿐이고 큐와 무관하다. `notesState.ts`는 초깃값만 갖고 있다. `storeImages.ts`의
`catch (error)`는 지역 변수 이름일 뿐 `NotesState.error`를 쓰지 않는다.
`storeSubscriptions.ts`는 `shellSnapshot`으로 그대로 옮길 뿐이다. 읽는 쪽은
`App.tsx:880`의 배너와 `storeSubscriptions.ts:108`이며, `NotesOutline.tsx`의
`imageIngest.error`는 이미지 인입 전용의 별개 상태라 이 경로와 섞이지 않는다.
그러므로 고칠 자리는 `enqueue` 하나로 닫혀 있다.

### "한 실행"을 무엇으로 잡는가

`pendingWrites`는 `enqueue`의 콜백 **안에서** 늘고 줄므로 큐가 직렬로 도는 한
항상 0 아니면 1이다. `beginCreateNode`가 `createNode`와 `setMarker`를 잇달아
동기적으로 큐에 넣어도, 그 사실은 콜백이 시작되기 전에는 어디에도 남지 않는다.
그래서 `pendingWrites`만으로는 "지금 실패한 명령 뒤에 이미 줄 선 것이 더
있는가"를 알 수 없다.

그 정보를 보관할 자리로 `enqueue` 호출 시점에 동기적으로 증가하는 카운터를
둔다. 콜을 `runDepth`라 부른다.

- `enqueue`가 불릴 때 — 아직 큐 콜백이 아니라 `execute`/`executeExternal`/
  `executeHistory`가 호출된 그 순간, 곧 `createNode`와 `setMarker`가 나란히
  불리는 바로 그 자리 — `runDepth`가 0이면 이번 호출이 "새 실행의 시작"이고,
  0보다 크면 "이미 흐르고 있는 실행의 연속"이다. 이 판정을 `startsNewRun`이라는
  이름으로 그 호출의 클로저에 캡처해 둔다.
- 판정 직후 `runDepth`를 1 늘린다.
- 그 명령이 성공하든 실패하든 완전히 끝나는 시점 — 지금 `pendingWrites`를
  줄이는 바로 그 `finally` — 에서 `runDepth`를 1 줄인다.

이렇게 하면 `runDepth`는 "큐에 들어왔지만 아직 끝나지 않은 명령의 수"를 언제나
정확히 들고 있다. 동기적으로 잇달아 들어온 명령들은 큐가 한 번도 비지 않은 채
이어지므로 하나의 "실행"으로 묶이고, 큐가 완전히 빈 다음에 시작된 명령은 새
실행이다. 사용자가 이전 동작이 아직 끝나기 전에 다음 동작을 시작해 두 실행이
큐 위에서 맞물려도, 이 정의로는 자연스럽게 하나의 실행으로 합쳐진다 — 그
경우도 뒤엣것의 실패가 앞엣것의 배너를 덮어쓰지 않아야 한다는 요구와 결이
같다.

### 쓰기 규칙

- 명령 시작: `error: null`은 `startsNewRun`일 때만 쓴다. 실행 중간의 명령은
  이 키 자체를 patch에 넣지 않는다.
- 실패 시: `this.host.read().error`가 아직 `null`일 때만
  `error: messageFrom(cause)`를 쓴다. 같은 실행 안에서 이미 앞선 실패가
  적혀 있으면 건드리지 않는다. 큐는 한 번에 한 콜백만 실행하므로(각
  `enqueue` 호출은 이전 콜백이 정착한 뒤에야 시작한다) 이 읽기·쓰기 사이에
  다른 명령이 끼어들 여지가 없다.
- 배너가 다시 지워지는 시점은 정확히 하나: 큐가 완전히 빈 뒤 시작하는
  **다음** 실행의 첫 명령이 제 차례를 시작할 때. 그 실행이 이어서 성공만
  하면 배너는 그 지워진 채로 남는다(성공 경로는 `error`를 건드리지 않으므로).
  그 실행 중 하나라도 실패하면 위 규칙대로 그 실행의 첫 실패가 다시 자리를
  잡는다.

`pendingWrites` 자체의 증감 지점과 의미는 바꾸지 않는다. 이 문제는 `error`
필드 하나에 관한 것이다.

## 계약

| 항목 | 내용 |
| --- | --- |
| 목표 | 한 실행 안에서 여러 명령이 잇달아 실패해도 `state.error`는 그 실행의 첫 실패 사유를 담고, 다음 실행이 시작되면 배너는 다시 지워질 수 있다 |
| 비대상 | `pending.committed`가 던지는 사유 변경(이미 맞다). 낙관적 롤백 로직 변경(이미 맞다). `setMarker`나 `createNode` 각각의 오류 문구 자체를 손보는 것. `pendingWrites`/"Saving..." 표시 로직. `NotesState`에 새 필드 추가. IPC 페이로드나 Rust 쪽 변경 — 이 버그는 프런트엔드의 큐 상태 관리에만 있다 |
| 영향 경계 | React/TS만. `apps/desktop/src/store/storeCommands.ts`의 private `enqueue` 하나. 테스트는 `apps/desktop/src/store/storeCommands.test.ts` |
| 직접 확인할 사용자 시나리오 | 빈 페이지에서 체크박스가 아닌 새 항목(⌘+Enter 등 marker가 bullet이 아닌 생성 경로)을 만들 때 백엔드 오프라인 등으로 `createNode`가 실패하도록 만들면, 배너에는 "행을 만들지 못했다"류의 createNode 실패 문구가 남아야 한다(지금은 "그 행이 없다"류의 setMarker 실패 문구가 남는다). 수동 확인은 게이트가 프런트엔드 전용이라 N/A로 남겨도 되고, 필요하면 목데이터로 `createNode` 실패를 강제하는 개발자 경로로 재현한다 |

### 인수 조건

| # | 조건 | 아이템 |
| --- | --- | --- |
| A1 | 한 실행 안에서 앞선 명령이 실패하고 뒤이은 명령도 실패하면, `state.error`는 앞선(첫) 실패의 메시지를 담는다 | 1 |
| A2 | 그 실행이 완전히 끝난 뒤 시작한 다음 실행이 성공하면, `state.error`는 `null`로 돌아온다 | 1 |

두 조건 모두 하나의 아이템, 하나의 테스트로 잠근다.

## 아이템

### 아이템 1 — `enqueue`가 실행 경계를 세고 첫 실패만 배너에 쓴다

`storeCommands.ts`의 private `enqueue`를 위 "쓰기 규칙"대로 고친다. private
필드 `runDepth`(초깃값 0)를 추가하고, `enqueue` 호출 시점에 동기적으로
`startsNewRun`을 판정 및 캡처한 뒤 증가시키고, 콜백의 시작부는 `startsNewRun`일
때만 `error: null`을 patch에 포함시키며, `catch`는 `this.host.read().error`가
`null`일 때만 쓰고, `finally`는 `pendingWrites`를 줄이는 것과 나란히
`runDepth`도 줄인다.

**실패하는 테스트**

- 파일: `apps/desktop/src/store/storeCommands.test.ts`
- 테스트 이름: `"keeps the first failure's message when a later command in the same run also fails, then clears it on the next successful run"`
- 위치: 기존 `describe("StoreCommands", ...)` 블록 안, 다른 `it`들과 나란히
- 무엇을 검증하는가: `createNode`와 `setMarker`를 `beginCreateNode`가 하는
  그대로(같은 history group, 첫 호출 직후 두 번째 호출이 동기적으로 이어짐)
  두 번 `execute`하되, `api.execute`가 첫 번째는 `"Could not create the
  row."`로, 두 번째는 `"That row no longer exists."`로 각각 reject하도록
  목을 만든다. 두 프라미스가 정착한 뒤 `state.error`가 첫 번째 메시지와
  같은지 확인한다. 이어서 큐가 빈 상태에서 성공하는 명령을 하나 더
  `execute`해 `state.error`가 다시 `null`이 되는지 확인한다.

```ts
it(
  "keeps the first failure's message when a later command in the same " +
  "run also fails, then clears it on the next successful run",
  async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1
    };
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("Could not create the row."))
      .mockRejectedValueOnce(new Error("That row no longer exists."))
      .mockResolvedValueOnce(receipt(2));
    const commands = new StoreCommands(api(execute), {
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      applyReceipt: (next) => {
        state = { ...state, revision: next.revision };
      },
      flushDrafts: () => Promise.resolve(),
      materializePage: () => Promise.resolve(),
      capturePaneSnapshot: () => null
    });

    const historyGroup = "create:a";
    const first = commands.execute(
      { kind: "createNode", id: "a", parent_id: "root", before_id: null, text: "" },
      historyGroup
    );
    const second = commands.execute(
      { kind: "setMarker", id: "a", marker: "todo" },
      historyGroup
    );
    await Promise.allSettled([first, second]);

    expect(state.error).toBe("Could not create the row.");

    await commands.execute(
      { kind: "setStarred", id: "bullet-1", starred: true }
    );

    expect(state.error).toBeNull();
  }
);
```

- 지금 코드로 돌린 red 출력: 첫 번째 `expect`에서 그대로 멈춘다. 지금
  `enqueue`는 `setMarker`의 차례가 시작될 때 `error: null`부터 쓴 뒤 그
  실패로 다시 덮어쓰므로 최종값은 두 번째 메시지다.

  ```
  FAIL apps/desktop/src/store/storeCommands.test.ts > StoreCommands >
  keeps the first failure's message when a later command in the same run
  also fails, then clears it on the next successful run
  AssertionError: expected 'That row no longer exists.' to be
  'Could not create the row.'

  - Expected
  + Received

  - Could not create the row.
  + That row no longer exists.
  ```

- 고친 뒤: `createNode`가 `startsNewRun = true`로 시작해 `error`를 지우고
  자기 실패를 적는다. `setMarker`는 같은 실행의 연속(`startsNewRun = false`)
  이라 `error: null`을 쓰지 않고, 자기 `catch`에 들어가도 `state.error`가
  이미 채워져 있어 건너뛴다. 최종 `state.error`는 `"Could not create the
  row."`. 큐가 빈 뒤 시작한 세 번째 명령은 `startsNewRun = true`라
  `error: null`을 쓰고 성공하므로 그대로 `null`로 남는다. 두 `expect` 모두
  통과한다.

## 게이트

프런트엔드 전용 변경이므로 `delivering-yonalist-changes`의 표대로
`npm test`, `npm run lint`, `npm run build`, `git diff --check`. Rust/Cargo
게이트는 건드리는 경계가 없으므로 생략한다.
