import { describe, expect, it } from "vitest";
import { isSyncStatus, type SyncStatus } from "./notesSyncContract";

const base: SyncStatus = {
  running: true,
  dirtyTopics: 0,
  quarantined: [],
  lastExportAt: null,
  lastMergeAt: null
};

describe("isSyncStatus", () => {
  it("accepts a minimal valid status without lastError", () => {
    expect(isSyncStatus(base)).toBe(true);
  });

  it("accepts a string or null lastError", () => {
    expect(isSyncStatus({ ...base, lastError: "boom" })).toBe(true);
    expect(isSyncStatus({ ...base, lastError: null })).toBe(true);
  });

  it("accepts extra unknown keys for forward compatibility", () => {
    expect(isSyncStatus({ ...base, somethingNew: 42 })).toBe(true);
  });

  it("accepts populated quarantined and timestamps", () => {
    expect(
      isSyncStatus({
        ...base,
        dirtyTopics: 3,
        quarantined: ["milk.1f2a.md"],
        lastExportAt: "2026-07-22T00:00:00.000Z",
        lastMergeAt: "2026-07-22T00:00:01.000Z"
      })
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ["non-record null", null],
    ["array", []],
    ["string", "status"],
    ["missing running", { ...structured(base, "running") }],
    ["missing quarantined", { ...structured(base, "quarantined") }],
    ["running wrong type", { ...base, running: "yes" }],
    ["negative dirtyTopics", { ...base, dirtyTopics: -1 }],
    ["fractional dirtyTopics", { ...base, dirtyTopics: 1.5 }],
    ["quarantined not array", { ...base, quarantined: "x" }],
    ["quarantined non-string member", { ...base, quarantined: [1] }],
    ["lastExportAt wrong type", { ...base, lastExportAt: 5 }],
    ["lastError wrong type", { ...base, lastError: 7 }]
  ])("rejects %s", (_label, value) => {
    expect(isSyncStatus(value)).toBe(false);
  });
});

function structured(status: SyncStatus, omit: keyof SyncStatus): object {
  const copy: Record<string, unknown> = { ...status };
  delete copy[omit];
  return copy;
}
