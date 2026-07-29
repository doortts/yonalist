import { describe, expect, it, vi } from "vitest";
import {
  ImageResidency,
  type ResidentImageIdentity
} from "./imageResidency";

function image(index: number, hash = `${index}`.repeat(64)): ResidentImageIdentity {
  return {
    nodeId: `image-${index}`,
    contentHash: hash.slice(0, 64).padEnd(64, "0"),
    mimeType: "image/png"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("ImageResidency", () => {
  it("shares reads and keeps only the newest eight object URLs", async () => {
    const read = vi.fn(async (nodeId: string) =>
      Uint8Array.from([Number(nodeId.split("-")[1])]));
    let nextUrl = 0;
    const createObjectURL = vi.fn(() => `blob:${++nextUrl}`);
    const revokeObjectURL = vi.fn();
    const residency = new ImageResidency(read, {
      createObjectURL,
      revokeObjectURL,
      maximumUrls: 8
    });

    const firstRelease = residency.activate(image(0));
    const duplicateRelease = residency.activate(image(0));
    await vi.waitFor(() =>
      expect(residency.getSnapshot(image(0)).status).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);
    firstRelease();
    duplicateRelease();

    for (let index = 1; index < 9; index += 1) {
      const release = residency.activate(image(index));
      await vi.waitFor(() =>
        expect(residency.getSnapshot(image(index)).status).toBe("ready"));
      release();
    }

    expect(createObjectURL).toHaveBeenCalledTimes(9);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(residency.getSnapshot(image(0))).toEqual({ status: "idle" });
  });

  it("does not read until activated and replacement revokes the old URL", async () => {
    const read = vi.fn(async () => Uint8Array.from([1]));
    const revokeObjectURL = vi.fn();
    const residency = new ImageResidency(read, {
      createObjectURL: vi.fn()
        .mockReturnValueOnce("blob:old")
        .mockReturnValueOnce("blob:new"),
      revokeObjectURL,
      maximumUrls: 8
    });
    const original = image(1, "a".repeat(64));
    const replacement = image(1, "b".repeat(64));

    const unsubscribe = residency.subscribe(original, vi.fn());
    expect(read).not.toHaveBeenCalled();
    const release = residency.activate(original);
    await vi.waitFor(() =>
      expect(residency.getSnapshot(original).status).toBe("ready"));
    release();

    residency.getSnapshot(replacement);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:old");
    expect(residency.getSnapshot(replacement)).toEqual({ status: "idle" });
    unsubscribe();
  });

  it("ignores late abandoned reads and dispose revokes every live URL", async () => {
    const pending = deferred<Uint8Array>();
    const read = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Uint8Array.from([2]));
    const revokeObjectURL = vi.fn();
    const residency = new ImageResidency(read, {
      createObjectURL: vi.fn(() => "blob:live"),
      revokeObjectURL,
      maximumUrls: 8
    });

    const releaseAbandoned = residency.activate(image(1));
    releaseAbandoned();
    pending.resolve(Uint8Array.from([1]));
    await Promise.resolve();
    await Promise.resolve();
    expect(residency.getSnapshot(image(1))).toEqual({ status: "idle" });

    residency.activate(image(2));
    await vi.waitFor(() =>
      expect(residency.getSnapshot(image(2)).status).toBe("ready"));
    residency.dispose();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(residency.getSnapshot(image(2))).toEqual({ status: "idle" });
  });
});
