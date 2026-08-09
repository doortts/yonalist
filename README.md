# Yonalist

Yonalist is a local-first outliner for organizing notes in a local vault.

## Current V1 Slice

- Yonalist outline editing and Notes SQLite storage.
- Yonalist Markdown and attachment synchronization.
- GN as a bundled external-source plugin.
- GitHub server/authentication settings.
- GN desktop notifications.
- Local-first Notes editing with nested outlines, zoom, drag, search, tags,
  Trash restore, and local Markdown or PDF export.
- Light, dark, and system theme modes.

GitHub authentication supports configured servers, OAuth where available, and
personal access tokens. GN uses that configuration only when its external-source
plugin is enabled; Yonalist editing and local storage do not depend on GitHub.

For the removed architecture and its reconstruction record, see [the 2026-07-27
design document](docs/superpowers/specs/2026-07-27-github-inbox-removal-and-yonalist-boundary-design.md).

## Commands

Yonalist requires Rust 1.88 or later. `npm run tauri:dev` and
`npm run tauri:build` use the repository-pinned rustup toolchain when rustup
is installed.

`npm run tauri:dev` starts the current desktop app in `apps/desktop`, whose
outline editor is the Monaco surface. Its web preview runs at
`http://127.0.0.1:1421/`.

```bash
npm install
npm run test:v2
npm run tauri:dev
```

The v1 application in the repository root keeps its own launcher:

```bash
npm install
npm test
npm run build
npm run dev
cargo test --manifest-path src-tauri/Cargo.toml
npm run legacy:tauri:dev
```

The v1 web preview runs at `http://127.0.0.1:1420/`.
