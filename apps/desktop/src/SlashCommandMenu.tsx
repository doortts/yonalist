import { CalendarDays, Circle, SquareCheckBig } from "lucide-react";
import {
  useCallback, useLayoutEffect, useRef, useState, type CSSProperties
} from "react";
import { createPortal } from "react-dom";
import type {
  SlashCommandDefinition, SlashCommandId
} from "./outline/outlineSlash";

export function SlashCommandMenu({
  anchor, commands, activeIndex, onSelect
}: {
  readonly anchor: HTMLElement;
  readonly commands: readonly SlashCommandDefinition[];
  readonly activeIndex: number;
  readonly onSelect: (id: SlashCommandId) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(() => placeMenu(
    anchor.getBoundingClientRect()
  ));
  const updatePlacement = useCallback(() => {
    setPlacement(placeMenu(
      anchor.getBoundingClientRect(),
      menuRef.current?.getBoundingClientRect().height
    ));
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
  return createPortal(
    <div
      ref={menuRef}
      className="notes-slash-command-menu"
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: "fixed",
        zIndex: 90,
        left: placement.left,
        top: placement.top,
        width: placement.width
      } satisfies CSSProperties}
    >
      {commands.map((command, index) => (
        <button
          key={command.id}
          className="notes-slash-command-option"
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === activeIndex}
          data-active={index === activeIndex ? "true" : undefined}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command.id)}
        >
          {command.icon === "todo"
            ? <SquareCheckBig size={17} aria-hidden="true" />
            : command.icon === "bullet"
              ? <Circle size={17} aria-hidden="true" />
              : <CalendarDays size={17} aria-hidden="true" />}
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

const viewportInset = 8;
const anchorGap = 6;
const preferredWidth = 360;
const estimatedHeight = 58;

function placeMenu(anchor: DOMRect, measuredHeight = estimatedHeight) {
  const width = Math.min(
    preferredWidth,
    Math.max(0, window.innerWidth - viewportInset * 2)
  );
  const left = Math.min(
    Math.max(anchor.left, viewportInset),
    Math.max(viewportInset, window.innerWidth - width - viewportInset)
  );
  const height = measuredHeight > 0 ? measuredHeight : estimatedHeight;
  const below = anchor.bottom + anchorGap;
  const top = below + height <= window.innerHeight - viewportInset
    ? below
    : Math.max(viewportInset, anchor.top - anchorGap - height);
  return { left, top, width };
}
