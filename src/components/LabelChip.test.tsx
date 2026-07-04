import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LabelChip } from "./LabelChip";

describe("LabelChip", () => {
  it("paints the label with its own color and readable text", () => {
    render(<LabelChip label={{ name: "bug", color: "b60205" }} />);
    const chip = screen.getByText("bug");
    expect(chip).toHaveStyle({ backgroundColor: "#b60205" });
    expect(chip).toHaveStyle({ color: "#ffffff" }); // dark bg → light text
  });

  it("uses dark text on a light label", () => {
    render(<LabelChip label={{ name: "docs", color: "fef2c0" }} />);
    expect(screen.getByText("docs")).toHaveStyle({ color: "#1f2328" });
  });

  it("falls back to a plain chip when no color is provided", () => {
    render(<LabelChip label={{ name: "plain", color: "" }} />);
    const chip = screen.getByText("plain");
    expect(chip).toHaveClass("chip");
    expect(chip).not.toHaveClass("label-chip");
  });
});
