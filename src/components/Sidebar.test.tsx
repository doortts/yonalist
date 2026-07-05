import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

function renderSidebar() {
  return render(
    <Sidebar
      online
      loginRequired={false}
      onToggleOnline={vi.fn()}
      filter="all"
      onFilterChange={vi.fn()}
      repositoryFilter={null}
      onRepositoryFilterChange={vi.fn()}
      repositoryGroups={[]}
      repositoriesLoading={false}
      counts={{
        all: 12,
        favorites: 2,
        issues: 7,
        pulls: 3,
        discussions: 2
      }}
      outboxCount={0}
      settingsOpen={false}
      onOpenSettings={vi.fn()}
      onOpenProjectSettings={vi.fn()}
      onOpenOutbox={vi.fn()}
      notificationsOpen={false}
      onOpenNotifications={vi.fn()}
      unreadNotificationCount={0}
      notificationsLoading={false}
    />
  );
}

describe("Sidebar", () => {
  it("shows Favorites before All items in the Inbox section", () => {
    renderSidebar();

    const favorites = screen.getByRole("button", { name: /^Favorites/ });
    const allItems = screen.getByRole("button", { name: /^All items/ });

    expect(
      favorites.compareDocumentPosition(allItems) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
