import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailRenderSnapshotOverlay } from "./DetailRenderSnapshotOverlay";

describe("DetailRenderSnapshotOverlay", () => {
  it("renders cached detail HTML as a non-interactive overlay", () => {
    render(
      <DetailRenderSnapshotOverlay html="<article><h1>Cached</h1></article>" />
    );

    expect(screen.getByText("Cached")).toBeInTheDocument();
    expect(
      screen.getByText("Cached").closest("[data-detail-render-snapshot-overlay]")
    ).toHaveAttribute("aria-hidden", "true");
  });
});
