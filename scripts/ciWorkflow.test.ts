import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();

type Step = { uses?: string; run?: string; name?: string };
type Job = { if?: string; steps: Step[] };
type Trigger = { paths?: string[] } | null;
type Workflow = {
  on: { push?: Trigger; pull_request?: Trigger; workflow_dispatch?: Trigger };
  jobs: Record<string, Job>;
};

function workflow(file: string): Workflow {
  return parse(
    readFileSync(join(root, ".github", "workflows", file), "utf8")
  ) as Workflow;
}

const v2 = workflow("ci.yml");
const v1 = workflow("ci-v1.yml");

function steps(job: Job): string[] {
  return job.steps.map((step) => step.uses ?? step.run ?? "");
}

function pinnedActions(flow: Workflow): string[] {
  return Object.values(flow.jobs)
    .flatMap((job) => job.steps)
    .map((step) => step.uses)
    .filter((uses): uses is string => Boolean(uses));
}

describe("CI workflows", () => {
  it("runs the v2 gate on every pull request with no paths filter", () => {
    expect(Object.keys(v2.on).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch"
    ]);
    expect(v2.on.pull_request).toBeNull();
    expect(v2.on.push).toEqual({ branches: ["main"] });
    for (const trigger of Object.values(v2.on)) {
      expect(trigger?.paths).toBeUndefined();
    }
  });

  it("makes the v2 job run the composite gate and nothing narrower", () => {
    expect(steps(v2.jobs.v2)).toContain("npm run test:v2");
    expect(v2.jobs.v2.if).toBeUndefined();
  });

  it("keeps the release performance suite off pull requests", () => {
    const performance = v2.jobs["v2-performance"];
    expect(steps(performance)).toContain("npm run test:v2:performance");
    expect(performance.if).toBe(
      "github.event_name == 'push' || github.event_name == 'workflow_dispatch'"
    );
  });

  it("gives the tauri workspace job the system libraries it links against", () => {
    const install = steps(v2.jobs.v2).find((step) =>
      step.includes("apt-get install")
    );
    for (const packageName of [
      "libwebkit2gtk-4.1-dev",
      "libgtk-3-dev",
      "libayatana-appindicator3-dev",
      "librsvg2-dev",
      "libdbus-1-dev",
      "pkg-config"
    ]) {
      expect(install).toContain(packageName);
    }
  });

  it("caches the root cargo workspace for v2 and src-tauri for v1", () => {
    const cache = (flow: Workflow, job: string) =>
      flow.jobs[job].steps.find((step) =>
        step.uses?.startsWith("Swatinem/rust-cache")
      ) as (Step & { with?: { workspaces?: string } }) | undefined;

    expect(cache(v2, "v2")?.with?.workspaces).toBeUndefined();
    expect(cache(v1, "rust")?.with?.workspaces).toBe("src-tauri");
  });

  it("installs node dependencies once, at the repo root", () => {
    const installs = steps(v2.jobs.v2).filter((step) => step.includes("npm ci"));
    expect(installs).toEqual(["npm ci"]);
  });

  it("runs the frozen v1 jobs only when v1 or shared tooling changes", () => {
    for (const trigger of [v1.on.push, v1.on.pull_request]) {
      expect(trigger?.paths).toEqual([
        ".github/workflows/ci-v1.yml",
        "index.html",
        "package-lock.json",
        "package.json",
        "rust-toolchain.toml",
        "scripts/**",
        "src-tauri/**",
        "src/**",
        "tsconfig.json",
        "vite.config.ts"
      ]);
    }
  });

  it("never triggers the v1 jobs from v2 sources", () => {
    const paths = v1.on.pull_request?.paths ?? [];
    for (const v2Path of ["apps/**", "apps/desktop/**", "crates/**", "Cargo.toml"]) {
      expect(paths).not.toContain(v2Path);
    }
  });

  it("pins every action to the version already in use", () => {
    expect([...new Set([...pinnedActions(v2), ...pinnedActions(v1)])].sort()).toEqual([
      "Swatinem/rust-cache@v2",
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "dtolnay/rust-toolchain@1.97.0"
    ]);
  });
});
