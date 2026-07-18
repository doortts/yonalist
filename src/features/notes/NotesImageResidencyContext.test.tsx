import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  NotesImageResidencyProvider,
  useNotesImageByteLease,
  useNotesImageResidencyLease,
  type NotesImageByteLease
} from "./NotesImageResidencyContext";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function LeaseProbe({
  id,
  renderCounts
}: {
  readonly id: number;
  readonly renderCounts?: Map<number, number>;
}) {
  const lease = useNotesImageResidencyLease();
  renderCounts?.set(id, (renderCounts.get(id) ?? 0) + 1);

  return (
    <div>
      <button type="button" onClick={lease.activate}>
        Activate {id}
      </button>
      <button type="button" onClick={lease.deactivate}>
        Deactivate {id}
      </button>
      <output data-testid={`lease-${id}`}>
        {lease.active ? "resident" : "dormant"}
      </output>
    </div>
  );
}

function AutoActivateProbe({ id }: { readonly id: number }) {
  const { active, activate } = useNotesImageResidencyLease();
  useEffect(() => activate(), [activate]);
  return (
    <output data-testid={`auto-lease-${id}`}>
      {active ? "resident" : "dormant"}
    </output>
  );
}

function ByteLeaseProbe({
  attachmentId,
  load,
  name = attachmentId
}: {
  readonly attachmentId: string;
  readonly load: () => Promise<Uint8Array>;
  readonly name?: string;
}) {
  const lease = useNotesImageByteLease();
  const [value, setValue] = useState<string>("none");
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void lease
            .prewarm(attachmentId, load)
            .then((bytes) => setValue(bytes ? String(bytes[0]) : "empty"))
            .catch(() => setValue("failed"));
        }}
      >
        Prewarm {name}
      </button>
      <button type="button" onClick={() => lease.release(attachmentId)}>
        Release {name}
      </button>
      <output data-testid={`bytes-${name}`}>{value}</output>
      <output data-testid={`cached-${name}`}>
        {lease.read(attachmentId)?.[0] ?? "none"}
      </output>
    </div>
  );
}

function RenderCountByteLeaseProbe({
  attachmentId,
  load,
  renderCount
}: {
  readonly attachmentId: string;
  readonly load: () => Promise<Uint8Array>;
  readonly renderCount: { value: number };
}) {
  const lease = useNotesImageByteLease();
  renderCount.value += 1;
  return (
    <button
      type="button"
      onClick={() => {
        void lease.prewarm(attachmentId, load).catch(() => undefined);
      }}
    >
      Prewarm render count
    </button>
  );
}

function RetainedByteLeaseProbe({
  retain
}: {
  readonly retain: (lease: NotesImageByteLease) => void;
}) {
  const lease = useNotesImageByteLease();
  useEffect(() => retain(lease), [lease, retain]);
  return null;
}

type MixedImageKind = "legacy-attachment" | "image-node";

function MixedObjectUrlProbe({
  activeUrls,
  autoActivate,
  createdBlobs,
  id,
  kind,
  maxActiveUrls
}: {
  readonly activeUrls: Set<string>;
  readonly autoActivate?: boolean;
  readonly createdBlobs: Blob[];
  readonly id: number;
  readonly kind: MixedImageKind;
  readonly maxActiveUrls: { value: number };
}) {
  const { active, activate, deactivate } = useNotesImageResidencyLease();
  useEffect(() => {
    if (autoActivate) activate();
  }, [activate, autoActivate]);
  useEffect(() => {
    if (!active) return;

    const blob = new Blob([new Uint8Array([id & 255])], {
      type: "image/png"
    });
    createdBlobs.push(blob);
    const objectUrl = URL.createObjectURL(blob);
    activeUrls.add(objectUrl);
    maxActiveUrls.value = Math.max(maxActiveUrls.value, activeUrls.size);
    return () => {
      activeUrls.delete(objectUrl);
      URL.revokeObjectURL(objectUrl);
    };
  }, [active, activeUrls, createdBlobs, id, maxActiveUrls]);

  return (
    <div>
      <button type="button" onClick={activate}>
        Activate {kind} {id}
      </button>
      <button type="button" onClick={deactivate}>
        Deactivate {kind} {id}
      </button>
      <output data-testid={`mixed-${id}`}>
        {kind}: {active ? "resident" : "dormant"}
      </output>
    </div>
  );
}

describe("NotesImageResidencyProvider", () => {
  it("grants at most eight leases and evicts the least recently activated", () => {
    render(
      <NotesImageResidencyProvider scopeKey="vault-1">
        {Array.from({ length: 10 }, (_, index) => (
          <LeaseProbe id={index + 1} key={index + 1} />
        ))}
      </NotesImageResidencyProvider>
    );

    for (let id = 1; id <= 8; id += 1) {
      fireEvent.click(screen.getByRole("button", { name: `Activate ${id}` }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Activate 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate 9" }));

    expect(screen.getAllByText("resident")).toHaveLength(8);
    expect(screen.getByTestId("lease-1")).toHaveTextContent("resident");
    expect(screen.getByTestId("lease-2")).toHaveTextContent("dormant");
    expect(screen.getByTestId("lease-9")).toHaveTextContent("resident");

    fireEvent.click(screen.getByRole("button", { name: "Deactivate 1" }));
    expect(screen.getAllByText("resident")).toHaveLength(7);
  });

  it("updates only leases whose resident snapshot changes", () => {
    const renderCounts = new Map<number, number>();
    render(
      <NotesImageResidencyProvider scopeKey="vault-1">
        {Array.from({ length: 3 }, (_, index) => (
          <LeaseProbe
            id={index + 1}
            key={index + 1}
            renderCounts={renderCounts}
          />
        ))}
      </NotesImageResidencyProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Activate 1" }));

    expect(renderCounts).toEqual(
      new Map([
        [1, 2],
        [2, 1],
        [3, 1]
      ])
    );

    fireEvent.click(screen.getByRole("button", { name: "Activate 1" }));
    expect(renderCounts.get(1)).toBe(2);
  });

  it("keeps a 512-consumer workspace capped at eight resident images", () => {
    render(
      <NotesImageResidencyProvider scopeKey="vault-1">
        {Array.from({ length: 512 }, (_, index) => (
          <AutoActivateProbe id={index + 1} key={index + 1} />
        ))}
      </NotesImageResidencyProvider>
    );

    expect(screen.getAllByText("resident")).toHaveLength(8);
    expect(screen.getAllByText("dormant")).toHaveLength(504);
    expect(screen.getByTestId("auto-lease-504")).toHaveTextContent("dormant");
    expect(screen.getByTestId("auto-lease-505")).toHaveTextContent("resident");
    expect(screen.getByTestId("auto-lease-512")).toHaveTextContent("resident");
  });

  it("shares exactly eight active object URLs between legacy attachments and image nodes through churn and release", async () => {
    const activeUrls = new Set<string>();
    const createdBlobs: Blob[] = [];
    const maxActiveUrls = { value: 0 };
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
      URL,
      "createObjectURL"
    );
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
      URL,
      "revokeObjectURL"
    );
    let objectUrlSequence = 0;
    const createObjectURL = vi.fn(() => `blob:mixed-${++objectUrlSequence}`);
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL
    });

    let view: ReturnType<typeof render> | null = null;
    try {
      view = render(
        <NotesImageResidencyProvider scopeKey="vault-1">
          {Array.from({ length: 512 }, (_, index) => {
            const id = index + 1;
            const kind: MixedImageKind =
              id <= 256 ? "legacy-attachment" : "image-node";
            return (
              <MixedObjectUrlProbe
                activeUrls={activeUrls}
                autoActivate
                createdBlobs={createdBlobs}
                id={id}
                key={id}
                kind={kind}
                maxActiveUrls={maxActiveUrls}
              />
            );
          })}
        </NotesImageResidencyProvider>
      );

      await waitFor(() => expect(activeUrls.size).toBe(8));
      expect(screen.getAllByText(/: resident$/u)).toHaveLength(8);
      expect(screen.getByTestId("mixed-1")).toHaveTextContent(
        "legacy-attachment: dormant"
      );
      expect(screen.getByTestId("mixed-256")).toHaveTextContent(
        "legacy-attachment: dormant"
      );
      expect(screen.getByTestId("mixed-504")).toHaveTextContent(
        "image-node: dormant"
      );
      expect(screen.getByTestId("mixed-505")).toHaveTextContent(
        "image-node: resident"
      );
      expect(screen.getByTestId("mixed-512")).toHaveTextContent(
        "image-node: resident"
      );
      expect(createObjectURL).toHaveBeenCalledTimes(8);
      expect(createdBlobs.map((blob) => blob.size)).toEqual(Array(8).fill(1));

      fireEvent.click(
        screen.getByRole("button", { name: "Activate legacy-attachment 1" })
      );
      await waitFor(() =>
        expect(screen.getByTestId("mixed-1")).toHaveTextContent(
          "legacy-attachment: resident"
        )
      );
      await waitFor(() => expect(activeUrls.size).toBe(8));
      expect(screen.getByTestId("mixed-505")).toHaveTextContent(
        "image-node: dormant"
      );
      expect(createObjectURL).toHaveBeenCalledTimes(9);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);

      fireEvent.click(
        screen.getByRole("button", { name: "Deactivate legacy-attachment 1" })
      );
      await waitFor(() => expect(activeUrls.size).toBe(7));
      expect(screen.getByTestId("mixed-1")).toHaveTextContent(
        "legacy-attachment: dormant"
      );
      expect(screen.getAllByText(/: resident$/u)).toHaveLength(7);
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);

      fireEvent.click(
        screen.getByRole("button", { name: "Activate image-node 300" })
      );
      await waitFor(() =>
        expect(screen.getByTestId("mixed-300")).toHaveTextContent(
          "image-node: resident"
        )
      );
      await waitFor(() => expect(activeUrls.size).toBe(8));
      expect(screen.getAllByText(/: resident$/u)).toHaveLength(8);
      expect(createObjectURL).toHaveBeenCalledTimes(10);
      expect(maxActiveUrls.value).toBe(8);
      expect(createdBlobs.map((blob) => blob.size)).toEqual(Array(10).fill(1));

      view.unmount();
      expect(activeUrls.size).toBe(0);
      expect(revokeObjectURL).toHaveBeenCalledTimes(10);
    } finally {
      view?.unmount();
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  }, 15_000);

  it("releases every lease when the workspace scope changes", () => {
    const view = render(
      <NotesImageResidencyProvider scopeKey="vault-1">
        <LeaseProbe id={1} />
      </NotesImageResidencyProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Activate 1" }));
    expect(screen.getByTestId("lease-1")).toHaveTextContent("resident");

    view.rerender(
      <NotesImageResidencyProvider scopeKey="vault-2">
        <LeaseProbe id={1} />
      </NotesImageResidencyProvider>
    );

    expect(screen.getByTestId("lease-1")).toHaveTextContent("dormant");
  });

  it("deduplicates concurrent byte loads and one holder cannot release another holder's bytes", async () => {
    const pending = deferred<Uint8Array>();
    const underlyingLoad = vi.fn(() => pending.promise);
    render(
      <NotesImageResidencyProvider scopeKey="byte-lease-test">
        <ByteLeaseProbe
          attachmentId="attachment-1"
          load={() => underlyingLoad()}
          name="first"
        />
        <ByteLeaseProbe
          attachmentId="attachment-1"
          load={() => underlyingLoad()}
          name="second"
        />
      </NotesImageResidencyProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Prewarm first" }));
    fireEvent.click(screen.getByRole("button", { name: "Prewarm second" }));
    expect(underlyingLoad).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(new Uint8Array([7])));
    await waitFor(() =>
      expect(screen.getByTestId("cached-first")).toHaveTextContent("7")
    );
    expect(screen.getByTestId("cached-second")).toHaveTextContent("7");

    fireEvent.click(screen.getByRole("button", { name: "Release first" }));
    expect(screen.getByTestId("cached-first")).toHaveTextContent("none");
    expect(screen.getByTestId("cached-second")).toHaveTextContent("7");
  });

  it("does not cache an empty or failed byte load and retries it", async () => {
    const load = vi
      .fn<() => Promise<Uint8Array>>()
      .mockResolvedValueOnce(new Uint8Array())
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(new Uint8Array([9]));
    render(
      <NotesImageResidencyProvider scopeKey="byte-lease-retry-test">
        <ByteLeaseProbe attachmentId="attachment-1" load={load} />
      </NotesImageResidencyProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(screen.getByTestId("cached-attachment-1")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByTestId("cached-attachment-1")).toHaveTextContent("9")
    );
  });

  it("bounds shared byte residency to eight attachment IDs", async () => {
    render(
      <NotesImageResidencyProvider scopeKey="byte-lease-lru-test">
        {Array.from({ length: 9 }, (_, index) => {
          const id = `attachment-${index + 1}`;
          return (
            <ByteLeaseProbe
              attachmentId={id}
              key={id}
              load={() => Promise.resolve(new Uint8Array([index + 1]))}
            />
          );
        })}
      </NotesImageResidencyProvider>
    );

    for (let index = 1; index <= 8; index += 1) {
      fireEvent.click(
        screen.getByRole("button", { name: `Prewarm attachment-${index}` })
      );
    }
    await waitFor(() =>
      expect(screen.getByTestId("cached-attachment-8")).toHaveTextContent("8")
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Prewarm attachment-9" })
    );
    await waitFor(() =>
      expect(screen.getByTestId("cached-attachment-9")).toHaveTextContent("9")
    );
  });

  it("drops pending bytes across a scope swap and allows the new scope to reload", async () => {
    const first = deferred<Uint8Array>();
    const load = vi
      .fn<() => Promise<Uint8Array>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(new Uint8Array([8]));
    const view = render(
      <NotesImageResidencyProvider scopeKey="byte-lease-scope-a">
        <ByteLeaseProbe attachmentId="attachment-1" load={load} />
      </NotesImageResidencyProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    expect(load).toHaveBeenCalledOnce();

    view.rerender(
      <NotesImageResidencyProvider scopeKey="byte-lease-scope-b">
        <ByteLeaseProbe attachmentId="attachment-1" load={load} />
      </NotesImageResidencyProvider>
    );
    await act(async () => first.resolve(new Uint8Array([7])));
    expect(screen.getByTestId("cached-attachment-1")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    await waitFor(() =>
      expect(screen.getByTestId("cached-attachment-1")).toHaveTextContent("8")
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not rerender a new scope when an old pending prewarm rejects", async () => {
    const pending = deferred<Uint8Array>();
    const renderCount = { value: 0 };
    const view = render(
      <NotesImageResidencyProvider scopeKey="render-count-scope-a">
        <RenderCountByteLeaseProbe
          attachmentId="attachment-1"
          load={() => pending.promise}
          renderCount={renderCount}
        />
      </NotesImageResidencyProvider>
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Prewarm render count" })
    );

    view.rerender(
      <NotesImageResidencyProvider scopeKey="render-count-scope-b">
        <RenderCountByteLeaseProbe
          attachmentId="attachment-1"
          load={() => pending.promise}
          renderCount={renderCount}
        />
      </NotesImageResidencyProvider>
    );
    const countAfterScopeSwap = renderCount.value;

    await act(async () => pending.reject(new Error("old scope failed")));

    expect(renderCount.value).toBe(countAfterScopeSwap);
  });

  it("rejects retained providerless prewarm callbacks after unmount without invoking their loader", async () => {
    const retainedLease = { current: null as NotesImageByteLease | null };
    const view = render(
      <RetainedByteLeaseProbe
        retain={(lease) => {
          retainedLease.current = lease;
        }}
      />
    );
    const lease = retainedLease.current;
    if (lease === null) throw new Error("Expected a retained lease.");
    view.unmount();
    const load = vi.fn(() => Promise.resolve(new Uint8Array([1])));

    await expect(lease.prewarm("attachment-1", load)).rejects.toThrow(
      "Image byte residency is unavailable."
    );
    lease.release("attachment-1");

    expect(load).not.toHaveBeenCalled();
  });

  it("does not reuse stale bytes when an attachment ID is reloaded after its final release", async () => {
    const firstLoad = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const secondLoad = vi.fn().mockResolvedValue(new Uint8Array([2]));
    const view = render(
      <NotesImageResidencyProvider scopeKey="byte-lease-identity-test">
        <ByteLeaseProbe attachmentId="attachment-1" load={firstLoad} />
      </NotesImageResidencyProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    await waitFor(() =>
      expect(screen.getByTestId("cached-attachment-1")).toHaveTextContent("1")
    );
    fireEvent.click(screen.getByRole("button", { name: "Release attachment-1" }));

    view.rerender(
      <NotesImageResidencyProvider scopeKey="byte-lease-identity-test">
        <ByteLeaseProbe attachmentId="attachment-1" load={secondLoad} />
      </NotesImageResidencyProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    await waitFor(() =>
      expect(screen.getByTestId("cached-attachment-1")).toHaveTextContent("2")
    );
    expect(firstLoad).toHaveBeenCalledOnce();
    expect(secondLoad).toHaveBeenCalledOnce();
  });

  it("resumes the same provider coordinator after StrictMode lifecycle replay", async () => {
    const load = vi.fn().mockResolvedValue(new Uint8Array([6]));
    render(
      <StrictMode>
        <NotesImageResidencyProvider scopeKey="strict-provider-byte-test">
          <ByteLeaseProbe attachmentId="attachment-1" load={load} />
        </NotesImageResidencyProvider>
      </StrictMode>
    );

    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-1" }));
    await waitFor(() =>
      expect(screen.getByTestId("cached-attachment-1")).toHaveTextContent("6")
    );
    expect(load).toHaveBeenCalledOnce();
  });

  it("admits at most eight pending attachment IDs before invoking loaders", async () => {
    const pending = Array.from({ length: 9 }, () => deferred<Uint8Array>());
    const loads = pending.map((item) => vi.fn(() => item.promise));
    render(
      <NotesImageResidencyProvider scopeKey="pending-byte-cap-test">
        {loads.map((load, index) => (
          <ByteLeaseProbe
            attachmentId={`attachment-${index + 1}`}
            key={index}
            load={load}
          />
        ))}
      </NotesImageResidencyProvider>
    );

    for (let index = 1; index <= 9; index += 1) {
      fireEvent.click(
        screen.getByRole("button", { name: `Prewarm attachment-${index}` })
      );
    }
    expect(loads.slice(0, 8).map((load) => load.mock.calls.length)).toEqual(
      Array(8).fill(1)
    );
    expect(loads[8]).not.toHaveBeenCalled();

    await act(async () => pending[0].resolve(new Uint8Array([1])));
    fireEvent.click(screen.getByRole("button", { name: "Prewarm attachment-9" }));
    expect(loads[8]).toHaveBeenCalledOnce();
  });
});
