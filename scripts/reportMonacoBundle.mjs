import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RUNTIME_ENTRY = "src/monaco-outline/runtime.ts";

export async function readMonacoBundleReport({
  root,
  manifestPath = path.join(root, ".vite", "manifest.json")
}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const initialKeys = new Set();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.isEntry) collectStaticKeys(manifest, key, initialKeys);
  }
  const runtimeKeys = new Set();
  collectStaticKeys(manifest, RUNTIME_ENTRY, runtimeKeys);

  const initialFiles = filesForKeys(manifest, initialKeys);
  const monacoKeys = new Set(
    [...runtimeKeys].filter((key) => !initialKeys.has(key))
  );
  const monacoFiles = filesForKeys(manifest, monacoKeys);
  const initialCss = cssForKeys(manifest, initialKeys);
  const monacoCss = cssForKeys(manifest, runtimeKeys)
    .filter((file) => !initialCss.includes(file));
  const workerFiles = await findWorkerFiles(root);
  const monacoSizes = await sizesForFiles(root, monacoFiles);

  return {
    initialJavaScript: await totalForFiles(root, initialFiles),
    monacoJavaScript: totalSizes(monacoSizes),
    monacoCss: await totalForFiles(root, monacoCss),
    workers: {
      raw: (await sizesForFiles(root, workerFiles))
        .reduce((total, asset) => total + asset.raw, 0)
    },
    largestMonacoAssets: monacoSizes
      .sort((left, right) => right.raw - left.raw ||
        left.file.localeCompare(right.file))
      .slice(0, 10)
      .map(({ file, raw }) => ({ file, raw }))
  };
}

function collectStaticKeys(manifest, key, output) {
  if (output.has(key)) return;
  const entry = manifest[key];
  if (!entry) {
    throw new Error(`Bundle manifest is missing ${key}.`);
  }
  output.add(key);
  for (const dependency of entry.imports ?? []) {
    collectStaticKeys(manifest, dependency, output);
  }
}

function filesForKeys(manifest, keys) {
  return [...new Set(
    [...keys].map((key) => manifest[key]?.file).filter(Boolean)
  )];
}

function cssForKeys(manifest, keys) {
  return [...new Set(
    [...keys].flatMap((key) => manifest[key]?.css ?? [])
  )];
}

async function findWorkerFiles(root) {
  const assetsDirectory = path.join(root, "assets");
  const entries = await readdir(assetsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /worker.*\.js$/u.test(entry.name))
    .map((entry) => path.posix.join("assets", entry.name));
}

async function totalForFiles(root, files) {
  return totalSizes(await sizesForFiles(root, files));
}

function totalSizes(sizes) {
  return sizes.reduce(
    (total, asset) => ({
      raw: total.raw + asset.raw,
      gzip: total.gzip + asset.gzip
    }),
    { raw: 0, gzip: 0 }
  );
}

async function sizesForFiles(root, files) {
  return Promise.all(files.map(async (file) => {
    const bytes = await readFile(path.join(root, ...file.split("/")));
    return { file, raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
  }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const root = path.resolve("apps/desktop/dist");
  const report = await readMonacoBundleReport({ root });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
