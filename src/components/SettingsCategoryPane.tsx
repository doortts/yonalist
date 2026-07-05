import { FolderTree, HardDrive, RotateCcw, Server, SunMoon } from "lucide-react";

export type SettingsSection =
  | "appearance"
  | "servers"
  | "projects"
  | "vault"
  | "reset";

export const settingsSections: Array<{
  key: SettingsSection;
  label: string;
  description: string;
  icon: typeof Server;
}> = [
  {
    key: "appearance",
    label: "Appearance",
    description: "테마와 마크다운",
    icon: SunMoon
  },
  {
    key: "servers",
    label: "GitHub 서버",
    description: "서버 목록과 로그인",
    icon: Server
  },
  {
    key: "projects",
    label: "Projects 표시",
    description: "사이드바 저장소 선택",
    icon: FolderTree
  },
  {
    key: "vault",
    label: "Vault and sync",
    description: "볼트 폴더와 동기화",
    icon: HardDrive
  },
  {
    key: "reset",
    label: "Reset",
    description: "설정과 캐시 초기화",
    icon: RotateCcw
  }
];

interface SettingsCategoryPaneProps {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}

/** Middle-column list of settings categories while the settings view is open. */
export function SettingsCategoryPane({ section, onSelect }: SettingsCategoryPaneProps) {
  return (
    <section className="list-pane settings-category-pane" aria-label="Settings sections">
      <div className="pane-titlebar-spacer" />
      <div className="settings-category-header">
        <p className="eyebrow">Preferences</p>
        <h2>Settings</h2>
      </div>
      <nav className="settings-category-list">
        {settingsSections.map(({ key, label, description, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={section === key ? "category-item active" : "category-item"}
            aria-pressed={section === key}
            onClick={() => onSelect(key)}
          >
            <Icon size={17} />
            <span className="category-label">
              {label}
              <em>{description}</em>
            </span>
          </button>
        ))}
      </nav>
    </section>
  );
}
