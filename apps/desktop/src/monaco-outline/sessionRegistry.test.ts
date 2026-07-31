import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import {
  MonacoOutlineSessionRegistry,
  type MonacoSessionRegistryPort
} from "./sessionRegistry";

function node(id: string): NoteView {
  return {
    id,
    parentId: "page",
    sortKey: 1_024,
    kind: "bullet",
    image: null,
    text: "alpha",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function registryPort(): MonacoSessionRegistryPort {
  return {
    loadMonacoPage: vi.fn().mockImplementation(async (pageId: string) => ({
      revision: 1,
      viewport: {
        pageId,
        anchorId: null,
        beforeCursor: null,
        afterCursor: null,
        nodes: [node(`${pageId}-first`)]
      }
    })),
    executeEditorBatch: vi.fn()
  };
}

describe("MonacoOutlineSessionRegistry", () => {
  it("shares one model and disposes only after the last pane", async () => {
    const registry = new MonacoOutlineSessionRegistry(registryPort());
    const first = await registry.acquire("page");
    const second = await registry.acquire("page");

    expect(first.session.model).toBe(second.session.model);
    await first.release();
    expect(second.session.model.isDisposed()).toBe(false);
    await second.release();
    expect(second.session.model.isDisposed()).toBe(true);
  });

  it("coalesces concurrent hydration for the same page", async () => {
    const port = registryPort();
    const registry = new MonacoOutlineSessionRegistry(port);

    const [first, second] = await Promise.all([
      registry.acquire("page"),
      registry.acquire("page")
    ]);

    expect(port.loadMonacoPage).toHaveBeenCalledOnce();
    await first.release();
    await second.release();
  });
});
