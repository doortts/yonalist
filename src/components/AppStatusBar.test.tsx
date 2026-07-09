import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppStatusBar } from "./AppStatusBar";

describe("AppStatusBar", () => {
  it("shows list, detail, and prefetch timings", () => {
    render(
      <AppStatusBar
        outboxCount={2}
        online
        syncing={false}
        getMetrics={() => ({
          listFetchDurationMs: 124.4,
          detailDisplayDurationMs: 48.2,
          prefetch: {
            enabled: true,
            visible: 5,
            queued: 1,
            active: 2,
            cached: 3,
            completed: 4,
            totalDurationMs: 310.2,
            lastDurationMs: 91.6
          },
          caches: [
            { label: "Bodies", entries: 2, bytes: 512 },
            { label: "Threads", entries: 5, bytes: 1536 },
            { label: "Markdown", entries: 13, bytes: 1_048_576 }
          ]
        })}
        onOpenOutbox={vi.fn()}
      />
    );

    const statusBar = screen.getByLabelText("Status bar");
    expect(within(statusBar).getByText("List 124ms")).toBeInTheDocument();
    expect(within(statusBar).getByText("Item 48ms")).toBeInTheDocument();
    expect(
      within(statusBar).getByText(
        "Prefetch 5 visible · 4 done · 2 active · 1 queued · last 92ms"
      )
    ).toBeInTheDocument();
    expect(
      within(statusBar).getByText(
        "Cache Bodies 2/512 B · Threads 5/1.5 KB · Markdown 13/1 MB"
      )
    ).toBeInTheDocument();
  });
});
