import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";
import {
  findJournalPage, journalDateOf, journalDays, shiftDay
} from "./journal";

function page(id: string, title: string, sortKey: number): PageSummary {
  return { id, title, sortKey };
}

describe("journalDateOf", () => {
  it("reads a title that is nothing but a date", () => {
    expect(journalDateOf("2026-08-21")).toBe("2026-08-21");
    expect(journalDateOf("  2026-08-21  ")).toBe("2026-08-21");
  });

  it("refuses a title that only carries a date somewhere in it", () => {
    expect(journalDateOf("Notes for 2026-08-21")).toBeNull();
    expect(journalDateOf("2026-08-21 standup")).toBeNull();
    expect(journalDateOf("")).toBeNull();
  });

  it("refuses a date the calendar does not have", () => {
    expect(journalDateOf("2026-02-30")).toBeNull();
    expect(journalDateOf("2026-02-29")).toBeNull();
    expect(journalDateOf("2026-13-01")).toBeNull();
    expect(journalDateOf("2024-02-29")).toBe("2024-02-29");
  });

  it("refuses a date that is not padded, since the vault sorts on the text", () => {
    expect(journalDateOf("2026-8-1")).toBeNull();
  });
});

describe("journalDays", () => {
  const pages = [
    page("a", "2026-08-19", 1_024),
    page("b", "Reading list", 2_048),
    page("c", "2026-08-21", 3_072),
    page("d", "2026-08-20", 4_096)
  ];

  it("lists the journals newest first and leaves ordinary pages out", () => {
    expect(journalDays(pages)).toEqual([
      { id: "c", date: "2026-08-21" },
      { id: "d", date: "2026-08-20" },
      { id: "a", date: "2026-08-19" }
    ]);
  });

  it("keeps both pages when two of them claim the same day", () => {
    const doubled = [...pages, page("e", "2026-08-21", 5_120)];
    expect(journalDays(doubled).filter((day) => day.date === "2026-08-21"))
      .toEqual([{ id: "c", date: "2026-08-21" }, { id: "e", date: "2026-08-21" }]);
  });
});

describe("findJournalPage", () => {
  const pages = [
    page("a", "2026-08-21", 1_024),
    page("b", "2026-08-21", 2_048)
  ];

  it("finds the page a day is written on", () => {
    expect(findJournalPage(pages, "2026-08-21")?.id).toBe("a");
  });

  it("answers with nothing when the day has no page", () => {
    expect(findJournalPage(pages, "2026-08-22")).toBeUndefined();
  });
});

describe("shiftDay", () => {
  it("crosses a month, a year and a leap day", () => {
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2026-08-21", 0)).toBe("2026-08-21");
  });
});
