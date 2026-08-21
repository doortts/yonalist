import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MobileToday } from "./MobileToday";
import { NotesStore } from "../notesStore";
import { localDateIso } from "../outline/outlineSlash";
import { appApi as api } from "../test/appApiFixture";

function mounted() {
  const notesApi = api();
  const store = new NotesStore(notesApi);
  render(<MobileToday store={store} />);
  return { notesApi, store };
}

describe("MobileToday", () => {
  it("opens on the day being lived, without being told which one", async () => {
    mounted();

    const today = localDateIso();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/\d{4}/)
    );
    expect(screen.getByRole("button", { name: `Previous day, ${shiftedBack(today)}` }))
      .toBeInTheDocument();
  });

  it("asks the store for that day's journal rather than any page it happens to hold", async () => {
    const { store } = mounted();
    const openJournal = vi.spyOn(store, "openJournal");

    await waitFor(() => expect(openJournal).toHaveBeenCalledWith(localDateIso()));
  });

  it("walks to another day and asks for that one instead", async () => {
    const user = userEvent.setup();
    const { store } = mounted();
    const openJournal = vi.spyOn(store, "openJournal");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /previous day/i }));

    await waitFor(() =>
      expect(openJournal).toHaveBeenCalledWith(shiftedBack(localDateIso()))
    );
  });
});

function shiftedBack(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day - 1));
  return shifted.toISOString().slice(0, 10);
}
