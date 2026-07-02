import { describe, expect, it } from "vitest";
import type { RepositorySummary } from "./githubItems";
import { isRepositoryVisible } from "./projectVisibilityStore";

function repo(overrides: Partial<RepositorySummary>): RepositorySummary {
  return {
    owner: "acme",
    name: "app",
    fullName: "acme/app",
    openIssuesCount: 0,
    pushedAt: "",
    participating: false,
    watched: false,
    orgMember: false,
    ...overrides
  };
}

describe("isRepositoryVisible", () => {
  const noInvolvement = new Set<string>();

  it("shows participating and watched repositories by default", () => {
    expect(isRepositoryVisible(repo({ participating: true }), {}, noInvolvement)).toBe(true);
    expect(isRepositoryVisible(repo({ watched: true }), {}, noInvolvement)).toBe(true);
  });

  it("hides org-membership-only repositories by default", () => {
    expect(isRepositoryVisible(repo({ orgMember: true }), {}, noInvolvement)).toBe(false);
  });

  it("shows org repositories where the user has inbox activity", () => {
    expect(
      isRepositoryVisible(repo({ orgMember: true }), {}, new Set(["acme/app"]))
    ).toBe(true);
  });

  it("lets explicit choices override every default", () => {
    expect(
      isRepositoryVisible(repo({ participating: true }), { "acme/app": false }, noInvolvement)
    ).toBe(false);
    expect(
      isRepositoryVisible(repo({ orgMember: true }), { "acme/app": true }, noInvolvement)
    ).toBe(true);
  });
});
