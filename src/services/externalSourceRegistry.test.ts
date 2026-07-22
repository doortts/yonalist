import { expect, it } from "vitest";
import { builtinExternalSourceDescriptors } from "./externalSourceRegistry";

it("registers only bundled first-party providers", () => {
  expect(builtinExternalSourceDescriptors).toEqual([
    { id: "github-notifications", title: "Notifications" }
  ]);
});
