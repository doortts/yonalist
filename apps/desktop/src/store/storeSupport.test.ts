import { freshId } from "./storeSupport";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The id is written into the markdown vault as `<!-- yid: ... -->` and is the
 * node's identity across devices, so a non-UUID id is unexportable. Minting a
 * fallback id would put such a node in the outline; throwing keeps it out.
 */
describe("freshId", () => {
  it("mints a UUID", () => {
    expect(freshId()).toMatch(UUID_V4);
  });

  it("throws rather than minting a non-UUID id", () => {
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
