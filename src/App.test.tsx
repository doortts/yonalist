import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultMocks = vi.hoisted(() => ({
  drain: vi.fn(),
  release: vi.fn(),
  commit: vi.fn(),
  flush: vi.fn()
}));

const githubRuntimeMocks = vi.hoisted(() => ({
  useRuntime: vi.fn(),
  boundary: {
    pages: [
      {
        providerId: "github-notifications",
        connectionId: null,
        title: "Runtime source",
        availability: "disconnected" as const,
        items: [],
        loaded: false,
        loading: false,
        error: null,
        syncedAt: null,
        completingKeys: [],
        completionErrors: {}
      }
    ],
    refresh: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    openDetails: vi.fn()
  }
}));

vi.mock("./features/notes/notesVaultDrain", () => ({
  acquireNotesVaultDrain: async (vaultRoot: string) => {
    const result = await vaultMocks.drain(vaultRoot);
    if (!result) return null;
    return {
      vaultRoot,
      generation: 1,
      release: () => vaultMocks.release(vaultRoot),
      commit: () => vaultMocks.commit(vaultRoot)
    };
  }
}));

vi.mock("./services/notesStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/notesStore")>();
  return {
    ...actual,
    notesSyncFlush: (vaultRoot: string) => vaultMocks.flush(vaultRoot)
  };
});

vi.mock(
  "./features/notes/githubNotifications/useGithubNotificationsRuntime",
  () => ({
    useGithubNotificationsRuntime: (input: unknown) => {
      githubRuntimeMocks.useRuntime(input);
      return { externalSources: githubRuntimeMocks.boundary };
    }
  })
);

vi.mock("./features/notes/NotesFeature", async () => {
  const React = await import("react");
  const { ExternalSourcesContext } = await import("./ExternalSourcesContext");
  const { GithubConnectionContext } = await import(
    "./GithubConnectionContext"
  );
  const { VaultRootContext } = await import("./VaultRootContext");

  function NotesLibraryProbe() {
    const vaultRoot = React.useContext(VaultRootContext);
    const sources = React.useContext(ExternalSourcesContext);
    const connection = React.useContext(GithubConnectionContext);
    return (
      <section
        aria-label="Notes library"
        data-vault-root={vaultRoot}
        data-source-title={sources.pages[0]?.title ?? ""}
        data-github-api={connection.apiBaseUrl}
      />
    );
  }

  return {
    notesFeatureRuntime: {
      Provider: ({ children }: React.PropsWithChildren) => <>{children}</>,
      renderPanes: () => ({
        middle: <NotesLibraryProbe />,
        detail: <section aria-label="Notes outline" />
      })
    }
  };
});

import App from "./App";
import { activeFeatureStorageKey } from "./features/core/featureSelection";
import * as vaultFolderService from "./services/vaultFolder";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function openVaultSettings() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const categories = await screen.findByLabelText("Settings sections");
  await user.click(
    within(categories).getByRole("tab", { name: /Vault and sync/ })
  );
  return user;
}

describe("Yonalist app shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vaultMocks.drain.mockReset();
    vaultMocks.drain.mockResolvedValue(true);
    vaultMocks.release.mockReset();
    vaultMocks.commit.mockReset();
    vaultMocks.flush.mockReset();
    vaultMocks.flush.mockResolvedValue(undefined);
    githubRuntimeMocks.useRuntime.mockClear();
  });

  it("opens Yonalist without waiting for GitHub authentication", async () => {
    window.localStorage.setItem(activeFeatureStorageKey, "inbox");

    render(<App initialOnline={false} />);

    const notes = await screen.findByLabelText("Notes library");
    expect(notes).toHaveAttribute("data-source-title", "Runtime source");
    expect(notes).toHaveAttribute(
      "data-github-api",
      "https://oss.navercorp.com/api/v3"
    );
    expect(screen.queryByLabelText("GitHub login")).toBeNull();
    expect(githubRuntimeMocks.useRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        online: false,
        pluginEnabled: true,
        desktopNotificationsEnabled: true
      })
    );
  });

  it("does not expose the removed Inbox surfaces", async () => {
    render(<App />);
    await screen.findByLabelText("Notes library");

    expect(screen.queryByText("GitHub Inbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /outbox/i })).toBeNull();
  });

  it("opens GitHub server settings while signed out", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      within(await screen.findByLabelText("Settings sections")).getByRole(
        "tab",
        { name: /GitHub 서버/ }
      )
    );

    expect(await screen.findByLabelText("GitHub servers")).toBeInTheDocument();
    expect(screen.queryByLabelText("GitHub login")).toBeNull();
  });

  it("returns from Settings to Yonalist", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      await screen.findByRole("button", { name: "Close settings" })
    );

    expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();
    expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("notes");
  });

  it("flushes the current Notes Vault before switching roots", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    const flush = deferred<void>();
    vaultMocks.flush.mockReturnValueOnce(flush.promise);
    render(<App />);
    await screen.findByLabelText("Notes library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-new" } });
    fireEvent.blur(input);

    expect(vaultMocks.drain).toHaveBeenCalledWith("/vault-old");
    await waitFor(() =>
      expect(vaultMocks.flush).toHaveBeenCalledWith("/vault-old")
    );
    expect(screen.getByLabelText("Notes library")).toHaveAttribute(
      "data-vault-root",
      "/vault-old"
    );
    expect(vaultMocks.commit).not.toHaveBeenCalled();

    await act(async () => {
      flush.resolve();
      await flush.promise;
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Notes library")).toHaveAttribute(
        "data-vault-root",
        "/vault-new"
      )
    );
    expect(vaultMocks.commit).toHaveBeenCalledWith("/vault-old");
  });

  it("keeps the current Vault selected when its drain fails", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    vaultMocks.drain.mockResolvedValueOnce(false);
    render(<App />);
    await screen.findByLabelText("Notes library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-unsaved" } });
    fireEvent.blur(input);

    expect(
      await screen.findByText("Could not save the current Vault. Try again.")
    ).toBeInTheDocument();
    expect(input).toHaveValue("/vault-unsaved");
    expect(screen.getByLabelText("Notes library")).toHaveAttribute(
      "data-vault-root",
      "/vault-old"
    );
    expect(vaultMocks.flush).not.toHaveBeenCalled();
    expect(vaultMocks.commit).not.toHaveBeenCalled();
  });

  it("keeps the current Vault selected when its flush fails", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    vaultMocks.flush.mockRejectedValueOnce(new Error("export failed"));
    render(<App />);
    await screen.findByLabelText("Notes library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-unsynced" } });
    fireEvent.blur(input);

    expect(
      await screen.findByText("Could not save the current Vault. Try again.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Notes library")).toHaveAttribute(
      "data-vault-root",
      "/vault-old"
    );
    expect(vaultMocks.release).toHaveBeenCalledWith("/vault-old");
    expect(vaultMocks.commit).not.toHaveBeenCalled();
  });

  it("ignores a stale folder picker result after a newer request wins", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    vi.spyOn(vaultFolderService, "pickVaultFolder")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<App />);
    await screen.findByLabelText("Notes library");
    const user = await openVaultSettings();
    const browse = screen.getByRole("button", { name: "Browse…" });

    await user.click(browse);
    await user.click(browse);
    await act(async () => {
      second.resolve("/vault-latest");
      await second.promise;
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Vault folder")).toHaveValue("/vault-latest")
    );
    await act(async () => {
      first.resolve("/vault-stale");
      await first.promise;
    });

    expect(screen.getByLabelText("Vault folder")).toHaveValue("/vault-latest");
    expect(screen.getByLabelText("Notes library")).toHaveAttribute(
      "data-vault-root",
      "/vault-latest"
    );
  });
});
