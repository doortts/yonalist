import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { VaultSetupCard } from "./VaultSetupCard";
import { pickVaultFolder } from "./vaultPicker";

vi.mock("./vaultPicker", () => ({ pickVaultFolder: vi.fn() }));

function renderCard(overrides: Partial<Parameters<typeof VaultSetupCard>[0]> = {}) {
  const props = {
    readVaultPath: vi.fn().mockResolvedValue(null),
    setVaultPath: vi.fn().mockResolvedValue("empty" as const),
    writeGuide: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  render(<VaultSetupCard {...props} />);
  return props;
}

/** Lets the mounting read resolve, so an absent card means absent for good. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("VaultSetupCard", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => backing.set(key, value),
        removeItem: (key: string) => backing.delete(key),
        clear: () => backing.clear()
      }
    });
  });

  afterEach(() => {
    delete (window as { localStorage?: unknown }).localStorage;
  });

  it("vault가 없으면 카드가 뜨고 폴더를 고르면 사라진다", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue("/Users/me/Yonalist");
    const props = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    await waitFor(() => {
      expect(props.setVaultPath).toHaveBeenCalledWith("/Users/me/Yonalist");
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Choose folder" }))
        .not.toBeInTheDocument();
    });
  });

  it("vault가 이미 있으면 카드가 아예 뜨지 않는다", async () => {
    const props = renderCard({
      readVaultPath: vi.fn().mockResolvedValue("/Users/me/Yonalist")
    });

    await settle();

    expect(props.readVaultPath).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Choose folder" }))
      .not.toBeInTheDocument();
  });

  it("Later가 dismissal을 저장해 다시 마운트해도 숨는다", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument();

    const remounted = renderCard();
    await settle();

    expect(remounted.readVaultPath).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument();
  });

  it("기존 vault 폴더를 고르면 병합 안내가 보인다", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue("/Users/me/Yonalist");
    renderCard({ setVaultPath: vi.fn().mockResolvedValue("existingVault" as const) });

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    expect(await screen.findByText(/already holds Yonalist notes/i))
      .toBeInTheDocument();
  });

  it("남의 파일이 있는 폴더를 고르면 전용 폴더를 권한다", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue("/Users/me/Projects");
    renderCard({ setVaultPath: vi.fn().mockResolvedValue("nonEmpty" as const) });

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    expect(await screen.findByText(/folder of its own/i)).toBeInTheDocument();
  });
});

describe("VaultSetupCard: who gets the guide notes", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => backing.set(key, value),
        removeItem: (key: string) => backing.delete(key),
        clear: () => backing.clear()
      }
    });
  });

  afterEach(() => {
    delete (window as { localStorage?: unknown }).localStorage;
  });

  it("빈 폴더를 고르면 안내 노트를 쓴다", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue("/Users/me/Fresh");
    const props = renderCard({
      setVaultPath: vi.fn().mockResolvedValue("empty" as const)
    });

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    await waitFor(() => expect(props.writeGuide).toHaveBeenCalledTimes(1));
  });

  it("이미 노트가 있는 폴더를 고르면 안내 노트를 쓰지 않는다", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue("/Users/me/Shared");
    const props = renderCard({
      setVaultPath: vi.fn().mockResolvedValue("existingVault" as const)
    });

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    await waitFor(() => expect(props.setVaultPath).toHaveBeenCalled());
    await settle();
    expect(props.writeGuide).not.toHaveBeenCalled();
  });

  it("다른 파일이 든 폴더는 이 앱의 vault가 아니므로 안내 노트를 쓴다", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue("/Users/me/Documents");
    const props = renderCard({
      setVaultPath: vi.fn().mockResolvedValue("nonEmpty" as const)
    });

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    await waitFor(() => expect(props.writeGuide).toHaveBeenCalledTimes(1));
  });

  it("나중에 정하겠다고 해도 안내 노트는 받는다", async () => {
    const props = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Later" }));

    await waitFor(() => expect(props.writeGuide).toHaveBeenCalledTimes(1));
  });

  it("폴더를 고르다 취소하면 아무 결정도 내려지지 않는다", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue(null);
    const props = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));
    await settle();

    expect(props.setVaultPath).not.toHaveBeenCalled();
    expect(props.writeGuide).not.toHaveBeenCalled();
  });
});
