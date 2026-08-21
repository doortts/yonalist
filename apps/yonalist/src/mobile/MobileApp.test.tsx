import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MobileApp } from "./MobileApp";
import { appApi } from "../test/appApiFixture";

const sections = () => screen.getByRole("tablist", { name: /sections/i });

describe("MobileApp", () => {
  it("offers the four sections the phone navigates by", () => {
    render(<MobileApp api={appApi()} />);

    const tabs = within(sections()).getAllByRole("tab");

    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Today",
      "Journals",
      "Pages",
      "Search"
    ]);
  });

  it("opens on Today, because that is what the app is for", () => {
    render(<MobileApp api={appApi()} />);

    expect(within(sections()).getByRole("tab", { selected: true })).toHaveTextContent("Today");
    // The section shows a day rather than its own name: the heading is the
    // date, which is what the screen is actually about.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/\d{4}/);
  });

  it("shows the section a tap selects and only that one", async () => {
    const user = userEvent.setup();
    render(<MobileApp api={appApi()} />);

    await user.click(within(sections()).getByRole("tab", { name: "Pages" }));

    expect(within(sections()).getByRole("tab", { selected: true })).toHaveTextContent("Pages");
    expect(screen.getByRole("heading", { name: "Pages" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument();
  });
});
