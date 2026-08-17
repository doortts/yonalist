import { freshId } from "./storeSupport";

const YID = /^[A-Za-z0-9_-]{12}$/;

/**
 * The id is written into the markdown vault as `<!-- yid: ... -->` and is the
 * node's identity across devices, so an id of the wrong shape is unexportable.
 * Minting a fallback would put such a node in the outline; throwing keeps it out.
 *
 * Twelve base64url characters, which is exactly nine bytes: three groups of
 * three, so there is no padding to strip and no partial group to bias. The same
 * alphabet a Markdown comment, a folder name and a SQLite key all carry without
 * quoting.
 */
describe("freshId", () => {
  it("mints twelve url-safe characters", () => {
    expect(freshId()).toMatch(YID);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 256 }, () => freshId()));

    expect(seen.size).toBe(256);
  });

  it("throws rather than minting an id of the wrong shape", () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true
    });
    try {
      expect(() => freshId()).toThrow();
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: real,
        configurable: true
      });
    }
  });
});
