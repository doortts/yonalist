import { describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "./github";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

describe("GitHub client", () => {
  it("uses host-specific API base URLs for issue creation", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ number: 123 }));
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://ghe.example.com/api/v3",
      webBaseUrl: "https://ghe.example.com",
      fetch: fetchMock
    });

    await client.createIssue("doortts", "yonalist", {
      title: "New issue",
      body: "Body"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ghe.example.com/api/v3/repos/doortts/yonalist/issues",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "New issue", body: "Body" })
      })
    );
  });

  it("posts regular issue comments for both issues and pulls", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 456 }));
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock
    });

    await client.createIssueComment("openai", "codex", 7, "Comment");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openai/codex/issues/7/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "Comment" })
      })
    );
  });

  it("starts OAuth device flow with the web base URL", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        device_code: "device",
        user_code: "ABCD",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900
      })
    );
    const client = createGitHubClient({
      token: "",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock
    });

    await client.startDeviceFlow({
      clientId: "client-id",
      scopes: ["repo"]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/device/code",
      expect.objectContaining({ method: "POST" })
    );
  });
});
