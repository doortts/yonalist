import { createContext, useContext } from "react";
import type { SettingsSection } from "./components/SettingsCategoryPane";

export type SettingsTarget = "images";

export interface AppNavigation {
  openNotes: () => void;
  openSettings: (section: SettingsSection, target?: SettingsTarget) => void;
}

export const AppNavigationContext = createContext<AppNavigation | null>(null);

export function useAppNavigation(): AppNavigation {
  const navigation = useContext(AppNavigationContext);
  if (!navigation) {
    throw new Error("useAppNavigation must be used within AppNavigationContext");
  }
  return navigation;
}
