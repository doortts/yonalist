// jsdom has no layout, so the outline can only be windowed when the geometry
// is injected explicitly. Rows alternate between a plain title and a title
// with a supporting note so the measured heights stay non-uniform.
export const VIEWPORT_HEIGHT = 640;
export const TITLE_ROW_HEIGHT = 32;
export const NOTE_ROW_HEIGHT = 68;

export function rowHeightOf(element: HTMLElement): number {
  if (!element.classList.contains("notes-outline-item")) {
    return Number.parseFloat(element.style.height) || 0;
  }
  return element.querySelector(".notes-node-note-field")
    ? NOTE_ROW_HEIGHT
    : TITLE_ROW_HEIGHT;
}

// jsdom stacks nothing, so the harness stacks the rows itself: a row sits
// below every sibling before it, offset by the container's scroll position.
function stackedTop(element: HTMLElement): number {
  let top = 0;
  for (
    let sibling = element.previousElementSibling;
    sibling instanceof HTMLElement;
    sibling = sibling.previousElementSibling
  ) {
    top += rowHeightOf(sibling);
  }
  return top;
}

export function stubGeometry(): () => void {
  const prototype = HTMLElement.prototype;
  const rect = (top: number, height: number) =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
  const original = {
    offsetHeight: Object.getOwnPropertyDescriptor(prototype, "offsetHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(prototype, "clientHeight"),
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
      prototype, "getBoundingClientRect")
  };
  Object.defineProperty(prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("notes-outline-item")) return rowHeightOf(this);
      return Number.parseFloat(this.style.height) || 0;
    }
  });
  Object.defineProperty(prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("notes-outline-rows") ? VIEWPORT_HEIGHT : 0;
    }
  });
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.classList.contains("notes-outline-rows")) {
        return rect(0, VIEWPORT_HEIGHT);
      }
      const scroller = this.closest<HTMLElement>(".notes-outline-rows");
      const listTop = scroller ? -scroller.scrollTop : 0;
      if (this.classList.contains("notes-outline-list")) {
        return rect(listTop, [...this.children].reduce(
          (total, child) => total + rowHeightOf(child as HTMLElement), 0));
      }
      const list = this.closest<HTMLElement>(".notes-outline-list");
      return list
        ? rect(listTop + stackedTop(this), rowHeightOf(this))
        : rect(listTop, 0);
    }
  });
  return () => {
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else Reflect.deleteProperty(prototype, name);
    }
  };
}
