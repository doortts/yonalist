import { describe, expect, it } from "vitest";
import {
  authorAssociationLabel,
  labelTextColor,
  summarizeReactions
} from "./conversation";

describe("labelTextColor", () => {
  it("uses dark text on light backgrounds", () => {
    expect(labelTextColor("d4c5f9")).toBe("#1f2328"); // light purple
    expect(labelTextColor("#ffffff")).toBe("#1f2328");
    expect(labelTextColor("fef2c0")).toBe("#1f2328"); // pale yellow
  });

  it("uses light text on dark backgrounds", () => {
    expect(labelTextColor("0e8a16")).toBe("#ffffff"); // green
    expect(labelTextColor("#000000")).toBe("#ffffff");
    expect(labelTextColor("b60205")).toBe("#ffffff"); // red
  });

  it("falls back to dark text for malformed colors", () => {
    expect(labelTextColor("")).toBe("#1f2328");
    expect(labelTextColor("xyz")).toBe("#1f2328");
  });
});

describe("authorAssociationLabel", () => {
  it("maps known associations to display labels", () => {
    expect(authorAssociationLabel("OWNER")).toBe("Owner");
    expect(authorAssociationLabel("MEMBER")).toBe("Member");
    expect(authorAssociationLabel("COLLABORATOR")).toBe("Collaborator");
    expect(authorAssociationLabel("CONTRIBUTOR")).toBe("Contributor");
  });

  it("returns null for NONE or unknown values", () => {
    expect(authorAssociationLabel("NONE")).toBeNull();
    expect(authorAssociationLabel(undefined)).toBeNull();
    expect(authorAssociationLabel("FIRST_TIMER")).toBeNull();
  });
});

describe("summarizeReactions", () => {
  it("keeps only non-zero reactions in GitHub's order with emoji", () => {
    expect(
      summarizeReactions({
        "+1": 3,
        "-1": 0,
        laugh: 1,
        hooray: 0,
        confused: 0,
        heart: 2,
        rocket: 0,
        eyes: 0,
        total_count: 6
      })
    ).toEqual([
      { emoji: "👍", count: 3 },
      { emoji: "😄", count: 1 },
      { emoji: "❤️", count: 2 }
    ]);
  });

  it("returns an empty summary when there are no reactions", () => {
    expect(summarizeReactions(undefined)).toEqual([]);
    expect(summarizeReactions({})).toEqual([]);
  });
});
