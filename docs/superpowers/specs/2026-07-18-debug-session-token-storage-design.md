# Debug Session Token Storage Design

**Status:** Approved for implementation

## Goal

Stop macOS Keychain authorization prompts during `tauri dev` and
`tauri build --debug`, while retaining Keychain-backed GitHub OAuth session
tokens in release builds.

## Current Behavior

The desktop session-token path writes an OAuth token to the operating-system
Keychain and then mirrors the same token into WebView `localStorage`. Startup
asks the native keyring for the token and falls back to the web copy if the
keyring is locked or unavailable.

The debug executable is linker/ad-hoc signed and has no stable designated code
requirement. Its identity changes after rebuilding, so macOS repeatedly asks
whether each new executable may read the `Yonalist GitHub` Keychain item.

## Selected Approach

Choose the token backend from the Rust build profile at runtime:

- Rust debug builds (`cfg!(debug_assertions)`) report `web` storage.
- Rust release builds report `keychain` storage.
- Browser builds continue to use `localStorage`.

A small read-only Tauri command exposes this choice. The TypeScript session
token service checks it before invoking any native keyring command. This works
for both hot development and bundled debug apps; it does not rely on Vite's
mode, which is production-like during `tauri build --debug`.

## Storage Contract

### Debug Tauri and browser

- Save, load, and clear tokens only in the existing
  `yonalist.github.sessionTokens.v1` `localStorage` record.
- Never invoke `store_token`, `load_token`, or `delete_token`.
- Preserve automatic sign-in after restarting a debug app.

### Release Tauri

- Save new tokens to Keychain and remove their web-storage copy after success.
- Load Keychain first.
- If a legacy web token exists while Keychain has no entry, migrate it to
  Keychain once and remove the web copy after success.
- If a legacy migration cannot reach Keychain, retain and return the web token
  so an existing signed-in user is not unexpectedly logged out; retry migration
  on a later launch.
- Clear both stores so old development or migration data cannot revive a
  logged-out session.

## Security

Debug tokens remain readable from the user's WebView storage on disk. This is
an explicit development trade-off to eliminate Keychain prompts from unstable
debug executables. Release tokens remain protected by the OS Keychain.

No token, signing identity, certificate, or Apple credential is added to the
repository. The existing `keyring` Rust dependency remains because release
builds still use it.

## Testing

Follow RED/GREEN coverage:

1. Native tests assert that debug builds report `web` storage.
2. Tauri frontend tests assert that the `web` backend never calls native token
   commands and persists through `localStorage`.
3. Release-backend frontend tests assert Keychain save/load/delete routing,
   removal of web copies, and one-time legacy migration.
4. Browser fallback tests remain unchanged.
5. Run focused TypeScript/Rust tests, the full frontend suite, lint, production
   build, `cargo test`, and `git diff --check`.

## Out of Scope

- Notarization, Developer ID certificates, or distribution signing.
- Encrypting debug `localStorage`.
- Changing GitHub OAuth scopes or token lifetime.
- Moving personal access tokens from the separate GitHub server settings.
