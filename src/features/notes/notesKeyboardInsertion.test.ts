import { describe, expect, it, vi } from "vitest";
import type { NoteId } from "../../domain/notes";
import type { FlattenedOutlineRow } from "./outlineTree";
import {
  classifyKeyboardInsertionPublication,
  createKeyboardInsertionRegistry,
  createOutlineVisibleSignature,
  type KeyboardInsertionSettlement,
  type NotesProjectionPublicationOwner,
  type OutlinePanePublicationSnapshot,
  type PendingKeyboardInsertion
} from "./notesKeyboardInsertion";

function row(
  id: NoteId,
  overrides: Partial<FlattenedOutlineRow> = {}
): FlattenedOutlineRow {
  return {
    id,
    parentId: null,
    depth: 0,
    isCollapsed: false,
    ancestorIds: [],
    ancestorGuideDepths: [],
    visibleDescendantEndId: null,
    ...overrides
  };
}

function pending(
  overrides: Partial<PendingKeyboardInsertion> = {}
): PendingKeyboardInsertion {
  return {
    intent: {
      token: 7,
      ownerSessionGeneration: 3,
      sourceId: "source",
      expectedNodeId: "inserted",
      postcondition: {
        kind: "split",
        expectedSourceTitle: "before",
        expectedInsertedTitle: "after"
      }
    },
    ownerSessionId: "session-a",
    ownerPaneId: "pane-a",
    interactionEpochAtDispatch: 11,
    expectedStructuralHistoryEpoch: "history-epoch",
    expectedStructuralHistoryEntryId: "history-entry",
    projectionGenerationAtDispatch: 20,
    layoutGenerationAtDispatch: 9,
    ...overrides
  };
}

function settlement(
  overrides: Partial<KeyboardInsertionSettlement> = {}
): KeyboardInsertionSettlement {
  return {
    intentToken: 7,
    expectedNodeId: "inserted",
    ownerSessionId: "session-a",
    ownerPaneId: "pane-a",
    ownerSessionGeneration: 3,
    interactionEpochAtDispatch: 11,
    baseProjectionGeneration: 20,
    acceptedProjectionGeneration: 24,
    baseLayoutGeneration: 9,
    acceptedLayoutGeneration: 13,
    authorityOutcome: "postconditionAccepted",
    focusEligible: true,
    ...overrides
  };
}

function pane(
  previousRows: readonly FlattenedOutlineRow[],
  overrides: Partial<OutlinePanePublicationSnapshot> = {}
): OutlinePanePublicationSnapshot {
  return {
    paneId: "pane-a",
    sessionId: "session-a",
    scope: { kind: "active" },
    zoomedNodeId: null,
    showCompleted: true,
    collapsedNodeIds: new Set(),
    locallyExpandedNodeIds: new Set(),
    interactionEpoch: 11,
    visibleSignature: createOutlineVisibleSignature(previousRows),
    geometryGeneration: 4,
    activeDrag: false,
    ...overrides
  };
}

const insertionOwner: NotesProjectionPublicationOwner = {
  kind: "keyboard-insertion",
  intentToken: 7
};

function classify(input: {
  pending?: PendingKeyboardInsertion;
  settlement?: KeyboardInsertionSettlement;
  previousRows: readonly FlattenedOutlineRow[];
  acceptedRows: readonly FlattenedOutlineRow[];
  owners?: readonly NotesProjectionPublicationOwner[];
  pane?: Partial<OutlinePanePublicationSnapshot>;
  acceptedGeometryGeneration?: number;
}) {
  const previousPane = pane(input.previousRows, input.pane);
  return classifyKeyboardInsertionPublication({
    pending: input.pending ?? pending(),
    settlement: input.settlement ?? settlement(),
    previousPane,
    acceptedVisibleRows: input.acceptedRows,
    acceptedGeometryGeneration:
      input.acceptedGeometryGeneration ?? previousPane.geometryGeneration,
    publicationOwners: input.owners ?? [insertionOwner]
  });
}

describe("keyboard insertion registry", () => {
  it("mutates an entry only for its exact expected ID and intent token", () => {
    const registry = createKeyboardInsertionRegistry();
    const entry = pending();
    registry.register(entry);

    expect(registry.consume("wrong-id", entry.intent.token)).toBeNull();
    expect(
      registry.cancel(entry.intent.expectedNodeId, entry.intent.token + 1)
    ).toBeNull();
    expect(
      registry.transfer(entry.intent.expectedNodeId, entry.intent.token + 1)
    ).toBeNull();
    expect(registry.get(entry.intent.expectedNodeId)).toBe(entry);

    expect(
      registry.consume(entry.intent.expectedNodeId, entry.intent.token)
    ).toBe(entry);
    expect(registry.size()).toBe(0);
  });

  it("does not remove ownership merely because the command promise resolves", async () => {
    const registry = createKeyboardInsertionRegistry();
    const entry = pending();
    registry.register(entry);

    await Promise.resolve({ ok: true });

    expect(registry.get(entry.intent.expectedNodeId)).toBe(entry);
    expect(registry.size()).toBe(1);
  });

  it("transfers exact outcome-unknown ownership out of the live registry", () => {
    const registry = createKeyboardInsertionRegistry();
    const entry = pending();
    registry.register(entry);

    expect(
      registry.transfer(entry.intent.expectedNodeId, entry.intent.token)
    ).toBe(entry);
    expect(registry.get(entry.intent.expectedNodeId)).toBeUndefined();
  });

  it("cancels only the entries owned by a terminal pane or session", () => {
    const registry = createKeyboardInsertionRegistry();
    const paneEntry = pending();
    const siblingPaneEntry = pending({
      intent: {
        ...pending().intent,
        token: 8,
        expectedNodeId: "sibling-pane"
      },
      ownerPaneId: "pane-b"
    });
    const otherSessionEntry = pending({
      intent: {
        ...pending().intent,
        token: 9,
        expectedNodeId: "other-session"
      },
      ownerSessionId: "session-b"
    });
    registry.register(paneEntry);
    registry.register(siblingPaneEntry);
    registry.register(otherSessionEntry);

    expect(registry.cancelForPane("session-a", "pane-a")).toEqual([paneEntry]);
    expect(registry.get("sibling-pane")).toBe(siblingPaneEntry);
    expect(registry.get("other-session")).toBe(otherSessionEntry);

    expect(registry.cancelForSession("session-a")).toEqual([siblingPaneEntry]);
    expect(registry.get("other-session")).toBe(otherSessionEntry);
  });

  it("clears every live entry on Vault replacement", () => {
    const registry = createKeyboardInsertionRegistry();
    const first = pending();
    const second = pending({
      intent: {
        ...pending().intent,
        token: 8,
        expectedNodeId: "second"
      }
    });
    registry.register(first);
    registry.register(second);

    expect(registry.clear()).toEqual([first, second]);
    expect(registry.size()).toBe(0);
  });
});

describe("classifyKeyboardInsertionPublication", () => {
  const source = row("source", { parentId: "parent", depth: 1 });
  const sibling = row("sibling", { parentId: "parent", depth: 1 });
  const insertedSplit = row("inserted", { parentId: "parent", depth: 1 });

  it.each([
    {
      name: "exact split",
      pending: pending(),
      previous: [source, sibling],
      accepted: [source, insertedSplit, sibling]
    },
    {
      name: "exact first child",
      pending: pending({
        intent: {
          ...pending().intent,
          postcondition: {
            kind: "first-child",
            expectedParentId: "parent",
            expectedIndex: 0,
            expectedInsertedTitle: ""
          }
        }
      }),
      previous: [
        row("parent"),
        row("old-child", { parentId: "parent", depth: 1 })
      ],
      accepted: [
        row("parent"),
        row("inserted", { parentId: "parent", depth: 1 }),
        row("old-child", { parentId: "parent", depth: 1 })
      ]
    },
    {
      name: "collapsed contextual first child with prospective expansion",
      pending: pending({
        intent: {
          ...pending().intent,
          postcondition: {
            kind: "first-child",
            expectedParentId: "parent",
            expectedIndex: 0,
            expectedInsertedTitle: ""
          }
        }
      }),
      previous: [row("parent", { isCollapsed: true }), row("next-root")],
      accepted: [
        row("parent"),
        row("inserted", { parentId: "parent", depth: 1 }),
        row("next-root")
      ]
    }
  ])("classifies $name without generation arithmetic", (fixture) => {
    const result = classify({
      pending: fixture.pending,
      previousRows: fixture.previous,
      acceptedRows: fixture.accepted,
      owners: [
        { kind: "keyboard-draft", intentToken: 7 },
        insertionOwner
      ]
    });

    expect(result.kind).toBe("exact");
    if (result.kind !== "exact") return;
    expect(result.pending).toBe(fixture.pending);
    expect(result.settlement.focusEligible).toBe(true);
  });

  it.each([
    ["session", settlement({ ownerSessionId: "session-b" })],
    ["pane", settlement({ ownerPaneId: "pane-b" })],
    ["session generation", settlement({ ownerSessionGeneration: 4 })],
    ["intent token", settlement({ intentToken: 8 })],
    ["expected ID", settlement({ expectedNodeId: "other-id" })]
  ])("leaves the intent pending for an unrelated %s settlement", (_name, changedSettlement) => {
    const result = classify({
      settlement: changedSettlement,
      previousRows: [source, sibling],
      acceptedRows: [source, insertedSplit, sibling]
    });

    expect(result.kind).toBe("unrelated");
  });

  it.each([
    [
      "base projection generation",
      settlement({ baseProjectionGeneration: 19 })
    ],
    ["base layout generation", settlement({ baseLayoutGeneration: 8 })]
  ])("rejects a terminal settlement with a different %s", (_name, changedSettlement) => {
    const result = classify({
      settlement: changedSettlement,
      previousRows: [source, sibling],
      acceptedRows: [source, insertedSplit, sibling]
    });

    expect(result.kind).toBe("mismatch");
    if (result.kind !== "mismatch") return;
    expect(result.settlement.focusEligible).toBe(false);
  });

  it("prioritizes superseded history over generation and relationship disagreement", () => {
    const result = classify({
      settlement: settlement({
        authorityOutcome: "ownedButSuperseded",
        baseProjectionGeneration: 19,
        focusEligible: true
      }),
      previousRows: [source, sibling],
      acceptedRows: [
        source,
        row("inserted", { parentId: "other-parent", depth: 1 }),
        sibling
      ]
    });

    expect(result.kind).toBe("mixed");
    if (result.kind !== "mixed") return;
    expect(result.settlement.focusEligible).toBe(false);
  });

  it("treats an unproved wrong relationship as a normal-motion mismatch", () => {
    const result = classify({
      settlement: settlement({
        authorityOutcome: "mismatch",
        focusEligible: true
      }),
      previousRows: [source, sibling],
      acceptedRows: [
        source,
        row("inserted", { parentId: "other-parent", depth: 1 }),
        sibling
      ]
    });

    expect(result.kind).toBe("mismatch");
    if (result.kind !== "mismatch") return;
    expect(result.settlement.focusEligible).toBe(false);
  });

  it.each([
    {
      name: "membership",
      accepted: [
        source,
        insertedSplit,
        row("remote", { parentId: "parent", depth: 1 }),
        sibling
      ]
    },
    {
      name: "parent",
      accepted: [
        source,
        insertedSplit,
        { ...sibling, parentId: "other-parent" }
      ]
    },
    {
      name: "depth",
      accepted: [source, insertedSplit, { ...sibling, depth: 2 }]
    },
    {
      name: "collapse",
      accepted: [
        { ...source, isCollapsed: true },
        insertedSplit,
        sibling
      ]
    },
    {
      name: "order",
      accepted: [sibling, source, insertedSplit]
    }
  ])("uses mixed for an extra $name diff outside the Enter allowance", (fixture) => {
    expect(
      classify({
        previousRows: [source, sibling],
        acceptedRows: fixture.accepted
      }).kind
    ).toBe("mixed");
  });

  it("uses mixed for an untagged accepted geometry change", () => {
    expect(
      classify({
        previousRows: [source, sibling],
        acceptedRows: [source, insertedSplit, sibling],
        acceptedGeometryGeneration: 5
      }).kind
    ).toBe("mixed");
  });

  it("recognizes first-child identity from the current authoritative index", () => {
    const firstChildPending = pending({
      intent: {
        ...pending().intent,
        postcondition: {
          kind: "first-child",
          expectedParentId: "parent",
          expectedIndex: 0,
          expectedInsertedTitle: ""
        }
      }
    });
    const parent = row("parent");
    const oldFirst = row("old-first", { parentId: "parent", depth: 1 });
    const remoteFirst = row("remote-first", {
      parentId: "parent",
      depth: 1
    });

    const result = classify({
      pending: firstChildPending,
      previousRows: [parent, oldFirst],
      acceptedRows: [
        parent,
        row("inserted", { parentId: "parent", depth: 1 }),
        remoteFirst,
        oldFirst
      ]
    });

    expect(result.kind).toBe("mixed");
  });

  it("recognizes split identity from the source's current parent and sibling position", () => {
    const parentA = row("parent-a");
    const sourceBeforeMove = row("source", {
      parentId: "parent-a",
      depth: 1
    });
    const siblingA = row("sibling-a", {
      parentId: "parent-a",
      depth: 1
    });
    const parentB = row("parent-b");
    const siblingB = row("sibling-b", {
      parentId: "parent-b",
      depth: 1
    });

    const result = classify({
      previousRows: [parentA, sourceBeforeMove, siblingA, parentB, siblingB],
      acceptedRows: [
        parentA,
        siblingA,
        parentB,
        row("source", { parentId: "parent-b", depth: 1 }),
        row("inserted", { parentId: "parent-b", depth: 1 }),
        siblingB
      ]
    });

    expect(result.kind).toBe("mixed");
  });

  it.each([
    {
      name: "active drag",
      pane: { activeDrag: true },
      owners: [insertionOwner]
    },
    {
      name: "another publication owner",
      pane: {},
      owners: [
        { kind: "other" as const },
        insertionOwner
      ]
    },
    {
      name: "another intent owner",
      pane: {},
      owners: [
        { kind: "keyboard-insertion" as const, intentToken: 99 },
        insertionOwner
      ]
    }
  ])("uses mixed when $name interleaves", (fixture) => {
    expect(
      classify({
        previousRows: [source, sibling],
        acceptedRows: [source, insertedSplit, sibling],
        pane: fixture.pane,
        owners: fixture.owners
      }).kind
    ).toBe("mixed");
  });

  it("requires same-intent draft publications to precede the structural publication", () => {
    expect(
      classify({
        previousRows: [source, sibling],
        acceptedRows: [source, insertedSplit, sibling],
        owners: [
          insertionOwner,
          { kind: "keyboard-draft", intentToken: 7 }
        ]
      }).kind
    ).toBe("mixed");
  });

  it("does not treat an unowned row-shaped publication as the insertion", () => {
    expect(
      classify({
        previousRows: [source, sibling],
        acceptedRows: [source, insertedSplit, sibling],
        owners: [{ kind: "other" }]
      }).kind
    ).toBe("unrelated");
  });

  it("keeps zero-motion classification but removes focus eligibility after a later interaction", () => {
    const result = classify({
      previousRows: [source, sibling],
      acceptedRows: [source, insertedSplit, sibling],
      pane: { interactionEpoch: 12 }
    });

    expect(result.kind).toBe("exact");
    if (result.kind !== "exact") return;
    expect(result.settlement.focusEligible).toBe(false);
  });

  it("returns a disposition without queueing a microtask", () => {
    const queueMicrotaskSpy = vi.spyOn(globalThis, "queueMicrotask");

    const result = classify({
      previousRows: [source, sibling],
      acceptedRows: [source, insertedSplit, sibling]
    });

    expect(result.kind).toBe("exact");
    expect(queueMicrotaskSpy).not.toHaveBeenCalled();
    queueMicrotaskSpy.mockRestore();
  });
});
