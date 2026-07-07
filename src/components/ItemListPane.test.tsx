import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ItemDocument } from "../domain/types";
import { ItemListPane } from "./ItemListPane";

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

describe("ItemListPane", () => {
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

    expect(screen.getByRole("button", { name: "Open 3" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: "Closed 2" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
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
});
