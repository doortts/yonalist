import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

vi.mock("./GithubServersSection", () => ({
  GithubServersSection: () => <div />
}));

describe("LoginPage", () => {
  it("offers Notes before GitHub authentication", async () => {
    const onOpenNotes = vi.fn();
    const onSkip = vi.fn();

    render(
      <LoginPage
        servers={{} as never}
        auth={{} as never}
        checking={false}
        error={null}
        onSkip={onSkip}
        onOpenNotes={onOpenNotes}
      />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Notes" }));

    expect(onOpenNotes).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBeNull();
  });
});
