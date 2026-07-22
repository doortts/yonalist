import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

it("keeps GitHub rows visually native while using Notes interactions", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("./main.jsx");
  });
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
