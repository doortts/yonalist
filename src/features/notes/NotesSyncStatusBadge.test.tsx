import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { SyncStatus } from "../../services/notesSyncContract";
import {
  publishNotesSyncStatus,
  resetNotesSyncStatusStore
} from "../../services/notesSyncStatusStore";
import { NotesSyncStatusBadge } from "./NotesSyncStatusBadge";

const healthy: SyncStatus = {
  running: true,
  dirtyTopics: 0,
  quarantined: [],
  lastExportAt: null,
  lastMergeAt: null
};

function renderBadge(vaultRoot = "/vault") {
  return render(
    <VaultRootContext.Provider value={vaultRoot}>
      <NotesSyncStatusBadge />
    </VaultRootContext.Provider>
  );
}

afterEach(() => {
  resetNotesSyncStatusStore();
});

describe("NotesSyncStatusBadge", () => {
  it("renders nothing without a status", () => {
    const { container } = renderBadge();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a healthy running status", () => {
    publishNotesSyncStatus("/vault", healthy);
    const { container } = renderBadge();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders on a quarantine event", () => {
    publishNotesSyncStatus("/vault", {
      ...healthy,
      quarantined: ["milk.1f2a.md", "eggs.2b3c.md"]
    });
    renderBadge();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 note files need attention"
    );
  });

  it("renders on a start failure (error status)", () => {
    publishNotesSyncStatus("/vault", {
      ...healthy,
      running: false,
      lastError: "Notes sync could not start."
    });
    renderBadge();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Notes sync reported an error");
    expect(status).toHaveTextContent("Notes sync could not start.");
    expect(status).not.toHaveTextContent("Recommended action:");
  });

  it("shows restart guidance for a known database identity mismatch", () => {
    publishNotesSyncStatus("/vault", {
      ...healthy,
      running: false,
      lastError:
        "The active Notes connection and pathname database disagree before WAL validation."
    });
    renderBadge();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Recommended action: Open Notes data settings and run Retry sync, or restart Yonalist, to reopen the current Notes database. Do not replace or edit the Notes database files while Yonalist is running."
    );
  });

  it("scopes status to its own vault", () => {
    publishNotesSyncStatus("/other", { ...healthy, quarantined: ["x.md"] });
    const { container } = renderBadge("/vault");
    expect(container).toBeEmptyDOMElement();
  });
});
