import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MobilePages } from "./MobilePages";
import type { PageSummary } from "../../../../packages/contracts/generated/PageSummary";

const pages: PageSummary[] = [
  { id: "p1", title: "Reading list", sortKey: 1 },
  { id: "j1", title: "2026-08-20", sortKey: 2 },
  { id: "p2", title: "Yonalist roadmap", sortKey: 3 },
  { id: "u1", title: "", sortKey: 4 }
];

function list(onOpenPage = vi.fn()) {
  render(<MobilePages pages={pages} onOpenPage={onOpenPage} />);
  return onOpenPage;
}

describe("MobilePages", () => {
  it("lists pages and leaves the days to the Journals tab", () => {
    list();

    expect(screen.getAllByRole("button").map((row) => row.textContent)).toEqual([
      "Reading list",
      "Yonalist roadmap",
      "Untitled page"
    ]);
  });

  it("opens the page a tap names", async () => {
    const user = userEvent.setup();
    const onOpenPage = list();

    await user.click(screen.getByRole("button", { name: "Yonalist roadmap" }));

    expect(onOpenPage).toHaveBeenCalledWith("p2");
  });

  it("says so plainly when there is nothing yet, rather than showing an empty box", () => {
    render(<MobilePages pages={[]} onOpenPage={vi.fn()} />);

    expect(screen.getByText(/no pages yet/i)).toBeInTheDocument();
  });
});
