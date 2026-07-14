# Yonalist

Yonalist is an offline-first GitHub inbox prototype for reading and queueing work
on issues and pull requests from a local Markdown vault.

## Current V1 Slice

- Tauri + React + TypeScript desktop app scaffold.
- Built-in local-only Notes workspace that works independently of GitHub auth
  and has no cloud or remote sync path. Notes user data is stored in the selected
  vault's `.yonalist/notes.sqlite` file; resetting app settings and caches
  preserves it, while deleting all Notes data is a separate Notes-specific
  confirmed action.
- Workflowy-style local Notes outliner with inline wrapping titles and notes,
  unlimited nesting, expand/collapse arrows, bullet zoom and drag, hierarchy
  guides, precise drop targets, breadcrumbs, completion filtering, starring,
  duplication, deletion, failed-draft retry, search, tags, and Trash restore.
- Notes title shortcuts: `Enter` splits a node, `Tab` indents,
  `Shift+Tab` outdents, boundary arrow keys navigate or expand/collapse, and
  empty `Backspace` removes a safe empty node. `Shift+Enter` opens the
  supporting note; `Ctrl/Cmd+Enter` completes; `Alt+Shift+D` on Windows/Linux
  or `Cmd+Shift+D` on macOS duplicates; `Ctrl+Shift+Backspace` on
  Windows/Linux or `Cmd+Shift+Backspace` on macOS deletes. IME composition is
  left untouched by structural shortcuts.
- Local Notes export saves either the selected node subtree or the current
  zoomed page as frontmatter Markdown or a semantic PDF. Current-page export
  is unavailable while viewing all notes, and replacing an existing destination
  always requires explicit confirmation. Export writes local files only and
  does not publish or synchronize Notes content.
- Notes PDFs bundle Nanum Gothic Regular for Korean text under the SIL Open Font
  License 1.1. The font and license are unmodified copies from the official
  Google Fonts repository; exact source URLs and checksums are recorded in
  `src-tauri/resources/FONT_SOURCE.md`. If a title or note contains a glyph the
  bundled font cannot render, export reports a retryable error and does not
  create or replace the destination.
- Three-column UI (navigation, item list, detail/comment pane) with
  resizable panes, independently scrolling columns, and a token-based
  design system.
- Signed-in inbox tabs backed by the GitHub API: All/Favorites/Issues/
  Pull requests/Discussions over an involves:@me search (discussions via
  GraphQL), with locally persisted favorites.
- Projects section grouped by owner, showing repositories the user
  participates in (owner/collaborator), watches, or has inbox activity
  in by default; org-membership-only repositories can be enabled with
  per-owner/per-repository checkboxes in Settings. Selecting a project
  gathers that repository's issues, pull requests, and discussions into
  the list.
- Light/dark/system theme modes selectable from Settings.
- Auth-first startup: the app assumes the last authenticated host and
  verifies its stored credentials; on failure or first run a login page
  (host picker + OAuth/token sign-in, skippable into sample data) is the
  start screen. After the gate the notifications inbox is the landing
  view.
- Two-column settings: the middle column lists setting categories
  (Appearance, GitHub 서버, Projects 표시, Vault and sync) and the
  detail column shows only the selected one.
- GitHub authentication mirrored from the Flutter github_client: a
  configurable server list (built-in Naver GHE / Naver Labs GHE / Github
  entries plus custom URLs with aliases), per-server auth method — OAuth
  authorization-code login through a loopback localhost redirect for
  servers with registered OAuth Apps, or a per-server personal access
  token that skips OAuth — and re-login on server switch.
- GitHub notifications inbox: 60s polling with If-Modified-Since caching,
  date-grouped list, reason-based icons/colors, unread badges, only-new
  filter, hide/unhide, search, and open-in-browser with local viewed
  tracking. Sample data is shown until a personal access token is set.
- Markdown + YAML Front Matter domain model for items, comments, outbox
  operations, favorites, attachment manifests, and vault indexing.
- Queued issue/comment drafts are written as Markdown documents in the selected
  vault, outbox operation files are restored on startup, and successful issue
  sync moves draft files to their remote issue-number paths.
- One-comment-per-file path strategy under
  `<vault>/<host>/<owner>/<repo>/<issues|pulls>/<number>/comments/`.
- Local-only favorite metadata with a red bookmark affordance.
- Offline badge, browser online/offline tracking, and an offline queue for
  issue/comment drafts.
- Outbox review modal shown when queued work exists and the app comes back
  online; queued operations sync through the GitHub REST client when a
  personal access token is configured.
- GitHub REST/OAuth client helpers for host-specific API and web base URLs.
- Tauri command boundary for vault folder creation, vault-scoped atomic
  text file read/write, Markdown file listing, deletion, and moves. Personal
  token storage remains in the current per-server settings store; OS keychain
  migration is intentionally deferred.

## Commands

Yonalist requires Rust 1.88 or later. `npm run tauri:dev` and
`npm run tauri:build` use the repository-pinned rustup toolchain when rustup
is installed.

```bash
npm install
npm test
npm run build
npm run dev
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:dev
```

The local web preview runs at `http://127.0.0.1:1420/`.
