import { render, screen } from "@testing-library/react";
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

describe("ItemListPane", () => {
  it("paints labels in the list with their GitHub label colors", () => {
    render(
      <ItemListPane
        items={[baseItem]}
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

    expect(screen.getByText("bug")).toHaveStyle({
      backgroundColor: "#b60205",
      color: "#ffffff",
      borderColor: "#b60205"
    });
  });

  it("marks the comment count icon for Yona-styled presentation", () => {
    const { container } = render(
      <ItemListPane
        items={[baseItem]}
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

    expect(container.querySelector(".yona-comment-icon")).not.toBeNull();
  });

  it("shows opened and closed state tabs above the item list", () => {
    render(
      <ItemListPane
        items={[baseItem]}
        selectedPath={null}
        stateFilter="closed"
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

    expect(screen.getByRole("button", { name: "Opened" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: "Closed" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
