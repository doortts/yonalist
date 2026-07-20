# 이미지 블릿 텍스트 기준선 안정화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미지와 텍스트가 함께 있는 블릿의 비편집 오버레이와 편집 원본 텍스트가 동일한 세로 기준선을 사용하게 한다.

**Architecture:** `ImageAtomEditor`의 기존 이중 표현 구조는 유지한다. 절대 배치 오버레이 컨테이너가 부모 텍스트 영역의 계산된 패딩을 상속하게 해, 포커스 상태와 무관하게 두 표현의 콘텐츠 시작점을 일치시킨다.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, CSS

## Global Constraints

- 이미지 앞·뒤 텍스트에 같은 규칙을 적용한다.
- 이미지 크기·배치, 이미지 선택 테두리, 토큰 표현, IME 입력, 키보드 명령은 변경하지 않는다.
- IPC, Rust, SQLite, 파일 저장, Undo/Redo 경계는 변경하지 않는다.
- 현재 2px 값에 결합된 별도 보정값이나 상태별 transform을 추가하지 않는다.

---

### Task 1: 오버레이와 원본 텍스트의 패딩 기준선 통일

**Files:**
- Modify: `src/features/notes/ImageAtomEditor.test.tsx`
- Modify: `src/features/notes/ImageAtomEditor.tsx`

**Interfaces:**
- Consumes: 각 `data-image-atom-region`이 소유한 계산된 패딩
- Produces: 앞·뒤 `data-image-atom-overlay-container`에 공통으로 적용되는 `padding: inherit`

- [ ] **Step 1: 실패하는 회귀 테스트 작성**

`shows independently parsed overlays at rest and reveals raw segment text while editing` 테스트 근처에 다음 테스트를 추가한다.

```tsx
it("inherits each text region padding so resting and editing baselines stay aligned", () => {
  const { host } = renderEditor({
    draft: { title: "beforeafter", note: "support", imageOffsetUtf16: 6 }
  });
  const overlays = host.querySelectorAll<HTMLElement>(
    "[data-image-atom-overlay-container]"
  );

  expect(overlays).toHaveLength(2);
  for (const overlay of overlays) {
    expect(overlay).toHaveStyle({
      position: "absolute",
      inset: "0",
      padding: "inherit"
    });
  }
});
```

- [ ] **Step 2: 테스트가 예상한 이유로 실패하는지 확인**

Run:

```sh
npm test -- src/features/notes/ImageAtomEditor.test.tsx
```

Expected: 새 테스트만 `padding: inherit`이 없어 실패하고 기존 72개 테스트는 통과한다.

- [ ] **Step 3: 최소 구현 적용**

`ImageAtomEditor.tsx`의 공통 `overlayStyle`에 패딩 상속을 추가한다.

```tsx
const overlayStyle = {
  position: "absolute" as const,
  inset: 0,
  padding: "inherit",
  pointerEvents: editing ? ("none" as const) : ("auto" as const),
  visibility: editing ? ("hidden" as const) : ("visible" as const)
};
```

- [ ] **Step 4: 집중 테스트와 diff 검사를 통과시킨다**

Run:

```sh
npm test -- src/features/notes/ImageAtomEditor.test.tsx
git diff --check
```

Expected: `ImageAtomEditor.test.tsx`의 73개 테스트가 모두 통과하고 `git diff --check` 출력이 없다.

- [ ] **Step 5: 구현 커밋 생성**

```sh
git add src/features/notes/ImageAtomEditor.test.tsx src/features/notes/ImageAtomEditor.tsx
git commit -m "fix(notes): stabilize image atom text baseline"
```

## 최종 검증

- 별도 실행 앱에서 이미지 뒤 텍스트와 이미지 앞 텍스트를 각각 포커스·선택해 세로 위치가 고정되는지 확인한다.
- 변경 범위가 프런트엔드뿐이므로 `npm test`, `npm run lint`, `npm run build`, `git diff --check`를 한 번씩 실행한다.
- Cargo 테스트, Rust 포맷, Clippy는 실행하지 않는다.
