import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary
} from "../../ExternalSourcesContext";
import {
  serializeExternalBulletKey,
  type ExternalBullet,
  type ExternalSourcePageSnapshot
} from "../../domain/externalSources";
import { NotesExternalOutlinePane } from "./NotesExternalOutlinePane";
import type { GithubOutlineProjection } from "./githubNotificationsOutline";

const connectionId = "github:user-7";

function bullet(remoteId: string, title: string): ExternalBullet {
  return {
    key: { providerId: "github", connectionId, remoteId },
    parentKey: {
      providerId: "github",
      connectionId,
      remoteId: "date:2026.07.22"
    },
    title,
    note: `Repository: acme/${remoteId}`,
    updatedAt: "2026-07-22T00:00:00Z",
    completed: false,
    capabilities: {
      expand: false,
      openDetails: true,
      complete: true,
      uncomplete: false,
      edit: false,
      move: false,
      delete: false,
      createChild: false
    }
  };
}

const projected = bullet("42", "Projected notification");

function page(
  overrides: Partial<ExternalSourcePageSnapshot> = {}
): ExternalSourcePageSnapshot {
  return {
    providerId: "github-notifications",
    connectionId,
    title: "Github Notifications",
    availability: "online",
    items: [projected],
    loaded: true,
    loading: false,
    error: null,
    syncedAt: "2026-07-22T00:00:00Z",
    completingKeys: new Set(),
    completionErrors: {},
    ...overrides
  };
}

function projection(
  overrides: Partial<GithubOutlineProjection> = {}
): GithubOutlineProjection {
  return {
    rows: [
      {
        kind: "date",
        key: "github-date:2026.07.22",
        dateKey: "2026.07.22",
        title: "Today",
        collapsed: false,
        storedNodeId: "date-node"
      },
      {
        kind: "stored",
        key: "github-stored:user-note",
        nodeId: "user-note",
        dateKey: "2026.07.22",
        depth: 1
      },
      {
        kind: "projected",
        key: `github-provider:${serializeExternalBulletKey(projected.key)}`,
        dateKey: "2026.07.22",
        depth: 1,
        bullet: projected
      }
    ],
    sortableIds: ["user-note"],
    selectableUserNodeIds: ["user-note"],
    editorFocusKeys: [],
    ...overrides
  };
}

function boundary(): ExternalSourcesBoundary {
  return {
    pages: [page()],
    refresh: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    openDetails: vi.fn()
  };
}

describe("NotesExternalOutlinePane", () => {
  it("renders one date group with native stored rows before provider rows", () => {
    const sourceBoundary = boundary();
    render(
      <ExternalSourcesContext.Provider value={sourceBoundary}>
        <ol>
          <NotesExternalOutlinePane
            page={page()}
            projection={projection()}
            renderStoredRow={(nodeId, depth) => (
              <li data-outline-id={nodeId} data-depth={depth}>
                Stored user note
              </li>
            )}
          />
        </ol>
      </ExternalSourcesContext.Provider>
    );

    const group = screen.getByRole("group", {
      name: "Notifications for Today"
    });
    const children = within(group).getByRole("list").children;
    expect(children).toHaveLength(2);
    expect(children[0]).toHaveAttribute("data-outline-id", "user-note");
    expect(children[0]).toHaveAttribute("data-depth", "1");
    expect(children[0]).not.toHaveAttribute(
      "data-github-notification-drop-target"
    );
    expect(children[1]).toHaveAttribute(
      "data-external-bullet-key",
      serializeExternalBulletKey(projected.key)
    );
    expect(children[1]).not.toHaveAttribute("data-outline-id");
    expect(children[1]).toHaveAttribute(
      "data-github-notification-drop-target",
      serializeExternalBulletKey(projected.key)
    );
  });

  it("keeps provider actions on the external host", async () => {
    const user = userEvent.setup();
    const sourceBoundary = boundary();
    render(
      <ExternalSourcesContext.Provider value={sourceBoundary}>
        <ol>
          <NotesExternalOutlinePane
            page={page()}
            projection={projection({
              rows: projection().rows.filter((row) => row.kind !== "stored")
            })}
            renderStoredRow={() => null}
          />
        </ol>
      </ExternalSourcesContext.Provider>
    );

    await user.click(
      screen.getByRole("button", {
        name: `More actions for ${projected.title}`
      })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Complete" })
    );
    await user.click(
      screen.getByRole("button", {
        name: `웹에서 열기: ${projected.title}`
      })
    );

    expect(sourceBoundary.openDetails).toHaveBeenCalledWith(
      projected.key,
      undefined
    );
    expect(sourceBoundary.complete).toHaveBeenCalledWith(projected.key);
  });

  it("renders stable status rows outside selection and exposes retry for errors", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <ol>
        <NotesExternalOutlinePane
          page={page({ error: "Refresh failed" })}
          projection={projection({
            rows: [{
              kind: "source-status",
              key: "github-status:error",
              status: "error",
              message: "Refresh failed"
            }],
            sortableIds: [],
            selectableUserNodeIds: []
          })}
          renderStoredRow={() => null}
          onRetry={retry}
        />
      </ol>
    );

    const status = screen.getByRole("listitem");
    expect(status).toHaveAttribute("data-external-status", "error");
    expect(status).not.toHaveAttribute("data-outline-id");
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps date groups expanded by default and reports an explicit collapse", async () => {
    const user = userEvent.setup();
    const onToggleDateGroup = vi.fn();
    render(
      <ol>
        <NotesExternalOutlinePane
          page={page()}
          projection={projection()}
          renderStoredRow={() => null}
          onToggleDateGroup={onToggleDateGroup}
        />
      </ol>
    );

    expect(screen.getByRole("button", { name: "Collapse Today" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "Collapse Today" }));

    expect(onToggleDateGroup).toHaveBeenCalledWith("2026.07.22", true);
  });
});
