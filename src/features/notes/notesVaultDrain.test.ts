import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireNotesVaultDrain,
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
    registerNotesVaultDrain("/vault-a", { drain: first, releaseDrain: vi.fn() });
    registerNotesVaultDrain("/vault-a", { drain: second, releaseDrain: vi.fn() });
    registerNotesVaultDrain("/vault-b", { drain: other, releaseDrain: vi.fn() });

    const lease = await acquireNotesVaultDrain("/vault-a");
    expect(lease).not.toBeNull();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    lease!.release();
  });

  it("reports an incomplete participant and propagates participant rejection", async () => {
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockResolvedValue(false),
      releaseDrain: vi.fn(),
    });
    await expect(acquireNotesVaultDrain("/vault")).resolves.toBeNull();

    resetNotesVaultDrainRegistryForTests();
    const failure = new Error("draft queue failed");
    registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockRejectedValue(failure),
      releaseDrain: vi.fn(),
    });
    await expect(acquireNotesVaultDrain("/vault")).rejects.toBe(failure);
  });

  it("shares one physical in-flight pass per Vault and unregisters by identity", async () => {
    const pending = deferred<boolean>();
    const participant = {
      drain: vi.fn(() => pending.promise),
      releaseDrain: vi.fn(),
    };
    const unregister = registerNotesVaultDrain("/vault", participant);

    const first = acquireNotesVaultDrain("/vault");
    const second = acquireNotesVaultDrain("/vault");

    expect(participant.drain).toHaveBeenCalledOnce();
    pending.resolve(true);
    const [firstLease, secondLease] = await Promise.all([first, second]);
    expect(firstLease).not.toBe(secondLease);
    firstLease!.release();
    secondLease!.release();

    unregister();
    const emptyLease = await acquireNotesVaultDrain("/vault");
    expect(emptyLease).toMatchObject({ generation: 0 });
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

    await expect(acquireNotesVaultDrain("/vault")).resolves.toBeNull();
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

    await expect(acquireNotesVaultDrain("/vault")).rejects.toBe(failure);
    expect(rejectionRelease).toHaveBeenCalledOnce();
    expect(siblingRelease).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight drain before returning its caller-owned lease", async () => {
    const pending = deferred<boolean>();
    const releaseDrain = vi.fn();
    registerNotesVaultDrain("/vault", {
      drain: vi.fn(() => pending.promise),
      releaseDrain,
    });

    const acquiring = acquireNotesVaultDrain("/vault");
    const settled = vi.fn();
    void acquiring.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(releaseDrain).not.toHaveBeenCalled();

    pending.resolve(true);
    const lease = await acquiring;
    expect(lease).not.toBeNull();
    lease!.release();
    expect(releaseDrain).toHaveBeenCalledOnce();
  });

  it("gives concurrent owners distinct leases and releases the physical lock only after both release", async () => {
    const pending = deferred<boolean>();
    const releaseDrain = vi.fn();
    const drain = vi.fn(() => pending.promise);
    registerNotesVaultDrain("/vault", { drain, releaseDrain });

    const firstLease = acquireNotesVaultDrain("/vault");
    const secondLease = acquireNotesVaultDrain("/vault");

    expect(drain).toHaveBeenCalledOnce();
    pending.resolve(true);
    const [first, second] = await Promise.all([firstLease, secondLease]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(first).toMatchObject({ vaultRoot: "/vault", generation: 1 });
    expect(second).toMatchObject({ vaultRoot: "/vault", generation: 1 });

    first!.release();
    first!.release();
    expect(releaseDrain).not.toHaveBeenCalled();
    second!.release();
    expect(releaseDrain).toHaveBeenCalledOnce();
  });

  it("does not let an old lease release a newer generation", async () => {
    const releaseDrain = vi.fn();
    const drain = vi.fn().mockResolvedValue(true);
    registerNotesVaultDrain("/vault", { drain, releaseDrain });

    const oldLease = await acquireNotesVaultDrain("/vault");
    oldLease!.release();
    const newLease = await acquireNotesVaultDrain("/vault");
    expect(drain).toHaveBeenCalledTimes(2);
    expect(newLease!.generation).toBe(2);

    oldLease!.release();
    expect(releaseDrain).toHaveBeenCalledOnce();
    newLease!.release();
    expect(releaseDrain).toHaveBeenCalledTimes(2);
  });

  it("keeps a committed generation locked until participant teardown", async () => {
    const releaseDrain = vi.fn();
    const unregister = registerNotesVaultDrain("/vault", {
      drain: vi.fn().mockResolvedValue(true),
      releaseDrain,
    });

    const lease = await acquireNotesVaultDrain("/vault");
    lease!.commit();
    lease!.commit();
    lease!.release();
    expect(releaseDrain).not.toHaveBeenCalled();

    unregister();
    await expect(acquireNotesVaultDrain("/vault")).resolves.toMatchObject({
      vaultRoot: "/vault",
    });
    expect(releaseDrain).not.toHaveBeenCalled();
  });
});
