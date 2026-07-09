import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  NotesFeatureProvider,
  NotesLibraryPlaceholder,
  NotesOutlinePlaceholder
} from "./NotesFeature";

describe("NotesFeature", () => {
  it("renders the Notes shell without a GitHub provider", () => {
    render(
      <NotesFeatureProvider>
        <NotesLibraryPlaceholder />
        <NotesOutlinePlaceholder />
      </NotesFeatureProvider>
    );

    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
    expect(
      screen.getByText("Select a note to view its outline.")
    ).toBeInTheDocument();
  });
});
