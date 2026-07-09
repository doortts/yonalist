import { render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useDetailContentPaintReady } from "./useDetailContentPaintReady";

function Harness({
  activeDetailKey = "item:1",
  detailReady = true,
  expectedMarkdownBodies,
  rendered
}: {
  activeDetailKey?: string | null;
  detailReady?: boolean;
  expectedMarkdownBodies: number;
  rendered: boolean[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ready = useDetailContentPaintReady(
    ref,
    activeDetailKey,
    detailReady,
    expectedMarkdownBodies
  );
  return (
    <>
      <div ref={ref}>
        {rendered.map((isRendered, index) => (
          <div
            data-markdown-body="true"
            data-markdown-rendered={isRendered ? "true" : "false"}
            key={index}
          />
        ))}
      </div>
      <output aria-label="content-ready">{ready ? "ready" : "waiting"}</output>
    </>
  );
}

describe("useDetailContentPaintReady", () => {
  it("waits until every expected detail markdown body is rendered", async () => {
    const { rerender } = render(
      <Harness expectedMarkdownBodies={3} rendered={[true, true]} />
    );

    expect(screen.getByLabelText("content-ready")).toHaveTextContent("waiting");

    rerender(
      <Harness expectedMarkdownBodies={3} rendered={[true, true, false]} />
    );

    expect(screen.getByLabelText("content-ready")).toHaveTextContent("waiting");

    rerender(
      <Harness expectedMarkdownBodies={3} rendered={[true, true, true]} />
    );

    await waitFor(() =>
      expect(screen.getByLabelText("content-ready")).toHaveTextContent("ready")
    );
  });

  it("resets when the active detail changes", async () => {
    const { rerender } = render(
      <Harness expectedMarkdownBodies={1} rendered={[true]} />
    );
    await waitFor(() =>
      expect(screen.getByLabelText("content-ready")).toHaveTextContent("ready")
    );

    rerender(
      <Harness
        activeDetailKey="item:2"
        expectedMarkdownBodies={1}
        rendered={[false]}
      />
    );

    expect(screen.getByLabelText("content-ready")).toHaveTextContent("waiting");
  });
});
