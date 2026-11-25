// Visible "Claude" cursor drawn on top of the page. Purely cosmetic: it never
// receives events (pointer-events: none), so elementFromPoint and real input
// pass straight through it.

const HOST_ATTR = "data-ccb-cursor";
const ACCENT = "#D97757";
const TIP_X = 3;
const TIP_Y = 2;
const IDLE_HIDE_MS = 90_000;

export type ScrollDirection = "up" | "down" | "left" | "right";

interface Overlay {
  host: HTMLElement;
  cursor: HTMLElement;
  ripples: HTMLElement;
}

let overlay: Overlay | null = null;
let position: { x: number; y: number } | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;

const STYLE = `
  :host { all: initial; }
  .cursor {
    position: fixed; left: 0; top: 0;
    transform: translate3d(-200px, -200px, 0);
    transition: transform var(--ccb-d, 300ms) cubic-bezier(.45,.05,.25,1), opacity .3s ease;
    will-change: transform;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,.4));
    opacity: 0;
  }
  .cursor.visible { opacity: 1; }
  .cursor .arrow { display: block; transform-origin: ${TIP_X}px ${TIP_Y}px; transition: transform .12s ease; }
  .cursor.pressed .arrow { transform: scale(.78); }
  .cursor.arrived .arrow { animation: ccb-pop .45s ease-out; }
  .label {
    position: absolute; left: 20px; top: 24px;
    padding: 2px 8px; border-radius: 999px;
    background: ${ACCENT}; color: #fff;
    font: 600 11px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    white-space: nowrap; letter-spacing: .01em;
  }
  .wheel {
    position: absolute; left: -14px; top: 30px;
    width: 26px; height: 26px; border-radius: 50%;
    background: ${ACCENT}; display: none;
    align-items: center; justify-content: center;
  }
  .wheel svg { display: block; }
  .cursor.scrolling .wheel { display: flex; }
  .cursor.scroll-down .wheel svg { animation: ccb-nudge-down .45s ease-in-out infinite; }
  .cursor.scroll-up .wheel svg { transform: rotate(180deg); animation: ccb-nudge-up .45s ease-in-out infinite; }
  .cursor.scroll-left .wheel svg { transform: rotate(90deg); animation: ccb-nudge-left .45s ease-in-out infinite; }
  .cursor.scroll-right .wheel svg { transform: rotate(-90deg); animation: ccb-nudge-right .45s ease-in-out infinite; }
  .ripple {
    position: fixed; width: 52px; height: 52px; margin: -26px 0 0 -26px;
    border-radius: 50%; box-sizing: border-box;
    border: 3px solid ${ACCENT}; background: rgba(217,119,87,.22);
    animation: ccb-ripple .7s ease-out forwards;
  }
  .ripple.right { border-style: dashed; }
  @keyframes ccb-ripple {
    from { transform: scale(.15); opacity: 1; }
    to { transform: scale(1.6); opacity: 0; }
  }
  @keyframes ccb-pop {
    0% { transform: scale(1.35); } 100% { transform: scale(1); }
  }
  @keyframes ccb-nudge-down { 50% { transform: translateY(3px); } }
  @keyframes ccb-nudge-up { 0%,100% { transform: rotate(180deg); } 50% { transform: rotate(180deg) translateY(3px); } }
  @keyframes ccb-nudge-left { 0%,100% { transform: rotate(90deg); } 50% { transform: rotate(90deg) translateY(3px); } }
  @keyframes ccb-nudge-right { 0%,100% { transform: rotate(-90deg); } 50% { transform: rotate(-90deg) translateY(3px); } }
`;

const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_PATH = "M3 2 L3 22.5 L8.6 17.2 L12.4 25.8 L16.2 24.2 L12.4 15.6 L20.2 15.6 Z";

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function ensureOverlay(): Overlay {
  if (overlay && overlay.host.isConnected) return overlay;

  // Drop cursors left behind by an older copy of this script (extension reload).
  for (const stale of document.querySelectorAll(`[${HOST_ATTR}]`)) stale.remove();

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLE;

  // Built with DOM calls, not innerHTML, so Trusted Types pages accept it.
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  const arrow = svgEl("svg", { class: "arrow", width: "26", height: "28", viewBox: "0 0 26 28" });
  arrow.appendChild(
    svgEl("path", {
      d: ARROW_PATH,
      fill: ACCENT,
      stroke: "#fff",
      "stroke-width": "1.8",
      "stroke-linejoin": "round",
    }),
  );
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Claude";
  const wheel = document.createElement("span");
  wheel.className = "wheel";
  const chevron = svgEl("svg", { width: "14", height: "14", viewBox: "0 0 14 14" });
  chevron.appendChild(
    svgEl("path", {
      d: "M2.5 5 L7 9.5 L11.5 5",
      fill: "none",
      stroke: "#fff",
      "stroke-width": "2.2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  wheel.appendChild(chevron);
  cursor.append(arrow, label, wheel);

  const ripples = document.createElement("div");
  root.append(style, ripples, cursor);
  document.documentElement.appendChild(host);

  overlay = { host, cursor, ripples };
  if (position) placeAt(cursor, position.x, position.y, 0);
  return overlay;
}

function placeAt(cursor: HTMLElement, x: number, y: number, durationMs: number): void {
  cursor.style.setProperty("--ccb-d", `${Math.round(durationMs)}ms`);
  cursor.style.transform = `translate3d(${x - TIP_X}px, ${y - TIP_Y}px, 0)`;
}

function keepVisible(cursor: HTMLElement): void {
  cursor.classList.add("visible");
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => cursor.classList.remove("visible"), IDLE_HIDE_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampToViewport(p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.min(Math.max(p.x, 0), window.innerWidth - 1),
    y: Math.min(Math.max(p.y, 0), window.innerHeight - 1),
  };
}

/**
 * Show the cursor without moving it: used right after a page load so the
 * cursor reappears where it was on the previous page instead of vanishing.
 */
export async function showCursorAt(x: number, y: number): Promise<void> {
  const { cursor } = ensureOverlay();
  if (!position) {
    position = clampToViewport({ x, y });
    placeAt(cursor, position.x, position.y, 0);
    void cursor.offsetWidth;
  }
  keepVisible(cursor);
  cursor.classList.remove("arrived");
  void cursor.offsetWidth;
  cursor.classList.add("arrived");
  await sleep(300);
}

/** Glide the cursor to (x, y) in viewport CSS pixels; resolves when it arrives. */
export async function moveCursor(
  x: number,
  y: number,
  from?: { x: number; y: number },
): Promise<void> {
  const { cursor } = ensureOverlay();

  if (!position) {
    // First appearance on this page: start from where the cursor was on the
    // previous page (if the background remembered it) or the viewport center.
    const start = clampToViewport(from ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    placeAt(cursor, start.x, start.y, 0);
    position = start;
    void cursor.offsetWidth; // Commit the start position before animating.
  }

  const wasHidden = !cursor.classList.contains("visible");
  keepVisible(cursor);
  if (wasHidden) await sleep(150); // Let it fade in before it starts to move.

  const distance = Math.hypot(x - position.x, y - position.y);
  // Slow enough to follow by eye: ~0.3s for short hops, up to 0.9s across the screen.
  const duration = distance < 2 ? 0 : Math.min(900, 280 + distance * 0.5);

  placeAt(cursor, x, y, duration);
  position = { x, y };
  await sleep(duration + 40);
}

/** Show a press + ripple at (x, y), moving there first if needed. */
export async function clickCursor(
  x: number,
  y: number,
  button: "left" | "right" | "middle",
): Promise<void> {
  if (!position || position.x !== x || position.y !== y) {
    await moveCursor(x, y);
  }
  const { cursor, ripples } = ensureOverlay();
  keepVisible(cursor);

  const ripple = document.createElement("div");
  ripple.className = button === "right" ? "ripple right" : "ripple";
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  ripples.appendChild(ripple);
  setTimeout(() => ripple.remove(), 800);

  cursor.classList.add("pressed");
  setTimeout(() => cursor.classList.remove("pressed"), 220);
  await sleep(180);
}

/** Show a scroll-wheel badge on the cursor while the page scrolls. */
export async function scrollCursor(
  x: number,
  y: number,
  direction: ScrollDirection,
): Promise<void> {
  if (!position || position.x !== x || position.y !== y) {
    await moveCursor(x, y);
  }
  const { cursor } = ensureOverlay();
  keepVisible(cursor);
  cursor.classList.remove("scroll-up", "scroll-down", "scroll-left", "scroll-right");
  cursor.classList.add("scrolling", `scroll-${direction}`);
  if (scrollTimer !== null) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    cursor.classList.remove("scrolling", `scroll-${direction}`);
  }, 1100);
  await sleep(200);
}

export function cursorPosition(): { x: number; y: number } | null {
  return position;
}
