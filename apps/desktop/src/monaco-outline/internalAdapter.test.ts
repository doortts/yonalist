import { describe, expect, it, vi } from "vitest";

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import {
  assertMonacoInternalCapabilities,
  keepCaretRightOfInjectedText,
  moveWithInjectedTextAffinity,
  pushMetadataUndo,
  readInjectedTextAttachment,
  readMonacoInternalCapabilities,
  realignCaretWithInjectedText,
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
      metadataUndo: true,
      cursorStateRewrite: true
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
                  kind: "yonalist-chevron",
                  nodeId: "node-1"
                }
              }
            }
          }
        }
      })
    ).toEqual({ kind: "yonalist-chevron", nodeId: "node-1" });

    expect(
      readInjectedTextAttachment({
        target: {
          detail: {
            injectedText: {
              options: {
                attachedData: {
                  kind: "yonalist-todo",
                  nodeId: "node-1"
                }
              }
            }
          }
        }
      })
    ).toEqual({ kind: "yonalist-todo", nodeId: "node-1" });

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

  it("realigns a column-one caret on demand without a cursor event", () => {
    const setCursorStates = vi.fn();
    const editor = {
      getSelection: () => new monaco.Selection(3, 1, 3, 1),
      _getViewModel: () => ({
        coordinatesConverter: {
          convertModelPositionToViewPosition: (
            _position: monaco.Position,
            affinity?: number
          ) =>
            affinity === 1
              ? new monaco.Position(3, 12)
              : new monaco.Position(3, 1)
        },
        setCursorStates
      })
    };

    realignCaretWithInjectedText(
      editor as unknown as monaco.editor.ICodeEditor
    );

    const state = setCursorStates.mock.calls[0]?.[2]?.[0] as {
      viewState: { position: monaco.Position };
    };
    expect(state.viewState.position).toEqual(new monaco.Position(3, 12));
  });

  it("rewrites a column-one caret to the right of injected text", () => {
    const listeners: Array<() => void> = [];
    const setCursorStates = vi.fn();
    let selection = new monaco.Selection(2, 1, 2, 1);
    const editor = {
      onDidChangeCursorPosition: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: vi.fn() };
      },
      getSelection: () => selection,
      _getViewModel: () => ({
        coordinatesConverter: {
          convertModelPositionToViewPosition: (
            _position: monaco.Position,
            affinity?: number
          ) =>
            affinity === 1
              ? new monaco.Position(2, 8)
              : new monaco.Position(2, 1)
        },
        setCursorStates
      })
    };

    keepCaretRightOfInjectedText(
      editor as unknown as monaco.editor.ICodeEditor
    );
    listeners[0]!();
    expect(setCursorStates).toHaveBeenCalledOnce();
    const state = setCursorStates.mock.calls[0]?.[2]?.[0] as {
      viewState: { position: monaco.Position };
    };
    expect(state.viewState.position).toEqual(new monaco.Position(2, 8));

    setCursorStates.mockClear();
    selection = new monaco.Selection(2, 4, 2, 4);
    listeners[0]!();
    expect(setCursorStates).not.toHaveBeenCalled();

    selection = new monaco.Selection(2, 1, 3, 1);
    listeners[0]!();
    expect(setCursorStates).not.toHaveBeenCalled();
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
