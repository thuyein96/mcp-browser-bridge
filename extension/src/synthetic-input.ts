// DOM-event input used when the Chrome debugger cannot attach to a tab (for
// example when another extension has injected a chrome-extension:// iframe,
// which makes chrome.debugger.attach fail). Events are untrusted
// (isTrusted === false), so the default actions that browsers only run for
// real input (focus on mousedown, text insertion on keydown, scrolling on
// wheel, Tab navigation) are emulated here explicitly.

export type MouseButtonName = "left" | "right" | "middle";

interface Hit {
  el: Element;
  x: number;
  y: number;
  win: Window;
  doc: Document;
}

const BUTTON_CODE: Record<MouseButtonName, number> = { left: 0, middle: 1, right: 2 };
const BUTTONS_MASK: Record<MouseButtonName, number> = { left: 1, middle: 4, right: 2 };

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

let lastHover: Element | null = null;

function modifierFlags(mask: number): {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
} {
  return {
    altKey: (mask & 1) !== 0,
    ctrlKey: (mask & 2) !== 0,
    metaKey: (mask & 4) !== 0,
    shiftKey: (mask & 8) !== 0,
  };
}

function isOurOverlay(el: Element | null): boolean {
  return el?.hasAttribute("data-ccb-cursor") ?? false;
}

/** elementFromPoint that descends into open shadow roots and same-origin iframes. */
export function deepElementFromPoint(x: number, y: number): Hit {
  let doc: Document = document;
  let win: Window = window;
  let lx = x;
  let ly = y;
  let el = doc.elementFromPoint(lx, ly);

  for (let guard = 0; el && guard < 32; guard++) {
    if (el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(lx, ly);
      if (inner && inner !== el && !isOurOverlay(inner)) {
        el = inner;
        continue;
      }
    }
    if (el instanceof HTMLIFrameElement) {
      let innerDoc: Document | null = null;
      try {
        innerDoc = el.contentDocument;
      } catch {
        innerDoc = null;
      }
      if (innerDoc && el.contentWindow) {
        const rect = el.getBoundingClientRect();
        const nx = lx - rect.left - el.clientLeft;
        const ny = ly - rect.top - el.clientTop;
        const inner = innerDoc.elementFromPoint(nx, ny);
        if (inner) {
          doc = innerDoc;
          win = el.contentWindow;
          lx = nx;
          ly = ny;
          el = inner;
          continue;
        }
      }
    }
    break;
  }

  if (!el || isOurOverlay(el)) {
    el = doc.body ?? doc.documentElement;
  }
  return { el, x: lx, y: ly, win, doc };
}

function mouseInit(
  hit: Hit,
  modifiers: number,
  extra: MouseEventInit = {},
): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: hit.win,
    clientX: hit.x,
    clientY: hit.y,
    screenX: Math.round(hit.x + window.screenX),
    screenY: Math.round(hit.y + window.screenY + (window.outerHeight - window.innerHeight)),
    ...modifierFlags(modifiers),
    ...extra,
  };
}

function pointer(type: string, hit: Hit, modifiers: number, extra: PointerEventInit = {}): boolean {
  const init: PointerEventInit = {
    ...mouseInit(hit, modifiers, extra),
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    width: 1,
    height: 1,
  };
  if (type === "pointerenter" || type === "pointerleave") init.bubbles = false;
  return hit.el.dispatchEvent(new PointerEvent(type, init));
}

function mouse(type: string, hit: Hit, modifiers: number, extra: MouseEventInit = {}): boolean {
  const init = mouseInit(hit, modifiers, extra);
  if (type === "mouseenter" || type === "mouseleave") init.bubbles = false;
  return hit.el.dispatchEvent(new MouseEvent(type, init));
}

function updateHover(hit: Hit, modifiers: number): void {
  if (lastHover === hit.el) return;
  const prev = lastHover;
  if (prev && prev.isConnected) {
    const prevHit: Hit = { ...hit, el: prev };
    pointer("pointerout", prevHit, modifiers, { relatedTarget: hit.el });
    pointer("pointerleave", prevHit, modifiers, { relatedTarget: hit.el });
    mouse("mouseout", prevHit, modifiers, { relatedTarget: hit.el });
    mouse("mouseleave", prevHit, modifiers, { relatedTarget: hit.el });
  }
  pointer("pointerover", hit, modifiers, { relatedTarget: prev });
  pointer("pointerenter", hit, modifiers, { relatedTarget: prev });
  mouse("mouseover", hit, modifiers, { relatedTarget: prev });
  mouse("mouseenter", hit, modifiers, { relatedTarget: prev });
  lastHover = hit.el;
}

function focusableAncestor(el: Element): HTMLElement | null {
  const hit = el.closest(FOCUSABLE_SELECTOR);
  if (hit instanceof HTMLElement) return hit;
  if (el instanceof HTMLElement && el.isContentEditable) return el;
  return null;
}

function placeCaretAtPoint(hit: Hit): void {
  const range = hit.doc.caretRangeFromPoint?.(hit.x, hit.y);
  if (!range) return;
  const selection = hit.win.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function syntheticHover(x: number, y: number, modifiers: number): Element {
  const hit = deepElementFromPoint(x, y);
  updateHover(hit, modifiers);
  pointer("pointermove", hit, modifiers);
  mouse("mousemove", hit, modifiers);
  return hit.el;
}

export function syntheticClick(
  x: number,
  y: number,
  button: MouseButtonName,
  clickCount: number,
  modifiers: number,
): { tag: string; label: string } {
  const hit = deepElementFromPoint(x, y);
  updateHover(hit, modifiers);
  pointer("pointermove", hit, modifiers);
  mouse("mousemove", hit, modifiers);

  const code = BUTTON_CODE[button];
  const mask = BUTTONS_MASK[button];

  for (let i = 1; i <= clickCount; i++) {
    const downOk =
      pointer("pointerdown", hit, modifiers, { button: code, buttons: mask, pressure: 0.5 }) &&
      mouse("mousedown", hit, modifiers, { button: code, buttons: mask, detail: i });

    if (downOk && button === "left" && i === 1) {
      const target = focusableAncestor(hit.el);
      if (target && hit.doc.activeElement !== target) {
        target.focus({ preventScroll: true });
      } else if (!target && hit.doc.activeElement instanceof HTMLElement) {
        hit.doc.activeElement.blur();
      }
      if (target?.isContentEditable) placeCaretAtPoint(hit);
    }

    pointer("pointerup", hit, modifiers, { button: code, buttons: 0, pressure: 0 });
    mouse("mouseup", hit, modifiers, { button: code, buttons: 0, detail: i });

    if (button === "left") {
      mouse("click", hit, modifiers, { button: code, buttons: 0, detail: i });
      if (i === 2) mouse("dblclick", hit, modifiers, { button: code, buttons: 0, detail: 2 });
    } else {
      pointer("auxclick", hit, modifiers, { button: code, buttons: 0, detail: i });
      if (button === "right") {
        pointer("contextmenu", hit, modifiers, { button: code, buttons: 0, detail: i });
      }
    }
  }

  if (button === "left" && clickCount >= 3) {
    const el = hit.el;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.select();
    }
  }

  const label =
    hit.el.getAttribute("aria-label") ??
    (hit.el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return { tag: hit.el.tagName.toLowerCase(), label };
}

export function syntheticDrag(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  modifiers: number,
): void {
  const start = deepElementFromPoint(sx, sy);
  updateHover(start, modifiers);
  pointer("pointerdown", start, modifiers, { button: 0, buttons: 1, pressure: 0.5 });
  mouse("mousedown", start, modifiers, { button: 0, buttons: 1, detail: 1 });

  const steps = 8;
  let hit = start;
  for (let i = 1; i <= steps; i++) {
    const x = sx + ((ex - sx) * i) / steps;
    const y = sy + ((ey - sy) * i) / steps;
    hit = deepElementFromPoint(x, y);
    updateHover(hit, modifiers);
    pointer("pointermove", hit, modifiers, { buttons: 1, pressure: 0.5 });
    mouse("mousemove", hit, modifiers, { buttons: 1 });
  }

  pointer("pointerup", hit, modifiers, { button: 0, buttons: 0, pressure: 0 });
  mouse("mouseup", hit, modifiers, { button: 0, buttons: 0, detail: 1 });
}

function canScroll(el: Element, dx: number, dy: number): boolean {
  const style = getComputedStyle(el);
  const scrollingElement = el.ownerDocument.scrollingElement;
  const isRoot = el === scrollingElement;
  const oy = isRoot || /(auto|scroll|overlay)/.test(style.overflowY);
  const ox = isRoot || /(auto|scroll|overlay)/.test(style.overflowX);
  if (dy > 0 && oy && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  if (dy < 0 && oy && el.scrollTop > 0) return true;
  if (dx > 0 && ox && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  if (dx < 0 && ox && el.scrollLeft > 0) return true;
  return false;
}

/**
 * Resolve once scrolling started by the caller has settled: on `scrollend`,
 * or early if nothing scrolls at all, or after a safety timeout.
 */
function waitForScrollSettled(doc: Document, timeoutMs = 1200): Promise<void> {
  return new Promise((resolve) => {
    let sawScroll = false;
    const onScroll = (): void => {
      sawScroll = true;
    };
    const finish = (): void => {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      doc.removeEventListener("scroll", onScroll, true);
      doc.removeEventListener("scrollend", finish, true);
      resolve();
    };
    // Capture phase sees scroll/scrollend from nested scrollers too.
    doc.addEventListener("scroll", onScroll, true);
    doc.addEventListener("scrollend", finish, true);
    const idleTimer = setTimeout(() => {
      if (!sawScroll) finish();
    }, 150);
    const hardTimer = setTimeout(finish, timeoutMs);
  });
}

function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView ?? window;
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < view.innerHeight &&
    rect.left < view.innerWidth &&
    rect.top >= 0 &&
    rect.bottom <= view.innerHeight
  );
}

/** Smooth-scroll `el` to the center of the viewport if it is not fully visible. */
export async function scrollIntoViewVisibly(el: Element): Promise<void> {
  if (isInViewport(el)) return;
  const settled = waitForScrollSettled(el.ownerDocument);
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  await settled;
  if (!isInViewport(el)) {
    // Smooth scrolling can be cut short by sticky headers or lazy layout shifts.
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  }
}

export async function syntheticScroll(
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
  modifiers: number,
): Promise<void> {
  const hit = deepElementFromPoint(x, y);
  const wheelOk = hit.el.dispatchEvent(
    new WheelEvent("wheel", {
      ...mouseInit(hit, modifiers),
      deltaX,
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    }),
  );
  if (!wheelOk) return;

  // Smooth, so the page visibly travels like a real wheel scroll.
  const settled = waitForScrollSettled(hit.doc);
  let node: Element | null = hit.el;
  let scrolled = false;
  while (node) {
    if (canScroll(node, deltaX, deltaY)) {
      node.scrollBy({ left: deltaX, top: deltaY, behavior: "smooth" });
      scrolled = true;
      break;
    }
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : (node.parentElement ?? null);
  }
  if (!scrolled) hit.win.scrollBy({ left: deltaX, top: deltaY, behavior: "smooth" });
  await settled;
}

function deepActiveElement(): { el: Element; doc: Document; win: Window } {
  let doc: Document = document;
  let win: Window = window;
  let el: Element | null = doc.activeElement;
  for (let guard = 0; el && guard < 32; guard++) {
    if (el.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    if (el instanceof HTMLIFrameElement) {
      try {
        const innerDoc = el.contentDocument;
        if (innerDoc?.activeElement && el.contentWindow) {
          doc = innerDoc;
          win = el.contentWindow;
          el = innerDoc.activeElement;
          continue;
        }
      } catch {
        // Cross-origin iframe: keep the iframe element itself.
      }
    }
    break;
  }
  return { el: el ?? doc.body ?? doc.documentElement, doc, win };
}

function isTextControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return /^(text|search|email|url|tel|password|number|)$/i.test(el.type);
}

function isEditable(el: Element): boolean {
  return isTextControl(el) || (el instanceof HTMLElement && el.isContentEditable);
}

function insertText(target: { el: Element; doc: Document }, text: string): boolean {
  if (!isEditable(target.el)) return false;
  // execCommand fires beforeinput/input and works with React, Lexical and
  // other editors that track the DOM selection.
  if (target.doc.execCommand("insertText", false, text)) return true;

  if (isTextControl(target.el)) {
    const el = target.el;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
    );
    return true;
  }
  return false;
}

export function syntheticType(text: string): { inserted: boolean; tag: string } {
  const target = deepActiveElement();
  const inserted = insertText(target, text);
  if (!inserted) {
    // Nothing editable has focus: deliver per-character key events so page
    // shortcuts (e.g. "j"/"k" navigation) still see the input.
    for (const ch of text) {
      syntheticKey({ key: ch, code: "", keyCode: ch.toUpperCase().charCodeAt(0), text: ch }, 0);
    }
  }
  return { inserted, tag: target.el.tagName.toLowerCase() };
}

function tabbables(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.tabIndex < 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

export interface SyntheticKeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

export function syntheticKey(spec: SyntheticKeySpec, modifiers: number): { tag: string } {
  const target = deepActiveElement();
  const flags = modifierFlags(modifiers);
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    key: spec.key,
    code: spec.code,
    keyCode: spec.keyCode,
    which: spec.keyCode,
    view: target.win,
    ...flags,
  } as KeyboardEventInit;

  const el = target.el;
  const downOk = el.dispatchEvent(new KeyboardEvent("keydown", init));
  const shortcut = flags.ctrlKey || flags.metaKey;

  if (downOk) {
    if (spec.text && spec.text !== "\r" && !shortcut) {
      const charCode = spec.text.charCodeAt(0);
      const pressOk = el.dispatchEvent(
        new KeyboardEvent("keypress", { ...init, charCode, keyCode: charCode } as KeyboardEventInit),
      );
      if (pressOk) insertText(target, spec.text);
    } else if (shortcut && spec.key.toLowerCase() === "a") {
      if (isTextControl(el)) el.select();
      else target.doc.execCommand("selectAll");
    } else {
      switch (spec.key) {
        case "Backspace":
          if (isEditable(el)) target.doc.execCommand("delete");
          break;
        case "Delete":
          if (isEditable(el)) target.doc.execCommand("forwardDelete");
          break;
        case "Enter": {
          const pressOk = el.dispatchEvent(
            new KeyboardEvent("keypress", { ...init, charCode: 13 } as KeyboardEventInit),
          );
          if (!pressOk) break;
          if (el instanceof HTMLTextAreaElement) {
            insertText(target, "\n");
          } else if (el instanceof HTMLElement && el.isContentEditable) {
            target.doc.execCommand(flags.shiftKey ? "insertLineBreak" : "insertParagraph");
          } else if (el instanceof HTMLInputElement && el.form) {
            el.form.requestSubmit();
          } else if (
            el instanceof HTMLAnchorElement ||
            el instanceof HTMLButtonElement ||
            el.getAttribute("role") === "button" ||
            el.getAttribute("role") === "link"
          ) {
            (el as HTMLElement).click();
          }
          break;
        }
        case "Tab": {
          const list = tabbables(target.doc);
          if (list.length === 0) break;
          const idx = list.indexOf(el as HTMLElement);
          const next = flags.shiftKey
            ? list[(idx <= 0 ? list.length : idx) - 1]
            : list[(idx + 1) % list.length];
          next?.focus();
          break;
        }
        default:
          break;
      }
    }
  }

  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return { tag: el.tagName.toLowerCase() };
}
