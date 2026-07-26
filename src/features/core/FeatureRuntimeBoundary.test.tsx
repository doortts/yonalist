import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureRuntimeBoundary } from "./FeatureRuntimeBoundary";

function BrokenPane(): never {
  throw new Error("pane render failed");
}

describe("FeatureRuntimeBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("localizes a runtime render failure and retries", () => {
    const onRetry = vi.fn();
    render(
      <FeatureRuntimeBoundary featureId="notes" onRetry={onRetry}>
        <BrokenPane />
      </FeatureRuntimeBoundary>
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Yonalist를 열 수 없습니다."
    );
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("clears the failure when the active feature changes", () => {
    const { rerender } = render(
      <FeatureRuntimeBoundary featureId="notes" onRetry={vi.fn()}>
        <BrokenPane />
      </FeatureRuntimeBoundary>
    );

    rerender(
      <FeatureRuntimeBoundary featureId="settings" onRetry={vi.fn()}>
        <div>Settings ready</div>
      </FeatureRuntimeBoundary>
    );

    expect(screen.getByText("Settings ready")).toBeInTheDocument();
  });
});
