# Yonalist

Yonalist is an offline-first GitHub inbox prototype for reading and queueing work
on issues and pull requests from a local Markdown vault.

## Current V1 Slice

- Tauri + React + TypeScript desktop app scaffold.
- Three-column UI: navigation, item list, and detail/comment pane.
- Markdown + YAML Front Matter domain model for items, comments, outbox
  operations, favorites, attachment manifests, and vault indexing.
- One-comment-per-file path strategy under
  `<vault>/<host>/<owner>/<repo>/<issues|pulls>/<number>/comments/`.
- Local-only favorite metadata with a red bookmark affordance.
- Offline badge and offline queue support for issue/comment drafts.
- Outbox review modal shown when queued work exists and the app comes back
  online.
- GitHub REST/OAuth client helpers for host-specific API and web base URLs.
- Tauri command boundary for vault folder creation, text file read/write, and
  token storage/loading through the OS keychain.

## Commands

```bash
npm install
npm test
npm run build
npm run dev
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:dev
```

The local web preview runs at `http://127.0.0.1:1420/`.
