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
  flush: vi.fn(),
  contextRoots: [] as string[]
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

const settingsPageProbe = vi.hoisted(() => ({
  fail: false,
  attempts: 0
}));

const settingsCategoryProbe = vi.hoisted(() => ({
  fail: false,
  attempts: 0
}));

const notesDetailProbe = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0
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

vi.mock("./components/SettingsCategoryPane", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./components/SettingsCategoryPane")>();

  function SettingsCategoryPaneProbe(
    props: Parameters<typeof actual.SettingsCategoryPane>[0]
  ) {
    settingsCategoryProbe.attempts += 1;
    if (settingsCategoryProbe.fail) {
      throw new Error("settings category render failed");
    }
    return <actual.SettingsCategoryPane {...props} />;
  }

  return { ...actual, SettingsCategoryPane: SettingsCategoryPaneProbe };
});

vi.mock("./components/SettingsPage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/SettingsPage")>();

  function SettingsPageProbe(
    props: Parameters<typeof actual.SettingsPage>[0]
  ) {
    settingsPageProbe.attempts += 1;
    if (settingsPageProbe.fail) {
      throw new Error("settings render failed");
    }
    return <actual.SettingsPage {...props} />;
  }

  return { ...actual, SettingsPage: SettingsPageProbe };
});

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
    React.useEffect(() => {
      vaultMocks.contextRoots.push(vaultRoot);
    }, [vaultRoot]);
    return (
      <section
        aria-label="Yonalist library"
        data-vault-root={vaultRoot}
        data-source-title={sources.pages[0]?.title ?? ""}
        data-github-api={connection.apiBaseUrl}
      />
    );
  }

  function NotesDetailProbe() {
    React.useEffect(() => {
      notesDetailProbe.mounts += 1;
      return () => {
        notesDetailProbe.unmounts += 1;
      };
    }, []);
    return <section aria-label="Notes outline" />;
  }

  return {
    notesFeatureRuntime: {
      Provider: ({ children }: React.PropsWithChildren) => <>{children}</>,
      renderPanes: () => ({
        navigation: {
          headerActions: null,
          content: <NotesLibraryProbe />
        },
        detail: <NotesDetailProbe />
      })
    }
  };
});

import App from "./App";
import { defaultSettings } from "./appSettings";
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
    vaultMocks.contextRoots.length = 0;
    githubRuntimeMocks.useRuntime.mockClear();
    settingsPageProbe.fail = false;
    settingsPageProbe.attempts = 0;
    settingsCategoryProbe.fail = false;
    settingsCategoryProbe.attempts = 0;
    notesDetailProbe.mounts = 0;
    notesDetailProbe.unmounts = 0;
  });

  it("opens Yonalist without waiting for GitHub authentication", async () => {
    window.localStorage.setItem(activeFeatureStorageKey, "inbox");

    render(<App initialOnline={false} />);

    const notes = await screen.findByLabelText("Yonalist library");
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
    await screen.findByLabelText("Yonalist library");

    expect(screen.queryByText("GitHub Inbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /outbox/i })).toBeNull();
  });

  it("renders Notes with no middle pane or item-list resizer", async () => {
    const { container } = render(<App />);

    await screen.findByLabelText("Yonalist library");

    const shell = container.querySelector(".app-shell");
    expect(shell).not.toHaveAttribute("data-has-middle-pane");
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(
      screen.queryByRole("separator", { name: "Resize item list pane" })
    ).toBeNull();
    expect(
      screen.getByRole("separator", { name: "Resize navigation pane" })
    ).toHaveAttribute("aria-valuemin", "320");
    expect(
      screen.getByRole("separator", { name: "Resize navigation pane" })
    ).toHaveAttribute("aria-valuemax", "480");
    expect(
      screen.getByRole("separator", { name: "Resize navigation pane" })
    ).toHaveAttribute("aria-valuenow", "336");
  });

  it("adds the Settings category pane without replacing navigation", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByLabelText("Yonalist library");

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(container.querySelector(".app-shell")).toHaveAttribute(
      "data-has-middle-pane",
      "true"
    );
    expect(
      screen.getByRole("navigation", { name: "Navigation" })
    ).toBeInTheDocument();
    const shell = container.querySelector("main.app-shell");
    const settingsSections = await screen.findByLabelText("Settings sections");
    expect(shell).toContainElement(settingsSections);
    expect(shell).toContainElement(
      screen.getByRole("separator", { name: "Resize item list pane" })
    );
  });

  it("keeps navigation and retries a Settings render failure inside Detail", async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await import("./components/SettingsPage");
    settingsPageProbe.fail = true;
    render(<App />);
    await screen.findByLabelText("Yonalist library");
    await waitFor(() => {
      expect(notesDetailProbe.mounts).toBeGreaterThan(0);
    });
    const notesMountsBeforeSettings = notesDetailProbe.mounts;
    const notesUnmountsBeforeSettings = notesDetailProbe.unmounts;

    await user.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(settingsPageProbe.attempts).toBeGreaterThan(0);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings를 열 수 없습니다."
    );
    expect(
      screen.getByRole("navigation", { name: "Navigation" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Settings sections")).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "Detail" });
    expect(within(detail).getByRole("alert")).toBeInTheDocument();
    expect(notesDetailProbe.mounts).toBe(notesMountsBeforeSettings);
    expect(notesDetailProbe.unmounts).toBe(notesUnmountsBeforeSettings);

    const attemptsBeforeRetry = settingsPageProbe.attempts;
    settingsPageProbe.fail = false;
    await user.click(
      within(detail).getByRole("button", { name: "다시 시도" })
    );

    expect(
      await screen.findByRole("radiogroup", { name: "Theme mode" })
    ).toBeInTheDocument();
    expect(settingsPageProbe.attempts).toBeGreaterThan(attemptsBeforeRetry);
    expect(
      screen.getByRole("navigation", { name: "Navigation" })
    ).toBeInTheDocument();
    expect(notesDetailProbe.mounts).toBe(notesMountsBeforeSettings);
    expect(notesDetailProbe.unmounts).toBe(notesUnmountsBeforeSettings);
    consoleError.mockRestore();
  });

  it("keeps navigation and Settings detail when the category pane retries", async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    settingsCategoryProbe.fail = true;
    render(<App />);
    await screen.findByLabelText("Yonalist library");

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings를 열 수 없습니다."
    );
    expect(
      screen.getByRole("navigation", { name: "Navigation" })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("radiogroup", { name: "Theme mode" })
    ).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "Detail" });
    expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();
    const categoryFailure = screen.getByRole("alert");
    const attemptsBeforeRetry = settingsCategoryProbe.attempts;

    settingsCategoryProbe.fail = false;
    await user.click(
      within(categoryFailure).getByRole("button", { name: "다시 시도" })
    );

    expect(await screen.findByLabelText("Settings sections")).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "Theme mode" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Navigation" })
    ).toBeInTheDocument();
    expect(settingsCategoryProbe.attempts).toBeGreaterThan(attemptsBeforeRetry);
    consoleError.mockRestore();
  });

  it("opens GitHub server settings while signed out", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("Yonalist library");

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
    await screen.findByLabelText("Yonalist library");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      await screen.findByRole("button", { name: "Close settings" })
    );

    expect(await screen.findByLabelText("Yonalist library")).toBeInTheDocument();
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
    await screen.findByLabelText("Yonalist library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-new" } });
    fireEvent.blur(input);

    expect(vaultMocks.drain).toHaveBeenCalledWith("/vault-old");
    await waitFor(() =>
      expect(vaultMocks.flush).toHaveBeenCalledWith("/vault-old")
    );
    expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
      "data-vault-root",
      "/vault-old"
    );
    expect(vaultMocks.commit).not.toHaveBeenCalled();

    await act(async () => {
      flush.resolve();
      await flush.promise;
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
        "data-vault-root",
        "/vault-new"
      )
    );
    expect(vaultMocks.commit).toHaveBeenCalledWith("/vault-old");
  });

  it("uses the default Vault root for context, drain, and flush when the stored folder is blank", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "   " })
    );
    const flush = deferred<void>();
    vaultMocks.flush.mockReturnValueOnce(flush.promise);
    render(<App />);

    expect(await screen.findByLabelText("Yonalist library")).toHaveAttribute(
      "data-vault-root",
      defaultSettings.vaultFolder
    );
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-new" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(vaultMocks.drain).toHaveBeenCalledWith(
        defaultSettings.vaultFolder
      )
    );
    await waitFor(() =>
      expect(vaultMocks.flush).toHaveBeenCalledWith(
        defaultSettings.vaultFolder
      )
    );
    expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
      "data-vault-root",
      defaultSettings.vaultFolder
    );

    await act(async () => {
      flush.resolve();
      await flush.promise;
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
        "data-vault-root",
        "/vault-new"
      )
    );
    expect(vaultMocks.commit).toHaveBeenCalledWith(defaultSettings.vaultFolder);
  });

  it("releases a superseded drain when the latest request returns to the active Vault", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    const drain = deferred<boolean>();
    vaultMocks.drain.mockReturnValue(drain.promise);
    render(<App />);
    await screen.findByLabelText("Yonalist library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-new" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "/vault-old" } });
    fireEvent.blur(input);

    await act(async () => {
      drain.resolve(true);
      await drain.promise;
    });

    await waitFor(() =>
      expect(vaultMocks.release).toHaveBeenCalledTimes(2)
    );
    expect(vaultMocks.release).toHaveBeenNthCalledWith(1, "/vault-old");
    expect(vaultMocks.release).toHaveBeenNthCalledWith(2, "/vault-old");
    expect(vaultMocks.commit).not.toHaveBeenCalled();
    expect(vaultMocks.contextRoots).not.toContain("/vault-new");
    expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
      "data-vault-root",
      "/vault-old"
    );
  });

  it("commits only the latest eligible Vault when a pending change is superseded", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    const drain = deferred<boolean>();
    vaultMocks.drain.mockReturnValue(drain.promise);
    render(<App />);
    await screen.findByLabelText("Yonalist library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-first" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "/vault-latest" } });
    fireEvent.blur(input);

    await act(async () => {
      drain.resolve(true);
      await drain.promise;
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
        "data-vault-root",
        "/vault-latest"
      )
    );
    expect(vaultMocks.release).toHaveBeenCalledOnce();
    expect(vaultMocks.release).toHaveBeenCalledWith("/vault-old");
    expect(vaultMocks.commit).toHaveBeenCalledOnce();
    expect(vaultMocks.commit).toHaveBeenCalledWith("/vault-old");
    expect(vaultMocks.flush).toHaveBeenCalledOnce();
    expect(vaultMocks.flush).toHaveBeenCalledWith("/vault-old");
    expect(vaultMocks.contextRoots).not.toContain("/vault-first");
  });

  it("keeps a return-to-active request stale when another Vault supersedes it", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    const drain = deferred<boolean>();
    vaultMocks.drain.mockReturnValue(drain.promise);
    render(<App />);
    await screen.findByLabelText("Yonalist library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    for (const folder of ["/vault-first", "/vault-old", "/vault-latest"]) {
      fireEvent.change(input, { target: { value: folder } });
      fireEvent.blur(input);
    }

    await act(async () => {
      drain.resolve(true);
      await drain.promise;
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
        "data-vault-root",
        "/vault-latest"
      )
    );
    expect(vaultMocks.release).toHaveBeenCalledTimes(2);
    expect(vaultMocks.commit).toHaveBeenCalledOnce();
    expect(vaultMocks.commit).toHaveBeenCalledWith("/vault-old");
    expect(vaultMocks.flush).toHaveBeenCalledOnce();
    expect(vaultMocks.flush).toHaveBeenCalledWith("/vault-old");
    expect(vaultMocks.contextRoots).not.toContain("/vault-first");
  });

  it("keeps the current Vault selected when its drain fails", async () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ vaultFolder: "/vault-old" })
    );
    vaultMocks.drain.mockResolvedValueOnce(false);
    render(<App />);
    await screen.findByLabelText("Yonalist library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-unsaved" } });
    fireEvent.blur(input);

    expect(
      await screen.findByText("Could not save the current Vault. Try again.")
    ).toBeInTheDocument();
    expect(input).toHaveValue("/vault-unsaved");
    expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
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
    await screen.findByLabelText("Yonalist library");
    await openVaultSettings();
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, { target: { value: "/vault-unsynced" } });
    fireEvent.blur(input);

    expect(
      await screen.findByText("Could not save the current Vault. Try again.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
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
    await screen.findByLabelText("Yonalist library");
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
    expect(screen.getByLabelText("Yonalist library")).toHaveAttribute(
      "data-vault-root",
      "/vault-latest"
    );
  });
});
