import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppStatusBar } from "./AppStatusBar";

describe("AppStatusBar", () => {
  it("shows Yonalist feedback and current connectivity", () => {
    render(
      <AppStatusBar
        online={false}
        feedback={<span>Saving locally</span>}
      />
    );

    expect(screen.getByText("Saving locally")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });
});
