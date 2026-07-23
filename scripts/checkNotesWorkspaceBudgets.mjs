import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const notesWorkspaceBudgets = Object.freeze({
  productionLines: 1_500,
  integrationLines: 5_500,
  nth: 0,
  invocation: 0,
  indexed: 25,
  allTestOrderObservations: 283
});

export const notesWorkspaceProductionFiles = Object.freeze([
  "src/features/notes/useNotesWorkspace.ts",
  "src/features/notes/notesWorkspaceRuntime.ts",
  "src/features/notes/notesWorkspaceTypes.ts",
  "src/features/notes/notesWorkspaceProjection.ts",
  "src/features/notes/notesWorkspaceCommandSupport.ts",
  "src/features/notes/notesDataDeletionRegistry.ts",
  "src/features/notes/notesWorkspaceNavigationSupport.ts",
  "src/features/notes/notesImageImportRecovery.ts",
  "src/features/notes/useNotesHistoryController.ts",
  "src/features/notes/useNotesDraftWorkflow.ts",
  "src/features/notes/useNotesCommandActions.ts",
  "src/features/notes/useNotesLibraryController.ts",
  "src/features/notes/useNotesAttachmentWorkflow.ts",
  "src/features/notes/useNotesSelectionController.ts",
  "src/features/notes/notesPaneHistory.ts",
  "src/features/notes/useNotesPaneSessions.ts",
  "src/features/notes/useNotesWorkspacePaneRegistry.ts"
]);

export const notesWorkspaceIntegrationTest =
  "src/features/notes/useNotesWorkspace.test.tsx";

const orderPatterns = Object.freeze({
  nth: /toHaveBeenNthCalledWith/,
  invocation: /invocationCallOrder/,
  indexed: /mock\.calls\s*\[/
});

function lineCount(text) {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function matchingLineCount(text, pattern) {
  return text.split(/\r?\n/).filter((line) => pattern.test(line)).length;
}

function orderCounts(text) {
  return {
    nth: matchingLineCount(text, orderPatterns.nth),
    invocation: matchingLineCount(text, orderPatterns.invocation),
    indexed: matchingLineCount(text, orderPatterns.indexed)
  };
}

function testFilesUnder(directory) {
  const found = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        /\.test\.(?:[cm]?js|tsx?)$/.test(entry.name) &&
        extname(entry.name) !== ".map"
      ) {
        found.push(relative(resolve("."), path));
      }
    }
  };
  visit(resolve(directory));
  return found;
}

function actualInputs() {
  const testFiles = ["src", "scripts"]
    .flatMap(testFilesUnder)
    .filter((path) => path !== "scripts/checkNotesWorkspaceBudgets.test.ts");
  const paths = new Set([
    ...notesWorkspaceProductionFiles,
    notesWorkspaceIntegrationTest,
    ...testFiles
  ]);
  return {
    files: Object.fromEntries(
      [...paths].map((path) => [path, readFileSync(resolve(path), "utf8")])
    ),
    productionFiles: [...notesWorkspaceProductionFiles],
    integrationTestFile: notesWorkspaceIntegrationTest,
    testFiles
  };
}

export function checkNotesWorkspaceBudgets(inputs = actualInputs()) {
  const {
    files,
    productionFiles,
    integrationTestFile,
    testFiles
  } = inputs;
  const violations = [];
  const productionLines = {};
  for (const path of productionFiles) {
    const actual = lineCount(files[path] ?? "");
    productionLines[path] = actual;
    if (actual > notesWorkspaceBudgets.productionLines) {
      violations.push(
        `${path} lines actual=${actual} budget=${notesWorkspaceBudgets.productionLines}`
      );
    }
  }

  const integrationText = files[integrationTestFile] ?? "";
  const integrationLines = lineCount(integrationText);
  if (integrationLines > notesWorkspaceBudgets.integrationLines) {
    violations.push(
      `${integrationTestFile} lines actual=${integrationLines} budget=${notesWorkspaceBudgets.integrationLines}`
    );
  }
  const { nth, invocation, indexed } = orderCounts(integrationText);
  for (const [name, actual] of Object.entries({ nth, invocation, indexed })) {
    const budget = notesWorkspaceBudgets[name];
    if (actual > budget) {
      violations.push(`${integrationTestFile} ${name} actual=${actual} budget=${budget}`);
    }
  }

  const allTestOrderObservations = testFiles.reduce((total, path) => {
    const counts = orderCounts(files[path] ?? "");
    return total + counts.nth + counts.invocation + counts.indexed;
  }, 0);
  if (
    allTestOrderObservations >
    notesWorkspaceBudgets.allTestOrderObservations
  ) {
    violations.push(
      `all-test-order-observations actual=${allTestOrderObservations} budget=${notesWorkspaceBudgets.allTestOrderObservations}`
    );
  }

  if (violations.length > 0) {
    throw new Error(violations.join("\n"));
  }
  return {
    productionLines,
    integrationLines,
    nth,
    invocation,
    indexed,
    allTestOrderObservations
  };
}

function run() {
  const result = checkNotesWorkspaceBudgets();
  for (const [path, lines] of Object.entries(result.productionLines)) {
    console.log(`${path} lines=${lines}/${notesWorkspaceBudgets.productionLines}`);
  }
  console.log(
    `${notesWorkspaceIntegrationTest} lines=${result.integrationLines}/${notesWorkspaceBudgets.integrationLines}`
  );
  console.log(
    `nth=${result.nth}/${notesWorkspaceBudgets.nth} invocation=${result.invocation}/${notesWorkspaceBudgets.invocation} indexed=${result.indexed}/${notesWorkspaceBudgets.indexed}`
  );
  console.log(
    `all-test-order-observations=${result.allTestOrderObservations}/${notesWorkspaceBudgets.allTestOrderObservations}`
  );
  console.log("notes workspace architecture budget PASS");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
