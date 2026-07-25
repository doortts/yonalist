import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainNotesVault,
  registerNotesVaultDrain,
  resetNotesVaultDrainRegistryForTests,
} from "./notesVaultDrain";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("notesVaultDrain", () => {
  afterEach(() => {
    resetNotesVaultDrainRegistryForTests();
  });

  it("drains only the participants registered for the requested Vault", async () => {
    const first = vi.fn().mockResolvedValue(true);
    const second = vi.fn().mockResolvedValue(true);
    const other = vi.fn().mockResolvedValue(true);
    registerNotesVaultDrain("/vault-a", { drain: first });
    registerNotesVaultDrain("/vault-a", { drain: second });
    registerNotesVaultDrain("/vault-b", { drain: other });

    await expect(drainNotesVault("/vault-a")).resolves.toBe(true);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("reports an incomplete participant and propagates participant rejection", async () => {
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockResolvedValue(false),
    });
    await expect(drainNotesVault("/vault")).resolves.toBe(false);

    resetNotesVaultDrainRegistryForTests();
    const failure = new Error("draft queue failed");
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockRejectedValue(failure),
    });
    await expect(drainNotesVault("/vault")).rejects.toBe(failure);
  });

  it("shares one in-flight pass per Vault and unregisters by identity", async () => {
    const pending = deferred<boolean>();
    const participant = { drain: vi.fn(() => pending.promise) };
    const unregister = registerNotesVaultDrain("/vault", participant);

    const first = drainNotesVault("/vault");
    const second = drainNotesVault("/vault");

    expect(second).toBe(first);
    expect(participant.drain).toHaveBeenCalledOnce();
    pending.resolve(true);
    await expect(first).resolves.toBe(true);

    unregister();
    await expect(drainNotesVault("/vault")).resolves.toBe(true);
    expect(participant.drain).toHaveBeenCalledOnce();
  });
});
