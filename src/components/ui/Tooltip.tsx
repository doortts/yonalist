import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import "./tooltip.css";

interface IconTooltipProps {
  /** Text shown in the tooltip popup on hover/focus. */
  label: ReactNode;
  /**
   * The existing icon button (or other element) to attach the tooltip to.
   * Rendered as-is via Base UI's `render` prop, so its DOM structure,
   * className, and event handlers are preserved.
   */
  children: ReactElement<{ "aria-describedby"?: string }>;
  /** Which side of the trigger to place the popup. Defaults to "top". */
  side?: "top" | "bottom" | "left" | "right";
}

/**
 * Thin wrapper around Base UI Tooltip that decorates an existing icon button
 * with a hover/focus label. The trigger keeps the passed element intact
 * (`render` composition), so callers only add supplementary visual text — the
 * `aria-label` on the button remains the accessible name.
 */
export function IconTooltip({ label, children, side = "top" }: IconTooltipProps) {
  const popupId = useId();
  const describedBy = [children.props["aria-describedby"], popupId]
    .filter(Boolean)
    .join(" ");
  const trigger = cloneElement(children, { "aria-describedby": describedBy });

  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={trigger} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          className="tooltip-positioner"
          side={side}
          sideOffset={6}
        >
          <BaseTooltip.Popup
            id={popupId}
            className="tooltip-popup"
            role="tooltip"
          >
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/**
 * Shared provider so grouped tooltips open instantly once one is visible and
 * respect a consistent open delay. Wrap a subtree (e.g. the app shell or a
 * toolbar) that contains multiple {@link IconTooltip}s.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={600}>{children}</BaseTooltip.Provider>;
}
