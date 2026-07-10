import { describe, expect, it } from "vitest";
import type { NotesExportRequest } from "./notesExport";
import {
  defaultNotesExportFileName,
  isNotesExportConflictMessage,
  isNotesExportResult,
  NotesExportConflictError
} from "./notesExport";

describe("defaultNotesExportFileName", () => {
  it.each(
    [undefined, null, "", "   ", ".", ".."]
  )(
    "uses the default Markdown filename for %j",
    (title) => {
      expect(defaultNotesExportFileName(title)).toBe("notes-export.md");
    }
  );

  it("removes path separators, control characters, and reserved filename punctuation", () => {
    expect(
      defaultNotesExportFileName("  Sprint/Plan:\\\u0000*  Q3?  ")
    ).toBe("Sprint Plan Q3.md");
  });

  it("collapses whitespace and keeps exactly one case-normalized Markdown suffix", () => {
    expect(defaultNotesExportFileName("  Project   roadmap.MD  ")).toBe(
      "Project roadmap.md"
    );
  });

  it.each([
    "Project.md.",
    "Project.md .",
    "Project.md.md",
    "Project.MD.md.."
  ])("normalizes trailing dots and repeated Markdown suffixes in %j", (title) => {
    expect(defaultNotesExportFileName(title)).toBe("Project.md");
  });

  const reservedDeviceStems = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
  ];

  it.each(
    reservedDeviceStems.flatMap((stem) => [stem, `${stem.toLowerCase()}.txt`])
  )("uses the default filename for reserved Windows device name %j", (title) => {
    expect(defaultNotesExportFileName(title)).toBe("notes-export.md");
  });

  it.each(["CON .md", "COM1 .md", "NUL .txt"])(
    "uses the default filename when whitespace precedes an extension in reserved Windows device name %j",
    (title) => {
      expect(defaultNotesExportFileName(title)).toBe("notes-export.md");
    }
  );

  it.each(["COM0", "COM10", "LPT0", "LPT10", "CONSOLE"])(
    "keeps non-reserved Windows filename stem %j",
    (title) => {
      expect(defaultNotesExportFileName(title)).toBe(`${title}.md`);
    }
  );
});

describe("isNotesExportResult", () => {
  it("accepts the exact camelCase Markdown result", () => {
    expect(
      isNotesExportResult({
        destination: "/exports/project.md",
        format: "markdown"
      })
    ).toBe(true);
  });

  it.each([
    null,
    [],
    { destination: "/exports/project.md" },
    { destination: "", format: "markdown" },
    { destination: "/exports/project.md", format: "Markdown" },
    {
      destination: "/exports/project.md",
      format: "markdown",
      overwrite: false
    }
  ])("rejects malformed native result %j", (value) => {
    expect(isNotesExportResult(value)).toBe(false);
  });
});

describe("Notes export conflicts", () => {
  const request: NotesExportRequest = {
    vaultPath: "/vault",
    rootNodeId: "11111111-1111-4111-8111-111111111111",
    destination: "/exports/project.md",
    overwrite: false
  };

  it("retains the exact conflict contract and original retry request", () => {
    const error = new NotesExportConflictError(request.destination, request);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotesExportConflictError");
    expect(error.message).toBe("Destination already exists.");
    expect(error.destination).toBe(request.destination);
    expect(error.request).toBe(request);
  });

  it("recognizes only the exact native conflict string", () => {
    expect(isNotesExportConflictMessage("Destination already exists.")).toBe(
      true
    );
    expect(isNotesExportConflictMessage("Destination already exists")).toBe(
      false
    );
    expect(
      isNotesExportConflictMessage(new Error("Destination already exists."))
    ).toBe(false);
  });
});
