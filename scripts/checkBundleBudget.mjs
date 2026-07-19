import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const bundleBudgets = Object.freeze({
  initialRaw: 917_136,
  initialGzip: 276_839,
  appRawExclusive: 500_000,
  appGzip: 150_000,
  notesRawExclusive: 500_000,
  notesRouteRaw: 574_719,
  notesRouteGzip: 165_751
});

function appManifestKey(manifest) {
  if (manifest["src/App.tsx"]) {
    return "src/App.tsx";
  }
  return Object.keys(manifest).find((key) => key.endsWith("/App.tsx"));
}

function notesManifestKey(manifest) {
  return Object.keys(manifest).find((key) =>
    key.endsWith("/features/notes/NotesFeature.tsx")
  );
}

function staticJavaScriptFiles(manifest, roots) {
  const visitedChunks = new Set();
  const files = new Set();
  const visit = (key) => {
    if (visitedChunks.has(key)) {
      return;
    }
    const chunk = manifest[key];
    if (!chunk) {
      throw new Error(`bundle manifest import is missing: ${key}`);
    }
    visitedChunks.add(key);
    if (chunk.file?.endsWith(".js")) {
      files.add(chunk.file);
    }
    for (const importedKey of chunk.imports ?? []) {
      visit(importedKey);
    }
  };

  for (const root of roots) visit(root);
  return files;
}

function fileBytes(files, file) {
  const value = files[file];
  if (value === undefined) {
    throw new Error(`bundle file is missing: ${file}`);
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function sourceCounts(sources) {
  let notes = 0;
  let dndKit = 0;
  let datePicker = 0;
  for (const source of sources) {
    const normalized = source.replaceAll("\\", "/");
    if (normalized.includes("/features/notes/")) {
      notes += 1;
    }
    if (normalized.includes("/node_modules/@dnd-kit/")) {
      dndKit += 1;
    }
    if (normalized.endsWith("/features/notes/NotesDatePicker.tsx")) {
      datePicker += 1;
    }
  }
  return { notes, dndKit, datePicker };
}

export function checkBundleBudget({ manifest, files, sourceMaps }) {
  const appKey = appManifestKey(manifest);
  if (!manifest["index.html"] || !appKey) {
    throw new Error("bundle manifest must contain index.html and src/App.tsx");
  }
  const notesKey = notesManifestKey(manifest);
  if (!notesKey) {
    throw new Error("bundle manifest must contain NotesFeature.tsx");
  }
  const appFile = manifest[appKey].file;
  const notesFile = manifest[notesKey].file;
  const initialFiles = staticJavaScriptFiles(manifest, ["index.html", appKey]);
  const notesRouteFiles = staticJavaScriptFiles(manifest, [notesKey]);
  const initialChunks = [...initialFiles].map((file) => fileBytes(files, file));
  const notesRouteChunks = [...notesRouteFiles]
    .filter((file) => !initialFiles.has(file))
    .map((file) => fileBytes(files, file));
  const appChunk = fileBytes(files, appFile);
  const appMap = sourceMaps[`${appFile}.map`];
  if (!appMap || !Array.isArray(appMap.sources)) {
    throw new Error(`App source map is missing: ${appFile}.map`);
  }
  const notesMap = sourceMaps[`${notesFile}.map`];
  if (!notesMap || !Array.isArray(notesMap.sources)) {
    throw new Error(`Notes source map is missing: ${notesFile}.map`);
  }

  const initialRaw = initialChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0
  );
  const initialGzip = initialChunks.reduce(
    (total, chunk) => total + gzipSync(chunk).byteLength,
    0
  );
  const appRaw = appChunk.byteLength;
  const appGzip = gzipSync(appChunk).byteLength;
  const notesRaw = fileBytes(files, notesFile).byteLength;
  const notesRouteRaw = notesRouteChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0
  );
  const notesRouteGzip = notesRouteChunks.reduce(
    (total, chunk) => total + gzipSync(chunk).byteLength,
    0
  );
  const { notes: notesSources, dndKit: dndKitSources } = sourceCounts(
    appMap.sources
  );
  const {
    dndKit: notesDndKitSources,
    datePicker: notesDatePickerSources
  } = sourceCounts(notesMap.sources);
  const violations = [];

  if (initialRaw > bundleBudgets.initialRaw) {
    violations.push(
      `initial-js raw actual=${initialRaw} budget=${bundleBudgets.initialRaw} over=${initialRaw - bundleBudgets.initialRaw}`
    );
  }
  if (initialGzip > bundleBudgets.initialGzip) {
    violations.push(
      `initial-js gzip actual=${initialGzip} budget=${bundleBudgets.initialGzip} over=${initialGzip - bundleBudgets.initialGzip}`
    );
  }
  if (appRaw >= bundleBudgets.appRawExclusive) {
    violations.push(
      `app-chunk raw actual=${appRaw} budget<${bundleBudgets.appRawExclusive} over=${appRaw - bundleBudgets.appRawExclusive + 1}`
    );
  }
  if (appGzip > bundleBudgets.appGzip) {
    violations.push(
      `app-chunk gzip actual=${appGzip} budget=${bundleBudgets.appGzip} over=${appGzip - bundleBudgets.appGzip}`
    );
  }
  if (notesRaw >= bundleBudgets.notesRawExclusive) {
    violations.push(
      `notes-chunk raw actual=${notesRaw} budget<${bundleBudgets.notesRawExclusive} over=${notesRaw - bundleBudgets.notesRawExclusive + 1}`
    );
  }
  if (notesRouteRaw > bundleBudgets.notesRouteRaw) {
    violations.push(
      `notes-route raw actual=${notesRouteRaw} budget=${bundleBudgets.notesRouteRaw} over=${notesRouteRaw - bundleBudgets.notesRouteRaw}`
    );
  }
  if (notesRouteGzip > bundleBudgets.notesRouteGzip) {
    violations.push(
      `notes-route gzip actual=${notesRouteGzip} budget=${bundleBudgets.notesRouteGzip} over=${notesRouteGzip - bundleBudgets.notesRouteGzip}`
    );
  }
  if (notesSources > 0) {
    violations.push(
      `app-map notes actual=${notesSources} budget=0 over=${notesSources}`
    );
  }
  if (dndKitSources > 0) {
    violations.push(
      `app-map dnd-kit actual=${dndKitSources} budget=0 over=${dndKitSources}`
    );
  }
  if (notesDndKitSources > 0) {
    violations.push(
      `notes-map dnd-kit actual=${notesDndKitSources} budget=0 over=${notesDndKitSources}`
    );
  }
  if (notesDatePickerSources > 0) {
    violations.push(
      `notes-map date-picker actual=${notesDatePickerSources} budget=0 over=${notesDatePickerSources}`
    );
  }

  if (violations.length > 0) {
    throw new Error(violations.join("\n"));
  }

  return {
    initialRaw,
    initialGzip,
    appRaw,
    appGzip,
    notesRaw,
    notesRouteRaw,
    notesRouteGzip,
    notesSources,
    dndKitSources,
    notesDndKitSources,
    notesDatePickerSources
  };
}

function run() {
  const distDirectory = resolve("dist");
  const manifest = JSON.parse(
    readFileSync(resolve(distDirectory, ".vite/manifest.json"), "utf8")
  );
  const files = {};
  for (const chunk of Object.values(manifest)) {
    if (chunk.file?.endsWith(".js") && files[chunk.file] === undefined) {
      files[chunk.file] = readFileSync(resolve(distDirectory, chunk.file));
    }
  }
  const appKey = appManifestKey(manifest);
  if (!appKey) {
    throw new Error("bundle manifest must contain src/App.tsx");
  }
  const appFile = manifest[appKey].file;
  const notesKey = notesManifestKey(manifest);
  if (!notesKey) {
    throw new Error("bundle manifest must contain NotesFeature.tsx");
  }
  const notesFile = manifest[notesKey].file;
  const sourceMaps = {
    [`${appFile}.map`]: JSON.parse(
      readFileSync(resolve(distDirectory, `${appFile}.map`), "utf8")
    ),
    [`${notesFile}.map`]: JSON.parse(
      readFileSync(resolve(distDirectory, `${notesFile}.map`), "utf8")
    )
  };
  const result = checkBundleBudget({ manifest, files, sourceMaps });

  console.log(
    `initial-js raw=${result.initialRaw}/${bundleBudgets.initialRaw} gzip=${result.initialGzip}/${bundleBudgets.initialGzip}`
  );
  console.log(
    `app-chunk raw=${result.appRaw}/<${bundleBudgets.appRawExclusive} gzip=${result.appGzip}/${bundleBudgets.appGzip}`
  );
  console.log(
    `app-map notes=${result.notesSources} dnd-kit=${result.dndKitSources}`
  );
  console.log(
    `notes-chunk raw=${result.notesRaw}/<${bundleBudgets.notesRawExclusive} dnd-kit=${result.notesDndKitSources} date-picker=${result.notesDatePickerSources}`
  );
  console.log(
    `notes-route raw=${result.notesRouteRaw}/${bundleBudgets.notesRouteRaw} gzip=${result.notesRouteGzip}/${bundleBudgets.notesRouteGzip}`
  );
  console.log("bundle budget PASS");
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
