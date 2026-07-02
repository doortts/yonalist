import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as windowDrag from "./windowDrag";

function installLocalStorageMock() {
  let store: Record<string, string> = {};
  const localStorageMock = {
    get length() {
      return Object.keys(store).length;
    },
    clear: vi.fn(() => {
      store = {};
    }),
    getItem: vi.fn((key: string) => store[key] ?? null),
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = String(value);
    })
  } as Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock
  });
}

describe("Yonalist app shell", () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  it("shows the offline badge at the top of the first column", () => {
    render(<App initialOnline={false} />);

    const leftColumn = screen.getByLabelText("Navigation");
    expect(within(leftColumn).getByText("Offline")).toBeInTheDocument();
  });

  it("marks the top-left titlebar area as the native window drag region", () => {
    render(<App />);

    expect(screen.getByLabelText("Window drag region")).toHaveAttribute(
      "data-tauri-drag-region"
    );
  });

  it("starts native dragging from the top-left titlebar area", async () => {
    const user = userEvent.setup();
    const startDrag = vi
      .spyOn(windowDrag, "startNativeWindowDrag")
      .mockResolvedValue(undefined);
    render(<App />);

    await user.pointer({
      keys: "[MouseLeft>]",
      target: screen.getByLabelText("Window drag region")
    });

    expect(startDrag).toHaveBeenCalledTimes(1);
    startDrag.mockRestore();
  });

  it("toggles the red bookmark favorite control in the detail header", async () => {
    const user = userEvent.setup();
    render(<App />);

    const bookmark = screen.getByRole("button", { name: /toggle favorite/i });
    expect(bookmark).toHaveAttribute("aria-pressed", "true");

    await user.click(bookmark);

    expect(bookmark).toHaveAttribute("aria-pressed", "false");
  });

  it("creates an offline comment draft and shows it in the outbox", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.type(
      screen.getByLabelText("Write a comment"),
      "I can write this offline."
    );
    await user.click(screen.getByRole("button", { name: "Queue comment" }));
    await user.click(screen.getByRole("button", { name: /outbox/i }));

    expect(screen.getByText("Pending sync")).toBeInTheDocument();
    expect(screen.getByText(/I can write this offline/)).toBeInTheDocument();
  });

  it("opens the new issue composer as the full right pane", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "New issue" }));

    expect(screen.getByLabelText("New issue composer")).toBeInTheDocument();
    expect(screen.queryByText("Issue conversation")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Issue title"), "A local draft");
    await user.click(screen.getByRole("button", { name: "Queue issue" }));

    expect(screen.getAllByText("A local draft").length).toBeGreaterThan(0);
  });

  it("asks which queued changes to sync when the app comes back online", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.type(screen.getByLabelText("Write a comment"), "Sync this later.");
    await user.click(screen.getByRole("button", { name: "Queue comment" }));
    await user.click(screen.getByRole("button", { name: "Go online" }));

    expect(screen.getByRole("dialog", { name: "Outbox" })).toBeInTheDocument();
    expect(screen.getByText("Choose queued changes to sync.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync selected" })).toBeEnabled();
  });

  it("opens settings and saves vault preferences", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByLabelText("Settings page")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Vault folder"));
    await user.type(screen.getByLabelText("Vault folder"), "/Users/doortts/Yonalist");
    await user.click(screen.getByLabelText("Cache linked attachments"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(screen.getByText("Settings saved")).toBeInTheDocument();
    expect(window.localStorage.getItem("yonalist.settings.v1")).toContain(
      "/Users/doortts/Yonalist"
    );
    expect(screen.getByLabelText("Cache linked attachments")).not.toBeChecked();
  });

  it("lists default GitHub servers and switches the selected one", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    const section = screen.getByLabelText("GitHub servers");
    const naver = within(section).getByRole("radio", {
      name: "네이버 — https://oss.navercorp.com/api/v3"
    });
    const github = within(section).getByRole("radio", {
      name: "Github — https://api.github.com"
    });
    expect(naver).toBeChecked();
    expect(
      within(section).getByRole("button", { name: "Login to Github" })
    ).toBeInTheDocument();

    await user.click(github);

    expect(github).toBeChecked();
    expect(
      within(section).getByText("서버를 변경했습니다. 새 서버로 다시 로그인하세요.")
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem("yonalist.github.apiBaseUrl.v1")
    ).toBe("https://api.github.com");
  });

  it("adds a custom GHE server with a personal token", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    const section = screen.getByLabelText("GitHub servers");
    await user.click(within(section).getByRole("button", { name: /URL 추가/ }));

    await user.type(
      within(section).getByLabelText("API Base URL"),
      "https://ghe.example.com/api/v3"
    );
    await user.type(within(section).getByLabelText("별칭"), "사내 GHE");
    await user.click(within(section).getByRole("radio", { name: "개인 토큰" }));
    await user.type(
      within(section).getByLabelText("Personal Access Token"),
      "ghp_test_token"
    );
    await user.click(within(section).getByRole("button", { name: "추가" }));

    expect(
      within(section).getByRole("radio", {
        name: "사내 GHE — https://ghe.example.com/api/v3"
      })
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem("yonalist.github.personalTokens.v1")
    ).toContain("ghp_test_token");

    // Selecting the token-backed server signs in without the OAuth flow.
    await user.click(
      within(section).getByRole("radio", {
        name: "사내 GHE — https://ghe.example.com/api/v3"
      })
    );
    expect(within(section).getByText("개인 토큰으로 인증됨")).toBeInTheDocument();
  });

  it("shows grouped sample notifications and hides one on demand", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    const pane = screen.getByLabelText("Notifications");
    expect(within(pane).getByText("Today")).toBeInTheDocument();
    expect(
      within(pane).getByText("Design offline issue reading")
    ).toBeInTheDocument();

    const hideButtons = within(pane).getAllByRole("button", {
      name: "Hide notification"
    });
    await user.click(hideButtons[0]);

    expect(
      within(pane).queryByText("Design offline issue reading")
    ).not.toBeInTheDocument();

    await user.click(within(pane).getByLabelText("Show hidden notifications"));

    expect(
      within(pane).getByText("Design offline issue reading")
    ).toBeInTheDocument();
  });

  it("shows the selected notification's conversation in the detail pane", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));

    const detailPane = screen.getByLabelText("Detail");
    expect(
      within(detailPane).getByLabelText("Empty notification detail")
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Design offline issue reading/ })
    );

    expect(
      within(detailPane).getByRole("heading", {
        name: "Design offline issue reading"
      })
    ).toBeInTheDocument();
    expect(
      within(detailPane).getByText(/Offline-first reading keeps GitHub work/)
    ).toBeInTheDocument();
    expect(
      within(detailPane).getByText(
        /Sample reply so the conversation thread layout is visible offline/
      )
    ).toBeInTheDocument();
  });

  it("switches themes from the settings page and persists the choice", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Dark theme" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("dark");

    await user.click(screen.getByRole("radio", { name: "Light theme" }));

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resizes panes from the column separators", () => {
    render(<App />);

    const layout = screen.getByLabelText("Yonalist layout");
    const navigationResizer = screen.getByRole("separator", {
      name: "Resize navigation pane"
    });
    const listResizer = screen.getByRole("separator", {
      name: "Resize item list pane"
    });

    fireEvent.pointerDown(navigationResizer, { clientX: 280, button: 0 });
    fireEvent.pointerMove(window, { clientX: 340 });
    fireEvent.pointerUp(window);

    expect(layout).toHaveStyle("--sidebar-width: 340px");
    expect(window.localStorage.getItem("yonalist.paneWidths.v1")).toContain(
      '"sidebar":340'
    );

    fireEvent.pointerDown(listResizer, { clientX: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 540 });
    fireEvent.pointerUp(window);

    expect(layout).toHaveStyle("--list-width: 320px");
  });
});
