# Tell the user to keep an iCloud vault downloaded

## Why

Optimize Mac Storage evicts vault files; since macOS 14 an evicted file keeps
its name and size and holds no bytes. The app now survives that (read-is-fetch,
`2a871f61`/`b8066dd9`), but surviving costs blocking fetches and delayed
writes, and eviction while the app is closed is what produced iCloud's bounced
copies in the first place. There is no API for a third-party app to pin files
as downloaded — the industry answer (Obsidian ships exactly this, verbatim
"Keep Downloaded" instructions in its bundle, and its help docs say the same)
is to tell the user once, in settings, next to the folder choice.

## Contract

| Field | Content |
| --- | --- |
| Goal | A user whose vault sits in iCloud Drive is told, in the settings screen's sync-folder section, to keep the folder downloaded — and a user whose vault is anywhere else never sees it. |
| Acceptance | A1: with a vault path under iCloud Drive (any path containing `Mobile Documents`), the sync-folder section shows the advisory. A2: with a local path (or no path yet), it does not. A3: the advisory names both gestures: Finder's "Keep Downloaded" on the vault folder, and turning off "Optimize Mac Storage" in iCloud settings (the macOS 14-and-earlier fallback). |
| Non-goals | No detection of whether files are actually evicted (no IPC, no new Rust). No dismissal state, no banner elsewhere, no links. |
| Boundaries | Frontend only: `apps/desktop/src/SettingsView.tsx` and its test. |
| Manual proof | Settings screen on this machine (vault is in iCloud Drive) shows the advisory under the folder path. |

## Item (one commit)

In `SettingsView.tsx`'s `SyncFolderSection`, when the loaded `path` contains
`Mobile Documents`, render a short informational paragraph under the path:

> This folder is in iCloud Drive. To keep sync reliable, right-click it in
> Finder and choose "Keep Downloaded". On macOS 14 or earlier, turn off
> "Optimize Mac Storage" in iCloud settings instead — otherwise macOS may
> remove the local copies of your notes and they will have to be re-downloaded
> before they can sync.

Match the section's existing tone and element classes — read the neighbouring
hint/description elements and reuse their styling; do not invent a new visual
component. `Mobile Documents` is the whole test: it is the mount point of every
iCloud container (`com~apple~CloudDocs` and app containers alike), and no
sane local vault path contains it.

Test first (`SettingsView.test.tsx`, existing scaffolding): A1 with a path like
`/Users/x/Library/Mobile Documents/com~apple~CloudDocs/vault`, A2 with
`/Users/x/notes` and with the unset-path state. Red before the change.

## Gates

Frontend-only: the owning test during the loop; then `npm test`,
`npm run lint`, `npm run build`, `git diff --check` once at the end. Cargo
gates skipped — no Rust change.
