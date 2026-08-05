import { outlineSurfaceFromSearch } from "./outlineSurface";

describe("outline surface selection", () => {
  it("defaults to the Monaco outline and opts out to React explicitly", () => {
    expect(outlineSurfaceFromSearch("")).toBe("monaco");
    expect(outlineSurfaceFromSearch("?outline=monaco")).toBe("monaco");
    expect(outlineSurfaceFromSearch("?outline=react")).toBe("react");
    expect(outlineSurfaceFromSearch("?outline=unknown")).toBe("monaco");
    expect(outlineSurfaceFromSearch("?other=monaco")).toBe("monaco");
  });
});
