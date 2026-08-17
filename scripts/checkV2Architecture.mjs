import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedDependencies = new Map([
  ["notes-core", []],
  ["notes-application", ["notes-core"]],
  ["notes-sync", ["notes-application", "notes-core"]],
  ["notes-sqlite", ["notes-application", "notes-core", "notes-sync"]]
]);

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: root,
    encoding: "utf8"
  })
);
const workspacePackages = new Map(
  metadata.packages
    .filter((pkg) => metadata.workspace_members.includes(pkg.id))
    .map((pkg) => [pkg.name, pkg])
);

for (const [name, expected] of expectedDependencies) {
  const pkg = workspacePackages.get(name);
  if (!pkg) {
    throw new Error(`missing v2 workspace package: ${name}`);
  }
  const actual = pkg.dependencies
    .map((dependency) => dependency.name)
    .filter((dependency) => expectedDependencies.has(dependency))
    .sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `${name} workspace dependencies ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`
    );
  }
  if (pkg.dependencies.length > 20) {
    console.warn(
      `warning: ${name} has ${pkg.dependencies.length} direct dependencies (budget 20)`
    );
  }
}

const visiting = new Set();
const visited = new Set();
function visit(name) {
  if (visiting.has(name)) {
    throw new Error(`v2 workspace dependency cycle includes ${name}`);
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of expectedDependencies.get(name) ?? []) visit(dependency);
  visiting.delete(name);
  visited.add(name);
}
for (const name of expectedDependencies.keys()) visit(name);

function sourceFiles(directory, extensions) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (["dist", "node_modules", "target"].includes(entry)) return [];
      return sourceFiles(path, extensions);
    }
    return extensions.includes(extname(path)) ? [path] : [];
  });
}

const v2Sources = [
  ...sourceFiles(join(root, "crates"), [".rs"]),
  ...sourceFiles(join(root, "apps", "desktop", "src"), [".ts", ".tsx"])
];
for (const path of v2Sources) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).length;
  const testFile = /(?:^|[\\/])tests?[\\/]|\.test\.[^.]+$/u.test(path);
  const budget = testFile ? 800 : 500;
  if (lines > budget) {
    console.warn(
      `warning: ${relative(root, path)} has ${lines} lines (advisory budget ${budget})`
    );
  }
}

const frontendSources = sourceFiles(join(root, "apps", "desktop", "src"), [".ts", ".tsx"]);
const frontendSet = new Set(frontendSources.map((path) => resolve(path)));
const dependencyGraph = new Map();
for (const path of frontendSources) {
  const source = readFileSync(path, "utf8");
  const dependencies = [...source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/gu)]
    .map((match) => match[1])
    .flatMap((specifier) => {
      const base = resolve(dirname(path), specifier);
      return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
    })
    .filter((candidate) => frontendSet.has(candidate));
  dependencyGraph.set(resolve(path), [...new Set(dependencies)]);
}

const frontendVisiting = new Set();
const frontendVisited = new Set();
function visitFrontend(path, stack) {
  if (frontendVisiting.has(path)) {
    const cycleStart = stack.indexOf(path);
    const cycle = [...stack.slice(cycleStart), path]
      .map((entry) => relative(root, entry))
      .join(" -> ");
    throw new Error(`v2 frontend dependency cycle: ${cycle}`);
  }
  if (frontendVisited.has(path)) return;
  frontendVisiting.add(path);
  for (const dependency of dependencyGraph.get(path) ?? []) {
    visitFrontend(dependency, [...stack, path]);
  }
  frontendVisiting.delete(path);
  frontendVisited.add(path);
}
for (const path of frontendSources) visitFrontend(resolve(path), []);

const expectedCommands = [
  "notes_bootstrap",
  "notes_query_viewport",
  "notes_query_forest",
  "notes_execute",
  "notes_undo",
  "notes_redo",
  "notes_search",
  "notes_sync_attachments",
  "notes_sync_status",
  "notes_sync_delete_attachment",
  "notes_sync_conflicts",
  "notes_sync_flush",
  "notes_sync_restore_conflict",
  "notes_sync_vault_get",
  "notes_sync_vault_set",
  "notes_close_session",
  "notes_unused_assets",
  "notes_delete_all_data",
  "notes_toggle_devtools",
  "notes_onboarding_write_guide",
  "notes_onboarding_first_run",
  "notes_rebuild_from_vault",
  "notes_sync_forget_conflict"
].sort();
const tauriSource = readFileSync(
  join(root, "apps", "desktop", "src-tauri", "src", "lib.rs"),
  "utf8"
);
const actualCommands = [...tauriSource.matchAll(/#\[tauri::command\]\s+async fn (notes_[a-z_]+)/gu)]
  .map((match) => match[1])
  .sort();
if (JSON.stringify(actualCommands) !== JSON.stringify(expectedCommands)) {
  throw new Error(
    `v2 Tauri command surface ${JSON.stringify(actualCommands)} != ` +
      JSON.stringify(expectedCommands)
  );
}

// A command missing from the ACL is denied at runtime with nothing to see at
// build time — three shipped commands were dead this way before anyone
// noticed. `generate_handler!` is the surface that matters, so hold the
// permission list and the build script's manifest against it.
const handlerBlock = /generate_handler!\[([^\]]*)\]/u.exec(tauriSource);
if (!handlerBlock) throw new Error("v2 Tauri handler list was not found");
const handlerCommands = handlerBlock[1]
  .split(",")
  .map((entry) => entry.trim().split("::").at(-1))
  .filter((entry) => /^[a-z_]+$/u.test(entry ?? ""))
  .sort();
for (const [label, path] of [
  ["permission allow-list", ["apps", "desktop", "src-tauri", "permissions", "main-window.toml"]],
  ["build.rs app manifest", ["apps", "desktop", "src-tauri", "build.rs"]]
]) {
  const source = readFileSync(join(root, ...path), "utf8");
  const declared = new Set(
    [...source.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1])
  );
  const missing = handlerCommands.filter((command) => !declared.has(command));
  if (missing.length > 0) {
    throw new Error(
      `v2 Tauri commands missing from the ${label}: ${JSON.stringify(missing)}`
    );
  }
}

const mainWindowCapability = JSON.parse(readFileSync(
  join(root, "apps", "desktop", "src-tauri", "capabilities", "default.json"),
  "utf8"
));
const requiredPermissions = [
  "core:default",
  "core:window:allow-destroy",
  "core:window:allow-start-dragging",
  "dialog:allow-open",
  "dialog:allow-save",
  "main-window-notes-commands"
].sort();
const actualPermissions = [...mainWindowCapability.permissions].sort();
if (JSON.stringify(actualPermissions) !== JSON.stringify(requiredPermissions)) {
  throw new Error(
    `v2 main-window permissions ${JSON.stringify(actualPermissions)} != ` +
      JSON.stringify(requiredPermissions)
  );
}

console.log("v2 architecture boundaries PASS");
