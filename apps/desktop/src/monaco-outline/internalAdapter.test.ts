import { describe, expect, it, vi } from "vitest";

import {
  assertMonacoInternalCapabilities,
  moveWithInjectedTextAffinity,
  pushMetadataUndo,
  readInjectedTextAttachment,
  readMonacoInternalCapabilities,
  registerOutlineContribution,
  setEditorHiddenAreas
} from "./internalAdapter";

describe("Monaco internal adapter", () => {
  it("reports every pinned Monaco capability", () => {
    expect(readMonacoInternalCapabilities()).toEqual({
      editorContribution: true,
      editorCommand: true,
      cursorAffinity: true,
      hiddenAreas: true,
      injectedMouseTarget: true,
      metadataUndo: true
    });
    expect(() => assertMonacoInternalCapabilities()).not.toThrow();
  });

  it("reads only Yonalist injected bullet attachments", () => {
    expect(
      readInjectedTextAttachment({
        target: {
          detail: {
            injectedText: {
              options: {
                attachedData: {
                  kind: "yonalist-bullet",
                  nodeId: "node-1"
                }
              }
            }
          }
        }
      })
    ).toEqual({ kind: "yonalist-bullet", nodeId: "node-1" });

    expect(
      readInjectedTextAttachment({
        target: {
          detail: {
            injectedText: {
              options: {
                attachedData: {
                  kind: "foreign",
                  nodeId: "node-1"
                }
              }
            }
          }
        }
      })
    ).toBeNull();
  });

  it("forwards pane-local hidden ranges through the private editor capability", () => {
    const setHiddenAreas = vi.fn();
    const ranges = [{ startLineNumber: 2, endLineNumber: 4 }];

    setEditorHiddenAreas(
      { setHiddenAreas } as never,
      ranges as never,
      "yonalist-secondary"
    );

    expect(setHiddenAreas).toHaveBeenCalledWith(
      ranges,
      "yonalist-secondary",
      true
    );
  });

  it("selects injected-text affinity without leaking internal imports", () => {
    const left = moveWithInjectedTextAffinity("left", (operations, affinity) => ({
      operations,
      affinity
    }));
    const right = moveWithInjectedTextAffinity(
      "right",
      (operations, affinity) => ({
        operations,
        affinity
      })
    );

    expect(typeof left.operations).toBe("function");
    expect(left.affinity).toBe(3);
    expect(right.affinity).toBe(4);
  });

  it("pushes metadata onto Monaco's resource Undo stack", () => {
    const pushElement = vi.fn();
    const editor = {
      invokeWithinContext: (
        callback: (accessor: { get(): { pushElement: typeof pushElement } }) => void
      ) => callback({ get: () => ({ pushElement }) })
    };
    const element = {
      resource: { toString: () => "inmemory://yonalist/page/page" },
      label: "Indent bullet",
      code: "yonalist.outline.indent",
      undo: vi.fn(),
      redo: vi.fn()
    };

    pushMetadataUndo(editor as never, element as never);

    expect(pushElement).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 0,
        resource: element.resource,
        label: "Indent bullet",
        code: "yonalist.outline.indent"
      }),
      expect.objectContaining({ id: expect.any(Number) })
    );
  });

  it("registers an eager outline contribution through the pinned registry", () => {
    const contributionId = `yonalist.outline.test.${crypto.randomUUID()}`;

    expect(
      registerOutlineContribution(
        contributionId,
        class TestContribution {
          dispose() {}
        }
      )
    ).toBe(contributionId);
  });
});
