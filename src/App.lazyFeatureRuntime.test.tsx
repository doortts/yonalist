import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getFeatureDefinition } from "./features/core/featureRegistry";
import { activeFeatureStorageKey } from "./features/core/featureSelection";
import type { FeatureRuntime } from "./features/core/featureTypes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function PassthroughProvider({ children }: PropsWithChildren) {
  return <>{children}</>;
}

function RetainedNotesPane() {
  const [draft, setDraft] = useState("");
  return (
    <label>
      Notes library
      <input
        aria-label="Notes draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </label>
  );
}

const notesPanes = {
  middle: <RetainedNotesPane />,
  detail: <div aria-label="Notes outline" />
};

const notesRuntime: FeatureRuntime = {
  Provider: PassthroughProvider,
  renderPanes: () => notesPanes
};

function notesLoader() {
  const notes = getFeatureDefinition("notes");
  if (!notes.loadRuntime) {
    throw new Error("Notes runtime must be lazy.");
  }
  return vi.spyOn(notes, "loadRuntime");
}

describe("App lazy feature runtime", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
    window.localStorage.setItem(activeFeatureStorageKey, "settings");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads Yonalist on first selection and retains its pane across navigation", async () => {
    const pending = deferred<FeatureRuntime>();
    const loadRuntime = notesLoader().mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await screen.findByLabelText("Navigation");
    expect(loadRuntime).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Yonalist" }));
    expect(await screen.findByText("Loading Yonalist…")).toBeInTheDocument();
    pending.resolve(notesRuntime);

    const draft = await screen.findByRole("textbox", { name: "Notes draft" });
    await user.type(draft, "keep me");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Yonalist" }));

    expect(screen.getByRole("textbox", { name: "Notes draft" })).toHaveValue(
      "keep me"
    );
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it("shows a local failure and succeeds after retry", async () => {
    const first = deferred<FeatureRuntime>();
    const second = deferred<FeatureRuntime>();
    const loadRuntime = notesLoader()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await user.click(await screen.findByRole("button", { name: "Yonalist" }));
    first.reject(new Error("chunk unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Yonalist를 열 수 없습니다."
    );

    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("Loading Yonalist…")).toBeInTheDocument();
    second.resolve(notesRuntime);

    expect(await screen.findByLabelText("Notes library")).toBeInTheDocument();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });
});
