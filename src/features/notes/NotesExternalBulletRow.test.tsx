import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary
} from "../../ExternalSourcesContext";
import type {
  ExternalBullet,
  ExternalBulletIcon
} from "../../domain/externalSources";
import type { NoteImportNode } from "../../domain/notes";
import { NotesExternalBulletRow } from "./NotesExternalBulletRow";

const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);

const unreadBullet: ExternalBullet = {
  key: {
    providerId: "github-notifications",
    connectionId: "github:user-7",
    remoteId: "thread-17"
  },
  icon: "pull-request",
  externalUrl: "https://github.com/acme/app/pull/17",
  parentKey: null,
  title: "Fix inline caret #17",
  note: "app, 2h ago, seen 1h ago",
  updatedAt: "2026-07-22T00:00:00Z",
  completed: false,
  capabilities: {
    expand: false,
    openDetails: true,
    complete: true,
    uncomplete: false,
    edit: false,
    move: false,
    delete: false,
    createChild: false
  }
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function getEditor(label: string): HTMLTextAreaElement {
  const editor = document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`
  );
  if (!editor) {
    throw new Error(`Unable to find editor: ${label}`);
  }
  return editor;
}

function renderExternalRow(
  options: {
    bullet?: ExternalBullet;
    complete?: ExternalSourcesBoundary["complete"];
    completing?: boolean;
    completionError?: string | null;
    openDetails?: ExternalSourcesBoundary["openDetails"];
    onCreateSibling?: (
      bullet: ExternalBullet
    ) => void | Promise<void>;
    onStructuralPaste?: (
      bullet: ExternalBullet,
      nodes: readonly NoteImportNode[]
    ) => void | Promise<void>;
  } = {}
) {
  const complete = options.complete ?? vi.fn().mockResolvedValue(undefined);
  const openDetails = options.openDetails ?? vi.fn();
  const boundary: ExternalSourcesBoundary = {
    pages: [],
    activeProviderId: unreadBullet.key.providerId,
    selectProvider: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    complete,
    openDetails
  };
  const rendered = render(
    <ExternalSourcesContext.Provider value={boundary}>
      <NotesExternalBulletRow
        bullet={options.bullet ?? unreadBullet}
        completing={options.completing ?? false}
        completionError={options.completionError ?? null}
        onCreateSibling={options.onCreateSibling}
        onStructuralPaste={options.onStructuralPaste}
      />
    </ExternalSourcesContext.Provider>
  );
  return { ...rendered, boundary, complete, openDetails };
}

describe("NotesExternalBulletRow", () => {
  it("uses the native node editor shape and an inline lock-link cluster", () => {
    renderExternalRow();
    const row = document.querySelector<HTMLElement>(
      "[data-external-bullet-key]"
    )!;
    const title = getEditor("Edit node title");
    const titlePresentation = within(row).getByRole("group", {
      name: "Edit node title"
    });
    const note = getEditor(`Supporting note: ${unreadBullet.title}`);
    const actions = row.querySelector<HTMLElement>(
      ".notes-node-inline-actions"
    )!;

    expect(row).toHaveClass("notes-node");
    expect(title).toHaveValue(unreadBullet.title);
    expect(titlePresentation).toHaveStyle({
      overflowWrap: "normal",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });
    expect(note).toHaveValue(unreadBullet.note);
    expect(within(actions).getByText("GitHub에서 관리됨")).toBeInTheDocument();
    const open = within(actions).getByRole("button", {
      name: `웹에서 열기: ${unreadBullet.title}`
    });
    expect(open.querySelector(".lucide-external-link")).not.toBeNull();
    expect(actions.firstElementChild).toHaveClass("notes-node-lock");
    expect(actions.lastElementChild).toBe(open);
    expect(notesStyles).toMatch(
      /\.notes-node-inline-actions\s*{[^}]*display:\s*inline-flex;[^}]*gap:\s*0;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-external-details:hover\s*{[^}]*background:\s*transparent;[^}]*border-color:\s*transparent;[^}]*color:\s*var\(--text-1\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-external-title\s*{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-external-title-line\s*{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-external-title-field\s*{[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-external-title-field\s*>\s*\.notes-token-text\s*{[^}]*position:\s*static !important;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-external-title-field\s*>\s*textarea\s*{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s
    );
  });

  it("shows a non-expandable typed row and its note immediately", () => {
    renderExternalRow();

    expect(
      screen.queryByRole("button", { name: `펼치기: ${unreadBullet.title}` })
    ).not.toBeInTheDocument();
    expect(
      getEditor(`Supporting note: ${unreadBullet.title}`)
    ).toHaveValue(unreadBullet.note);
    expect(
      screen.getByRole("img", { name: "Pull Request" })
    ).toBeInTheDocument();
  });

  it("reveals a generic expandable row note only after expansion", async () => {
    const user = userEvent.setup();
    const expandable = {
      ...unreadBullet,
      icon: undefined,
      capabilities: { ...unreadBullet.capabilities, expand: true }
    };
    renderExternalRow({ bullet: expandable });

    const expand = screen.getByRole("button", {
      name: `펼치기: ${expandable.title}`
    });
    expect(
      document.querySelector(
        `textarea[aria-label="Supporting note: ${expandable.title}"]`
      )
    ).not.toBeInTheDocument();

    await user.click(expand);

    expect(expand).toHaveAttribute("aria-expanded", "true");
    expect(
      getEditor(`Supporting note: ${expandable.title}`)
    ).toHaveValue(expandable.note);
  });

  it.each<[ExternalBulletIcon, string]>([
    ["issue", "Issue"],
    ["pull-request", "Pull Request"],
    ["discussion", "Discussion"],
    ["release", "Release"],
    ["notification", "Notification"]
  ])("maps the %s icon to the %s accessible name", (icon, label) => {
    renderExternalRow({ bullet: { ...unreadBullet, icon } });

    expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
  });

  it("does not complete on selection or opening the web target", async () => {
    const user = userEvent.setup();
    const { complete, openDetails } = renderExternalRow();

    await user.click(
      screen.getByRole("button", {
        name: `웹에서 열기: ${unreadBullet.title}`
      })
    );

    expect(complete).not.toHaveBeenCalled();
    expect(openDetails).toHaveBeenCalledWith(
      unreadBullet.key,
      unreadBullet.externalUrl
    );
    expect(
      getEditor(`Supporting note: ${unreadBullet.title}`)
    ).toHaveValue(unreadBullet.note);
  });

  it("blocks duplicate completion and waits for the host snapshot", async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<void>();
    const complete = vi.fn().mockReturnValue(deferred.promise);
    const rendered = renderExternalRow({ complete });
    const title = getEditor("Edit node title");

    title.focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-external-bullet-key]")).toHaveAttribute(
      "aria-busy",
      "true"
    );
    deferred.resolve();
    await act(async () => deferred.promise);
    expect(document.querySelector("[data-external-bullet-key]")).toHaveAttribute(
      "aria-busy",
      "false"
    );

    rendered.rerender(
      <ExternalSourcesContext.Provider value={rendered.boundary}>
        <NotesExternalBulletRow
          bullet={{ ...unreadBullet, completed: true }}
          completing={false}
          completionError={null}
        />
      </ExternalSourcesContext.Provider>
    );
    expect(
      document.querySelector("[data-external-bullet-key]")
    ).toHaveAttribute("data-completed", "true");
  });

  it("keeps a failed item incomplete and retries explicitly", async () => {
    const user = userEvent.setup();
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unable to complete external item."))
      .mockResolvedValueOnce(undefined);
    renderExternalRow({ complete });

    const title = getEditor("Edit node title");
    title.focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to complete external item."
    );
    expect(document.querySelector("[data-external-bullet-key]")).toHaveAttribute(
      "data-completed",
      "false"
    );

    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each(["Control", "Meta"] as const)(
    "completes only on %s+Enter keyboard intent",
    async (modifier) => {
      const user = userEvent.setup();
      const { complete } = renderExternalRow();
      const title = getEditor("Edit node title");

      title.focus();
      await user.keyboard(`{${modifier}>}{Enter}{/${modifier}}`);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(unreadBullet.key);
    }
  );

  it("keeps provider edits temporary and restores on blur, Escape, and refresh", async () => {
    const user = userEvent.setup();
    const rendered = renderExternalRow();
    const title = getEditor("Edit node title");

    await user.click(
      screen.getByRole("group", { name: "Edit node title" })
    );
    await user.clear(title);
    await user.type(title, "temporary");
    expect(title).toHaveValue("temporary");
    fireEvent.blur(title);
    expect(title).toHaveValue(unreadBullet.title);

    await user.click(
      screen.getByRole("group", { name: "Edit node title" })
    );
    await user.clear(title);
    await user.type(title, "another draft");
    await user.keyboard("{Escape}");
    expect(title).toHaveValue(unreadBullet.title);

    title.focus();
    title.setSelectionRange(unreadBullet.title.length, unreadBullet.title.length);
    rendered.rerender(
      <ExternalSourcesContext.Provider value={rendered.boundary}>
        <NotesExternalBulletRow
          bullet={{ ...unreadBullet, title: "Short" }}
          completing={false}
          completionError={null}
        />
      </ExternalSourcesContext.Provider>
    );
    expect(title).toHaveValue("Short");
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(5);
    expect(title.selectionEnd).toBe(5);
  });

  it("restores the draft when a same-content provider snapshot advances or completes", async () => {
    const user = userEvent.setup();
    const rendered = renderExternalRow();
    const title = getEditor("Edit node title");

    await user.click(
      screen.getByRole("group", { name: "Edit node title" })
    );
    await user.clear(title);
    await user.type(title, "temporary");
    title.setSelectionRange(4, 4);
    rendered.rerender(
      <ExternalSourcesContext.Provider value={rendered.boundary}>
        <NotesExternalBulletRow
          bullet={{
            ...unreadBullet,
            updatedAt: "2026-07-22T00:01:00Z"
          }}
          completing={false}
          completionError={null}
        />
      </ExternalSourcesContext.Provider>
    );

    expect(title).toHaveValue(unreadBullet.title);
    expect(title).toHaveFocus();
    await waitFor(() => expect(title.selectionStart).toBe(4));
    await user.type(title, " draft");
    rendered.rerender(
      <ExternalSourcesContext.Provider value={rendered.boundary}>
        <NotesExternalBulletRow
          bullet={{
            ...unreadBullet,
            updatedAt: "2026-07-22T00:01:00Z",
            completed: true
          }}
          completing={false}
          completionError={null}
        />
      </ExternalSourcesContext.Provider>
    );

    expect(title).toHaveValue(unreadBullet.title);
  });

  it("announces when temporary provider text is restored", async () => {
    const user = userEvent.setup();
    renderExternalRow();
    const title = getEditor("Edit node title");

    await user.click(
      screen.getByRole("group", { name: "Edit node title" })
    );
    await user.type(title, " temporary");
    fireEvent.blur(title);

    expect(screen.getByRole("status")).toHaveTextContent(
      "GitHub content restored."
    );
  });

  it("materializes and creates a sibling on title Enter or note Shift+Enter", async () => {
    const user = userEvent.setup();
    const onCreateSibling = vi.fn().mockResolvedValue(undefined);
    renderExternalRow({ onCreateSibling });
    const title = getEditor("Edit node title");

    await user.click(
      screen.getByRole("group", { name: "Edit node title" })
    );
    await user.type(title, " temporary");
    await user.keyboard("{Enter}");
    expect(onCreateSibling).toHaveBeenCalledTimes(1);
    expect(onCreateSibling).toHaveBeenCalledWith(unreadBullet);
    expect(title).toHaveValue(unreadBullet.title);

    const note = getEditor(`Supporting note: ${unreadBullet.title}`);
    note.focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onCreateSibling).toHaveBeenCalledTimes(2);
  });

  it("materializes only structural title paste and keeps note paste temporary", () => {
    const onStructuralPaste = vi.fn();
    renderExternalRow({ onStructuralPaste });
    const title = getEditor("Edit node title");
    const note = getEditor(`Supporting note: ${unreadBullet.title}`);

    fireEvent.paste(title, {
      clipboardData: { getData: () => "- first\n- second" }
    });
    fireEvent.paste(title, {
      clipboardData: { getData: () => "single line" }
    });
    fireEvent.paste(note, {
      clipboardData: { getData: () => "- note\n- remains text" }
    });

    expect(onStructuralPaste).toHaveBeenCalledOnce();
    expect(onStructuralPaste).toHaveBeenCalledWith(
      unreadBullet,
      [
        { title: "first", children: [] },
        { title: "second", children: [] }
      ]
    );
  });

  it("leaves structural title paste native when no atomic handler is available", () => {
    renderExternalRow();
    const title = getEditor("Edit node title");

    expect(
      fireEvent.paste(title, {
        clipboardData: { getData: () => "- first\n- second" }
      })
    ).toBe(true);
  });

  it.each([
    ["Tab", {}],
    ["Tab", { shiftKey: true }],
    ["Backspace", {}],
    ["Backspace", { metaKey: true, shiftKey: true }],
    ["d", { metaKey: true, shiftKey: true }],
    ["ArrowUp", { ctrlKey: true, shiftKey: true }]
  ])("consumes protected structural %s shortcuts", (key, modifiers) => {
    renderExternalRow();
    const title = getEditor("Edit node title");
    title.setSelectionRange(0, 0);
    expect(
      fireEvent.keyDown(title, { key, ...modifiers })
    ).toBe(false);
  });

  it("keeps primary Backspace native for temporary word and selection edits", () => {
    renderExternalRow();
    const title = getEditor("Edit node title");

    title.setSelectionRange(3, 3);
    expect(
      fireEvent.keyDown(title, { key: "Backspace", metaKey: true })
    ).toBe(true);

    title.setSelectionRange(1, 4);
    expect(
      fireEvent.keyDown(title, { key: "Backspace", ctrlKey: true })
    ).toBe(true);
  });

  it("keeps completed notifications editable-temporary without uncomplete UI", () => {
    renderExternalRow({ bullet: { ...unreadBullet, completed: true } });

    const row = document.querySelector("[data-external-bullet-key]")!;
    expect(row).not.toHaveAttribute("data-outline-id");
    expect(getEditor("Edit node title")).toHaveValue(unreadBullet.title);
    expect(screen.queryByRole("button", { name: /완료 취소/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^완료:/ })).toBeNull();
  });
});
