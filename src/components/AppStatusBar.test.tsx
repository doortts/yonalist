import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { AppStatusBar } from "./AppStatusBar";

describe("AppStatusBar", () => {
  it("shows Yonalist feedback and current connectivity without an outbox", () => {
    const props = {
      online: false,
      feedback: <span>Saving locally</span>,
      outboxCount: 2,
      syncing: false,
      getMetrics: () => ({
        listFetchDurationMs: null,
        detailDisplayDurationMs: null,
        prefetch: {
          enabled: false,
          visible: 0,
          queued: 0,
          active: 0,
          cached: 0,
          completed: 0,
          totalDurationMs: 0,
          lastDurationMs: null
        },
        caches: []
      }),
      onOpenOutbox: () => undefined
    } as unknown as ComponentProps<typeof AppStatusBar>;
    render(
      <AppStatusBar {...props} />
    );

    expect(screen.getByText("Saving locally")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /outbox/i })).toBeNull();
    expect(screen.queryByLabelText("Performance metrics")).toBeNull();
  });
});
