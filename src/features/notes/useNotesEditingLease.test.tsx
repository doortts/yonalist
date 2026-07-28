import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNotesEditingLease } from "./useNotesEditingLease";

describe("useNotesEditingLease", () => {
  it("flushes the previous node before transferring editing ownership", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useNotesEditingLease());

    await act(async () => {
      expect(
        await result.current.claim(
          { paneId: "primary", nodeId: "a", field: "title" },
          flush
        )
      ).toBe(true);
      expect(
        await result.current.claim(
          { paneId: "secondary", nodeId: "b", field: "note" },
          flush
        )
      ).toBe(true);
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith("a");
    expect(result.current.lease).toEqual({
      paneId: "secondary",
      nodeId: "b",
      field: "note"
    });
  });

  it("keeps the previous owner when its draft cannot be flushed", async () => {
    const flush = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() => useNotesEditingLease());

    await act(async () => {
      await result.current.claim(
        { paneId: "primary", nodeId: "a", field: "title" },
        flush
      );
      expect(
        await result.current.claim(
          { paneId: "secondary", nodeId: "b", field: "title" },
          flush
        )
      ).toBe(false);
    });

    expect(result.current.lease?.paneId).toBe("primary");
  });

  it("flushes the live editor when the same node moves between panes", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useNotesEditingLease());

    await act(async () => {
      await result.current.claim(
        { paneId: "primary", nodeId: "same", field: "title" },
        flush
      );
      expect(
        await result.current.claim(
          { paneId: "secondary", nodeId: "same", field: "title" },
          flush
        )
      ).toBe(true);
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith("same");
    expect(result.current.lease?.paneId).toBe("secondary");
  });

  it("keeps the same-node owner when a cross-pane flush fails", async () => {
    const flush = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() => useNotesEditingLease());

    await act(async () => {
      await result.current.claim(
        { paneId: "primary", nodeId: "same", field: "title" },
        flush
      );
      expect(
        await result.current.claim(
          { paneId: "secondary", nodeId: "same", field: "title" },
          flush
        )
      ).toBe(false);
    });

    expect(flush).toHaveBeenCalledWith("same");
    expect(result.current.lease?.paneId).toBe("primary");
  });

  it("blocks ownership transfer and structural work during composition", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useNotesEditingLease());

    await act(async () => {
      await result.current.claim(
        { paneId: "primary", nodeId: "a", field: "title" },
        flush
      );
      result.current.setCompositionActive("primary", true);
    });

    expect(result.current.structuralCommandsAllowed()).toBe(false);
    await act(async () => {
      expect(
        await result.current.claim(
          { paneId: "secondary", nodeId: "b", field: "title" },
          flush
        )
      ).toBe(false);
      result.current.setCompositionActive("primary", false);
    });
    expect(result.current.structuralCommandsAllowed()).toBe(true);
  });

  it("keeps controller methods stable while lease and composition values change", async () => {
    const flush = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useNotesEditingLease());
    const methodsBefore = {
      claim: result.current.claim,
      release: result.current.release,
      canEdit: result.current.canEdit,
      setCompositionActive: result.current.setCompositionActive,
      structuralCommandsAllowed: result.current.structuralCommandsAllowed
    };

    await act(async () => {
      await result.current.claim(
        { paneId: "primary", nodeId: "a", field: "title" },
        flush
      );
      result.current.setCompositionActive("secondary", true);
    });

    expect(
      methodsBefore.canEdit({ paneId: "primary", nodeId: "a", field: "title" })
    ).toBe(true);
    expect(
      methodsBefore.canEdit({ paneId: "secondary", nodeId: "b", field: "title" })
    ).toBe(false);
    expect(methodsBefore.structuralCommandsAllowed()).toBe(false);
    act(() => result.current.setCompositionActive("secondary", false));
    expect(methodsBefore.structuralCommandsAllowed()).toBe(true);

    expect({
      claim: result.current.claim,
      release: result.current.release,
      canEdit: result.current.canEdit,
      setCompositionActive: result.current.setCompositionActive,
      structuralCommandsAllowed: result.current.structuralCommandsAllowed
    }).toEqual(methodsBefore);
  });
});
