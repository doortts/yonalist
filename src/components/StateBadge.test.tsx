import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StateBadge } from "./StateBadge";

describe("StateBadge", () => {
  it("shows Open with the open style for open issues", () => {
    render(<StateBadge kind="issue" state="open" />);
    const badge = screen.getByText("Open");
    expect(badge).toHaveClass("state-open");
  });

  it("shows Merged for merged pulls", () => {
    render(<StateBadge kind="pull" state="merged" />);
    expect(screen.getByText("Merged")).toHaveClass("state-merged");
  });

  it("shows Closed for closed items", () => {
    render(<StateBadge kind="issue" state="closed" />);
    expect(screen.getByText("Closed")).toHaveClass("state-closed");
  });

  it("prefers Draft over the state when a pull is a draft", () => {
    render(<StateBadge kind="pull" state="open" draft />);
    expect(screen.getByText("Draft")).toHaveClass("state-draft");
    expect(screen.queryByText("Open")).toBeNull();
  });
});
