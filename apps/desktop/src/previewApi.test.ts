import { previewNotesApi } from "./previewApi";

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
          { id: "preview-import-root", parentId: pageId, text: "Root" },
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
        text: "Root"
      }),
      expect.objectContaining({
        id: "preview-import-child",
        parentId: "preview-import-root",
        text: "Child"
      })
    ]));
  });

  it("completes multiple preview rows with one batch command", async () => {
    const boot = await previewNotesApi.bootstrap();
    const ids = boot.viewport!.nodes.slice(0, 2).map((node) => node.id);
    const completed = await previewNotesApi.execute({
      sessionId: boot.sessionId,
      requestId: "preview-complete-many-request",
      baseRevision: boot.revision,
      historyGroup: null,
      command: { kind: "setCompletedMany", ids, completed: true }
    });

    expect(completed.changedNodes).toHaveLength(2);
    expect(completed.changedNodes).toEqual(expect.arrayContaining(
      ids.map((id) => expect.objectContaining({ id, completed: true }))
    ));
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
});
