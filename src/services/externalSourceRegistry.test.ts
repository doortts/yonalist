import { expect, it } from "vitest";
import { builtinExternalSourceDescriptors } from "./externalSourceRegistry";
import { GITHUB_NOTIFICATIONS_PROVIDER_TITLE } from "./githubNotificationsProvider";

it("registers only bundled first-party providers", () => {
  expect(builtinExternalSourceDescriptors).toEqual([
    {
      id: "github-notifications",
      title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
    }
  ]);
});
