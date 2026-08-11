import { Archive, Clock3, ListTree, Star, Tags, Trash2 } from "lucide-react";

export type LibraryView = "all" | "starred" | "tags" | "trash";

const views = [
  { id: "all", label: "All", icon: ListTree, available: true },
  { id: "starred", label: "Starred", icon: Star, available: true },
  { id: "recent", label: "Recent", icon: Clock3, available: false },
  { id: "tags", label: "Tags", icon: Tags, available: true },
  { id: "archive", label: "Archive", icon: Archive, available: false },
  { id: "trash", label: "Trash", icon: Trash2, available: true }
] as const;

export function LibraryViewButtons({
  active, onSelect
}: {
  readonly active: LibraryView | null;
  readonly onSelect: (view: LibraryView) => void;
}) {
  return views.map(({ id, label, icon: Icon, available }) => (
    <button
      key={label}
      type="button"
      aria-pressed={active === id}
      disabled={!available}
      onClick={() => {
        if (available) onSelect(id as LibraryView);
      }}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  ));
}
