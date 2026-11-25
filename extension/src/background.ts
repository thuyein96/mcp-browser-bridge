import { z } from "zod";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  WireMessageSchema,
  type BridgeCommand,
  type BridgeResponseEnvelope,
  type ExtensionHello,
  type ScreenshotResult,
  type TabInfo,
} from "../../shared/protocol";
import { sendToContentScript } from "./content-bridge";
import { DebuggerSessionManager, DebuggerUnavailableError } from "./debugger-session";
import {
  PopupRequestSchema,
  ResolveRefDataSchema,
  ViewportDataSchema,
  type ActivityEntry,
  type ContentRequest,
  type PopupState,
} from "./internal-messages";

type SyntheticMouseRequest = Extract<ContentRequest, { type: "ccb_synthetic_mouse" }>;
import { executeFileUpload } from "./uploader";

const KEEPALIVE_ALARM = "ccb-keepalive";
const STORAGE_PORT_KEY = "bridgePort";
const BACKOFF_MS = [1000, 2000, 5000] as const;
const MAX_ACTIVITY = 25;

const debuggerMgr = new DebuggerSessionManager();

let bridgePort = DEFAULT_BRIDGE_PORT;
let socket: WebSocket | null = null;
let connected = false;
let connecting = false;
let lastError: string | null = null;
let backoffIndex = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
const activityLog: ActivityEntry[] = [];

const ScreenshotCdpSchema = z.object({
  data: z.string().min(1),
});

const LayoutMetricsSchema = z.object({
  cssLayoutViewport: z
    .object({
      clientWidth: z.number(),
      clientHeight: z.number(),
    })
    .optional(),
  layoutViewport: z
    .object({
      clientWidth: z.number(),
      clientHeight: z.number(),
    })
    .optional(),
});

const RuntimeEvalResultSchema = z.object({
  result: z.object({
    type: z.string(),
    subtype: z.string().optional(),
    value: z.unknown().optional(),
    description: z.string().optional(),
  }),
  exceptionDetails: z
    .object({
      text: z.string(),
      exception: z
        .object({
          description: z.string().optional(),
          value: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
});

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 },
  f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 },
  f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 },
  f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
  f12: { key: "F12", code: "F12", keyCode: 123 },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8,
};

function parseModifierBitmask(modifiers?: string): number {
  if (!modifiers) return 0;
  let mask = 0;
  for (const raw of modifiers.split(/[+,\s]+/)) {
    const bit = MODIFIER_BITS[raw.trim().toLowerCase()];
    if (bit !== undefined) {
      mask |= bit;
    }
  }
  return mask;
}

function resolveKeySpec(token: string): KeySpec {
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return named;

  if (token.length === 1) {
    const upper = token.toUpperCase();
    const charCode = upper.charCodeAt(0);
    if (charCode >= 65 && charCode <= 90) {
      return {
        key: token,
        code: `Key${upper}`,
        keyCode: charCode,
        text: token,
      };
    }
    if (charCode >= 48 && charCode <= 57) {
      return {
        key: token,
        code: `Digit${token}`,
        keyCode: charCode,
        text: token,
      };
    }
    return {
      key: token,
      code: token,
      keyCode: token.charCodeAt(0),
      text: token,
    };
  }

  return { key: token, code: token, keyCode: 0 };
}

function recordActivity(entry: ActivityEntry): void {
  activityLog.unshift(entry);
  if (activityLog.length > MAX_ACTIVITY) {
    activityLog.length = MAX_ACTIVITY;
  }
}

function summarizeCommandTarget(command: BridgeCommand): string {
  switch (command.method) {
    case "tabs_context":
      return "all tabs";
    case "tabs_create":
      return command.params.url ?? "new tab";
    case "tabs_close":
      return `tab ${command.params.tabId}`;
    case "navigate":
      return command.params.url;
    case "read_page":
      return command.params.refId ?? command.params.filter;
    case "get_page_text":
      return `max ${command.params.maxChars}`;
    case "find":
      return command.params.query;
    case "computer":
      return command.params.action;
    case "form_input":
      return command.params.ref;
    case "file_upload":
      return `${command.params.files.length} file(s) [${command.params.mode}]`;
    case "javascript_tool":
      return command.params.code.slice(0, 40).replace(/\s+/g, " ");
    case "read_console_messages":
      return command.params.onlyErrors ? "errors" : "all";
    case "read_network_requests":
      return command.params.urlPattern ?? "all";
    case "resize_window":
      return `${command.params.width}x${command.params.height}`;
    default: {
      const _exhaustive: never = command;
      return String(_exhaustive);
    }
  }
}

function toTabInfo(tab: chrome.tabs.Tab): TabInfo | null {
  if (tab.id === undefined || tab.windowId === undefined) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: Boolean(tab.active),
    status: tab.status,
  };
}

async function resolveTabId(tabId?: number): Promise<number> {
  if (tabId !== undefined) return tabId;

  const focused = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const focusedId = focused[0]?.id;
  if (focusedId !== undefined) return focusedId;

  const anyActive = await chrome.tabs.query({ active: true });
  const anyActiveId = anyActive[0]?.id;
  if (anyActiveId !== undefined) return anyActiveId;

  const all = await chrome.tabs.query({});
  const first = all.find((t) => t.id !== undefined);
  if (first?.id !== undefined) return first.id;

  throw new Error("No active Chrome tab found");
}

function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveCoordinate(
  tabId: number,
  coordinate?: [number, number],
  ref?: string,
): Promise<[number, number]> {
  if (coordinate) {
    return coordinate;
  }
  if (ref) {
    const raw = await sendToContentScript(tabId, {
      type: "ccb_resolve_ref",
      ref,
    });
    const parsed = ResolveRefDataSchema.parse(raw);
    return [parsed.x, parsed.y];
  }
  throw new Error('Action requires either "coordinate" or "ref"');
}

async function dispatchMouseClicks(
  tabId: number,
  x: number,
  y: number,
  button: "left" | "right" | "middle",
  clickCount: number,
  modifiers: number,
): Promise<void> {
  const buttonsMask = button === "left" ? 1 : button === "right" ? 2 : 4;

  await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    modifiers,
  });

  for (let i = 1; i <= clickCount; i++) {
    await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: buttonsMask,
      clickCount: i,
      modifiers,
    });
    await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: i,
      modifiers,
    });
  }
}

async function dispatchKeyChord(
  tabId: number,
  chord: string,
  extraModifiers: number,
): Promise<void> {
  const parts = chord.split("+").filter(Boolean);
  let modifiers = extraModifiers;
  let primaryToken: string | null = null;

  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (bit !== undefined) {
      modifiers |= bit;
    } else {
      primaryToken = part;
    }
  }

  if (!primaryToken) {
    throw new Error(`Invalid key specification "${chord}"`);
  }

  const spec = resolveKeySpec(primaryToken);
  const hasShortcutMod = (modifiers & (2 | 4)) !== 0;
  const sendText = !hasShortcutMod ? spec.text : undefined;

  await debuggerMgr.send(tabId, "Input.dispatchKeyEvent", {
    type: sendText ? "keyDown" : "rawKeyDown",
    modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    ...(sendText ? { text: sendText, unmodifiedText: sendText } : {}),
  });

  await debuggerMgr.send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  });
}

async function dispatchDrag(
  tabId: number,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  modifiers: number,
): Promise<void> {
  await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: sx,
    y: sy,
    modifiers,
  });
  await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: sx,
    y: sy,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(sx + ((ex - sx) * i) / steps),
      y: Math.round(sy + ((ey - sy) * i) / steps),
      button: "left",
      buttons: 1,
      modifiers,
    });
  }
  await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: ex,
    y: ey,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers,
  });
}

// ---------------------------------------------------------------------------
// Visible cursor
// ---------------------------------------------------------------------------

type MouseButtonName = "left" | "right" | "middle";

/** Last cursor spot per tab, so a new page's cursor starts where the old one was. */
const cursorPositions = new Map<number, { x: number; y: number }>();
/** Last cursor spot in any tab, for tabs that have never shown the cursor. */
let lastCursor: { x: number; y: number } | null = null;
chrome.tabs.onRemoved.addListener((tabId) => cursorPositions.delete(tabId));

async function showCursor(
  tabId: number,
  op: "move" | "click" | "scroll" | "show",
  x: number,
  y: number,
  extra: { button?: MouseButtonName; direction?: "up" | "down" | "left" | "right" } = {},
): Promise<void> {
  const from = cursorPositions.get(tabId) ?? lastCursor ?? undefined;
  cursorPositions.set(tabId, { x, y });
  lastCursor = { x, y };
  try {
    await sendToContentScript(tabId, {
      type: "ccb_cursor",
      op,
      x,
      y,
      button: extra.button,
      direction: extra.direction,
      fromX: from?.x,
      fromY: from?.y,
    });
  } catch {
    // The cursor is cosmetic; pages that block content scripts
    // (chrome://, Web Store) still get the real input.
  }
}

/** After a page load, bring the cursor back where it was so it doesn't vanish. */
async function reshowCursorAfterLoad(tabId: number): Promise<void> {
  const at = cursorPositions.get(tabId) ?? lastCursor;
  if (!at) return;
  await showCursor(tabId, "show", at.x, at.y);
}

async function viewportCenter(tabId: number): Promise<[number, number]> {
  try {
    const vp = ViewportDataSchema.parse(
      await sendToContentScript(tabId, { type: "ccb_viewport" }),
    );
    return [Math.round(vp.width / 2), Math.round(vp.height / 2)];
  } catch {
    return [400, 400];
  }
}

// ---------------------------------------------------------------------------
// CDP-blocked fallbacks
// ---------------------------------------------------------------------------

type InputVia = "cdp" | "synthetic";

/**
 * Run real input through CDP; if Chrome refuses to attach the debugger to the
 * tab, deliver DOM events from the content script instead.
 */
async function viaCdpOrSynthetic(
  tabId: number,
  cdp: () => Promise<void>,
  synthetic: ContentRequest,
): Promise<{ via: InputVia; target?: unknown }> {
  try {
    await cdp();
    return { via: "cdp" };
  } catch (err) {
    if (!(err instanceof DebuggerUnavailableError)) throw err;
    const target = await sendToContentScript(tabId, synthetic);
    return { via: "synthetic", target };
  }
}

function syntheticMouse(
  kind: SyntheticMouseRequest["kind"],
  x: number,
  y: number,
  extra: Partial<Omit<SyntheticMouseRequest, "type" | "kind" | "x" | "y">> = {},
): SyntheticMouseRequest {
  return {
    type: "ccb_synthetic_mouse",
    kind,
    x,
    y,
    button: "left",
    clickCount: 1,
    modifiers: 0,
    deltaX: 0,
    deltaY: 0,
    ...extra,
  };
}

function syntheticKeyRequest(chord: string, extraModifiers: number): ContentRequest {
  let modifiers = extraModifiers;
  let primary: string | null = null;
  for (const part of chord.split("+").filter(Boolean)) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (bit !== undefined) modifiers |= bit;
    else primary = part;
  }
  if (!primary) throw new Error(`Invalid key specification "${chord}"`);
  const spec = resolveKeySpec(primary);
  return {
    type: "ccb_synthetic_key",
    key: spec.key,
    code: spec.code,
    keyCode: spec.keyCode,
    text: spec.text,
    modifiers,
  };
}

async function captureViaCdp(tabId: number): Promise<ScreenshotResult> {
  const rawShot = await debuggerMgr.send(tabId, "Page.captureScreenshot", {
    format: "png",
  });
  const shot = ScreenshotCdpSchema.parse(rawShot);
  let width: number | undefined;
  let height: number | undefined;
  try {
    const rawMetrics = await debuggerMgr.send(tabId, "Page.getLayoutMetrics");
    const metrics = LayoutMetricsSchema.safeParse(rawMetrics);
    if (metrics.success) {
      const vp = metrics.data.cssLayoutViewport ?? metrics.data.layoutViewport;
      if (vp) {
        width = Math.round(vp.clientWidth);
        height = Math.round(vp.clientHeight);
      }
    }
  } catch {
    // Layout metrics are optional.
  }
  return { tabId, mimeType: "image/png", base64: shot.data, width, height };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Scale a device-pixel PNG down to CSS pixels so image coords match click coords. */
async function scalePng(base64: string, width: number, height: number): Promise<string> {
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width === width && bitmap.height === height) return base64;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return base64;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const out = await canvas.convertToBlob({ type: "image/png" });
  return bytesToBase64(new Uint8Array(await out.arrayBuffer()));
}

/** Screenshot without the debugger: captureVisibleTab on the (activated) tab. */
async function captureViaTabs(tabId: number): Promise<ScreenshotResult> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  let base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  let width: number | undefined;
  let height: number | undefined;
  try {
    const vp = ViewportDataSchema.parse(
      await sendToContentScript(tabId, { type: "ccb_viewport" }),
    );
    width = Math.round(vp.width);
    height = Math.round(vp.height);
    base64 = await scalePng(base64, width, height);
  } catch {
    // Keep the device-pixel image if the viewport size is unavailable.
  }
  return { tabId, mimeType: "image/png", base64, width, height };
}

async function evaluateViaCdp(
  tabId: number,
  code: string,
): Promise<{ value: unknown; type: string; subtype?: string }> {
  const evaluate = async (expression: string) => {
    const raw = await debuggerMgr.send(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      // Console semantics: let/const may be redeclared across calls.
      replMode: true,
    });
    return RuntimeEvalResultSchema.parse(raw);
  };

  let outcome = await evaluate(code);
  if (outcome.exceptionDetails) {
    const errDesc =
      outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text;
    if (/SyntaxError/i.test(errDesc)) {
      outcome = await evaluate(`(async () => {\n${code}\n})()`);
    }
  }

  if (outcome.exceptionDetails) {
    const detail =
      outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text;
    throw new Error(`JavaScript evaluation failed: ${detail}`);
  }

  return {
    value:
      outcome.result.value !== undefined
        ? outcome.result.value
        : (outcome.result.description ?? null),
    type: outcome.result.type,
    subtype: outcome.result.subtype,
  };
}

const MainWorldResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.unknown(),
    type: z.string(),
    subtype: z.string().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

interface UserScriptsExecuteApi {
  execute(details: {
    target: { tabId: number };
    world: "MAIN" | "USER_SCRIPT";
    js: Array<{ code: string }>;
    injectImmediately?: boolean;
  }): Promise<Array<{ result?: unknown; error?: string }>>;
}

const USER_SCRIPTS_HINT =
  "Turn on \"Allow User Scripts\" for MCP Browser Bridge for Claude Code in chrome://extensions → Details " +
  "to run JavaScript on pages whose CSP forbids eval while the debugger is blocked.";

/**
 * JavaScript without the debugger, via chrome.userScripts.execute: the code is
 * injected as a real script, so page CSPs without 'unsafe-eval' (Facebook,
 * Hacker News) don't block it. Returns null when the API is not enabled.
 */
async function evaluateViaUserScripts(
  tabId: number,
  code: string,
): Promise<{ value: unknown; type: string; via: "userScripts" } | null> {
  const api = (chrome as unknown as { userScripts?: Partial<UserScriptsExecuteApi> })
    .userScripts;
  if (typeof api?.execute !== "function") return null;
  const execute = api.execute.bind(api);

  const run = async (source: string) => {
    const [injection] = await execute({
      target: { tabId },
      world: "MAIN",
      js: [{ code: source }],
      injectImmediately: true,
    });
    return injection;
  };

  // userScripts.execute reports neither thrown exceptions nor syntax errors:
  // both just yield an empty result. So the code is wrapped to (a) return
  // thrown errors as a marker object and (b) set a per-call run flag, which
  // tells "did not parse" apart from "ran and produced undefined" without
  // ever running the code twice.
  const ERROR_KEY = "__ccbError";
  const catchClause = `catch (__ccbErr) { RET({ ${ERROR_KEY}: String((__ccbErr && __ccbErr.stack) || __ccbErr) }) }`;
  const flagFor = (nonce: string) => `void (globalThis.__ccbJsRun = ${JSON.stringify(nonce)});`;

  const ranWith = async (nonce: string): Promise<boolean> =>
    (await run("globalThis.__ccbJsRun"))?.result === nonce;

  const unwrap = (injection: { result?: unknown; error?: string } | undefined): unknown => {
    if (injection?.error) throw new Error(`JavaScript evaluation failed: ${injection.error}`);
    const result = injection?.result;
    if (result && typeof result === "object" && ERROR_KEY in result) {
      throw new Error(`JavaScript evaluation failed: ${String((result as Record<string, unknown>)[ERROR_KEY])}`);
    }
    return result;
  };

  // 1. As a script: the try block keeps let/const out of the page's shared
  //    global scope and its completion value is the last statement's value.
  const scriptNonce = crypto.randomUUID();
  let value = unwrap(
    await run(
      `try {\n${flagFor(scriptNonce)}\n${code}\n} ${catchClause.replace("RET", "")}`,
    ),
  );

  // 2. Didn't parse as a script (top-level await/return): async function body.
  if (value == null && !(await ranWith(scriptNonce))) {
    const asyncNonce = crypto.randomUUID();
    value = unwrap(
      await run(
        `(async () => { ${flagFor(asyncNonce)} try {\n${code}\n} ${catchClause.replace("RET", "return ")} })()`,
      ),
    );
    if (value == null && !(await ranWith(asyncNonce))) {
      throw new Error(
        "JavaScript evaluation failed: SyntaxError (the page's DevTools console has the details)",
      );
    }
  }

  return { value: value === undefined ? null : value, type: typeof value, via: "userScripts" };
}

/** JavaScript without the debugger: userScripts if enabled, else scripting + eval. */
async function evaluateInMainWorld(
  tabId: number,
  code: string,
): Promise<{ value: unknown; type: string; subtype?: string; via: "userScripts" | "scripting" }> {
  const viaUserScripts = await evaluateViaUserScripts(tabId, code);
  if (viaUserScripts) return viaUserScripts;
  return evaluateViaScriptingEval(tabId, code);
}

/** chrome.scripting in the main world; subject to the page's CSP (needs 'unsafe-eval'). */
async function evaluateViaScriptingEval(
  tabId: number,
  code: string,
): Promise<{ value: unknown; type: string; subtype?: string; via: "scripting" }> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [code],
    // Serialized into the page: must not reference anything outside itself.
    func: async (source: string) => {
      const indirectEval = eval;
      try {
        let value: unknown;
        try {
          value = indirectEval(source);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          value = indirectEval(`(async () => {\n${source}\n})()`);
        }
        value = await value;
        const subtype =
          value === null
            ? "null"
            : Array.isArray(value)
              ? "array"
              : value instanceof Node
                ? "node"
                : undefined;
        let out: unknown;
        if (value instanceof Element) {
          out = value.outerHTML.slice(0, 500);
        } else {
          try {
            out = value === undefined ? null : JSON.parse(JSON.stringify(value));
          } catch {
            out = String(value);
          }
        }
        return { ok: true as const, value: out, type: typeof value, subtype };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        };
      }
    },
  });

  const parsed = MainWorldResultSchema.safeParse(injection?.result);
  if (!parsed.success) {
    throw new Error("JavaScript evaluation returned no result (page may block scripting)");
  }
  if (!parsed.data.ok) {
    const hint = /unsafe-eval|Content Security Policy/i.test(parsed.data.error)
      ? ` (this page's CSP forbids eval and the debugger is blocked on this tab. ${USER_SCRIPTS_HINT})`
      : "";
    throw new Error(`JavaScript evaluation failed: ${parsed.data.error}${hint}`);
  }
  return {
    value: parsed.data.value,
    type: parsed.data.type,
    subtype: parsed.data.subtype,
    via: "scripting",
  };
}

type CommandByMethod<M extends BridgeCommand["method"]> = Extract<
  BridgeCommand,
  { method: M }
>;

type CommandHandlers = {
  [M in BridgeCommand["method"]]: (
    params: CommandByMethod<M>["params"],
  ) => Promise<unknown>;
};

const handlers: CommandHandlers = {
  async tabs_context() {
    const tabs = await chrome.tabs.query({});
    const mapped = tabs
      .map(toTabInfo)
      .filter((t): t is TabInfo => t !== null);
    const focused = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const activeTabId = focused[0]?.id ?? mapped.find((t) => t.active)?.id ?? null;
    const allowedFileAccess = await chrome.extension.isAllowedFileSchemeAccess();
    return { activeTabId, allowedFileAccess, tabs: mapped };
  },

  async tabs_create(params) {
    const created = await chrome.tabs.create({
      url: params.url,
      active: params.active ?? true,
    });
    if (created.id === undefined) {
      throw new Error("Created tab has no ID");
    }
    if (params.url && /^https?:\/\//i.test(params.url) && created.status !== "complete") {
      await waitForTabLoad(created.id, 5_000);
      await reshowCursorAfterLoad(created.id);
    }
    const fresh = await chrome.tabs.get(created.id);
    return toTabInfo(fresh);
  },

  async tabs_close(params) {
    await chrome.tabs.remove(params.tabId);
    return { closed: true, tabId: params.tabId };
  },

  async navigate(params) {
    const tabId = await resolveTabId(params.tabId);
    const normalized = params.url.trim();
    const lower = normalized.toLowerCase();

    let isHashOnlyNavigation = false;
    let targetUrl: string | null = null;
    if (lower !== "back" && lower !== "forward" && lower !== "reload") {
      targetUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)
        ? normalized
        : `https://${normalized}`;
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.url) {
          const cur = new URL(currentTab.url);
          const next = new URL(targetUrl);
          if (
            cur.origin === next.origin &&
            cur.pathname === next.pathname &&
            cur.search === next.search &&
            cur.hash !== next.hash
          ) {
            isHashOnlyNavigation = true;
          }
        }
      } catch {
        // Non-URL current tab (e.g., chrome://newtab).
      }
    }

    const loadPromise = isHashOnlyNavigation
      ? sleep(100)
      : waitForTabLoad(tabId, 15_000);

    if (lower === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (lower === "forward") {
      await chrome.tabs.goForward(tabId);
    } else if (lower === "reload") {
      await chrome.tabs.reload(tabId);
    } else if (targetUrl !== null) {
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    await loadPromise;
    await reshowCursorAfterLoad(tabId);
    const updated = await chrome.tabs.get(tabId);
    return toTabInfo(updated);
  },

  async resize_window(params) {
    const tabId = await resolveTabId(params.tabId);
    const tab = await chrome.tabs.get(tabId);
    const updated = await chrome.windows.update(tab.windowId, {
      width: params.width,
      height: params.height,
      state: "normal",
    });
    return {
      windowId: tab.windowId,
      width: updated.width ?? params.width,
      height: updated.height ?? params.height,
    };
  },

  async read_page(params) {
    const tabId = await resolveTabId(params.tabId);
    return sendToContentScript(tabId, {
      type: "ccb_read_page",
      filter: params.filter,
      depth: params.depth,
      refId: params.refId,
      maxChars: params.maxChars,
    });
  },

  async get_page_text(params) {
    const tabId = await resolveTabId(params.tabId);
    return sendToContentScript(tabId, {
      type: "ccb_get_page_text",
      maxChars: params.maxChars,
    });
  },

  async find(params) {
    const tabId = await resolveTabId(params.tabId);
    return sendToContentScript(tabId, {
      type: "ccb_find",
      query: params.query,
      selector: params.selector,
      limit: params.limit,
    });
  },

  async form_input(params) {
    const tabId = await resolveTabId(params.tabId);
    return sendToContentScript(tabId, {
      type: "ccb_form_input",
      ref: params.ref,
      value: params.value,
    });
  },

  async computer(params) {
    const tabId = await resolveTabId(params.tabId);
    const modifiers = parseModifierBitmask(params.modifiers);

    const click = async (
      button: MouseButtonName,
      clickCount: number,
    ): Promise<Record<string, unknown>> => {
      const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
      await showCursor(tabId, "move", x, y);
      await showCursor(tabId, "click", x, y, { button });
      const outcome = await viaCdpOrSynthetic(
        tabId,
        () => dispatchMouseClicks(tabId, x, y, button, clickCount, modifiers),
        syntheticMouse("click", x, y, { button, clickCount, modifiers }),
      );
      return { action: params.action, tabId, x, y, ...outcome };
    };

    switch (params.action) {
      case "screenshot": {
        try {
          return await captureViaCdp(tabId);
        } catch (err) {
          if (!(err instanceof DebuggerUnavailableError)) throw err;
          return captureViaTabs(tabId);
        }
      }

      case "left_click":
        return click("left", 1);
      case "right_click":
        return click("right", 1);
      case "double_click":
        return click("left", 2);
      case "triple_click":
        return click("left", 3);
      case "middle_click":
        return click("middle", 1);

      case "hover": {
        const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        await showCursor(tabId, "move", x, y);
        const outcome = await viaCdpOrSynthetic(
          tabId,
          async () => {
            await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
              modifiers,
            });
          },
          syntheticMouse("move", x, y, { modifiers }),
        );
        return { action: params.action, tabId, x, y, ...outcome };
      }

      case "left_click_drag": {
        if (!params.startCoordinate) {
          throw new Error('left_click_drag requires "startCoordinate"');
        }
        const [sx, sy] = params.startCoordinate;
        const [ex, ey] = await resolveCoordinate(
          tabId,
          params.coordinate,
          params.ref,
        );
        await showCursor(tabId, "move", sx, sy);
        await showCursor(tabId, "click", sx, sy, { button: "left" });
        const [, outcome] = await Promise.all([
          showCursor(tabId, "move", ex, ey),
          viaCdpOrSynthetic(
            tabId,
            () => dispatchDrag(tabId, sx, sy, ex, ey, modifiers),
            syntheticMouse("drag", ex, ey, { startX: sx, startY: sy, modifiers }),
          ),
        ]);
        return { action: params.action, tabId, from: [sx, sy], to: [ex, ey], ...outcome };
      }

      case "scroll": {
        const [x, y] =
          params.coordinate || params.ref
            ? await resolveCoordinate(tabId, params.coordinate, params.ref)
            : await viewportCenter(tabId);
        const distance = (params.scrollAmount ?? 3) * 120;
        const dir = params.scrollDirection ?? "down";
        await showCursor(tabId, "move", x, y);
        await showCursor(tabId, "scroll", x, y, { direction: dir });
        const deltaX = dir === "left" ? -distance : dir === "right" ? distance : 0;
        const deltaY = dir === "up" ? -distance : dir === "down" ? distance : 0;
        const outcome = await viaCdpOrSynthetic(
          tabId,
          async () => {
            await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x,
              y,
              deltaX,
              deltaY,
              modifiers,
            });
            await sleep(350); // Let the wheel animation play before the next action.
          },
          syntheticMouse("scroll", x, y, { deltaX, deltaY, modifiers }),
        );
        return { action: params.action, tabId, x, y, deltaX, deltaY, ...outcome };
      }

      case "type": {
        if (params.text === undefined) {
          throw new Error('type action requires "text"');
        }
        const text = params.text;
        const outcome = await viaCdpOrSynthetic(
          tabId,
          async () => {
            await debuggerMgr.send(tabId, "Input.insertText", { text });
          },
          { type: "ccb_synthetic_type", text },
        );
        return { action: params.action, tabId, length: text.length, ...outcome };
      }

      case "key": {
        if (!params.text) {
          throw new Error('key action requires "text"');
        }
        const chords = params.text.trim().split(/\s+/).filter(Boolean);
        const repeat = params.repeat ?? 1;
        let via: InputVia = "cdp";
        for (let r = 0; r < repeat; r++) {
          for (const chord of chords) {
            const outcome = await viaCdpOrSynthetic(
              tabId,
              () => dispatchKeyChord(tabId, chord, modifiers),
              syntheticKeyRequest(chord, modifiers),
            );
            via = outcome.via;
          }
        }
        return { action: params.action, tabId, keys: params.text, repeat, via };
      }

      case "wait": {
        const ms = Math.round((params.duration ?? 1) * 1000);
        await sleep(ms);
        return { action: params.action, waitedMs: ms };
      }

      default: {
        const _exhaustive: never = params.action;
        throw new Error(`Unsupported computer action: ${String(_exhaustive)}`);
      }
    }
  },

  async file_upload(params) {
    const tabId = await resolveTabId(params.tabId);
    return executeFileUpload(debuggerMgr, tabId, params);
  },

  async javascript_tool(params) {
    const tabId = await resolveTabId(params.tabId);
    try {
      return await evaluateViaCdp(tabId, params.code);
    } catch (err) {
      if (!(err instanceof DebuggerUnavailableError)) throw err;
      return evaluateInMainWorld(tabId, params.code);
    }
  },

  async read_console_messages(params) {
    const tabId = await resolveTabId(params.tabId);
    await debuggerMgr.ensureAttached(tabId);
    return debuggerMgr.getConsoleMessages(tabId, {
      pattern: params.pattern,
      onlyErrors: params.onlyErrors,
      clear: params.clear,
      limit: params.limit,
    });
  },

  async read_network_requests(params) {
    const tabId = await resolveTabId(params.tabId);
    await debuggerMgr.ensureAttached(tabId);
    return debuggerMgr.getNetworkRequests(tabId, {
      urlPattern: params.urlPattern,
      clear: params.clear,
      limit: params.limit,
    });
  },
};

function dispatchCommand(command: BridgeCommand): Promise<unknown> {
  switch (command.method) {
    case "tabs_context":
      return handlers.tabs_context(command.params);
    case "tabs_create":
      return handlers.tabs_create(command.params);
    case "tabs_close":
      return handlers.tabs_close(command.params);
    case "navigate":
      return handlers.navigate(command.params);
    case "read_page":
      return handlers.read_page(command.params);
    case "get_page_text":
      return handlers.get_page_text(command.params);
    case "find":
      return handlers.find(command.params);
    case "computer":
      return handlers.computer(command.params);
    case "form_input":
      return handlers.form_input(command.params);
    case "file_upload":
      return handlers.file_upload(command.params);
    case "javascript_tool":
      return handlers.javascript_tool(command.params);
    case "read_console_messages":
      return handlers.read_console_messages(command.params);
    case "read_network_requests":
      return handlers.read_network_requests(command.params);
    case "resize_window":
      return handlers.resize_window(command.params);
    default: {
      const _exhaustive: never = command;
      return Promise.reject(new Error(`Unknown command: ${String(_exhaustive)}`));
    }
  }
}

async function updateBadge(isConnected: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: isConnected ? "ON" : "OFF" });
    await chrome.action.setBadgeBackgroundColor({
      color: isConnected ? "#16a34a" : "#64748b",
    });
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  } catch {
    // Badge API may not be ready during early startup.
  }
}

function sendWire(message: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function stopPing(): void {
  if (pingInterval !== null) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function startPing(): void {
  stopPing();
  pingInterval = setInterval(() => {
    sendWire({ type: "ping", ts: Date.now() });
  }, 20_000);
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)] ?? 5000;
  backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

let connectGen = 0;

function disconnectSocket(): void {
  connectGen += 1;
  stopPing();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    const prev = socket;
    socket = null;
    prev.onopen = null;
    prev.onmessage = null;
    prev.onerror = null;
    prev.onclose = null;
    try {
      prev.close();
    } catch {
      // Ignore close errors.
    }
  }
  connected = false;
  connecting = false;
}

async function isBridgeReachable(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(`http://${DEFAULT_BRIDGE_HOST}:${port}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectWebSocket(): Promise<void> {
  if (
    connecting ||
    (socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING))
  ) {
    return;
  }

  connecting = true;
  const gen = ++connectGen;
  const targetPort = bridgePort;
  const url = `ws://${DEFAULT_BRIDGE_HOST}:${targetPort}/ext`;

  const reachable = await isBridgeReachable(targetPort);
  if (gen !== connectGen) {
    return;
  }
  if (!reachable) {
    connecting = false;
    lastError = `Waiting for bridge at ${DEFAULT_BRIDGE_HOST}:${targetPort}`;
    void updateBadge(false);
    scheduleReconnect();
    return;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    connecting = false;
    lastError = err instanceof Error ? err.message : String(err);
    void updateBadge(false);
    scheduleReconnect();
    return;
  }

  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    connected = true;
    connecting = false;
    lastError = null;
    backoffIndex = 0;
    void updateBadge(true);
    startPing();

    void chrome.extension
      .isAllowedFileSchemeAccess()
      .then((allowedFileAccess) => {
        const hello: ExtensionHello = {
          type: "hello",
          version: BRIDGE_PROTOCOL_VERSION,
          extensionId: chrome.runtime.id,
          allowedFileAccess,
          userAgent: navigator.userAgent,
        };
        sendWire(hello);
      });
  };

  ws.onmessage = (event) => {
    if (socket !== ws || typeof event.data !== "string") return;
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(event.data);
    } catch {
      return;
    }

    const parsed = WireMessageSchema.safeParse(rawJson);
    if (!parsed.success) return;

    const msg = parsed.data;
    if (msg.type === "ping") {
      sendWire({ type: "pong", ts: msg.ts });
      return;
    }
    if (msg.type !== "request") {
      return;
    }

    const startedAt = Date.now();
    const target = summarizeCommandTarget(msg.command);

    void dispatchCommand(msg.command)
      .then((result) => {
        const durationMs = Date.now() - startedAt;
        recordActivity({
          id: msg.id,
          method: msg.command.method,
          target,
          status: "ok",
          durationMs,
          timestamp: Date.now(),
        });
        const response: BridgeResponseEnvelope = {
          type: "response",
          id: msg.id,
          ok: true,
          result,
        };
        sendWire(response);
      })
      .catch((err: unknown) => {
        const durationMs = Date.now() - startedAt;
        const errorMessage = err instanceof Error ? err.message : String(err);
        recordActivity({
          id: msg.id,
          method: msg.command.method,
          target,
          status: "error",
          durationMs,
          timestamp: Date.now(),
          detail: errorMessage,
        });
        const response: BridgeResponseEnvelope = {
          type: "response",
          id: msg.id,
          ok: false,
          error: errorMessage,
        };
        sendWire(response);
      });
  };

  ws.onerror = () => {
    if (socket !== ws) return;
    lastError = `Unable to reach bridge at ${url}`;
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    connected = false;
    connecting = false;
    stopPing();
    void updateBadge(false);
    scheduleReconnect();
  };
}

async function buildPopupState(): Promise<PopupState> {
  const allowedFileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  return {
    connected,
    connecting,
    port: bridgePort,
    lastError,
    allowedFileAccess,
    extensionId: chrome.runtime.id,
    activity: [...activityLog],
  };
}

async function loadPortAndConnect(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_PORT_KEY);
    const maybePort = stored[STORAGE_PORT_KEY];
    if (
      typeof maybePort === "number" &&
      Number.isInteger(maybePort) &&
      maybePort >= 1 &&
      maybePort <= 65535
    ) {
      bridgePort = maybePort;
    }
  } catch {
    // Use default bridge port.
  }
  await updateBadge(false);
  connectWebSocket();
}

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendWire({ type: "ping", ts: Date.now() });
  } else {
    connectWebSocket();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  void loadPortAndConnect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  void loadPortAndConnect();
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  const parsed = PopupRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    return false;
  }

  const request = parsed.data;
  const run = async (): Promise<PopupState> => {
    switch (request.type) {
      case "ccb_popup_state":
        return buildPopupState();
      case "ccb_popup_reconnect":
        disconnectSocket();
        backoffIndex = 0;
        connectWebSocket();
        return buildPopupState();
      case "ccb_popup_set_port":
        bridgePort = request.port;
        await chrome.storage.local.set({ [STORAGE_PORT_KEY]: request.port });
        disconnectSocket();
        backoffIndex = 0;
        connectWebSocket();
        return buildPopupState();
      default: {
        const _exhaustive: never = request;
        throw new Error(`Unhandled popup request: ${String(_exhaustive)}`);
      }
    }
  };

  void run()
    .then((state) => sendResponse(state))
    .catch(() => sendResponse(null));

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const change = changes[STORAGE_PORT_KEY];
  if (!change) return;
  const nextPort = change.newValue;
  if (
    typeof nextPort === "number" &&
    Number.isInteger(nextPort) &&
    nextPort >= 1 &&
    nextPort <= 65535 &&
    nextPort !== bridgePort
  ) {
    bridgePort = nextPort;
    disconnectSocket();
    backoffIndex = 0;
    connectWebSocket();
  }
});

void loadPortAndConnect();
