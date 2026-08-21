import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileAccessoryBar } from "./MobileAccessoryBar";

const NODE = "row-1";

function editor() {
  const node = document.createElement("div");
  node.setAttribute("data-outline-id", NODE);
  const field = document.createElement("textarea");
  field.value = "a row";
  node.append(field);
  document.body.append(node);
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  return field;
}

function bar() {
  const store = { cycleCompleted: vi.fn().mockResolvedValue(undefined) };
  render(<MobileAccessoryBar store={store as never} />);
  return store;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("MobileAccessoryBar", () => {
  it("offers what the phone has no keys for", () => {
    editor();
    bar();

    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Outdent", "Indent", "To-do", "Tag", "Date", "Hide keyboard"]);
  });

  it("sends indent and outdent as the keys the outline already answers", async () => {
    const user = userEvent.setup();
    const field = editor();
    bar();
    const keys: { key: string; shift: boolean }[] = [];
    field.addEventListener("keydown", (event) =>
      keys.push({ key: event.key, shift: event.shiftKey })
    );

    await user.click(screen.getByRole("button", { name: "Indent" }));
    await user.click(screen.getByRole("button", { name: "Outdent" }));

    expect(keys).toEqual([
      { key: "Tab", shift: false },
      { key: "Tab", shift: true }
    ]);
  });

  it("turns the focused row into a to-do through the store, not a key", async () => {
    const user = userEvent.setup();
    editor();
    const store = bar();

    await user.click(screen.getByRole("button", { name: "To-do" }));

    expect(store.cycleCompleted).toHaveBeenCalledWith(NODE);
  });

  it("writes a tag and a date into the row the caret is in", async () => {
    const user = userEvent.setup();
    const field = editor();
    bar();

    await user.click(screen.getByRole("button", { name: "Tag" }));
    expect(field.value).toBe("a row #");

    await user.click(screen.getByRole("button", { name: "Date" }));
    expect(field.value).toMatch(/^a row # \d{4}-\d{2}-\d{2}$/);
  });

  it("puts the keyboard away by letting the row go", async () => {
    const user = userEvent.setup();
    const field = editor();
    bar();

    await user.click(screen.getByRole("button", { name: "Hide keyboard" }));

    expect(document.activeElement).not.toBe(field);
  });

  it("does nothing at all when no row has the caret", async () => {
    const user = userEvent.setup();
    const store = bar();

    await user.click(screen.getByRole("button", { name: "To-do" }));

    expect(store.cycleCompleted).not.toHaveBeenCalled();
  });
});
