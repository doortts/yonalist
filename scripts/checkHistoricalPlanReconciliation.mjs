import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const manifestPath =
  "docs/superpowers/reports/2026-07-19-historical-plan-manifest.json";
const ledgerPath =
  "docs/superpowers/reports/2026-07-19-historical-plan-ledger.json";
const dispositions = new Set([
  "complete",
  "partial",
  "superseded",
  "unimplemented"
]);

function checkboxes(document) {
  return [...document.matchAll(/^\s*-\s+\[([ xX])\]\s+(.*)$/gm)].map(
    (match) => ({ checked: match[1].toLowerCase() === "x", text: match[2] })
  );
}

export function checkboxDigest(document) {
  return createHash("sha256")
    .update(checkboxes(document).map(({ text }) => text).join("\n"))
    .digest("hex");
}

function expectedDocumentStatus(groups, checkboxCount) {
  const dispositionsByOrdinal = new Array(checkboxCount);
  for (const group of groups) {
    for (let ordinal = group.from; ordinal <= group.to; ordinal += 1) {
      dispositionsByOrdinal[ordinal - 1] = group.disposition;
    }
  }
  if (dispositionsByOrdinal.every((value) => value === "complete")) {
    return "complete";
  }
  if (dispositionsByOrdinal.every((value) => value === "superseded")) {
    return "superseded";
  }
  if (dispositionsByOrdinal.every((value) => value === "unimplemented")) {
    return "unimplemented";
  }
  return "partial";
}

function fail(message) {
  throw new Error(message);
}

export function resolveEvidenceHead({
  auditedHead,
  manifestIntroductionCommit,
  ledgerIntroductionCommit,
  isCommit
}) {
  if (isCommit(auditedHead)) return auditedHead;
  if (
    manifestIntroductionCommit &&
    manifestIntroductionCommit === ledgerIntroductionCommit &&
    isCommit(manifestIntroductionCommit)
  ) {
    return manifestIntroductionCommit;
  }
  fail(
    `missing auditedHead ${auditedHead} and immutable reconciliation snapshot`
  );
}

export function validatePlanReconciliation({
  manifest,
  ledger,
  documents,
  isReachableCommit,
  hasArtifact
}) {
  if (ledger.auditedHead !== manifest.auditedHead) {
    fail("ledger auditedHead does not match manifest");
  }
  if (manifest.plans.length !== manifest.totalPlans) {
    fail(`manifest plan count ${manifest.plans.length}/${manifest.totalPlans}`);
  }
  const manifestCheckboxes = manifest.plans.reduce(
    (total, plan) => total + plan.checkboxes,
    0
  );
  if (manifestCheckboxes !== manifest.totalCheckboxes) {
    fail(`manifest checkbox count ${manifestCheckboxes}/${manifest.totalCheckboxes}`);
  }

  const ledgerByPlan = new Map();
  for (const plan of ledger.plans) {
    if (ledgerByPlan.has(plan.plan)) fail(`duplicate plan ${plan.plan}`);
    ledgerByPlan.set(plan.plan, plan);
  }
  if (ledgerByPlan.size !== manifest.totalPlans) {
    fail(`ledger plan count ${ledgerByPlan.size}/${manifest.totalPlans}`);
  }

  let reconciled = 0;
  let complete = 0;
  const dispositionCounts = {
    complete: 0,
    partial: 0,
    superseded: 0,
    unimplemented: 0
  };
  const documentSummaries = [];
  for (const manifestPlan of manifest.plans) {
    const document = documents.get(manifestPlan.path);
    if (document === undefined) fail(`missing plan document ${manifestPlan.path}`);
    const actualCheckboxes = checkboxes(document);
    if (actualCheckboxes.length !== manifestPlan.checkboxes) {
      fail(
        `${manifestPlan.path}: checkbox count ${actualCheckboxes.length}/${manifestPlan.checkboxes}`
      );
    }
    if (checkboxDigest(document) !== manifestPlan.checkboxDigest) {
      fail(`${manifestPlan.path}: checkbox digest mismatch`);
    }

    const plan = ledgerByPlan.get(manifestPlan.path);
    if (!plan) fail(`missing ledger plan ${manifestPlan.path}`);
    const owners = new Array(manifestPlan.checkboxes).fill(null);
    for (const group of plan.groups) {
      if (
        !Number.isInteger(group.from) ||
        !Number.isInteger(group.to) ||
        group.from < 1 ||
        group.to < group.from ||
        group.to > manifestPlan.checkboxes
      ) {
        fail(`${manifestPlan.path}: invalid range ${group.from}..${group.to}`);
      }
      if (!dispositions.has(group.disposition)) {
        fail(`${manifestPlan.path}: invalid disposition ${group.disposition}`);
      }
      if (typeof group.rationaleKo !== "string" || group.rationaleKo.trim() === "") {
        fail(`${manifestPlan.path}: missing Korean rationale`);
      }
      for (let ordinal = group.from; ordinal <= group.to; ordinal += 1) {
        if (owners[ordinal - 1] !== null) {
          fail(`${manifestPlan.path}: duplicate checkbox ordinal ${ordinal}`);
        }
        owners[ordinal - 1] = group;
      }
      if (group.disposition === "complete") {
        if (!Array.isArray(group.commits) || group.commits.length === 0) {
          fail(`${manifestPlan.path}: complete group has no commit`);
        }
        if (!Array.isArray(group.artifacts) || group.artifacts.length === 0) {
          fail(`${manifestPlan.path}: complete group has no artifact`);
        }
        for (const commit of group.commits) {
          if (!isReachableCommit(commit)) {
            fail(`${manifestPlan.path}: unreachable commit ${commit}`);
          }
        }
        for (const artifact of group.artifacts) {
          if (!hasArtifact(artifact)) {
            fail(`${manifestPlan.path}: missing artifact ${artifact}`);
          }
        }
      }
    }

    for (let index = 0; index < owners.length; index += 1) {
      const group = owners[index];
      if (!group) fail(`${manifestPlan.path}: missing checkbox ordinal ${index + 1}`);
      const shouldBeChecked = group.disposition === "complete";
      if (actualCheckboxes[index].checked !== shouldBeChecked) {
        fail(
          `${manifestPlan.path}: checkbox ${index + 1} must be ${
            shouldBeChecked ? "checked" : "unchecked"
          }`
        );
      }
      reconciled += 1;
      dispositionCounts[group.disposition] += 1;
      if (shouldBeChecked) complete += 1;
    }

    const expectedStatus = expectedDocumentStatus(
      plan.groups,
      manifestPlan.checkboxes
    );
    if (plan.documentStatus !== expectedStatus) {
      fail(
        `${manifestPlan.path}: document status ${plan.documentStatus}/${expectedStatus}`
      );
    }
    const header = document.match(
      /<!-- reconciliation: auditedHead=([^ ]+) status=([^ ]+) -->/
    );
    if (!header) fail(`${manifestPlan.path}: missing reconciliation header`);
    if (header[1] !== manifest.auditedHead || header[2] !== expectedStatus) {
      fail(`${manifestPlan.path}: reconciliation header mismatch`);
    }
    if (
      !document.includes(
        "[감사 보고서](../reports/2026-07-19-historical-plan-reconciliation.md)"
      )
    ) {
      fail(`${manifestPlan.path}: missing reconciliation report link`);
    }
    documentSummaries.push({
      plan: manifestPlan.path,
      status: expectedStatus,
      checkboxes: manifestPlan.checkboxes
    });
  }

  if (reconciled !== manifest.totalCheckboxes) {
    fail(`reconciled checkbox count ${reconciled}/${manifest.totalCheckboxes}`);
  }
  return {
    plans: manifest.totalPlans,
    checkboxes: reconciled,
    complete,
    dispositions: dispositionCounts,
    documents: documentSummaries
  };
}

function gitSucceeds(args) {
  return spawnSync("git", args, { stdio: "ignore" }).status === 0;
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run() {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const ledger = JSON.parse(readFileSync(resolve(ledgerPath), "utf8"));
  const documents = new Map(
    manifest.plans.map((plan) => [
      plan.path,
      readFileSync(resolve(plan.path), "utf8")
    ])
  );
  const manifestIntroductionCommit = gitOutput([
    "log",
    "--diff-filter=A",
    "-1",
    "--format=%H",
    "--",
    manifestPath
  ]);
  const ledgerIntroductionCommit = gitOutput([
    "log",
    "--diff-filter=A",
    "-1",
    "--format=%H",
    "--",
    ledgerPath
  ]);
  const evidenceHead = resolveEvidenceHead({
    auditedHead: manifest.auditedHead,
    manifestIntroductionCommit,
    ledgerIntroductionCommit,
    isCommit: (commit) => gitSucceeds([
      "cat-file",
      "-e",
      `${commit}^{commit}`
    ])
  });
  if (evidenceHead !== manifest.auditedHead) {
    if (!gitSucceeds([
      "diff",
      "--quiet",
      evidenceHead,
      "--",
      manifestPath,
      ledgerPath
    ])) {
      fail("reconciliation evidence changed after its fallback commit");
    }
    console.warn(
      `historical plan auditedHead is unavailable; using immutable reconciliation snapshot ${evidenceHead}`
    );
  }
  const result = validatePlanReconciliation({
    manifest,
    ledger,
    documents,
    isReachableCommit: (commit) =>
      gitSucceeds(["cat-file", "-e", `${commit}^{commit}`]) &&
      gitSucceeds([
        "merge-base",
        "--is-ancestor",
        commit,
        evidenceHead
      ]),
    hasArtifact: (artifact) =>
      gitSucceeds(["cat-file", "-e", `${evidenceHead}:${artifact}`])
  });
  if (process.argv.includes("--summary-json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`historical plans: ${result.plans}/${manifest.totalPlans}`);
  console.log(
    `checkboxes reconciled: ${result.checkboxes}/${manifest.totalCheckboxes} complete=${result.complete}`
  );
  console.log("historical plan reconciliation PASS");
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
