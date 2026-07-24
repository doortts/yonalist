import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGithubAccountBinding,
  decodeGithubAccountIdentity,
  githubSourceConnectionId,
  loadGithubAccountBinding,
  persistGithubAccountBinding
} from "./githubAccountIdentity";

const API_URL = "https://api.github.com";

describe("GitHub account identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes numeric or string ids with a non-empty login", () => {
    expect(decodeGithubAccountIdentity({ id: 42, login: "octocat" })).toEqual({
      id: "42",
      login: "octocat"
    });
    expect(decodeGithubAccountIdentity({ id: "84", login: " monalisa " })).toEqual({
      id: "84",
      login: "monalisa"
    });
    expect(decodeGithubAccountIdentity({ login: "octocat" })).toBeNull();
    expect(decodeGithubAccountIdentity({ id: 42, login: " " })).toBeNull();
  });

  it("restores an account only when the current credential digest matches", async () => {
    const account = { id: "42", login: "octocat" };
    await persistGithubAccountBinding(
      "https://api.github.com/",
      "token-a",
      account
    );

    await expect(
      loadGithubAccountBinding("https://api.github.com", "token-a")
    ).resolves.toEqual(account);
    await expect(
      loadGithubAccountBinding("https://api.github.com", "token-b")
    ).resolves.toBeNull();
    expect(
      window.localStorage.getItem("yonalist.github.accountBindings.v1")
    ).not.toContain("token-a");
  });

  it("clears the binding for one normalized server", async () => {
    await persistGithubAccountBinding("https://api.github.com", "token-a", {
      id: "42",
      login: "octocat"
    });
    await persistGithubAccountBinding("https://ghe.example.com/api/v3", "token-b", {
      id: "84",
      login: "monalisa"
    });

    clearGithubAccountBinding("https://api.github.com/");

    await expect(
      loadGithubAccountBinding("https://api.github.com", "token-a")
    ).resolves.toBeNull();
    await expect(
      loadGithubAccountBinding("https://ghe.example.com/api/v3", "token-b")
    ).resolves.toEqual({ id: "84", login: "monalisa" });
  });

  it("does not revive a binding cleared while its digest is pending", async () => {
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let resolveDigest!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => digest);

    const saving = persistGithubAccountBinding(API_URL, "token-a", {
      id: "42",
      login: "octocat"
    });
    clearGithubAccountBinding(API_URL);
    resolveDigest(
      await originalDigest("SHA-256", new TextEncoder().encode("token-a"))
    );
    await saving;

    await expect(
      loadGithubAccountBinding(API_URL, "token-a")
    ).resolves.toBeNull();
  });

  it("normalizes whitespace and trailing slashes in the source connection", () => {
    expect(githubSourceConnectionId("  https://api.github.com///  ", "42")).toBe(
      githubSourceConnectionId("https://api.github.com", "42")
    );
  });
});
