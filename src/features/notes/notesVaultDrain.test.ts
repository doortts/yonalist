import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainNotesVault,
  registerNotesVaultDrain,
  releaseNotesVaultDrain,
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
    registerNotesVaultDrain("/vault-a", { drain: first, releaseDrain: vi.fn() });
    registerNotesVaultDrain("/vault-a", { drain: second, releaseDrain: vi.fn() });
    registerNotesVaultDrain("/vault-b", { drain: other, releaseDrain: vi.fn() });

    await expect(drainNotesVault("/vault-a")).resolves.toBe(true);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("reports an incomplete participant and propagates participant rejection", async () => {
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockResolvedValue(false),
      releaseDrain: vi.fn(),
    });
    await expect(drainNotesVault("/vault")).resolves.toBe(false);

    resetNotesVaultDrainRegistryForTests();
    const failure = new Error("draft queue failed");
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockRejectedValue(failure),
      releaseDrain: vi.fn(),
    });
    await expect(drainNotesVault("/vault")).rejects.toBe(failure);
  });

  it("shares one in-flight pass per Vault and unregisters by identity", async () => {
    const pending = deferred<boolean>();
    const participant = {
      drain: vi.fn(() => pending.promise),
      releaseDrain: vi.fn(),
    };
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

  it("releases every participant when one drain is incomplete or rejects", async () => {
    const successfulRelease = vi.fn();
    const failedRelease = vi.fn();
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockResolvedValue(true),
      releaseDrain: successfulRelease,
    });
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockResolvedValue(false),
      releaseDrain: failedRelease,
    });

    await expect(drainNotesVault("/vault")).resolves.toBe(false);
    expect(successfulRelease).toHaveBeenCalledOnce();
    expect(failedRelease).toHaveBeenCalledOnce();

    resetNotesVaultDrainRegistryForTests();
    const rejectionRelease = vi.fn();
    const siblingRelease = vi.fn();
    const failure = new Error("queue failed");
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockRejectedValue(failure),
      releaseDrain: rejectionRelease,
    });
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockResolvedValue(true),
      releaseDrain: siblingRelease,
    });

    await expect(drainNotesVault("/vault")).rejects.toBe(failure);
    expect(rejectionRelease).toHaveBeenCalledOnce();
    expect(siblingRelease).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight drain before explicitly releasing its participants", async () => {
    const pending = deferred<boolean>();
    const releaseDrain = vi.fn();
    registerNotesVaultDrain("/vault", {
      drain: vi.fn(() => pending.promise),
      releaseDrain,
    });

    const drain = drainNotesVault("/vault");
    const release = releaseNotesVaultDrain("/vault");
    await Promise.resolve();
    expect(releaseDrain).not.toHaveBeenCalled();

    pending.resolve(true);
    await expect(drain).resolves.toBe(true);
    await release;
    expect(releaseDrain).toHaveBeenCalledOnce();
  });
});
