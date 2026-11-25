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
import { DebuggerSessionManager } from "./debugger-session";
import {
  PopupRequestSchema,
  ResolveRefDataSchema,
  type ActivityEntry,
  type PopupState,
} from "./internal-messages";
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

    switch (params.action) {
      case "screenshot": {
        const rawShot = await debuggerMgr.send(tabId, "Page.captureScreenshot", {
          format: "png",
        });
        const shot = ScreenshotCdpSchema.parse(rawShot);
        let width: number | undefined;
        let height: number | undefined;
        try {
          const rawMetrics = await debuggerMgr.send(
            tabId,
            "Page.getLayoutMetrics",
          );
          const metrics = LayoutMetricsSchema.safeParse(rawMetrics);
          if (metrics.success) {
            const vp =
              metrics.data.cssLayoutViewport ?? metrics.data.layoutViewport;
            if (vp) {
              width = Math.round(vp.clientWidth);
              height = Math.round(vp.clientHeight);
            }
          }
        } catch {
          // Layout metrics are optional.
        }
        const result: ScreenshotResult = {
          tabId,
          mimeType: "image/png",
          base64: shot.data,
          width,
          height,
        };
        return result;
      }

      case "left_click": {
        const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        await dispatchMouseClicks(tabId, x, y, "left", 1, modifiers);
        return { action: params.action, tabId, x, y };
      }

      case "right_click": {
        const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        await dispatchMouseClicks(tabId, x, y, "right", 1, modifiers);
        return { action: params.action, tabId, x, y };
      }

      case "double_click": {
        const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        await dispatchMouseClicks(tabId, x, y, "left", 2, modifiers);
        return { action: params.action, tabId, x, y };
      }

      case "triple_click": {
        const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        await dispatchMouseClicks(tabId, x, y, "left", 3, modifiers);
        return { action: params.action, tabId, x, y };
      }

      case "middle_click": {
        const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        await dispatchMouseClicks(tabId, x, y, "middle", 1, modifiers);
        return { action: params.action, tabId, x, y };
      }

      case "hover": {
        const [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          modifiers,
        });
        return { action: params.action, tabId, x, y };
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
          const ix = Math.round(sx + ((ex - sx) * i) / steps);
          const iy = Math.round(sy + ((ey - sy) * i) / steps);
          await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: ix,
            y: iy,
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
        return { action: params.action, tabId, from: [sx, sy], to: [ex, ey] };
      }

      case "scroll": {
        let x = 400;
        let y = 400;
        if (params.coordinate || params.ref) {
          [x, y] = await resolveCoordinate(tabId, params.coordinate, params.ref);
        }
        const distance = (params.scrollAmount ?? 3) * 120;
        const dir = params.scrollDirection ?? "down";
        const deltaX = dir === "left" ? -distance : dir === "right" ? distance : 0;
        const deltaY = dir === "up" ? -distance : dir === "down" ? distance : 0;
        await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX,
          deltaY,
          modifiers,
        });
        return { action: params.action, tabId, x, y, deltaX, deltaY };
      }

      case "type": {
        if (params.text === undefined) {
          throw new Error('type action requires "text"');
        }
        await debuggerMgr.send(tabId, "Input.insertText", {
          text: params.text,
        });
        return { action: params.action, tabId, length: params.text.length };
      }

      case "key": {
        if (!params.text) {
          throw new Error('key action requires "text"');
        }
        const chords = params.text.trim().split(/\s+/).filter(Boolean);
        const repeat = params.repeat ?? 1;
        for (let r = 0; r < repeat; r++) {
          for (const chord of chords) {
            await dispatchKeyChord(tabId, chord, modifiers);
          }
        }
        return { action: params.action, tabId, keys: params.text, repeat };
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
    const evaluate = async (expression: string) => {
      const raw = await debuggerMgr.send(tabId, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      return RuntimeEvalResultSchema.parse(raw);
    };

    let outcome = await evaluate(params.code);
    if (outcome.exceptionDetails) {
      const errDesc =
        outcome.exceptionDetails.exception?.description ??
        outcome.exceptionDetails.text;
      if (/SyntaxError/i.test(errDesc)) {
        outcome = await evaluate(`(async () => {\n${params.code}\n})()`);
      }
    }

    if (outcome.exceptionDetails) {
      const detail =
        outcome.exceptionDetails.exception?.description ??
        outcome.exceptionDetails.text;
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

function disconnectSocket(): void {
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

function connectWebSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  connecting = true;
  const url = `ws://${DEFAULT_BRIDGE_HOST}:${bridgePort}/ext`;
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
