import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubConnectionContext } from "../GithubConnectionContext";
import type { ItemDocument } from "../domain/types";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { ItemListPane } from "./ItemListPane";

const fetchUserProfilesMock = vi.hoisted(() => vi.fn());

vi.mock("../services/userProfiles", () => ({
  fetchUserProfiles: fetchUserProfilesMock
}));

const signedInConnection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

const baseItem: ItemDocument = {
  path: "/vault/github.com/acme/app/issues/42/issue.md",
  body: "Body",
  frontMatter: {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 42,
    title: "Fix login",
    state: "open",
    author: "mona",
    labels: ["bug"],
    label_colors: { bug: "b60205" },
    comments_count: 3,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  }
};

function itemAt(index: number): ItemDocument {
  return {
    ...baseItem,
    path: `/vault/github.com/acme/app/issues/${index}/issue.md`,
    frontMatter: {
      ...baseItem.frontMatter,
      number: index,
      title: `Issue ${index}`,
      updated_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`
    }
  };
}

function renderPane(items: ItemDocument[]) {
  return render(
    <ItemListPane
      items={items}
      selectedPath={null}
      stateFilter="open"
      query=""
      loading={false}
      error={null}
      demoMode={false}
      onStateFilterChange={vi.fn()}
      onQueryChange={vi.fn()}
      onSelect={vi.fn()}
      onNewIssue={vi.fn()}
      onRefresh={vi.fn()}
    />
  );
}

function renderPaneWith(
  items: ItemDocument[],
  overrides: {
    connection?: GithubConnection;
    demoMode?: boolean;
    online?: boolean;
  } = {}
) {
  return render(
    <GithubConnectionContext.Provider
      value={overrides.connection ?? signedInConnection}
    >
      <ItemListPane
        items={items}
        selectedPath={null}
        stateFilter="open"
        query=""
        loading={false}
        error={null}
        demoMode={overrides.demoMode ?? false}
        online={overrides.online ?? true}
        onStateFilterChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onNewIssue={vi.fn()}
        onRefresh={vi.fn()}
      />
    </GithubConnectionContext.Provider>
  );
}

describe("ItemListPane", () => {
  beforeEach(() => {
    fetchUserProfilesMock.mockReset();
    fetchUserProfilesMock.mockResolvedValue({});
  });

  it("paints labels in the list with their GitHub label colors", () => {
    renderPane([baseItem]);

    expect(screen.getByText("bug")).toHaveStyle({
      backgroundColor: "#b60205",
      color: "#ffffff",
      borderColor: "#b60205"
    });
  });

  it("marks the comment count icon for Yona-styled presentation", () => {
    const { container } = renderPane([baseItem]);

    expect(container.querySelector(".yona-comment-icon")).not.toBeNull();
  });

  it("shows open and closed state tabs with counts above the item list", () => {
    render(
      <ItemListPane
        items={[baseItem]}
        selectedPath={null}
        stateFilter="closed"
        stateCounts={{ open: 3, closed: 2 }}
        query=""
        loading={false}
        error={null}
        demoMode={false}
        onStateFilterChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onNewIssue={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole("tab", { name: "Open 3" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByRole("tab", { name: "Closed 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("switches state filter when a tab is activated and moves focus with arrow keys", async () => {
    const onStateFilterChange = vi.fn();
    render(
      <ItemListPane
        items={[baseItem]}
        selectedPath={null}
        stateFilter="open"
        stateCounts={{ open: 3, closed: 2 }}
        query=""
        loading={false}
        error={null}
        demoMode={false}
        onStateFilterChange={onStateFilterChange}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onNewIssue={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    const openTab = screen.getByRole("tab", { name: "Open 3" });
    const closedTab = screen.getByRole("tab", { name: "Closed 2" });

    fireEvent.click(closedTab);
    expect(onStateFilterChange).toHaveBeenCalledWith("closed");

    openTab.focus();
    fireEvent.keyDown(openTab, { key: "ArrowRight" });
    await waitFor(() => {
      expect(closedTab).toHaveFocus();
    });
  });

  it("keeps the scroll position when items are re-created with the same paths", () => {
    const items = Array.from({ length: 100 }, (_, index) => itemAt(index + 1));
    const { container, rerender } = render(
      <ItemListPane
        items={items}
        selectedPath={items[50].path}
        stateFilter="open"
        query=""
        loading={false}
        error={null}
        demoMode={false}
        onStateFilterChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onNewIssue={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    const list = container.querySelector(".item-list") as HTMLDivElement;
    list.scrollTop = 720;

    rerender(
      <ItemListPane
        items={items.map((item) => ({ ...item }))}
        selectedPath={items[51].path}
        stateFilter="open"
        query=""
        loading={false}
        error={null}
        demoMode={false}
        onStateFilterChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onNewIssue={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(list.scrollTop).toBe(720);
  });

  it("reports the items currently visible in the list viewport", async () => {
    const items = [itemAt(1), itemAt(2)];
    const onVisibleItemsChange = vi.fn();
    render(
      <ItemListPane
        items={items}
        selectedPath={null}
        stateFilter="open"
        query=""
        loading={false}
        error={null}
        demoMode={false}
        onStateFilterChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onVisibleItemsChange={onVisibleItemsChange}
        onNewIssue={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(onVisibleItemsChange).toHaveBeenCalled();
    });
    expect(onVisibleItemsChange).toHaveBeenLastCalledWith(items);
  });

  it("renders the author name as the third line, after the title and before labels", () => {
    const { container } = renderPane([baseItem]);

    expect(screen.getByText("mona")).toBeInTheDocument();

    const card = container.querySelector(".item-card") as HTMLElement;
    const rows = Array.from(card.children).map((node) =>
      node.className.split(" ")[0]
    );
    const titleIndex = rows.indexOf("item-title");
    const authorIndex = rows.indexOf("item-author");
    const labelsIndex = rows.indexOf("item-labels");

    expect(authorIndex).toBe(titleIndex + 1);
    expect(authorIndex).toBeLessThan(labelsIndex);
    expect(card.querySelector(".item-author")).toHaveTextContent("mona");
  });

  it("does not render an author line when the author is an empty string", () => {
    const item: ItemDocument = {
      ...baseItem,
      frontMatter: { ...baseItem.frontMatter, author: "" }
    };
    const { container } = renderPane([item]);

    expect(container.querySelector(".item-author")).toBeNull();
  });

  it("does not render an author line when the author is unknown", () => {
    const item: ItemDocument = {
      ...baseItem,
      frontMatter: { ...baseItem.frontMatter, author: "unknown" }
    };
    const { container } = renderPane([item]);

    expect(container.querySelector(".item-author")).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("shows the repo name without its owner on the meta line, before the number", () => {
    const { container } = renderPane([baseItem]);

    const meta = container.querySelector(".item-meta") as HTMLElement;
    // The kind text label is gone; the meta line leads with the repo name.
    expect(meta.textContent).not.toContain("Issue");
    expect(meta.querySelector(".item-repo")).toHaveTextContent("app");
    expect(meta.textContent).toContain("#42");
    expect(meta.textContent).not.toContain("acme/app");

    // The repo now comes before the number on the meta line.
    const metaText = meta.textContent ?? "";
    expect(metaText.indexOf("app")).toBeLessThan(metaText.indexOf("#42"));
  });

  it("conveys the item kind through a labelled icon, not a text label", () => {
    const { container } = renderPane([baseItem]);

    const meta = container.querySelector(".item-meta") as HTMLElement;
    expect(meta.textContent).not.toContain("Issue");
    expect(meta.textContent).not.toContain("PR");
    expect(meta.textContent).not.toContain("Discussion");

    // The kind is still announced to assistive tech through the icon.
    expect(screen.getByRole("img", { name: "Issue" })).toBeInTheDocument();
  });

  it("renders the author's avatar image before the name on the author line", async () => {
    fetchUserProfilesMock.mockResolvedValue({
      mona: {
        login: "mona",
        name: "Mona Lisa",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4"
      }
    });

    const { container } = renderPaneWith([baseItem]);

    const authorImg = await screen.findByRole("img", { name: "mona" });
    const authorLine = container.querySelector(".item-author") as HTMLElement;
    expect(authorLine).toContainElement(authorImg);
    expect(authorImg).toHaveAttribute(
      "src",
      "https://avatars.githubusercontent.com/u/1?v=4"
    );
    expect(authorLine).toHaveTextContent("Mona Lisa");

    // The avatar precedes the display name on the line.
    const nameNode = screen.getByText("Mona Lisa");
    expect(
      authorImg.compareDocumentPosition(nameNode) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders the author name without an avatar when the profile has no avatar URL", async () => {
    fetchUserProfilesMock.mockResolvedValue({
      mona: { login: "mona", name: "Mona Lisa" }
    });

    const { container } = renderPaneWith([baseItem]);

    await waitFor(() => {
      expect(container.querySelector(".item-author")).toHaveTextContent(
        "Mona Lisa"
      );
    });
    const authorLine = container.querySelector(".item-author") as HTMLElement;
    expect(authorLine.querySelector("img")).toBeNull();
    expect(authorLine.querySelector(".avatar-skeleton")).toBeNull();
  });

  it("no longer renders the owner/repo slug in the footer", () => {
    const { container } = renderPane([baseItem]);

    const labelRow = container.querySelector(".item-labels") as HTMLElement;
    expect(labelRow.querySelector(".item-repo")).toBeNull();
    expect(labelRow.textContent).not.toContain("acme");
    expect(labelRow.textContent).not.toContain("app");
  });

  it("aligns comment count to the right edge of the author line when there are no labels", () => {
    const item: ItemDocument = {
      ...baseItem,
      frontMatter: {
        ...baseItem.frontMatter,
        labels: [],
        label_colors: {},
        comments_count: 5
      }
    };
    const { container } = renderPane([item]);

    const authorLine = container.querySelector(".item-author") as HTMLElement;
    expect(authorLine.querySelector(".item-row-actions .item-comments")).toHaveTextContent(
      "5"
    );
    expect(container.querySelector(".item-labels")).toBeNull();
    expect(container.querySelector(".item-footer")).toBeNull();
  });

  it("aligns comment count to the right edge of the label line when labels are present", () => {
    const { container } = renderPane([baseItem]);

    const labelLine = container.querySelector(".item-labels") as HTMLElement;
    expect(labelLine.querySelector(".item-label")).toHaveTextContent("bug");
    expect(labelLine.querySelector(".item-row-actions .item-comments")).toHaveTextContent(
      "3"
    );
    expect(container.querySelector(".item-footer")).toBeNull();
  });

  it("does not render a footer when there are no comments and no bookmark", () => {
    const item: ItemDocument = {
      ...baseItem,
      frontMatter: {
        ...baseItem.frontMatter,
        comments_count: 0,
        local: { favorite: false }
      }
    };
    const { container } = renderPane([item]);

    expect(container.querySelector(".item-footer")).toBeNull();
  });

  it("renders a footer with only the bookmark when a favorite has no comments", () => {
    const item: ItemDocument = {
      ...baseItem,
      frontMatter: {
        ...baseItem.frontMatter,
        comments_count: 0,
        local: { favorite: true }
      }
    };
    const { container } = renderPane([item]);

    const labelLine = container.querySelector(".item-labels") as HTMLElement;
    expect(labelLine.querySelector(".small-bookmark")).not.toBeNull();
    expect(labelLine.querySelector(".item-comments")).toBeNull();
    expect(container.querySelector(".item-footer")).toBeNull();
  });

  it("shows the author's display name from their profile on the author line", async () => {
    fetchUserProfilesMock.mockResolvedValue({
      mona: { login: "mona", name: "Mona Lisa" }
    });

    const { container } = renderPaneWith([baseItem]);

    await waitFor(() => {
      expect(container.querySelector(".item-author")).toHaveTextContent(
        "Mona Lisa"
      );
    });
    expect(screen.queryByText("mona")).toBeNull();
    expect(fetchUserProfilesMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the login on the author line when no profile name is available", async () => {
    fetchUserProfilesMock.mockResolvedValue({});

    const { container } = renderPaneWith([baseItem]);

    await waitFor(() => {
      expect(fetchUserProfilesMock).toHaveBeenCalled();
    });
    expect(container.querySelector(".item-author")).toHaveTextContent("mona");
  });

  it("does not fetch profiles in demo mode (no signed-in token)", async () => {
    const { container } = renderPaneWith([baseItem], { demoMode: true });

    await Promise.resolve();
    expect(fetchUserProfilesMock).not.toHaveBeenCalled();
    // Author line still falls back to the login.
    expect(container.querySelector(".item-author")).toHaveTextContent("mona");
  });

  it("uses actual row positions for non-virtualized visible item reporting", async () => {
    const items = [itemAt(1), itemAt(2), itemAt(3), itemAt(4)];
    const onVisibleItemsChange = vi.fn();
    const { container } = render(
      <ItemListPane
        items={items}
        selectedPath={null}
        stateFilter="open"
        query=""
        loading={false}
        error={null}
        demoMode={false}
        onStateFilterChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onVisibleItemsChange={onVisibleItemsChange}
        onNewIssue={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    const list = container.querySelector(".item-list") as HTMLDivElement;
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 100
    });
    container.querySelectorAll(".item-card").forEach((row, index) => {
      Object.defineProperty(row, "offsetTop", {
        configurable: true,
        value: index * 100
      });
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        value: 100
      });
    });

    fireEvent(window, new Event("resize"));
    fireEvent.scroll(list, { target: { scrollTop: 250 } });

    await waitFor(() => {
      expect(onVisibleItemsChange).toHaveBeenLastCalledWith([
        items[2],
        items[3]
      ]);
    });
  });

  it("does not reserve label-row height for virtualized items without labels", async () => {
    const labelled = itemAt(1);
    const withoutLabels: ItemDocument = {
      ...itemAt(2),
      frontMatter: {
        ...itemAt(2).frontMatter,
        labels: [],
        label_colors: {}
      }
    };
    const items = [
      labelled,
      withoutLabels,
      ...Array.from({ length: 90 }, (_, index) => itemAt(index + 3))
    ];
    const { container } = renderPane(items);
    const list = container.querySelector(".item-list") as HTMLDivElement;
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 320
    });

    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(container.querySelectorAll(".virtual-row").length).toBeGreaterThan(1);
    });
    const rows = Array.from(
      container.querySelectorAll(".virtual-row")
    ) as HTMLElement[];

    expect(rows[0].style.height).toBe("140px");
    expect(rows[1].style.height).toBe("112px");
    expect(rows[1].querySelector(".item-labels")).toBeNull();
  });
});
