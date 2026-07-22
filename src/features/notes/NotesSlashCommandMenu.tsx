import { CalendarDays, SquareCheckBig } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import type {
  NotesSlashCommandDefinition,
  NotesSlashCommandId
} from "./notesSlashCommands";

interface NotesSlashCommandMenuProps {
  readonly anchor: HTMLElement;
  readonly commands: readonly NotesSlashCommandDefinition[];
  readonly activeIndex: number;
  readonly menuId: string;
  readonly onSelect: (id: NotesSlashCommandId) => void;
}

interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

const viewportInset = 8;
const anchorGap = 6;
const preferredWidth = 360;
const estimatedHeight = 58;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function menuPlacement(
  anchor: DOMRect,
  measuredHeight = estimatedHeight
): MenuPlacement {
  const width = Math.min(
    preferredWidth,
    Math.max(0, window.innerWidth - viewportInset * 2)
  );
  const left = clamp(
    anchor.left,
    viewportInset,
    window.innerWidth - width - viewportInset
  );
  const below = anchor.bottom + anchorGap;
  const top =
    below + measuredHeight <= window.innerHeight - viewportInset
      ? below
      : Math.max(viewportInset, anchor.top - anchorGap - measuredHeight);
  return { left, top, width };
}

export function NotesSlashCommandMenu({
  anchor,
  commands,
  activeIndex,
  menuId,
  onSelect
}: NotesSlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement>(() =>
    menuPlacement(anchor.getBoundingClientRect())
  );

  const updatePlacement = useCallback(() => {
    const height = menuRef.current?.getBoundingClientRect().height;
    setPlacement(
      menuPlacement(
        anchor.getBoundingClientRect(),
        height && height > 0 ? height : estimatedHeight
      )
    );
  }, [anchor]);

  useLayoutEffect(() => {
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [updatePlacement]);

  if (commands.length === 0) return null;

  const style = {
    position: "fixed",
    zIndex: 90,
    left: placement.left,
    top: placement.top,
    width: placement.width
  } satisfies CSSProperties;

  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      className="notes-slash-command-menu"
      role="listbox"
      aria-label="Slash commands"
      style={style}
    >
      {commands.map((command, index) => (
        <button
          key={command.id}
          id={`${menuId}-${command.id}`}
          className="notes-slash-command-option"
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === activeIndex}
          data-active={index === activeIndex ? "true" : undefined}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command.id)}
        >
          {command.id === "todo" ? (
            <SquareCheckBig size={17} aria-hidden="true" />
          ) : (
            <CalendarDays size={17} aria-hidden="true" />
          )}
          <span className="notes-slash-command-label">{command.label}</span>
          <span className="notes-slash-command-description">
            {command.description}
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
}
