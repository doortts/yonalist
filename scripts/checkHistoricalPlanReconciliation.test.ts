import { describe, expect, it } from "vitest";
import {
  checkboxDigest,
  validatePlanReconciliation
} from "./checkHistoricalPlanReconciliation.mjs";

const planPath = "docs/superpowers/plans/example.md";
const document = `<!-- reconciliation: auditedHead=head-a status=complete -->
# Example
- [x] first
- [x] second
`;
const manifest = {
  auditedHead: "head-a",
  totalPlans: 1,
  totalCheckboxes: 2,
  plans: [{ path: planPath, checkboxes: 2, checkboxDigest: checkboxDigest(document) }]
};
const completeLedger = {
  auditedHead: "head-a",
  plans: [
    {
      plan: planPath,
      documentStatus: "complete",
      groups: [
        {
          from: 1,
          to: 2,
          disposition: "complete",
          commits: ["commit-a"],
          artifacts: ["src/example.ts"],
          rationaleKo: "구현 커밋과 테스트 파일이 남아 있다."
        }
      ]
    }
  ]
};

function validate(ledger = completeLedger, source = document) {
  return validatePlanReconciliation({
    manifest,
    ledger,
    documents: new Map([[planPath, source]]),
    isReachableCommit: (commit: string) => commit === "commit-a",
    hasArtifact: (artifact: string) => artifact === "src/example.ts"
  });
}

describe("historical plan reconciliation", () => {
  it("ignores checkbox markers when hashing plan text", () => {
    expect(checkboxDigest("- [ ] first\n- [x] second\n")).toBe(
      checkboxDigest("- [x] first\n- [ ] second\n")
    );
  });

  it("accepts complete, reachable evidence with matching checkboxes", () => {
    expect(validate()).toEqual({ plans: 1, checkboxes: 2, complete: 2 });
  });

  it("rejects missing or duplicate checkbox coverage", () => {
    const bad = structuredClone(completeLedger);
    bad.plans[0]!.groups.push({ ...bad.plans[0]!.groups[0]!, from: 2, to: 2 });

    expect(() => validate(bad)).toThrow("duplicate checkbox ordinal 2");
  });

  it("rejects checkbox and evidence mismatches", () => {
    expect(() => validate(completeLedger, document.replace("- [x] second", "- [ ] second")))
      .toThrow("checkbox 2 must be checked");

    const unreachable = structuredClone(completeLedger);
    unreachable.plans[0]!.groups[0]!.commits = ["missing"];
    expect(() => validate(unreachable)).toThrow("unreachable commit missing");
  });
});
