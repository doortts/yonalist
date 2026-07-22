import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary
} from "../../ExternalSourcesContext";
import type { ExternalBullet } from "../../domain/externalSources";
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
  parentKey: null,
  title: "Fix inline caret #17",
  note: "Repository: acme/app\nReason: mention",
  updatedAt: "2026-07-22T00:00:00Z",
  completed: false,
  capabilities: {
    expand: true,
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
  it("matches ordinary supporting-note typography", () => {
    expect(notesStyles).toMatch(
      /\.notes-external-note\s*{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s
    );
  });

  it("does not offer expansion when the provider disallows it", () => {
    renderExternalRow({
      bullet: {
        ...unreadBullet,
        capabilities: { ...unreadBullet.capabilities, expand: false }
      }
    });

    expect(
      screen.queryByRole("button", { name: `펼치기: ${unreadBullet.title}` })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Repository: acme/app")).not.toBeInTheDocument();
  });

  it("does not complete on selection, expansion, or details", async () => {
    const user = userEvent.setup();
    const { complete, openDetails } = renderExternalRow();

    await user.click(screen.getByRole("button", { name: unreadBullet.title }));
    await user.click(
      screen.getByRole("button", { name: `펼치기: ${unreadBullet.title}` })
    );
    await user.click(screen.getByRole("button", { name: "상세보기" }));

    expect(complete).not.toHaveBeenCalled();
    expect(openDetails).toHaveBeenCalledWith(unreadBullet.key);
    expect(screen.getByText("Repository: acme/app")).toBeInTheDocument();
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
    deferred.resolve();
    await act(async () => deferred.promise);
    expect(button).toHaveAttribute("aria-pressed", "false");

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

  it("renders title and note as read-only text and never offers uncomplete", async () => {
    const user = userEvent.setup();
    renderExternalRow({ bullet: { ...unreadBullet, completed: true } });

    await user.click(
      screen.getByRole("button", { name: `펼치기: ${unreadBullet.title}` })
    );

    const row = document.querySelector("[data-external-bullet-key]")!;
    expect(row).not.toHaveAttribute("data-outline-id");
    expect(row.querySelector("textarea")).toBeNull();
    expect(row.querySelector("[contenteditable]" )).toBeNull();
    expect(screen.getByText("Repository: acme/app")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /완료 취소/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^완료:/ })).toBeNull();
  });
});
