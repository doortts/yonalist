import { describe, expect, it } from "vitest";
import { timeAgo } from "./timeFormat";

const now = new Date("2026-07-03T12:00:00Z");

describe("timeAgo", () => {
  it("formats recent moments as now", () => {
    expect(timeAgo("2026-07-03T11:59:30Z", now)).toBe("now");
  });

  it("formats minutes, hours, and days", () => {
    expect(timeAgo("2026-07-03T11:55:00Z", now)).toBe("5m ago");
    expect(timeAgo("2026-07-03T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-07-01T12:00:00Z", now)).toBe("2d ago");
  });

  it("falls back to a date for older timestamps", () => {
    expect(timeAgo("2026-01-01T00:00:00Z", now)).toContain("2026");
  });

  it("shows a clock time for future timestamps", () => {
    expect(timeAgo("2026-07-03T13:30:00Z", now)).toMatch(/\d{1,2}.\d{2}/);
  });

  it("returns an empty string for invalid input", () => {
    expect(timeAgo("not-a-date", now)).toBe("");
  });
});
