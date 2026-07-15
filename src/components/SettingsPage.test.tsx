import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../appSettings";
import type { ResetProgressStatus } from "../resetProgress";
import { SettingsPage } from "./SettingsPage";

type SettingsProps = ComponentProps<typeof SettingsPage>;

function renderResetProgress(status: Exclude<ResetProgressStatus, "idle">) {
  const stepStatus = status === "done" ? "done" : status;
  render(
    <SettingsPage
      section="reset"
      settings={defaultSettings}
      status=""
      resetProgress={{
        status,
        message: `${status} reset`,
        steps: [{ id: "cache", label: "Cache", status: stepStatus }]
      }}
      themeMode="system"
      lightTheme="graphite"
      darkTheme="dark"
      onThemeModeChange={vi.fn()}
      onLightThemeChange={vi.fn()}
      onDarkThemeChange={vi.fn()}
      servers={{} as SettingsProps["servers"]}
      auth={{} as SettingsProps["auth"]}
      repositoryGroups={[]}
      projectVisibility={{} as SettingsProps["projectVisibility"]}
      onUpdate={vi.fn()}
      onSave={vi.fn()}
      onResetAll={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

describe("SettingsPage reset feedback", () => {
  it.each([
    ["running", "status"],
    ["done", "status"],
    ["failed", "alert"]
  ] as const)("uses %s reset semantics", (status, role) => {
    renderResetProgress(status);
    expect(screen.getByRole(role, { name: "Reset progress" }))
      .toHaveTextContent(`${status} reset`);
  });
});
