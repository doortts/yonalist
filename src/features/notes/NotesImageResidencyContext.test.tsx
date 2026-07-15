import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  NotesImageResidencyProvider,
  useNotesImageResidencyLease
} from "./NotesImageResidencyContext";

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
});
