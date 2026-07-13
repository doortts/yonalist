import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NotesExportRequest,
  NotesExportSaveRequest
} from "../domain/notesExport";
import { NotesExportConflictError } from "../domain/notesExport";
import {
  renderMarkdownExport,
  renderPdfExport,
  saveNotesExport
} from "./notesExport";

const tauriCoreFactoryEvaluated = vi.hoisted(() => ({ current: false }));
const dialogFactoryEvaluated = vi.hoisted(() => ({ current: false }));
const invokeMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => {
  tauriCoreFactoryEvaluated.current = true;
  return { invoke: invokeMock };
});

vi.mock("@tauri-apps/plugin-dialog", () => {
  dialogFactoryEvaluated.current = true;
  return { save: saveMock };
});

const saveRequest: NotesExportSaveRequest = {
  vaultPath: "/vault",
  rootNodeId: "11111111-1111-4111-8111-111111111111",
  format: "markdown"
};

const pdfSaveRequest: NotesExportSaveRequest = {
  ...saveRequest,
  format: "pdf"
};

const exportRequest: NotesExportRequest = {
  vaultPath: saveRequest.vaultPath,
  rootNodeId: saveRequest.rootNodeId,
  destination: "/exports/project.md",
  overwrite: true
};

describe("notesExport", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    tauriCoreFactoryEvaluated.current = false;
    dialogFactoryEvaluated.current = false;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("guards outside Tauri before importing either native module", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    const error = await saveNotesExport(saveRequest).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Notes requires Tauri desktop storage."
    );
    expect(dialogFactoryEvaluated.current).toBe(false);
    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(saveMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns null on dialog cancellation before importing or invoking core", async () => {
    saveMock.mockResolvedValue(null);

    await expect(saveNotesExport(saveRequest)).resolves.toBeNull();

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "notes-export.md",
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    expect(dialogFactoryEvaluated.current).toBe(true);
    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the Markdown filter and sanitized default path before invoking the exact payload", async () => {
    const destination = "/exports/Project roadmap.md";
    saveMock.mockResolvedValue(destination);
    invokeMock.mockResolvedValue({ destination, format: "markdown" });

    await expect(
      saveNotesExport({
        ...saveRequest,
        defaultFileName: "  Project/roadmap.MD  "
      })
    ).resolves.toEqual({ destination, format: "markdown" });

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "Project roadmap.md",
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    expect(invokeMock).toHaveBeenCalledWith("notes_export_markdown", {
      vaultPath: "/vault",
      rootNodeId: "11111111-1111-4111-8111-111111111111",
      destination,
      overwrite: false
    });
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0]
    );
  });

  it("returns null on PDF dialog cancellation before importing or invoking core", async () => {
    saveMock.mockResolvedValue(null);

    await expect(saveNotesExport(pdfSaveRequest)).resolves.toBeNull();

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "notes-export.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the PDF filter and sanitized default path before invoking the exact payload", async () => {
    const destination = "/exports/Project roadmap.pdf";
    saveMock.mockResolvedValue(destination);
    invokeMock.mockResolvedValue({ destination, format: "pdf" });

    await expect(
      saveNotesExport({
        ...pdfSaveRequest,
        defaultFileName: "  Project/roadmap.PDF.PDF  "
      })
    ).resolves.toEqual({ destination, format: "pdf" });

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "Project roadmap.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    expect(invokeMock).toHaveBeenCalledWith("notes_export_pdf", {
      vaultPath: "/vault",
      rootNodeId: "11111111-1111-4111-8111-111111111111",
      destination,
      overwrite: false
    });
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0]
    );
  });

  it("passes an overwrite retry request unchanged to the native command", async () => {
    invokeMock.mockResolvedValue({
      destination: exportRequest.destination,
      format: "markdown"
    });

    await expect(renderMarkdownExport(exportRequest)).resolves.toEqual({
      destination: exportRequest.destination,
      format: "markdown"
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "notes_export_markdown",
      exportRequest
    );
  });

  it("rejects a malformed native response", async () => {
    invokeMock.mockResolvedValue({
      destination: exportRequest.destination,
      format: "Markdown"
    });

    await expect(renderMarkdownExport(exportRequest)).rejects.toEqual(
      new Error("Notes export returned an invalid result.")
    );
  });

  it("rejects a PDF response with the wrong native format", async () => {
    const request = {
      ...exportRequest,
      destination: "/exports/project.pdf"
    };
    invokeMock.mockResolvedValue({
      destination: request.destination,
      format: "markdown"
    });

    await expect(renderPdfExport(request)).rejects.toEqual(
      new Error("Notes export returned an invalid result.")
    );
  });

  it("maps the destinationExists code and retains the retry request", async () => {
    invokeMock.mockRejectedValue({
      code: "destinationExists",
      message: "Destination already exists."
    });

    const error = await renderMarkdownExport(exportRequest).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(NotesExportConflictError);
    expect((error as NotesExportConflictError).message).toBe(
      "Destination already exists."
    );
    expect((error as NotesExportConflictError).destination).toBe(
      exportRequest.destination
    );
    expect((error as NotesExportConflictError).request).toBe(exportRequest);
  });

  it("maps a PDF destinationExists conflict and retains the PDF retry request", async () => {
    const request = {
      ...exportRequest,
      destination: "/exports/project.pdf",
      overwrite: false
    };
    invokeMock.mockRejectedValue({
      code: "destinationExists",
      message: "Destination already exists."
    });

    const error = await renderPdfExport(request).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(NotesExportConflictError);
    expect((error as NotesExportConflictError).destination).toBe(
      request.destination
    );
    expect((error as NotesExportConflictError).request).toBe(request);
    expect(invokeMock).toHaveBeenCalledWith("notes_export_pdf", request);
  });

  it.each([
    // Bare message text — even the exact conflict string — is no longer a
    // conflict now that detection keys on the structured code.
    "Destination already exists.",
    new Error("Destination already exists."),
    new Error("Disk full"),
    // A different structured code (foreign assets folder) is a distinct
    // failure, not a destination-exists conflict.
    {
      code: "foreignExportAssetDir",
      message:
        "Export assets folder already exists and was not created by a previous export. Move or rename it and retry."
    },
    { code: "internal", message: "Notes background task failed." }
  ])("passes through a non-destinationExists rejection", async (cause) => {
    invokeMock.mockRejectedValue(cause);

    const error = await renderMarkdownExport(exportRequest).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toBe(cause);
  });
});
