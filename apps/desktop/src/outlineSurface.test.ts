import { outlineSurfaceFromSearch } from "./outlineSurface";

describe("outline surface selection", () => {
  it("keeps the React outline as control and opts into Monaco explicitly", () => {
    expect(outlineSurfaceFromSearch("")).toBe("react");
    expect(outlineSurfaceFromSearch("?outline=monaco")).toBe("monaco");
    expect(outlineSurfaceFromSearch("?outline=react")).toBe("react");
    expect(outlineSurfaceFromSearch("?outline=unknown")).toBe("react");
    expect(outlineSurfaceFromSearch("?other=monaco")).toBe("react");
  });
});
