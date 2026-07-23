import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";

const styles = readFileSync(
  join(
    process.cwd(),
    "docs/superpowers/mockups/2026-07-23-github-notifications-notes/src/styles.css"
  ),
  "utf8"
);

beforeEach(async () => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await act(async () => {
    await import("./main.jsx");
  });
});

it("keeps GitHub rows visually native while using Notes interactions", async () => {
  const user = userEvent.setup();

  expect(screen.queryByRole("button", { name: /^완료:/ })).toBeNull();

  const showCompleted = screen.getByRole("button", {
    name: "완료 항목 표시"
  });
  await user.click(showCompleted);
  expect(
    screen.queryByRole("textbox", {
      name: "알림 제목: [#45] 매뉴얼 검색 및 RAG 응답 구현 #121"
    })
  ).toBeNull();
  await user.click(showCompleted);

  const notificationTitle = screen.getByRole("textbox", {
    name: "알림 제목: [#44] 임베딩 게이트웨이 클라이언트 추가 #102"
  });
  await user.clear(notificationTitle);
  await user.type(notificationTitle, "임시 수정");
  await user.tab();
  expect(notificationTitle).toHaveValue(
    "[#44] 임베딩 게이트웨이 클라이언트 추가 #102"
  );

  const notificationNote = screen.getByRole("textbox", {
    name: "알림 설명: pi/arc-agent, 2h ago, seen 18m ago"
  });
  await user.clear(notificationNote);
  await user.type(notificationNote, "임시 설명");
  await user.tab();
  expect(notificationNote).toHaveValue("pi/arc-agent, 2h ago, seen 18m ago");

  await user.click(notificationTitle);
  await user.keyboard("{Enter}");
  const newBullet = screen.getByRole("textbox", { name: "새 블릿" });
  expect(newBullet.closest("[data-local-note]")).toHaveAttribute(
    "data-parent-notification-id",
    ""
  );
  await user.keyboard("{Tab}");
  expect(
    screen.getByRole("textbox", { name: "새 블릿" }).closest("[data-local-note]")
  ).toHaveAttribute(
    "data-parent-notification-id",
    "102"
  );

  const row = notificationTitle.closest("[data-notification-id]");
  expect(row).not.toBeNull();
  expect(
    within(row).getByRole("button", {
      name: "웹에서 열기: [#44] 임베딩 게이트웨이 클라이언트 추가 #102"
    })
  ).toBeInTheDocument();
});

it("marks only GitHub-owned rows as provider-managed", async () => {
  const user = userEvent.setup();
  const all = screen.getByLabelText("All Notes");
  const root = within(all)
    .getByRole("button", { name: "Github Notifications" })
    .closest(".row-wrap");
  const date = within(all).getByRole("button", { name: "Today" }).closest(".row-wrap");
  const notification = screen
    .getByRole("textbox", {
      name: "알림 제목: [#44] 임베딩 게이트웨이 클라이언트 추가 #102"
    })
    .closest("[data-notification-id]");

  expect(within(root).getByLabelText("GitHub에서 관리됨")).toBeInTheDocument();
  expect(within(date).getByLabelText("GitHub에서 관리됨")).toBeInTheDocument();
  expect(
    within(notification).getByLabelText("GitHub에서 관리됨")
  ).toBeInTheDocument();

  await user.click(
    within(notification).getByRole("button", {
      name: "[#44] 임베딩 게이트웨이 클라이언트 추가 #102 메뉴"
    })
  );
  expect(
    within(notification).queryByRole("menuitemcheckbox", { name: "읽기 전용" })
  ).toBeNull();
  expect(
    within(root).queryByRole("button", { name: "Github Notifications 메뉴" })
  ).toBeNull();
});

it("keeps lock and web actions adjacent with no gap after the bullet title", () => {
  const title = screen.getByRole("textbox", {
    name: "알림 제목: [#44] 임베딩 게이트웨이 클라이언트 추가 #102"
  });
  const titleLine = title.closest(".title-line");
  const actions = titleLine.querySelector(".trailing-actions");

  expect(title.nextElementSibling).toBe(actions);
  expect(actions.children[0]).toHaveAccessibleName("GitHub에서 관리됨");
  expect(actions.children[1]).toHaveAccessibleName(
    "웹에서 열기: [#44] 임베딩 게이트웨이 클라이언트 추가 #102"
  );
  expect(styles).toMatch(
    /\.title-line\s*\{[^}]*display:\s*inline-flex;[^}]*max-width:\s*100%;/s
  );
  expect(styles).toMatch(/\.row-title\s*\{[^}]*flex:\s*0 1 auto;/s);
  expect(styles).toMatch(
    /\.row-title-input\s*\{[^}]*field-sizing:\s*content;/s
  );
  expect(styles).toMatch(/\.trailing-actions\s*\{[^}]*gap:\s*0;/s);
});

it("restores locked native edits and persists unlocked edits", async () => {
  const user = userEvent.setup();
  const title = screen.getByRole("textbox", {
    name: "블릿 제목: 공유 체크리스트"
  });
  const note = screen.getByRole("textbox", {
    name: "블릿 메모: 원본 메모"
  });
  const row = title.closest("[data-native-note]");

  expect(within(row).getByLabelText("읽기 전용")).toBeInTheDocument();
  await user.clear(title);
  await user.type(title, "임시 제목");
  await user.tab();
  expect(title).toHaveValue("공유 체크리스트");
  await user.clear(note);
  await user.type(note, "임시 메모");
  await user.tab();
  expect(note).toHaveValue("원본 메모");
  await user.clear(title);
  await user.type(title, "Escape로 취소할 제목");
  await user.keyboard("{Escape}");
  expect(title).toHaveValue("공유 체크리스트");
  await user.clear(note);
  await user.type(note, "Escape로 취소할 메모");
  await user.keyboard("{Escape}");
  expect(note).toHaveValue("원본 메모");

  await user.click(title);
  await user.keyboard("{Enter}");
  const sibling = screen.getByRole("textbox", { name: "새 일반 블릿" });
  const siblingRow = sibling.closest("[data-native-note]");
  expect(siblingRow).toHaveAttribute("data-readonly", "false");
  expect(within(siblingRow).queryByLabelText("읽기 전용")).toBeNull();

  await user.click(within(row).getByRole("button", { name: "공유 체크리스트 메뉴" }));
  expect(within(row).getByRole("menuitem", { name: "Move To" })).toBeDisabled();
  expect(within(row).getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  await user.click(
    within(row).getByRole("menuitemcheckbox", { name: "읽기 전용" })
  );

  await user.clear(title);
  await user.type(title, "수정된 체크리스트");
  await user.tab();
  expect(title).toHaveValue("수정된 체크리스트");
  await user.clear(note);
  await user.type(note, "저장된 메모");
  await user.tab();
  expect(note).toHaveValue("저장된 메모");
});

it("confirms deleting an ancestor that contains a readonly bullet", async () => {
  const user = userEvent.setup();
  const openAncestorMenu = () =>
    user.click(screen.getByRole("button", { name: "2026-07-23 메뉴" }));

  await openAncestorMenu();
  expect(screen.getByRole("menuitem", { name: "Move To" })).toBeDisabled();
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent(
    "읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?"
  );
  const cancel = within(dialog).getByRole("button", { name: "취소" });
  const confirm = within(dialog).getByRole("button", { name: "삭제" });
  expect(cancel).toHaveFocus();
  await user.tab();
  expect(confirm).toHaveFocus();
  await user.tab();
  expect(cancel).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "2026-07-23 메뉴" })).toHaveFocus();
  expect(
    screen.getByRole("textbox", { name: "블릿 제목: 공유 체크리스트" })
  ).toBeInTheDocument();

  await openAncestorMenu();
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "삭제" })
  );
  expect(
    screen.queryByRole("textbox", { name: "블릿 제목: 공유 체크리스트" })
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "2026-07-23 메뉴" })).toBeNull();
  expect(
    within(screen.getByLabelText("All Notes")).getByRole("button", {
      name: "Daily"
    })
  ).toHaveFocus();
  await waitFor(() => {
    expect(
      JSON.parse(window.localStorage.getItem("yona-mock-native-date-visible"))
    ).toBe(false);
    expect(JSON.parse(window.localStorage.getItem("yona-mock-native-notes"))).toEqual([]);
  });
});

it("lets a local GitHub child use the ordinary readonly behavior", async () => {
  const user = userEvent.setup();
  const title = screen.getByRole("textbox", {
    name: "블릿 제목: 배포 전에 API 응답 형식 확인"
  });
  const row = title.closest("[data-local-note]");

  await user.click(
    within(row).getByRole("button", {
      name: "배포 전에 API 응답 형식 확인 메뉴"
    })
  );
  const toggle = within(row).getByRole("menuitemcheckbox", {
    name: "읽기 전용"
  });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  await user.click(toggle);
  expect(within(row).getByLabelText("읽기 전용")).toBeInTheDocument();

  await user.clear(title);
  await user.type(title, "임시 하위 메모");
  await user.tab();
  expect(title).toHaveValue("배포 전에 API 응답 형식 확인");
  expect(row).toHaveAttribute("data-parent-notification-id", "102");

  title.focus();
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  const childNote = screen.getByRole("textbox", {
    name: "블릿 메모: 배포 전에 API 응답 형식 확인"
  });
  await user.type(childNote, "저장되지 않을 메모");
  await user.keyboard("{Escape}");
  expect(title).toHaveFocus();
  expect(
    screen.queryByRole("textbox", {
      name: "블릿 메모: 배포 전에 API 응답 형식 확인"
    })
  ).toBeNull();

  title.focus();
  await user.keyboard("{Enter}");
  const sibling = screen.getByRole("textbox", { name: "새 블릿" });
  expect(sibling.closest("[data-local-note]")).toHaveAttribute(
    "data-parent-notification-id",
    "102"
  );
  expect(sibling.closest("[data-local-note]")).toHaveAttribute(
    "data-readonly",
    "false"
  );
});

it("preserves IME input and follows the provider note focus contract", async () => {
  const user = userEvent.setup();
  const title = screen.getByRole("textbox", {
    name: "알림 제목: 가드레일 위반 및 오류 시스템 메시지 처리 #116"
  });
  const note = screen.getByRole("textbox", {
    name: "알림 설명: pi/arc-agent, 5h ago"
  });

  fireEvent.keyDown(title, {
    key: "Enter",
    code: "Enter",
    isComposing: true
  });
  expect(screen.queryByRole("textbox", { name: "새 블릿" })).toBeNull();

  note.focus();
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  await user.click(screen.getByRole("button", { name: "완료 항목 표시" }));
  expect(note).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "완료 항목 표시" }));

  note.focus();
  await user.type(note, "임시");
  await user.keyboard("{Escape}");
  expect(title).toHaveFocus();
  expect(note).toHaveValue("pi/arc-agent, 5h ago");

  note.focus();
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(screen.getByRole("textbox", { name: "새 블릿" })).toBeInTheDocument();
});

it("keeps supporting-note focus explicit and exposes a keyboard-operable readonly menu", async () => {
  const user = userEvent.setup();
  const providerTitle = screen.getByRole("textbox", {
    name: "알림 제목: [#44] 임베딩 게이트웨이 클라이언트 추가 #102"
  });
  const providerNote = screen.getByRole("textbox", {
    name: "알림 설명: pi/arc-agent, 2h ago, seen 18m ago"
  });
  const title = screen.getByRole("textbox", {
    name: "블릿 제목: 배포 전에 API 응답 형식 확인"
  });
  const row = title.closest("[data-local-note]");
  const trigger = within(row).getByRole("button", {
    name: "배포 전에 API 응답 형식 확인 메뉴"
  });

  providerTitle.focus();
  await user.keyboard("{ArrowDown}");
  expect(providerNote).toHaveFocus();
  providerNote.setSelectionRange(providerNote.value.length, providerNote.value.length);
  await user.keyboard("{ArrowDown}");
  expect(title).toHaveFocus();

  await user.click(trigger);
  const toggle = within(row).getByRole("menuitemcheckbox", {
    name: "읽기 전용"
  });
  expect(toggle).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(within(row).getByRole("menuitem", { name: "Move To" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();

  await user.keyboard("{Enter}");
  await user.keyboard("{Enter}");
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.keyboard("{Enter}");
  expect(trigger).toHaveFocus();

  title.focus();
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  const note = screen.getByRole("textbox", {
    name: "블릿 메모: 배포 전에 API 응답 형식 확인"
  });
  await user.type(note, "다시 펼쳐도 포커스를 훔치지 않는 메모");
  await user.tab();

  const collapse = screen.getByRole("button", {
    name: "[#44] 임베딩 게이트웨이 클라이언트 추가 #102 접기"
  });
  await user.click(collapse);
  await user.click(
    screen.getByRole("button", {
      name: "[#44] 임베딩 게이트웨이 클라이언트 추가 #102 펼치기"
    })
  );
  expect(
    screen.getByRole("button", {
      name: "[#44] 임베딩 게이트웨이 클라이언트 추가 #102 접기"
    })
  ).toHaveFocus();
  expect(
    screen.getByRole("textbox", {
      name: "블릿 메모: 배포 전에 API 응답 형식 확인"
    })
  ).not.toHaveFocus();
});

it("reorders the GitHub root once for both the sidebar and All", async () => {
  const user = userEvent.setup();
  const all = screen.getByLabelText("All Notes");
  const githubRoot = within(all).getByRole("button", {
    name: "Github Notifications"
  });

  githubRoot.focus();
  await user.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");

  const pageIds = (container) =>
    [...container.querySelectorAll(":scope > [data-page-id]")].map(
      (element) => element.dataset.pageId
    );
  const sidebar = screen.getByRole("list", { name: "Top level Notes pages" });
  expect(pageIds(sidebar)).toEqual(["start", "daily", "github", "idea", "today"]);
  expect(pageIds(all)).toEqual(pageIds(sidebar));

  await user.click(screen.getByRole("button", { name: "데모 초기화" }));
  expect(pageIds(sidebar)).toEqual(["start", "github", "daily", "idea", "today"]);
  expect(pageIds(all)).toEqual(pageIds(sidebar));
});
