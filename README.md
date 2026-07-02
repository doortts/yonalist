# Yonalist

Yonalist is an offline-first GitHub inbox prototype for reading and queueing work
on issues and pull requests from a local Markdown vault.

## Current V1 Slice

- Tauri + React + TypeScript desktop app scaffold.
- Three-column UI (navigation, item list, detail/comment pane) with
  resizable panes, independently scrolling columns, and a token-based
  design system.
- Signed-in inbox tabs backed by the GitHub API: All/Favorites/Issues/
  Pull requests/Discussions over an involves:@me search (discussions via
  GraphQL), with locally persisted favorites.
- Projects section listing the user's repositories grouped by owner;
  selecting one gathers that repository's issues, pull requests, and
  discussions into the list.
- Light/dark/system theme modes selectable from Settings.
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
  text file read/write, and token storage/loading through the OS keychain.

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
