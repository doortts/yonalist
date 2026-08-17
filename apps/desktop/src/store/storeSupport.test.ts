import { freshId } from "./storeSupport";

const YID = /^[A-Za-z0-9_-]{12}$/;

/**
 * The id is written into the markdown vault as `<!-- yid: ... -->` and is the
 * node's identity across devices, so an id of any other shape is unexportable.
 * Minting a fallback id would put such a node in the outline; throwing keeps
 * it out.
 */
describe("freshId", () => {
  it("mints a yid", () => {
    expect(freshId()).toMatch(YID);
  });

  it("does not repeat itself", () => {
    const minted = new Set(Array.from({ length: 512 }, freshId));
    expect(minted.size).toBe(512);
  });

  it("throws rather than minting an id of another shape", () => {
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
