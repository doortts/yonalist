import type { IpcImportNode } from "../../../../packages/contracts/generated/IpcImportNode";
import type { IpcNotesCommand } from "../../../../packages/contracts/generated/IpcNotesCommand";
import { previewNotesApi } from "./previewApi";
import { SORT_KEY_STEP } from "../outline/outlineSortKeys";

describe("browser-only preview adapter", () => {
  it("does not seed instructional text as a bullet", async () => {
    const boot = await previewNotesApi.bootstrap();

    expect(boot.viewport?.nodes.map((node) => node.text)).not.toContain(
      "Press Enter to add another thought."
    );
  });

  it("seeds a note and an image row for the outline to draw", async () => {
    const boot = await previewNotesApi.bootstrap();
    const nodes = boot.viewport!.nodes;

    expect(nodes.find((node) => node.note.length > 0)?.note)
      .toContain("\n");
    const image = nodes.find((node) => node.kind === "image");
    expect(image?.image).toEqual(expect.objectContaining({
      originalName: "sample.png",
      pixelWidth: 640
    }));
    // No bytes are seeded with it, so the row has to fail into its
    // placeholder rather than take the preview down.
    await expect(previewNotesApi.readImage({
      sessionId: boot.sessionId,
      nodeId: image!.id
    })).rejects.toThrow();
  });

  it("lists the root's live children as the pages", async () => {
    const boot = await previewNotesApi.bootstrap();

    expect(boot.pages).toEqual([
      {
        id: "preview-page",
        title: "Welcome to Yonalist",
        sortKey: SORT_KEY_STEP
      }
    ]);
    expect(boot.viewport?.nodes.map((node) => node.id))
      .not.toContain("preview-page");
  });

  it("boots a bounded editable outline and applies command patches", async () => {
    const boot = await previewNotesApi.bootstrap();
    expect(boot.activePageId).not.toBeNull();
    expect(boot.viewport?.nodes.length).toBeGreaterThan(0);

    const target = boot.viewport!.nodes[0];
    const receipt = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: { kind: "updateText", id: target.id, text: "Edited in preview" }
    });

    expect(receipt.revision).toBe(boot.revision + 1);
    expect(receipt.changedNodes).toContainEqual(
      expect.objectContaining({ id: target.id, text: "Edited in preview" })
    );
  });

  it("rejects removing a row that still holds text, as notes-core does", async () => {
    const boot = await previewNotesApi.bootstrap();
    const target = boot.viewport!.nodes.find((node) => node.text.trim())!;

    await expect(previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-remove-nonempty",
      baseRevision: boot.revision,
      historyGroup: null,
      command: { kind: "removeEmptyNode", id: target.id }
    })).rejects.toThrow(`node is not empty: ${target.id}`);
  });

  it("folds a first child into its parent and undoes it in one step", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    for (const [id, parentId, text] of [
      ["preview-fold-parent", pageId, "위"],
      ["preview-fold-row", "preview-fold-parent", "아래"],
      ["preview-fold-child", "preview-fold-row", ""]
    ] as const) {
      revision = (await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId: `preview-fold-create-${id}`,
        baseRevision: revision,
        historyGroup: null,
        command: {
          kind: "createNode", id, parent_id: parentId, before_id: null, text
        }
      })).revision;
    }

    const merged = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-fold-request",
      baseRevision: revision,
      historyGroup: "backspace:1",
      command: {
        kind: "mergeNodeIntoParent",
        id: "preview-fold-row",
        parent_id: "preview-fold-parent",
        parent_text: "위",
        current_text: "아래"
      }
    });

    expect(merged.deletedIds).toContain("preview-fold-row");
    expect(merged.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "preview-fold-parent", text: "위아래" }),
      expect.objectContaining({
        id: "preview-fold-child",
        parentId: "preview-fold-parent"
      })
    ]));

    // One command, so one history entry: the whole gesture comes back at once,
    // which is what the three-command version could not promise.
    await previewNotesApi.undo({
      sessionId: boot.sessionId,
      baseRevision: merged.revision
    });
    const after = (await previewNotesApi.bootstrap()).viewport!.nodes;
    expect(after).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "preview-fold-parent", text: "위" }),
      expect.objectContaining({ id: "preview-fold-row", text: "아래" }),
      expect.objectContaining({
        id: "preview-fold-child",
        parentId: "preview-fold-row"
      })
    ]));
  });

  it("rejects a parent merge the domain would refuse", async () => {
    const boot = await previewNotesApi.bootstrap();
    const nodes = boot.viewport!.nodes;
    const target = nodes.find((node) => node.text.trim())!;
    const stranger = nodes.find((node) => node.id !== target.id)!;

    await expect(previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-fold-stranger",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "mergeNodeIntoParent",
        id: target.id,
        parent_id: stranger.id,
        parent_text: "",
        current_text: target.text
      }
    })).rejects.toThrow("Preview parent merge is invalid.");
  });

  // Preview is the only backend the browser dev surface ever sees, so anything
  // it waves through that notes-core rejects shows a broken feature working.
  it("rejects a split aimed at a parent the source has nothing to do with", async () => {
    const boot = await previewNotesApi.bootstrap();
    const nodes = boot.viewport!.nodes;
    const target = nodes[0];
    const stranger = nodes.find((node) =>
      node.id !== target.id && node.id !== target.parentId)!;

    await expect(previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-wrong-parent",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "splitNode",
        id: target.id,
        new_id: "preview-split-wrong-parent-row",
        parent_id: stranger.id,
        before_id: null,
        prefix: "a",
        suffix: "b"
      }
    })).rejects.toThrow(/is neither a child of/u);
  });

  // notes-core carries the source's marker onto the new half, so a run of
  // numbered rows keeps counting under Enter. A preview that answers with a
  // plain bullet shows the feature broken on the browser surface alone.
  it("carries the source's marker onto the half a split makes", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const created = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-marker-source",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "preview-split-marker",
        parent_id: pageId,
        before_id: null,
        text: "Milk"
      }
    });
    const marked = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-marker-set",
      baseRevision: created.revision,
      historyGroup: null,
      command: {
        kind: "setMarker",
        id: "preview-split-marker",
        marker: { ordered: { start: 3 } }
      }
    });

    const split = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-marker-split",
      baseRevision: marked.revision,
      historyGroup: null,
      command: {
        kind: "splitNode",
        id: "preview-split-marker",
        new_id: "preview-split-marker-half",
        parent_id: pageId,
        before_id: null,
        prefix: "Milk",
        suffix: ""
      }
    });

    expect(split.changedNodes.find((node) =>
      node.id === "preview-split-marker-half")?.marker
    ).toEqual({ ordered: { start: 3 } });
  });

  it("nests a split under the source and opens it, as notes-core does", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const source = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-nested-source",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "preview-split-nested",
        parent_id: pageId,
        before_id: null,
        text: "AAABBB"
      }
    });
    const collapsed = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-nested-collapse",
      baseRevision: source.revision,
      historyGroup: null,
      command: { kind: "setCollapsed", id: "preview-split-nested", collapsed: true }
    });

    const split = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-nested-split",
      baseRevision: collapsed.revision,
      historyGroup: null,
      command: {
        kind: "splitNode",
        id: "preview-split-nested",
        new_id: "preview-split-nested-child",
        parent_id: "preview-split-nested",
        before_id: null,
        prefix: "AAA",
        suffix: "BBB"
      }
    });

    expect(split.changedNodes).toContainEqual(expect.objectContaining({
      id: "preview-split-nested-child",
      parentId: "preview-split-nested",
      text: "BBB"
    }));
    expect(split.changedNodes).toContainEqual(expect.objectContaining({
      id: "preview-split-nested",
      text: "AAA",
      collapsed: false
    }));
  });

  it("supports atomic split and empty-row removal in browser preview", async () => {
    const boot = await previewNotesApi.bootstrap();
    const target = boot.viewport!.nodes[0];
    const split = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-split-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "splitNode",
        id: target.id,
        new_id: "preview-split",
        parent_id: target.parentId!,
        before_id: null,
        prefix: target.text,
        suffix: ""
      }
    });

    expect(split.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.id, text: target.text }),
      expect.objectContaining({
        id: "preview-split",
        parentId: target.parentId,
        text: ""
      })
    ]));

    const removed = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-remove-request",
      baseRevision: split.revision,
      historyGroup: null,
      command: { kind: "removeEmptyNode", id: "preview-split" }
    });

    expect(removed.deletedIds).toContain("preview-split");
    expect((await previewNotesApi.bootstrap()).viewport?.nodes)
      .not.toContainEqual(expect.objectContaining({ id: "preview-split" }));
  });

  it("deletes rows that disappear when a repeated split is undone", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const created = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-repeat-undo-create",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "preview-repeat-undo-source",
        parent_id: pageId,
        before_id: null,
        text: "하하하"
      }
    });
    const firstSplit = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-repeat-undo-first",
      baseRevision: created.revision,
      historyGroup: null,
      command: {
        kind: "splitNode",
        id: "preview-repeat-undo-source",
        new_id: "preview-repeat-undo-first-row",
        parent_id: pageId,
        before_id: null,
        prefix: "",
        suffix: "하하하"
      }
    });
    const secondSplit = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-repeat-undo-second",
      baseRevision: firstSplit.revision,
      historyGroup: null,
      command: {
        kind: "splitNode",
        id: "preview-repeat-undo-first-row",
        new_id: "preview-repeat-undo-second-row",
        parent_id: pageId,
        before_id: null,
        prefix: "",
        suffix: "하하하"
      }
    });

    const undone = await previewNotesApi.undo({
      sessionId: boot.sessionId,
      baseRevision: secondSplit.revision
    });

    expect(undone.deletedIds).toEqual(["preview-repeat-undo-second-row"]);
    expect(undone.changedNodes.map((node) => node.id))
      .toEqual(["preview-repeat-undo-first-row"]);
    expect(undone.changedNodes[0]?.text).toBe("하하하");
  });

  it("keeps long repeated splits ordered directly before their anchor", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const source = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-repeat-order-source-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "preview-repeat-order-source",
        parent_id: pageId,
        before_id: null,
        text: ""
      }
    });
    const anchor = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-repeat-order-anchor-request",
      baseRevision: source.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "middle-preview-repeat-order-anchor",
        parent_id: pageId,
        before_id: null,
        text: "anchor"
      }
    });
    let currentId = "preview-repeat-order-source";
    let revision = anchor.revision;

    for (let index = 0; index < 24; index += 1) {
      const newId = `${index % 2 === 0 ? "z" : "a"}-preview-repeat-${index}`;
      const split = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId: `preview-repeat-order-split-${index}`,
        baseRevision: revision,
        historyGroup: null,
        command: {
          kind: "splitNode",
          id: currentId,
          new_id: newId,
          parent_id: pageId,
          before_id: "middle-preview-repeat-order-anchor",
          prefix: "",
          suffix: ""
        }
      });
      currentId = newId;
      revision = split.revision;
    }

    const siblings = (await previewNotesApi.bootstrap()).viewport!.nodes
      .filter((node) =>
        node.id === "preview-repeat-order-source" ||
        node.id === "middle-preview-repeat-order-anchor" ||
        node.id.includes("-preview-repeat-")
      );
    const anchorIndex = siblings.findIndex(
      (node) => node.id === "middle-preview-repeat-order-anchor"
    );

    expect(siblings[anchorIndex - 1]?.id).toBe(currentId);
    expect(new Set(siblings.map((node) => node.sortKey)).size)
      .toBe(siblings.length);
  });

  it("keeps the current row identity during an atomic backward merge", async () => {
    const boot = await previewNotesApi.bootstrap();
    const parentId = boot.activePageId!;
    const previous = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-merge-previous-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "preview-merge-previous",
        parent_id: parentId,
        before_id: null,
        text: "stale previous"
      }
    });
    const current = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-merge-current-request",
      baseRevision: previous.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "preview-merge-current",
        parent_id: parentId,
        before_id: null,
        text: "stale current"
      }
    });

    const merged = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-merge-request",
      baseRevision: current.revision,
      historyGroup: null,
      command: {
        kind: "mergeNodeBackward",
        id: "preview-merge-current",
        previous_id: "preview-merge-previous",
        previous_text: "draft previous",
        current_text: "draft current"
      }
    });

    expect(merged.deletedIds).toEqual(["preview-merge-previous"]);
    expect(merged.changedNodes).toEqual([
      expect.objectContaining({
        id: "preview-merge-current",
        text: "draft previousdraft current"
      })
    ]);
  });

  it("imports a nested outline with one preview command", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const imported = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-import-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "importNodes",
        parent_id: pageId,
        before_id: null,
        nodes: [
          {
            id: "preview-import-root",
            parentId: pageId,
            text: "Root",
            collapsed: true,
            starred: true
          },
          {
            id: "preview-import-child",
            parentId: "preview-import-root",
            text: "Child"
          }
        ]
      }
    });

    expect(imported.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "preview-import-root",
        parentId: pageId,
        text: "Root",
        // The two the payload carries and the desktop lands: a subtree cut
        // while collapsed pastes back collapsed here too.
        collapsed: true,
        starred: true
      }),
      expect.objectContaining({
        id: "preview-import-child",
        parentId: "preview-import-root",
        text: "Child",
        collapsed: false,
        starred: false
      })
    ]));
  });

  it("settles the whole Todo chain from one ticked row", async () => {
    const boot = await previewNotesApi.bootstrap();
    const [parent, child] = boot.viewport!.nodes;
    let revision = boot.revision;
    for (const [index, id] of [parent.id, child.id].entries()) {
      const marked = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId: `preview-chain-marker-${index}`,
        baseRevision: revision,
        historyGroup: null,
        command: { kind: "setMarker", id, marker: "todo" }
      });
      revision = marked.revision;
    }
    const nested = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-chain-indent",
      baseRevision: revision,
      historyGroup: null,
      command: {
        kind: "moveNode",
        id: child.id,
        parent_id: parent.id,
        before_id: null
      }
    });

    const completed = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-chain-complete",
      baseRevision: nested.revision,
      historyGroup: null,
      command: { kind: "setCompleted", id: parent.id, completed: true }
    });

    expect(completed.changedNodes).toEqual(expect.arrayContaining(
      [parent.id, child.id].map((id) =>
        expect.objectContaining({ id, completed: true }))
    ));
  });

  it("folds commands that share a history group into one undo", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    const run = async (
      requestId: string,
      historyGroup: string | null,
      command: IpcNotesCommand
    ) => {
      const result = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId,
        baseRevision: revision,
        historyGroup,
        command
      });
      revision = result.revision;
      return result;
    };
    const created = await run("grouped-create", "create:grouped", {
      kind: "createNode",
      id: "grouped",
      parent_id: pageId,
      before_id: null,
      text: ""
    });
    const marked = await run("grouped-marker", "create:grouped", {
      kind: "setMarker", id: "grouped", marker: "todo"
    });

    // The second command adds no entry of its own, the way the server's
    // coalescer leaves it.
    expect(marked.history.undoDepth).toBe(created.history.undoDepth);
    const undone = await previewNotesApi.undo({
      sessionId: boot.sessionId,
      baseRevision: revision
    });
    revision = undone.revision;

    const page = await previewNotesApi.queryViewport({
      pageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      limit: 200
    });
    // The row is gone, not left behind with its box taken off.
    expect(page.nodes.map((node) => node.id)).not.toContain("grouped");
  });

  it("opens the finished rows above a newly placed row", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    const run = async (requestId: string, command: IpcNotesCommand) => {
      const result = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId,
        baseRevision: revision,
        historyGroup: null,
        command
      });
      revision = result.revision;
      return result;
    };
    await run("reopen-parent-create", {
      kind: "createNode",
      id: "reopen-parent",
      parent_id: pageId,
      before_id: null,
      text: "Parent"
    });
    await run("reopen-child-create", {
      kind: "createNode",
      id: "reopen-child",
      parent_id: "reopen-parent",
      before_id: null,
      text: "Child"
    });
    await run("reopen-parent-tick", {
      kind: "setCompleted", id: "reopen-parent", completed: true
    });

    await run("reopen-fresh-create", {
      kind: "createNode",
      id: "reopen-fresh",
      parent_id: "reopen-parent",
      before_id: null,
      text: ""
    });

    const page = await previewNotesApi.queryViewport({
      pageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      limit: 200
    });
    const completedById = new Map(
      page.nodes.map((node) => [node.id, node.completed])
    );
    expect(completedById.get("reopen-parent")).toBe(false);
    // The rows the tick had settled keep their own state.
    expect(completedById.get("reopen-child")).toBe(true);
  });

  it("hands the rows back their own states when a tick is taken back", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    const run = async (requestId: string, command: IpcNotesCommand) => {
      const result = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId,
        baseRevision: revision,
        historyGroup: null,
        command
      });
      revision = result.revision;
      return result;
    };
    await run("restore-parent-create", {
      kind: "createNode",
      id: "restore-parent",
      parent_id: pageId,
      before_id: null,
      text: "Parent"
    });
    for (const id of ["restore-done", "restore-open"]) {
      await run(`${id}-create`, {
        kind: "createNode",
        id,
        parent_id: "restore-parent",
        before_id: null,
        text: id
      });
    }
    await run("restore-done-tick", {
      kind: "setCompleted", id: "restore-done", completed: true
    });
    await run("restore-parent-tick", {
      kind: "setCompleted", id: "restore-parent", completed: true
    });

    await run("restore-parent-clear", {
      kind: "setCompleted", id: "restore-parent", completed: false
    });

    const page = await previewNotesApi.queryViewport({
      pageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      limit: 200
    });
    const completedById = new Map(
      page.nodes.map((node) => [node.id, node.completed])
    );
    expect(completedById.get("restore-parent")).toBe(false);
    expect(completedById.get("restore-open")).toBe(false);
    // Ticked before the parent was, so taking the parent's tick back leaves it.
    expect(completedById.get("restore-done")).toBe(true);
  });

  it("takes a selection's tick back whatever order the ids arrive in", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    const run = async (requestId: string, command: IpcNotesCommand) => {
      const result = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId,
        baseRevision: revision,
        historyGroup: null,
        command
      });
      revision = result.revision;
      return result;
    };
    const ids = ["selection-first", "selection-second"];
    for (const id of ids) {
      await run(`${id}-create`, {
        kind: "createNode",
        id,
        parent_id: pageId,
        before_id: null,
        text: id
      });
    }
    await run("selection-first-tick", {
      kind: "setCompleted", id: ids[0], completed: true
    });
    await run("selection-tick", {
      kind: "setCompletedMany", ids, completed: true
    });

    await run("selection-clear", {
      kind: "setCompletedMany", ids: [...ids].reverse(), completed: false
    });

    const page = await previewNotesApi.queryViewport({
      pageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      limit: 200
    });
    const completedById = new Map(
      page.nodes.map((node) => [node.id, node.completed])
    );
    // Ticked before the selection was, so the selection's own tick is all that
    // comes back off it.
    expect(completedById.get(ids[0])).toBe(true);
    expect(completedById.get(ids[1])).toBe(false);
  });

  it("completes multiple preview rows with one batch command", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    // Two open bullets of its own: the seeded rows an earlier test already
    // ticked would be dropped as no-ops, hiding whether the batch wrote at all.
    const ids = ["batch-plain-one", "batch-plain-two"];
    for (const id of ids) {
      const created = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId: `preview-complete-many-create-${id}`,
        baseRevision: revision,
        historyGroup: null,
        command: {
          kind: "createNode",
          id,
          parent_id: pageId,
          before_id: null,
          text: id
        }
      });
      revision = created.revision;
    }
    const completed = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-complete-many-request",
      baseRevision: revision,
      historyGroup: null,
      command: { kind: "setCompletedMany", ids, completed: true }
    });

    // Plain bullets, so the batch is still exactly the rows it names.
    expect(completed.changedNodes).toHaveLength(2);
    expect(completed.changedNodes).toEqual(expect.arrayContaining(
      ids.map((id) => expect.objectContaining({ id, completed: true }))
    ));
  });

  it("settles every listed row's Todo chain in one batch", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    const run = async (requestId: string, command: IpcNotesCommand) => {
      const result = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId,
        baseRevision: revision,
        historyGroup: null,
        command
      });
      revision = result.revision;
      return result;
    };
    const rows = ["batch-top", "batch-under", "batch-loose"];
    for (const id of rows) {
      await run(`preview-batch-create-${id}`, {
        kind: "createNode",
        id,
        parent_id: pageId,
        before_id: null,
        text: id
      });
      await run(`preview-batch-marker-${id}`, {
        kind: "setMarker",
        id,
        marker: "todo"
      });
    }
    await run("preview-batch-nest", {
      kind: "moveNode",
      id: "batch-under",
      parent_id: "batch-top",
      before_id: null
    });

    // Only the two chain heads are listed, so `batch-under` can flip only by
    // riding the cascade under `batch-top` -- the way the server expands it.
    const completed = await run("preview-batch-complete", {
      kind: "setCompletedMany",
      ids: ["batch-top", "batch-loose"],
      completed: true
    });

    expect(completed.changedNodes).toEqual(expect.arrayContaining(
      rows.map((id) => expect.objectContaining({ id, completed: true }))
    ));
  });

  it("closes a parent no single row in the batch could close", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    let revision = boot.revision;
    const run = async (requestId: string, command: IpcNotesCommand) => {
      const result = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId,
        baseRevision: revision,
        historyGroup: null,
        command
      });
      revision = result.revision;
      return result;
    };
    for (const id of ["joint-parent", "joint-first", "joint-second"]) {
      await run(`preview-joint-create-${id}`, {
        kind: "createNode",
        id,
        parent_id: pageId,
        before_id: null,
        text: id
      });
      await run(`preview-joint-marker-${id}`, {
        kind: "setMarker",
        id,
        marker: "todo"
      });
    }
    for (const id of ["joint-first", "joint-second"]) {
      await run(`preview-joint-nest-${id}`, {
        kind: "moveNode",
        id,
        parent_id: "joint-parent",
        before_id: null
      });
    }

    const completed = await run("preview-joint-complete", {
      kind: "setCompletedMany",
      ids: ["joint-first", "joint-second"],
      completed: true
    });

    // Neither sibling settles the parent on its own -- the second one only
    // closes it because the first already landed. Reading the batch against
    // the state it started from would leave the parent open here.
    expect(completed.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "joint-parent", completed: true })
    ]));
  });

  it("deletes multiple preview subtrees with one batch command", async () => {
    const boot = await previewNotesApi.bootstrap();
    const ids = boot.viewport!.nodes.slice(0, 2).map((node) => node.id);
    const deleted = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-delete-many-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: { kind: "deleteSubtrees", ids }
    });

    expect(deleted.deletedIds).toEqual(expect.arrayContaining(ids));
    expect((await previewNotesApi.bootstrap()).viewport?.nodes)
      .not.toEqual(expect.arrayContaining(
        ids.map((id) => expect.objectContaining({ id }))
      ));
  });

  it("moves multiple preview roots with one batch command", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const setup = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-move-setup-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "importNodes",
        parent_id: pageId,
        before_id: null,
        nodes: [
          { id: "preview-move-parent", parentId: pageId, text: "Parent" },
          { id: "preview-move-first", parentId: pageId, text: "First" },
          { id: "preview-move-second", parentId: pageId, text: "Second" }
        ]
      }
    });
    const moved = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-move-many-request",
      baseRevision: setup.revision,
      historyGroup: null,
      command: {
        kind: "moveNodes",
        moves: [
          {
            id: "preview-move-first",
            parentId: "preview-move-parent",
            beforeId: null
          },
          {
            id: "preview-move-second",
            parentId: "preview-move-parent",
            beforeId: null
          }
        ]
      }
    });

    expect(moved.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "preview-move-first",
        parentId: "preview-move-parent"
      }),
      expect.objectContaining({
        id: "preview-move-second",
        parentId: "preview-move-parent"
      })
    ]));
  });

  it("expands a collapsed preview destination in the batch move", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const setup = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-collapsed-move-setup",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "importNodes",
        parent_id: pageId,
        before_id: null,
        nodes: [
          { id: "preview-collapsed-parent", parentId: pageId, text: "Parent" },
          { id: "preview-collapsed-moving", parentId: pageId, text: "Moving" }
        ]
      }
    });
    const collapsed = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-collapse-move-parent",
      baseRevision: setup.revision,
      historyGroup: null,
      command: {
        kind: "setCollapsed",
        id: "preview-collapsed-parent",
        collapsed: true
      }
    });
    const moved = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-move-into-collapsed",
      baseRevision: collapsed.revision,
      historyGroup: null,
      command: {
        kind: "moveNodes",
        moves: [{
          id: "preview-collapsed-moving",
          parentId: "preview-collapsed-parent",
          beforeId: null
        }]
      }
    });

    expect(moved.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "preview-collapsed-parent",
        collapsed: false
      }),
      expect.objectContaining({
        id: "preview-collapsed-moving",
        parentId: "preview-collapsed-parent"
      })
    ]));
  });

  it("duplicates complete preview subtrees with one batch command", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const duplicated = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-duplicate-many-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "duplicateNodes",
        duplicates: [{
          id: "preview-move-parent",
          newId: "preview-move-parent-copy",
          parentId: pageId,
          beforeId: null
        }]
      }
    });

    expect(duplicated.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "preview-move-parent-copy",
        parentId: pageId,
        text: "Parent"
      }),
      expect.objectContaining({
        id: "preview-move-parent-copy/1",
        parentId: "preview-move-parent-copy",
        text: "First"
      }),
      expect.objectContaining({
        id: "preview-move-parent-copy/2",
        parentId: "preview-move-parent-copy",
        text: "Second"
      })
    ]));
  });

  it("rejects an invalid preview batch without a partial mutation or revision", async () => {
    const before = await previewNotesApi.bootstrap();
    const first = before.viewport!.nodes[0];

    await expect(previewNotesApi.execute({
      sessionId: before.sessionId,
      requestId: "preview-invalid-atomic-batch",
      baseRevision: before.revision,
      historyGroup: null,
      command: {
        kind: "moveNodes",
        moves: [
          { id: first.id, parentId: before.activePageId!, beforeId: null },
          { id: "missing-preview-node", parentId: before.activePageId!, beforeId: null }
        ]
      }
    })).rejects.toThrow("stale node");

    const after = await previewNotesApi.bootstrap();
    expect(after.revision).toBe(before.revision);
    expect(after.viewport!.nodes.find((node) => node.id === first.id))
      .toEqual(first);
  });

  it("bounds preview undo history to the production session limit", async () => {
    const boot = await previewNotesApi.bootstrap();
    const target = boot.viewport!.nodes[0];
    let baseRevision = boot.revision;

    for (let index = 0; index <= 1_000; index += 1) {
      const receipt = await previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId: `preview-bounded-history-${index}`,
        baseRevision,
        historyGroup: null,
        command: {
          kind: "updateText",
          id: target.id,
          text: index % 2 === 0 ? "even" : "odd"
        }
      });
      baseRevision = receipt.revision;
    }

    const after = await previewNotesApi.bootstrap();
    expect(after.history.undoDepth).toBe(1_000);
  });

  it("keeps preview image bytes outside receipts while undo and redo restore metadata", async () => {
    const boot = await previewNotesApi.bootstrap();
    const imported = await previewNotesApi.importImageBytes({
      sessionId: boot.sessionId,
      requestId: "preview-image-import",
      baseRevision: boot.revision,
      historyGroup: "images:batch",
      parentId: boot.activePageId!,
      beforeId: null,
      images: [{
        nodeId: "preview-image",
        originalName: "cat.png",
        declaredMimeType: "image/png",
        blob: new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" })
      }]
    });

    expect(imported.changedNodes[0]).toEqual(expect.objectContaining({
      id: "preview-image",
      kind: "image",
      text: "cat.png",
      image: expect.objectContaining({ originalName: "cat.png" })
    }));
    expect(JSON.stringify(imported)).not.toContain("1,2,3");
    expect(await previewNotesApi.readImage({
      sessionId: boot.sessionId,
      nodeId: "preview-image"
    })).toEqual(Uint8Array.from([1, 2, 3]));

    const undone = await previewNotesApi.undo({
      sessionId: boot.sessionId,
      baseRevision: imported.revision
    });
    expect(undone.deletedIds).toContain("preview-image");
    const redone = await previewNotesApi.redo({
      sessionId: boot.sessionId,
      baseRevision: undone.revision
    });
    expect(redone.changedNodes[0]).toEqual(expect.objectContaining({
      id: "preview-image",
      image: expect.objectContaining({ originalName: "cat.png" })
    }));

    const replaced = await previewNotesApi.replaceImageBytes({
      sessionId: boot.sessionId,
      requestId: "preview-image-replace",
      baseRevision: redone.revision,
      historyGroup: "images:replace",
      targetId: "preview-image",
      image: {
        nodeId: "preview-image",
        originalName: "dog.png",
        declaredMimeType: "image/png",
        blob: new Blob([Uint8Array.from([4, 5, 6])], { type: "image/png" })
      }
    });
    expect(replaced.changedNodes[0]).toEqual(expect.objectContaining({
      id: "preview-image",
      image: expect.objectContaining({
        originalName: "dog.png",
        displayWidth: 320
      })
    }));
    expect(await previewNotesApi.readImage({
      sessionId: boot.sessionId,
      nodeId: "preview-image"
    })).toEqual(Uint8Array.from([4, 5, 6]));

    const replacementUndone = await previewNotesApi.undo({
      sessionId: boot.sessionId,
      baseRevision: replaced.revision
    });
    expect(replacementUndone.changedNodes[0].image?.originalName).toBe("cat.png");
    expect(await previewNotesApi.readImage({
      sessionId: boot.sessionId,
      nodeId: "preview-image"
    })).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("undoes a replacement whose file keeps the original name", async () => {
    const boot = await previewNotesApi.bootstrap();
    const imported = await previewNotesApi.importImageBytes({
      sessionId: boot.sessionId,
      requestId: "preview-same-name-import",
      baseRevision: boot.revision,
      historyGroup: null,
      parentId: boot.activePageId!,
      beforeId: null,
      images: [{
        nodeId: "preview-same-name-image",
        originalName: "cat.png",
        declaredMimeType: "image/png",
        blob: new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" })
      }]
    });
    const originalHash = imported.changedNodes[0].image!.contentHash;

    const replaced = await previewNotesApi.replaceImageBytes({
      sessionId: boot.sessionId,
      requestId: "preview-same-name-replace",
      baseRevision: imported.revision,
      historyGroup: "images:replace",
      targetId: "preview-same-name-image",
      image: {
        nodeId: "preview-same-name-image",
        originalName: "cat.png",
        declaredMimeType: "image/png",
        blob: new Blob([Uint8Array.from([4, 5, 6])], { type: "image/png" })
      }
    });
    expect(replaced.changedNodes[0].image!.contentHash).not.toBe(originalHash);

    const undone = await previewNotesApi.undo({
      sessionId: boot.sessionId,
      baseRevision: replaced.revision
    });
    expect(undone.changedNodes[0]?.image?.contentHash).toBe(originalHash);
    expect(await previewNotesApi.readImage({
      sessionId: boot.sessionId,
      nodeId: "preview-same-name-image"
    })).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("pastes marker, note, tick and an image reference, and refuses a stale hash", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const source = await previewNotesApi.importImageBytes({
      sessionId: boot.sessionId,
      requestId: "preview-paste-source",
      baseRevision: boot.revision,
      historyGroup: null,
      parentId: pageId,
      beforeId: null,
      images: [{
        nodeId: "preview-paste-source",
        originalName: "sample.png",
        declaredMimeType: "image/png",
        blob: new Blob([Uint8Array.from([7, 8, 9])], { type: "image/png" })
      }]
    });
    const image = source.changedNodes[0].image!;

    const pasted = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-rich-paste",
      baseRevision: source.revision,
      historyGroup: null,
      command: {
        kind: "importNodes",
        parent_id: pageId,
        before_id: null,
        nodes: [
          {
            id: "preview-paste-todo",
            parentId: pageId,
            text: "Buy milk",
            note: "Two litres",
            marker: "todo",
            completed: true
          },
          {
            id: "preview-paste-image",
            parentId: "preview-paste-todo",
            text: "sample.png",
            image
          }
        ]
      }
    });

    expect(pasted.changedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "preview-paste-todo",
        note: "Two litres",
        marker: "todo",
        completed: true
      }),
      expect.objectContaining({
        id: "preview-paste-image",
        kind: "image",
        text: "sample.png",
        image: expect.objectContaining({ contentHash: image.contentHash })
      })
    ]));

    await expect(previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-stale-paste",
      baseRevision: pasted.revision,
      historyGroup: null,
      command: {
        kind: "importNodes",
        parent_id: pageId,
        before_id: null,
        nodes: [{
          id: "preview-paste-stale",
          parentId: pageId,
          text: "gone.png",
          image: { ...image, contentHash: "b".repeat(64) }
        }]
      }
    })).rejects.toThrow("no longer in the image store");
    // A resident hash that lies about its length is just as stale: the bytes it
    // names are not the bytes the row would read back.
    await expect(previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-short-paste",
      baseRevision: pasted.revision,
      historyGroup: null,
      command: {
        kind: "importNodes",
        parent_id: pageId,
        before_id: null,
        nodes: [{
          id: "preview-paste-short",
          parentId: pageId,
          text: "sample.png",
          image: { ...image, byteLength: image.byteLength + 1 }
        }]
      }
    })).rejects.toThrow("no longer in the image store");
    expect((await previewNotesApi.bootstrap()).viewport?.nodes.map((node) => node.id))
      .not.toContain("preview-paste-stale");
  });

  it("leaves undo and redo alone when it refuses a paste", async () => {
    const boot = await previewNotesApi.bootstrap();
    const pageId = boot.activePageId!;
    const created = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-refused-setup",
      baseRevision: boot.revision,
      historyGroup: null,
      command: {
        kind: "createNode",
        id: "preview-refused-row",
        parent_id: pageId,
        before_id: null,
        text: "Undo me"
      }
    });
    const undone = await previewNotesApi.undo({
      sessionId: boot.sessionId,
      baseRevision: created.revision
    });
    expect(undone.history.redoDepth).toBe(1);
    const image = {
      contentHash: "a".repeat(64),
      originalName: "sample.png",
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 1,
      pixelHeight: 1,
      displayWidth: 320
    };
    const refuse = (requestId: string, node: IpcImportNode) =>
      previewNotesApi.execute({
        sessionId: boot.sessionId,
        requestId,
        baseRevision: undone.revision,
        historyGroup: null,
        command: {
          kind: "importNodes",
          parent_id: pageId,
          before_id: null,
          nodes: [node]
        }
      });

    // Hash shape, the MIME allowlist and the 100KB note bound are all checks the
    // Rust conversion runs, so the same payloads have to fail here.
    await expect(refuse("preview-refused-hash", {
      id: "preview-refused-hash-row",
      parentId: pageId,
      text: "sample.png",
      image: { ...image, contentHash: "A".repeat(64) }
    })).rejects.toThrow("image reference is invalid");
    await expect(refuse("preview-refused-mime", {
      id: "preview-refused-mime-row",
      parentId: pageId,
      text: "sample.png",
      image: { ...image, mimeType: "image/svg+xml" }
    })).rejects.toThrow("image reference is invalid");
    await expect(refuse("preview-refused-note", {
      id: "preview-refused-note-row",
      parentId: pageId,
      text: "Buy milk",
      note: "x".repeat(100_001)
    })).rejects.toThrow("too large");

    const redone = await previewNotesApi.redo({
      sessionId: boot.sessionId,
      baseRevision: undone.revision
    });
    expect(redone.changedNodes.map((node) => node.id))
      .toContain("preview-refused-row");
    expect(redone.history.redoDepth).toBe(0);
  });
});
