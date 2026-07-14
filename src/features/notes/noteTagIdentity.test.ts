import { describe, expect, it } from "vitest";
import identityFixtures from "./noteTagIdentity.fixtures.json";
import { normalizeNoteTagIdentity } from "./noteTagIdentity";

describe("normalizeNoteTagIdentity", () => {
  it.each([
    ["Straße", "strasse"],
    ["STRASSE", "strasse"],
    ["ﬀ", "ff"],
    ["ff", "ff"],
    ["İ", "i̇"]
  ])("applies the full default Unicode fold to %j", (source, expected) => {
    expect(normalizeNoteTagIdentity(source)).toBe(expected);
  });

  it.each(identityFixtures)(
    "preserves every three-scalar full-fold mapping for $source",
    ({ source, normalized }) => {
      expect(normalizeNoteTagIdentity(source)).toBe(normalized);
    }
  );

  it("returns NFC after folding canonically equivalent input", () => {
    expect(normalizeNoteTagIdentity("CAFE\u0301")).toBe("café");
    expect(normalizeNoteTagIdentity("ΐ")).toBe("ΐ");
    expect(normalizeNoteTagIdentity("ΐ").normalize("NFC")).toBe(
      normalizeNoteTagIdentity("ΐ")
    );
  });
});
