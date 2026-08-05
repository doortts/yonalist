import {
  runOutlineCommand,
  type YonalistOutlineEditorBinding
} from "./plugin";

function binding(): YonalistOutlineEditorBinding {
  return {
    session: {
      canAcceptStructuralEdit: vi.fn().mockReturnValue(true),
      indent: vi.fn(),
      outdent: vi.fn()
    } as unknown as YonalistOutlineEditorBinding["session"],
    pane: {
      activeNodeId: () => "child",
      handleBullet: vi.fn(),
      handleChevron: vi.fn()
    }
  };
}

describe("Yonalist Monaco outline plugin", () => {
  it("routes Tab only through the active outline binding", () => {
    const active = binding();

    expect(runOutlineCommand("yonalist.outline.indent", active)).toBe(true);
    expect(active.session.indent).toHaveBeenCalledWith("child");
  });

  it("leaves commands native when no outline node is active", () => {
    const inactive = binding();
    inactive.pane.activeNodeId = () => null;

    expect(runOutlineCommand("yonalist.outline.outdent", inactive)).toBe(false);
    expect(inactive.session.outdent).not.toHaveBeenCalled();
  });
});
