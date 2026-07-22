import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen } from "@testing-library/react";
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

function renderExternalRow(
  options: {
    bullet?: ExternalBullet;
    complete?: ExternalSourcesBoundary["complete"];
    completing?: boolean;
    completionError?: string | null;
    openDetails?: ExternalSourcesBoundary["openDetails"];
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
      />
    </ExternalSourcesContext.Provider>
  );
  return { ...rendered, boundary, complete, openDetails };
}

describe("NotesExternalBulletRow", () => {
  it("keeps child, note, and mobile action alignment compact", () => {
    const mobileStyles = notesStyles.slice(
      notesStyles.indexOf("@media (max-width: 720px)")
    );

    expect(notesStyles).toMatch(
      /\.notes-external-children\s*{[^}]*margin-left:\s*28px;/s
    );
    expect(notesStyles).toMatch(
      /\.notes-external-note\s*{[^}]*margin:\s*0 66px 7px 45px;[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s
    );
    expect(mobileStyles).toMatch(
      /\.notes-external-row-main\s*{[^}]*grid-template-columns:\s*26px 14px minmax\(0, 1fr\) 28px 28px;/s
    );
    expect(mobileStyles).toMatch(
      /\.notes-external-details\s*{[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;/s
    );
    expect(mobileStyles).toMatch(
      /\.notes-external-complete\s*{[^}]*grid-column:\s*5;[^}]*grid-row:\s*1;/s
    );
    expect(mobileStyles).toMatch(
      /\.notes-external-note,\s*\.notes-external-completion-error\s*{[^}]*margin-inline:\s*45px 4px;/s
    );
  });

  it("shows a non-expandable typed row and its note immediately", () => {
    renderExternalRow();

    expect(
      screen.queryByRole("button", { name: `펼치기: ${unreadBullet.title}` })
    ).not.toBeInTheDocument();
    expect(screen.getByText(unreadBullet.note)).toBeInTheDocument();
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
    expect(screen.queryByText(expandable.note)).not.toBeInTheDocument();

    await user.click(expand);

    expect(expand).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(expandable.note)).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: unreadBullet.title }));
    await user.click(
      screen.getByRole("button", {
        name: `웹에서 열기: ${unreadBullet.title}`
      })
    );

    expect(complete).not.toHaveBeenCalled();
    expect(openDetails).toHaveBeenCalledWith(unreadBullet.key);
    expect(screen.getByText(unreadBullet.note)).toBeInTheDocument();
  });

  it("blocks duplicate completion and waits for the host snapshot", async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<void>();
    const complete = vi.fn().mockReturnValue(deferred.promise);
    const rendered = renderExternalRow({ complete });
    const button = screen.getByRole("button", {
      name: `완료: ${unreadBullet.title}`
    });

    await user.dblClick(button);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector("[data-external-bullet-key]")).toHaveAttribute(
      "aria-busy",
      "true"
    );
    deferred.resolve();
    await act(async () => deferred.promise);
    expect(button).toHaveAttribute("aria-pressed", "false");
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
      screen.queryByRole("button", { name: `완료: ${unreadBullet.title}` })
    ).not.toBeInTheDocument();
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

    await user.click(
      screen.getByRole("button", { name: `완료: ${unreadBullet.title}` })
    );

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
      const title = screen.getByRole("button", { name: unreadBullet.title });

      title.focus();
      await user.keyboard(`{${modifier}>}{Enter}{/${modifier}}`);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(unreadBullet.key);
    }
  );

  it("renders title and note as read-only text and never offers uncomplete", () => {
    renderExternalRow({ bullet: { ...unreadBullet, completed: true } });

    expect(
      screen.getByRole("button", { name: `${unreadBullet.title}, 완료됨` })
    ).toBeInTheDocument();

    const row = document.querySelector("[data-external-bullet-key]")!;
    expect(row).not.toHaveAttribute("data-outline-id");
    expect(row.querySelector("textarea")).toBeNull();
    expect(row.querySelector("[contenteditable]" )).toBeNull();
    expect(screen.getByText(unreadBullet.note)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /완료 취소/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^완료:/ })).toBeNull();
  });
});
