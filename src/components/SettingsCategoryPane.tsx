import { Tabs } from "@base-ui/react/tabs";
import {
  HardDrive,
  NotebookPen,
  Plug,
  RotateCcw,
  Server,
  SunMoon
} from "lucide-react";
import "./ui/category-tabs.css";

export type SettingsSection =
  | "appearance"
  | "notes"
  | "servers"
  | "vault"
  | "plugins"
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
    key: "vault",
    label: "Vault and sync",
    description: "볼트 폴더와 동기화",
    icon: HardDrive
  },
  {
    key: "notes",
    label: "Yonalist",
    description: "Images",
    icon: NotebookPen
  },
  {
    key: "plugins",
    label: "Plugins",
    description: "GitHub Notifications",
    icon: Plug
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
      <Tabs.Root
        className="settings-category-tabs-root"
        value={section}
        onValueChange={(value) => onSelect(value as SettingsSection)}
        orientation="vertical"
      >
        <Tabs.List className="settings-category-list" activateOnFocus>
          {settingsSections.map(({ key, label, description, icon: Icon }) => (
            <Tabs.Tab
              key={key}
              value={key}
              className={(state) =>
                state.active ? "category-item active" : "category-item"
              }
            >
              <Icon size={17} />
              <span className="category-label">
                {label}
                <em>{description}</em>
              </span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.Root>
    </section>
  );
}
