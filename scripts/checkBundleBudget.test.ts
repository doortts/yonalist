import { describe, expect, it } from "vitest";
import { checkBundleBudget } from "./checkBundleBudget.mjs";

interface ManifestChunk {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
}

function bytes(length: number, seed = 17): Uint8Array {
  let value = seed;
  return Uint8Array.from({ length }, () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value >>> 24;
  });
}

function fixture({
  index = new Uint8Array(100),
  app = new Uint8Array(200),
  vendor = new Uint8Array(300),
  notesSources = [],
  lazyNotesSources = [],
  dynamic = new Uint8Array(0),
  notesStatic
}: {
  index?: Uint8Array;
  app?: Uint8Array;
  vendor?: Uint8Array;
  notesSources?: string[];
  lazyNotesSources?: string[];
  dynamic?: Uint8Array;
  notesStatic?: Uint8Array;
} = {}) {
  const manifest: Record<string, ManifestChunk> = {
    "index.html": {
      file: "assets/index.js",
      imports: ["src/App.tsx"],
      dynamicImports: ["src/features/notes/NotesFeature.tsx"]
    },
    "src/App.tsx": {
      file: "assets/App.js",
      imports: ["_vendor.js"]
    },
    "_vendor.js": { file: "assets/vendor.js" },
    "src/features/notes/NotesFeature.tsx": {
      file: "assets/NotesFeature.js",
      imports: notesStatic ? ["_notes-static.js"] : []
    }
  };
  if (notesStatic) {
    manifest["_notes-static.js"] = { file: "assets/notes-static.js" };
  }
  return {
    manifest,
    files: {
      "assets/index.js": index,
      "assets/App.js": app,
      "assets/vendor.js": vendor,
      "assets/NotesFeature.js": dynamic,
      ...(notesStatic ? { "assets/notes-static.js": notesStatic } : {})
    },
    sourceMaps: {
      "assets/App.js.map": { sources: notesSources },
      "assets/NotesFeature.js.map": { sources: lazyNotesSources }
    }
  };
}

describe("bundle budget", () => {
  it("rejects an initial static graph above the raw-byte budget", () => {
    expect(() =>
      checkBundleBudget(
        fixture({
          index: new Uint8Array(100),
          app: new Uint8Array(417_037),
          vendor: new Uint8Array(500_000)
        })
      )
    ).toThrow("initial-js raw actual=917137 budget=917136 over=1");
  });

  it("rejects an initial static graph above the gzip budget", () => {
    expect(() =>
      checkBundleBudget(
        fixture({
          index: bytes(20_000, 1),
          app: bytes(140_000, 2),
          vendor: bytes(140_000, 3)
        })
      )
    ).toThrow(/initial-js gzip actual=\d+ budget=276839 over=\d+/);
  });

  it("rejects an App chunk at the exclusive raw-byte limit", () => {
    expect(() =>
      checkBundleBudget(fixture({ app: new Uint8Array(500_000) }))
    ).toThrow("app-chunk raw actual=500000 budget<500000 over=1");
  });

  it("rejects an App chunk above the gzip budget", () => {
    expect(() =>
      checkBundleBudget(fixture({ app: bytes(170_000, 4) }))
    ).toThrow(/app-chunk gzip actual=\d+ budget=150000 over=\d+/);
  });

  it("rejects Notes sources in the App source map", () => {
    expect(() =>
      checkBundleBudget(
        fixture({ notesSources: ["../../src/features/notes/NotesFeature.tsx"] })
      )
    ).toThrow("app-map notes actual=1 budget=0 over=1");
  });

  it("rejects dnd-kit sources in the App source map", () => {
    expect(() =>
      checkBundleBudget(
        fixture({ notesSources: ["../../node_modules/@dnd-kit/core/dist/core.esm.js"] })
      )
    ).toThrow("app-map dnd-kit actual=1 budget=0 over=1");
  });

  it("rejects a Notes feature chunk at the raw warning limit", () => {
    expect(() =>
      checkBundleBudget(fixture({ dynamic: new Uint8Array(500_000) }))
    ).toThrow("notes-chunk raw actual=500000 budget<500000 over=1");
  });

  it("rejects a Notes route static graph above its measured raw baseline", () => {
    expect(() =>
      checkBundleBudget(
        fixture({
          dynamic: new Uint8Array(400_000),
          notesStatic: new Uint8Array(174_720)
        })
      )
    ).toThrow("notes-route raw actual=574720 budget=574719 over=1");
  });

  it("rejects a Notes route static graph above its measured gzip baseline", () => {
    expect(() =>
      checkBundleBudget(
        fixture({
          dynamic: bytes(90_000, 6),
          notesStatic: bytes(90_000, 7)
        })
      )
    ).toThrow(/notes-route gzip actual=\d+ budget=165751 over=\d+/);
  });

  it("rejects dnd-kit sources retained in the Notes feature chunk", () => {
    expect(() =>
      checkBundleBudget(
        fixture({
          lazyNotesSources: ["../../node_modules/@dnd-kit/core/dist/core.esm.js"]
        })
      )
    ).toThrow("notes-map dnd-kit actual=1 budget=0 over=1");
  });

  it("rejects the on-demand date picker retained in the Notes feature chunk", () => {
    expect(() =>
      checkBundleBudget(
        fixture({
          lazyNotesSources: ["../../src/features/notes/NotesDatePicker.tsx"]
        })
      )
    ).toThrow("notes-map date-picker actual=1 budget=0 over=1");
  });

  it("does not count dynamic Notes bytes in the initial graph", () => {
    const result = checkBundleBudget(
      fixture({ dynamic: new Uint8Array(400_000) })
    );

    expect(result.initialRaw).toBe(600);
    expect(result.notesSources).toBe(0);
    expect(result.dndKitSources).toBe(0);
  });
});
