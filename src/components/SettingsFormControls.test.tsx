import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UseProjectVisibilityResult } from "../hooks/useProjectVisibility";
import type { OwnerGroup, RepositorySummary } from "../services/githubItems";
import { GithubServersSection } from "./GithubServersSection";
import { MarkdownStyleComparison } from "./MarkdownStyleComparison";
import { ProjectsVisibilitySection } from "./ProjectsVisibilitySection";
import { ConfirmDialog } from "./ui/ConfirmDialog";

function makeRepo(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    owner: "acme",
    name: "app",
    fullName: "acme/app",
    openIssuesCount: 0,
    pushedAt: "2026-01-01T00:00:00Z",
    participating: true,
    watched: false,
    orgMember: false,
    ...overrides
  };
}

describe("MarkdownStyleComparison (Base UI RadioGroup)", () => {
  it("renders a radio group with one radio per style option", () => {
    render(<MarkdownStyleComparison value="github" onChange={() => {}} />);

    const group = screen.getByRole("radiogroup", { name: "Markdown style" });
    expect(group).toHaveClass("theme-options", "markdown-style-options");

    const github = screen.getByRole("radio", { name: "GitHub markdown style" });
    const yona = screen.getByRole("radio", { name: "Yona markdown style" });
    expect(github).toHaveAttribute("aria-checked", "true");
    expect(yona).toHaveAttribute("aria-checked", "false");
  });

  it("keeps the active class in sync with the selected value", () => {
    const { rerender } = render(
      <MarkdownStyleComparison value="github" onChange={() => {}} />
    );
    expect(screen.getByRole("radio", { name: "GitHub markdown style" })).toHaveClass(
      "theme-option",
      "active"
    );

    rerender(<MarkdownStyleComparison value="yona" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Yona markdown style" })).toHaveClass(
      "theme-option",
      "active"
    );
  });

  it("invokes onChange with the newly selected style value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MarkdownStyleComparison value="github" onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Yona markdown style" }));

    expect(onChange).toHaveBeenCalledWith("yona");
  });
});

describe("ProjectsVisibilitySection (Base UI Checkbox)", () => {
  const groups: OwnerGroup[] = [
    {
      owner: "acme",
      repositories: [
        makeRepo({ name: "app", fullName: "acme/app" }),
        makeRepo({ name: "web", fullName: "acme/web", orgMember: true })
      ]
    }
  ];

  function makeVisibility(
    visibleFullNames: string[],
    overrides: Partial<UseProjectVisibilityResult> = {}
  ): UseProjectVisibilityResult {
    return {
      visibleGroups: [],
      isVisible: (repository) => visibleFullNames.includes(repository.fullName),
      setRepositoryVisible: vi.fn(),
      setOwnerVisible: vi.fn(),
      reset: vi.fn(),
      ...overrides
    };
  }

  it("shows the owner checkbox as indeterminate when only some repos are visible", () => {
    render(
      <ProjectsVisibilitySection
        groups={groups}
        visibility={makeVisibility(["acme/app"])}
      />
    );

    expect(
      screen.getByRole("checkbox", { name: "Show acme projects" })
    ).toHaveAttribute("aria-checked", "mixed");
  });

  it("shows the owner checkbox as checked when all repos are visible", () => {
    render(
      <ProjectsVisibilitySection
        groups={groups}
        visibility={makeVisibility(["acme/app", "acme/web"])}
      />
    );

    expect(
      screen.getByRole("checkbox", { name: "Show acme projects" })
    ).toHaveAttribute("aria-checked", "true");
  });

  it("toggles an individual repository via onCheckedChange", async () => {
    const user = userEvent.setup();
    const setRepositoryVisible = vi.fn();
    render(
      <ProjectsVisibilitySection
        groups={groups}
        visibility={makeVisibility(["acme/app"], { setRepositoryVisible })}
      />
    );

    await user.click(screen.getByRole("checkbox", { name: "Show acme/web" }));

    expect(setRepositoryVisible).toHaveBeenCalledWith("acme/web", true);
  });

  it("toggles the whole owner group via onCheckedChange", async () => {
    const user = userEvent.setup();
    const setOwnerVisible = vi.fn();
    render(
      <ProjectsVisibilitySection
        groups={groups}
        visibility={makeVisibility(["acme/app", "acme/web"], { setOwnerVisible })}
      />
    );

    await user.click(screen.getByRole("checkbox", { name: "Show acme projects" }));

    expect(setOwnerVisible).toHaveBeenCalledWith(groups[0], false);
  });
});

describe("GithubServersSection auth toggle (Base UI ToggleGroup)", () => {
  function makeServers(): UseGithubServersResultLike {
    return {
      urls: ["https://api.github.com"],
      selectedUrl: "https://api.github.com",
      state: { aliases: {} },
      labelOf: (url: string) => url,
      usesToken: () => false,
      tokenOf: () => "",
      select: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn(),
      reset: vi.fn()
    };
  }

  const auth = {
    signedIn: false,
    loggingIn: false,
    authMethod: "oauth" as const,
    error: null,
    login: vi.fn(),
    logout: vi.fn()
  };

  it("renders both auth segments as pressable toggles with OAuth selected by default", async () => {
    const user = userEvent.setup();
    render(
      <GithubServersSection
        servers={makeServers() as never}
        auth={auth as never}
      />
    );

    await user.click(screen.getByRole("button", { name: "URL 추가" }));

    const oauth = screen.getByRole("button", { name: "OAuth" });
    const token = screen.getByRole("button", { name: "개인 토큰" });
    expect(oauth).toHaveClass("segment");
    expect(oauth).toHaveAttribute("aria-pressed", "true");
    expect(token).toHaveAttribute("aria-pressed", "false");
  });

  it("switches auth method to personal token when the token segment is pressed", async () => {
    const user = userEvent.setup();
    render(
      <GithubServersSection
        servers={makeServers() as never}
        auth={auth as never}
      />
    );

    await user.click(screen.getByRole("button", { name: "URL 추가" }));
    await user.click(screen.getByRole("button", { name: "개인 토큰" }));

    const tokenSegment = screen.getByRole("button", { name: "개인 토큰" });
    const oauthSegment = screen.getByRole("button", { name: "OAuth" });
    expect(tokenSegment).toHaveAttribute("aria-pressed", "true");
    // Single-select: pressing one segment unpresses the other.
    expect(oauthSegment).toHaveAttribute("aria-pressed", "false");
    // The personal token field only appears once token auth is selected.
    expect(
      screen.getByLabelText("Personal Access Token")
    ).toBeInTheDocument();
  });
});

describe("ConfirmDialog (Base UI AlertDialog)", () => {
  it("renders the title, description and labelled buttons when open", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete server?"
        description="This removes the URL from the list."
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    );

    const dialog = screen.getByRole("alertdialog", { name: "Delete server?" });
    expect(dialog).toHaveTextContent("This removes the URL from the list.");
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    // Cancel label defaults when not provided.
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeInTheDocument();
  });

  it("does not render its popup while closed", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="Delete server?"
        description="This removes the URL from the list."
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("calls onConfirm and closes when the confirm button is pressed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete server?"
        description="This removes the URL from the list."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes without confirming when the cancel button is pressed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete server?"
        description="This removes the URL from the list."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
      />
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Escape without confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete server?"
        description="This removes the URL from the list."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    );

    await user.keyboard("{Escape}");

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("applies the danger class to the confirm button when danger is set", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete server?"
        description="This removes the URL from the list."
        confirmLabel="Delete"
        danger
        onConfirm={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("danger-button");
  });
});

describe("GithubServersSection remove confirmation (Base UI AlertDialog)", () => {
  function makeServers(
    overrides: Partial<UseGithubServersResultLike> = {}
  ): UseGithubServersResultLike {
    return {
      urls: ["https://ghe.example.com/api/v3"],
      selectedUrl: "https://ghe.example.com/api/v3",
      state: { aliases: {} },
      labelOf: (url: string) => url,
      usesToken: () => false,
      tokenOf: () => "",
      select: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn(),
      reset: vi.fn(),
      ...overrides
    };
  }

  const auth = {
    signedIn: false,
    loggingIn: false,
    authMethod: "oauth" as const,
    error: null,
    login: vi.fn(),
    logout: vi.fn()
  };

  it("opens a confirmation dialog instead of window.confirm when removing a server", async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    render(
      <GithubServersSection
        servers={makeServers({ remove }) as never}
        auth={auth as never}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Remove https://ghe.example.com/api/v3" })
    );

    const dialog = await screen.findByRole("alertdialog", {
      name: "URL을 삭제할까요?"
    });
    expect(dialog).toHaveTextContent("이 URL을 목록에서 삭제할까요?");
    // Nothing removed until the confirm button is pressed.
    expect(remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    expect(remove).toHaveBeenCalledWith("https://ghe.example.com/api/v3");
  });

  it("does not remove the server when the removal dialog is cancelled", async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    render(
      <GithubServersSection
        servers={makeServers({ remove }) as never}
        auth={auth as never}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Remove https://ghe.example.com/api/v3" })
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "URL을 삭제할까요?"
    });
    await user.click(within(dialog).getByRole("button", { name: "취소" }));

    expect(remove).not.toHaveBeenCalled();
  });

  it("opens a confirmation dialog before resetting to defaults", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(
      <GithubServersSection
        servers={makeServers({ reset }) as never}
        auth={auth as never}
      />
    );

    await user.click(screen.getByRole("button", { name: "기본값으로 초기화" }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "기본값으로 초기화할까요?"
    });
    expect(reset).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "초기화" }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("decorates the edit and remove icon buttons with tooltips instead of native titles", () => {
    render(
      <GithubServersSection
        servers={makeServers() as never}
        auth={auth as never}
      />
    );

    const editButton = screen.getByRole("button", {
      name: "Edit https://ghe.example.com/api/v3"
    });
    const removeButton = screen.getByRole("button", {
      name: "Remove https://ghe.example.com/api/v3"
    });
    expect(editButton).not.toHaveAttribute("title");
    expect(removeButton).not.toHaveAttribute("title");
  });
});

interface UseGithubServersResultLike {
  urls: string[];
  selectedUrl: string;
  state: { aliases: Record<string, string> };
  labelOf: (url: string) => string;
  usesToken: (url: string) => boolean;
  tokenOf: (url: string) => string;
  select: (url: string) => void;
  upsert: (input: unknown) => void;
  remove: (url: string) => void;
  reset: () => void;
}
