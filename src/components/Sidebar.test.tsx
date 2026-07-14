import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

function renderSidebar(
  featureNavigation: {
    activeFeatureId?: "inbox" | "notes" | "settings";
    onFeatureChange?: (featureId: "inbox" | "notes" | "settings") => void;
  } = {}
) {
  return render(
    <Sidebar
      online
      loginRequired={false}
      onToggleOnline={vi.fn()}
      filter="all"
      onFilterChange={vi.fn()}
      repositoryFilter="yonalist/workflowy"
      onRepositoryFilterChange={vi.fn()}
      repositoryGroups={[
        {
          owner: "yonalist",
          repositories: [
            {
              owner: "yonalist",
              name: "workflowy",
              fullName: "yonalist/workflowy",
              openIssuesCount: 4,
              pushedAt: "2026-07-10T00:00:00Z",
              participating: true,
              watched: false,
              orgMember: false
            }
          ]
        }
      ]}
      repositoriesLoading={false}
      counts={{
        all: 12,
        favorites: 2,
        issues: 7,
        pulls: 3,
        discussions: 2
      }}
      settingsOpen={false}
      onOpenSettings={vi.fn()}
      onOpenProjectSettings={vi.fn()}
      notificationsOpen={false}
      onOpenNotifications={vi.fn()}
      unreadNotificationCount={0}
      notificationsLoading={false}
      {...featureNavigation}
    />
  );
}

describe("Sidebar", () => {
  it("shows Notifications without a GitHub section heading", () => {
    renderSidebar();

    expect(screen.getByRole("button", { name: /^Notifications/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "GitHub" })
    ).not.toBeInTheDocument();
  });

  it("shows Favorites before All items in the Inbox section", () => {
    renderSidebar();

    const favorites = screen.getByRole("button", { name: /^Favorites/ });
    const allItems = screen.getByRole("button", { name: /^All items/ });

    expect(
      favorites.compareDocumentPosition(allItems) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders Notes in the Workspace section and activates it", async () => {
    const onFeatureChange = vi.fn();
    renderSidebar({ activeFeatureId: "notes", onFeatureChange });

    const notes = screen.getByRole("button", { name: "Notes" });
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(notes).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^All items/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: /^workflowy\s*4/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    await userEvent.setup().click(notes);

    expect(onFeatureChange).toHaveBeenCalledWith("notes");
  });
});
