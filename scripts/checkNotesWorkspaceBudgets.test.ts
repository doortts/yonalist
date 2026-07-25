import { describe, expect, it } from "vitest";
import { checkNotesWorkspaceBudgets } from "./checkNotesWorkspaceBudgets.mjs";

const productionPath = "src/features/notes/notesWorkspaceRuntime.ts";
const integrationPath = "src/features/notes/useNotesWorkspace.test.tsx";

function lines(count: number, value = "export {};" ): string {
  return Array.from({ length: count }, () => value).join("\n");
}

function fixture(overrides: Record<string, string> = {}) {
  return {
    files: {
      [productionPath]: lines(1),
      [integrationPath]: lines(1),
      ...overrides
    },
    productionFiles: [productionPath],
    integrationTestFile: integrationPath,
    testFiles: [integrationPath]
  };
}

describe("Notes workspace architecture budgets", () => {
  it("rejects a production module above 1,500 lines", () => {
    expect(() =>
      checkNotesWorkspaceBudgets(fixture({ [productionPath]: lines(1_501) }))
    ).toThrow(/notesWorkspaceRuntime\.ts lines actual=1501 budget=1500/);
  });

  it("enforces a no-increase limit for every extracted production module", () => {
    const extractedPath =
      "src/features/notes/notesBackspaceRuntime.ts";
    expect(() =>
      checkNotesWorkspaceBudgets({
        ...fixture({
          [productionPath]: lines(1),
          [extractedPath]: lines(101),
        }),
        productionFiles: [productionPath, extractedPath],
        productionLineBudgets: {
          [productionPath]: 1_500,
          [extractedPath]: 100,
        },
      }),
    ).toThrow(/notesBackspaceRuntime\.ts lines actual=101 budget=100/);
  });

  it("rejects the integration test above 5,500 lines", () => {
    expect(() =>
      checkNotesWorkspaceBudgets(fixture({ [integrationPath]: lines(5_501) }))
    ).toThrow(/useNotesWorkspace\.test\.tsx lines actual=5501 budget=5500/);
  });

  it("rejects any nth-call observation", () => {
    expect(() =>
      checkNotesWorkspaceBudgets(
        fixture({ [integrationPath]: "expect(fn).toHaveBeenNthCalledWith(1);" })
      )
    ).toThrow(/nth actual=1 budget=0/);
  });

  it("rejects any invocation-order observation", () => {
    expect(() =>
      checkNotesWorkspaceBudgets(
        fixture({ [integrationPath]: "expect(fn.mock.invocationCallOrder);" })
      )
    ).toThrow(/invocation actual=1 budget=0/);
  });

  it("rejects more than 25 indexed mock-call observations", () => {
    expect(() =>
      checkNotesWorkspaceBudgets(
        fixture({ [integrationPath]: lines(26, "expect(fn.mock.calls[0]);") })
      )
    ).toThrow(/indexed actual=26 budget=25/);
  });

  it("rejects a suite-wide order-observation regression above 283 lines", () => {
    const otherTest = "src/other.test.ts";
    expect(() =>
      checkNotesWorkspaceBudgets({
        ...fixture({ [integrationPath]: lines(25, "expect(fn.mock.calls[0]);") }),
        files: {
          [productionPath]: lines(1),
          [integrationPath]: lines(25, "expect(fn.mock.calls[0]);"),
          [otherTest]: lines(259, "expect(fn.mock.calls[0]);")
        },
        testFiles: [integrationPath, otherTest]
      })
    ).toThrow(/all-test-order-observations actual=284 budget=283/);
  });

  it("returns measured counts when every budget passes", () => {
    const result = checkNotesWorkspaceBudgets(
      fixture({ [integrationPath]: lines(25, "expect(fn.mock.calls[0]);") })
    );

    expect(result).toMatchObject({
      integrationLines: 25,
      nth: 0,
      invocation: 0,
      indexed: 25,
      allTestOrderObservations: 25
    });
  });
});
