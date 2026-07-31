import {
  blockPendingCanonicalTitleKey,
  handleCanonicalTitleHistory
} from "./OutlineHeader";

function keyboardEvent(
  overrides: Partial<{
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
  }> = {}
) {
  return {
    key: "z",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides
  };
}

describe("canonical outline title history", () => {
  it("keeps Undo and Redo inside the Monaco session", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const undoEvent = keyboardEvent();
    const redoEvent = keyboardEvent({ shiftKey: true });

    expect(handleCanonicalTitleHistory(undoEvent, undo, redo)).toBe(true);
    expect(handleCanonicalTitleHistory(redoEvent, undo, redo)).toBe(true);

    expect(undo).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledOnce();
    expect(undoEvent.preventDefault).toHaveBeenCalledOnce();
    expect(undoEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(redoEvent.preventDefault).toHaveBeenCalledOnce();
    expect(redoEvent.stopPropagation).toHaveBeenCalledOnce();
  });

  it("leaves non-history keys and non-canonical titles untouched", () => {
    const undo = vi.fn();
    const redo = vi.fn();

    expect(handleCanonicalTitleHistory(
      keyboardEvent({ key: "Enter" }),
      undo,
      redo
    )).toBe(false);
    expect(handleCanonicalTitleHistory(
      keyboardEvent(),
      undefined,
      undefined
    )).toBe(false);

    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });

  it("blocks store-owned Enter while canonical title authority is pending", () => {
    const event = keyboardEvent({ key: "Enter" });

    expect(blockPendingCanonicalTitleKey(event, true)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(blockPendingCanonicalTitleKey(
      keyboardEvent({ key: "Enter" }),
      false
    )).toBe(false);
  });
});
