import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MobileDayHeader } from "./MobileDayHeader";

describe("MobileDayHeader", () => {
  it("names the day the way a calendar does, not the way a filename does", () => {
    render(<MobileDayHeader date="2026-08-21" today="2026-08-21" onOpenDay={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Aug 21, 2026");
    expect(screen.getByText(/Friday/)).toBeInTheDocument();
  });

  it("says which day is the one being lived, and only on that day", () => {
    const { rerender } = render(
      <MobileDayHeader date="2026-08-21" today="2026-08-21" onOpenDay={vi.fn()} />
    );
    expect(screen.getByText(/Today/)).toBeInTheDocument();

    rerender(<MobileDayHeader date="2026-08-20" today="2026-08-21" onOpenDay={vi.fn()} />);
    expect(screen.queryByText(/Today/)).not.toBeInTheDocument();
  });

  it("walks to the day either side, whether or not anything is written there", async () => {
    const user = userEvent.setup();
    const onOpenDay = vi.fn();
    render(<MobileDayHeader date="2026-08-21" today="2026-08-21" onOpenDay={onOpenDay} />);

    await user.click(screen.getByRole("button", { name: /previous day/i }));
    await user.click(screen.getByRole("button", { name: /next day/i }));

    expect(onOpenDay.mock.calls.map(([date]) => date)).toEqual(["2026-08-20", "2026-08-22"]);
  });

  it("crosses a month end rather than counting within the month", async () => {
    const user = userEvent.setup();
    const onOpenDay = vi.fn();
    render(<MobileDayHeader date="2026-09-01" today="2026-08-21" onOpenDay={onOpenDay} />);

    await user.click(screen.getByRole("button", { name: /previous day/i }));

    expect(onOpenDay).toHaveBeenCalledWith("2026-08-31");
  });
});
