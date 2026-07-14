import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
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
