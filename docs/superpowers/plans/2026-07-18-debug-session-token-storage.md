# Debug Session Token Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep GitHub OAuth session tokens in `localStorage` for debug/browser builds without touching macOS Keychain, while release Tauri builds use Keychain and migrate the legacy web copy.

**Architecture:** Rust exposes one read-only command whose result is derived from `cfg!(debug_assertions)`. The existing TypeScript session-token service asks for that backend before routing save/load/clear operations; no new storage abstraction or dependency is introduced.

**Tech Stack:** Rust, Tauri 2, TypeScript 6, Vitest, browser `localStorage`, Rust `keyring`

## Global Constraints

- `tauri dev` and `tauri build --debug` must never invoke `store_token`, `load_token`, or `delete_token`.
- Release Tauri builds must continue using the `Yonalist GitHub` Keychain service.
- Browser builds must continue using `yonalist.github.sessionTokens.v1` in `localStorage`.
- Release migration must remove a legacy web token only after Keychain storage succeeds.
- No signing identity, Apple credential, token, encryption layer, or dependency may be added.

---

## File Structure

- `src-tauri/src/lib.rs`: report the build-profile-selected token backend and register its Tauri command.
- `src-tauri/build.rs`: include the new command in the generated Tauri application manifest.
- `src/services/sessionTokens.ts`: route the existing public save/load/clear API to web or Keychain storage.
- `src/services/sessionTokens.tauri.test.ts`: prove debug routing, release routing, cleanup, and migration behavior with the existing Tauri invoke mock.
- `src/services/sessionTokens.test.ts`: retain browser-storage regression coverage and update its stale comment.

### Task 1: Expose the Rust-selected storage backend

**Files:**
- Modify: `src-tauri/src/lib.rs:1430-1458`
- Modify: `src-tauri/src/lib.rs:1525-1546`
- Modify: `src-tauri/src/lib.rs:1609-1692`
- Modify: `src-tauri/build.rs:1-25`

**Interfaces:**
- Consumes: Rust `cfg!(debug_assertions)`.
- Produces: Tauri command `session_token_storage_backend() -> &'static str`, returning exactly `"web"` or `"keychain"`.

- [ ] **Step 1: Write the failing native test**

Add this test inside `src-tauri/src/lib.rs`'s existing `#[cfg(test)] mod tests`:

```rust
#[cfg(debug_assertions)]
#[test]
fn debug_build_uses_web_session_token_storage() {
    assert_eq!(session_token_storage_backend(), "web");
}
```

- [ ] **Step 2: Run the native test to verify it fails**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml debug_build_uses_web_session_token_storage
```

Expected: compilation fails because `session_token_storage_backend` does not exist.

- [ ] **Step 3: Add the minimal command and register it**

Add next to the three existing token commands in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn session_token_storage_backend() -> &'static str {
    if cfg!(debug_assertions) {
        "web"
    } else {
        "keychain"
    }
}
```

Add `session_token_storage_backend,` immediately before `store_token,` in the `tauri::generate_handler!` list, and add `"session_token_storage_backend",` immediately before `"store_token",` in `src-tauri/build.rs`'s `APP_COMMANDS` list. This keeps the existing command-manifest parity test valid.

- [ ] **Step 4: Run focused and command-manifest tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml debug_build_uses_web_session_token_storage
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once
```

Expected: both commands exit 0; the focused test reports one pass and the existing command registration/manifest tests report all passes.

- [ ] **Step 5: Commit the native boundary**

```bash
git add src-tauri/src/lib.rs src-tauri/build.rs
git commit -m "feat(auth): report session token storage backend"
```

### Task 2: Route session-token operations by backend

**Files:**
- Modify: `src/services/sessionTokens.ts:1-112`
- Modify: `src/services/sessionTokens.tauri.test.ts:1-91`
- Modify: `src/services/sessionTokens.test.ts:10-13`

**Interfaces:**
- Consumes: `invoke<SessionTokenBackend>("session_token_storage_backend")` from Task 1.
- Produces: unchanged public functions `saveSessionToken(url, token)`, `loadSessionToken(url)`, and `clearSessionToken(url)`.

- [ ] **Step 1: Replace stale Tauri cache tests with failing backend-routing tests**

Keep the existing mocks and `storedTokens()` helper, then make `invokeMock` return by command:

```ts
type Backend = "web" | "keychain";

function useBackend(backend: Backend) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "session_token_storage_backend") return backend;
    return undefined;
  });
}

function nativeTokenCommands(): string[] {
  return invokeMock.mock.calls
    .map(([command]) => String(command))
    .filter((command) =>
      ["store_token", "load_token", "delete_token"].includes(command)
    );
}
```

Add these cases to `src/services/sessionTokens.tauri.test.ts`:

```ts
it("uses only localStorage for a debug Tauri backend", async () => {
  useBackend("web");
  await saveSessionToken(URL, "gho_debug");
  await expect(loadSessionToken(URL)).resolves.toBe("gho_debug");
  await clearSessionToken(URL);
  expect(nativeTokenCommands()).toEqual([]);
  expect(storedTokens()[URL]).toBeUndefined();
});

it("stores release tokens only in Keychain", async () => {
  useBackend("keychain");
  await saveSessionToken(URL, "gho_release");
  expect(invokeMock).toHaveBeenCalledWith("store_token", {
    service: "Yonalist GitHub",
    account: URL,
    token: "gho_release"
  });
  expect(storedTokens()[URL]).toBeUndefined();
});

it("migrates a legacy web token after an empty Keychain load", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ [URL]: "gho_legacy" })
  );
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "session_token_storage_backend") return "keychain";
    if (command === "load_token") return null;
    return undefined;
  });
  await expect(loadSessionToken(URL)).resolves.toBe("gho_legacy");
  expect(invokeMock).toHaveBeenCalledWith("store_token", {
    service: "Yonalist GitHub",
    account: URL,
    token: "gho_legacy"
  });
  expect(storedTokens()[URL]).toBeUndefined();
});

it("prefers a release Keychain token and removes its legacy web copy", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ [URL]: "gho_legacy" })
  );
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "session_token_storage_backend") return "keychain";
    if (command === "load_token") return "gho_keychain";
    return undefined;
  });
  await expect(loadSessionToken(URL)).resolves.toBe("gho_keychain");
  expect(storedTokens()[URL]).toBeUndefined();
  expect(invokeMock).not.toHaveBeenCalledWith(
    "store_token",
    expect.anything()
  );
});

it("retains a legacy token when migration cannot store it", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ [URL]: "gho_legacy" })
  );
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "session_token_storage_backend") return "keychain";
    if (command === "load_token") return null;
    if (command === "store_token") throw new Error("keychain locked");
    return undefined;
  });
  await expect(loadSessionToken(URL)).resolves.toBe("gho_legacy");
  expect(storedTokens()[URL]).toBe("gho_legacy");
});

it("clears release tokens from both stores", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ [URL]: "gho_legacy" })
  );
  useBackend("keychain");
  await clearSessionToken(URL);
  expect(invokeMock).toHaveBeenCalledWith("delete_token", {
    service: "Yonalist GitHub",
    account: URL
  });
  expect(storedTokens()[URL]).toBeUndefined();
});
```

- [ ] **Step 2: Run the Tauri service tests to verify they fail**

Run:

```bash
npm test -- src/services/sessionTokens.tauri.test.ts
```

Expected: failures show debug operations still calling native token commands, release saves still leaving a web copy, and migration not invoking `store_token`.

- [ ] **Step 3: Implement backend routing in the existing service**

Add the backend type and selector near the constants in `src/services/sessionTokens.ts`:

```ts
type SessionTokenBackend = "web" | "keychain";

async function sessionTokenBackend(): Promise<SessionTokenBackend> {
  if (!isTauri()) return "web";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SessionTokenBackend>("session_token_storage_backend");
}

function removeWebToken(url: string): void {
  const tokens = loadWebTokens();
  delete tokens[url];
  persistWebTokens(tokens);
}
```

Route the public functions with these exact rules:

```ts
export async function saveSessionToken(url: string, token: string): Promise<void> {
  const normalized = normalize(token);
  if (!normalized) {
    await clearSessionToken(url);
    return;
  }
  if ((await sessionTokenBackend()) === "web") {
    persistWebTokens({ ...loadWebTokens(), [url]: normalized });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("store_token", {
    service: KEYCHAIN_SERVICE,
    account: url,
    token: normalized
  });
  removeWebToken(url);
}

export async function loadSessionToken(url: string): Promise<string | null> {
  const webToken = normalize(loadWebTokens()[url]);
  if ((await sessionTokenBackend()) === "web") return webToken;

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const keychainToken = normalize(
      await invoke<string | null>("load_token", {
        service: KEYCHAIN_SERVICE,
        account: url
      })
    );
    if (keychainToken) {
      removeWebToken(url);
      return keychainToken;
    }
    if (!webToken) return null;
    try {
      await invoke("store_token", {
        service: KEYCHAIN_SERVICE,
        account: url,
        token: webToken
      });
      removeWebToken(url);
    } catch {
      // Keep the legacy copy and retry migration on a later launch.
    }
    return webToken;
  } catch {
    return webToken;
  }
}

export async function clearSessionToken(url: string): Promise<void> {
  removeWebToken(url);
  if ((await sessionTokenBackend()) === "web") return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("delete_token", {
      service: KEYCHAIN_SERVICE,
      account: url
    });
  } catch {
    // Logout still clears the active and web-stored session.
  }
}
```

Update the comment in `src/services/sessionTokens.test.ts` to say these tests cover browser web storage; do not claim all Tauri calls use Keychain.

- [ ] **Step 4: Run focused frontend tests**

Run:

```bash
npm test -- src/services/sessionTokens.test.ts src/services/sessionTokens.tauri.test.ts src/hooks/useGithubAuth.test.tsx src/hooks/useAuthGate.test.tsx src/services/appReset.test.ts
```

Expected: all selected Vitest files pass; the debug Tauri test observes no native token commands.

- [ ] **Step 5: Commit the frontend routing**

```bash
git add src/services/sessionTokens.ts src/services/sessionTokens.test.ts src/services/sessionTokens.tauri.test.ts
git commit -m "fix(auth): skip keychain in debug builds"
```

### Task 3: Verify the complete token-storage change

**Files:**
- Verify only: all files changed in Tasks 1-2.

**Interfaces:**
- Consumes: the Rust backend command and unchanged TypeScript public API.
- Produces: a verified debug-web/release-Keychain storage boundary.

- [ ] **Step 1: Run all native tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: exit 0 with no failed Rust tests.

- [ ] **Step 2: Run all frontend checks**

```bash
npm test
npm run lint
npm run build
```

Expected: every command exits 0; Vitest has no failed tests, ESLint reports no errors, and Vite produces `dist/`.

- [ ] **Step 3: Check the final diff**

```bash
git diff --check
git status --short
```

Expected: `git diff --check` prints nothing; status contains only the separately tracked plan/spec status changes if they have not yet been committed.
