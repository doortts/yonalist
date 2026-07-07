import { type CSSProperties, useEffect, useRef, useState } from "react";

interface NavigationListAccentPalette {
  hover: string;
  selected: string;
  border: string;
  elevation: string;
}

const navigationListAccentPalettes: NavigationListAccentPalette[] = [
  {
    hover:
      "linear-gradient(90deg, rgb(217 255 16 / 10%) 0%, rgb(198 40 40 / 10%) 100%)",
    selected:
      "linear-gradient(90deg, rgb(217 255 16 / 20%) 0%, rgb(198 40 40 / 18%) 100%)",
    border: "#c62828",
    elevation: "1px 1px 2px rgb(68 68 68 / 18%)"
  },
  {
    hover:
      "linear-gradient(90deg, rgb(131 58 180 / 10%) 0%, rgb(253 29 29 / 9%) 50%, rgb(252 176 69 / 10%) 100%)",
    selected:
      "linear-gradient(90deg, rgb(131 58 180 / 18%) 0%, rgb(253 29 29 / 16%) 50%, rgb(252 176 69 / 18%) 100%)",
    border: "#833ab4",
    elevation: "1px 1px 2px rgb(68 68 68 / 18%)"
  },
  {
    hover:
      "radial-gradient(circle, rgb(63 94 251 / 10%) 0%, rgb(252 70 107 / 10%) 100%)",
    selected:
      "radial-gradient(circle, rgb(63 94 251 / 18%) 0%, rgb(252 70 107 / 17%) 100%)",
    border: "#3f5efb",
    elevation: "1px 1px 2px rgb(68 68 68 / 18%)"
  },
  {
    hover:
      "radial-gradient(circle, rgb(34 193 195 / 10%) 0%, rgb(253 187 45 / 10%) 100%)",
    selected:
      "radial-gradient(circle, rgb(34 193 195 / 18%) 0%, rgb(253 187 45 / 18%) 100%)",
    border: "#22c1c3",
    elevation: "1px 1px 2px rgb(68 68 68 / 18%)"
  },
  {
    hover:
      "linear-gradient(90deg, rgb(5 191 231 / 10%) 0%, rgb(29 79 253 / 9%) 50%, rgb(252 69 85 / 10%) 100%)",
    selected:
      "linear-gradient(90deg, rgb(5 191 231 / 18%) 0%, rgb(29 79 253 / 16%) 50%, rgb(252 69 85 / 18%) 100%)",
    border: "#1d4ffd",
    elevation: "1px 1px 2px rgb(68 68 68 / 18%)"
  }
];

function pickPaletteIndex(previousIndex: number | null) {
  const nextIndex = Math.floor(Math.random() * navigationListAccentPalettes.length);
  if (
    previousIndex !== null &&
    navigationListAccentPalettes.length > 1 &&
    nextIndex === previousIndex
  ) {
    return (nextIndex + 1) % navigationListAccentPalettes.length;
  }
  return nextIndex;
}

function paletteStyle(palette: NavigationListAccentPalette): CSSProperties {
  return {
    "--nav-list-hover-bg": palette.hover,
    "--nav-list-selected-bg": palette.selected,
    "--nav-list-selected-border": palette.border,
    "--nav-list-selected-elevation": palette.elevation
  } as CSSProperties;
}

export function useNavigationListAccent(activeNavigationKey: string): CSSProperties {
  const selectedIndex = useRef<number | null>(null);
  const activeKey = useRef(activeNavigationKey);
  const [style, setStyle] = useState<CSSProperties>(() => {
    selectedIndex.current = pickPaletteIndex(null);
    return paletteStyle(navigationListAccentPalettes[selectedIndex.current]);
  });

  useEffect(() => {
    if (activeKey.current === activeNavigationKey) {
      return;
    }
    activeKey.current = activeNavigationKey;
    selectedIndex.current = pickPaletteIndex(selectedIndex.current);
    setStyle(paletteStyle(navigationListAccentPalettes[selectedIndex.current]));
  }, [activeNavigationKey]);

  return style;
}
