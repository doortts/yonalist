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
    // Each section shows what it is about rather than its own name: Pages is
    // the list of them, and the day that was on screen is gone.
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
});

describe("MobileApp sections", () => {
  it("shows each section's own screen, not a placeholder", async () => {
    const user = userEvent.setup();
    render(<MobileApp api={appApi()} />);
    const tab = (name: string) =>
      within(sections()).getByRole("tab", { name });

    await user.click(tab("Journals"));
    expect(screen.getByText(/nothing written on any day yet/i)).toBeInTheDocument();

    await user.click(tab("Pages"));
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();

    await user.click(tab("Search"));
    expect(screen.getByRole("searchbox", { name: /search/i })).toBeInTheDocument();
  });

  it("opens a page from the list and offers the way back", async () => {
    const user = userEvent.setup();
    render(<MobileApp api={appApi()} />);
    await user.click(within(sections()).getByRole("tab", { name: "Pages" }));

    await user.click(screen.getByRole("button", { name: "Today" }));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Today");
    expect(screen.getByRole("button", { name: /back to pages/i })).toBeInTheDocument();
  });
});
