import { z } from "zod";

const MAX_BUFFER_SIZE = 500;
const DEBUGGER_PROTOCOL_VERSION = "1.3";

export interface ConsoleEntry {
  level: string;
  text: string;
  source: "console" | "exception" | "log";
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failed?: boolean;
  errorText?: string;
  timestamp: number;
}

export interface FileChooserEvent {
  backendNodeId: number;
  mode: string;
  frameId: string;
}

interface FileChooserWaiter {
  resolve: (event: FileChooserEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RemoteObjectSchema = z.object({
  type: z.string(),
  value: z.unknown().optional(),
  description: z.string().optional(),
});

const StackFrameSchema = z.object({
  url: z.string().optional(),
  lineNumber: z.number().optional(),
});

const ConsoleAPICalledSchema = z.object({
  type: z.string(),
  args: z.array(RemoteObjectSchema).default([]),
  timestamp: z.number().optional(),
  stackTrace: z
    .object({
      callFrames: z.array(StackFrameSchema).default([]),
    })
    .optional(),
});

const ExceptionThrownSchema = z.object({
  timestamp: z.number().optional(),
  exceptionDetails: z.object({
    text: z.string(),
    url: z.string().optional(),
    lineNumber: z.number().optional(),
    exception: RemoteObjectSchema.optional(),
  }),
});

const LogEntryAddedSchema = z.object({
  entry: z.object({
    level: z.string(),
    text: z.string(),
    timestamp: z.number().optional(),
    url: z.string().optional(),
    lineNumber: z.number().optional(),
  }),
});

const NetworkRequestWillBeSentSchema = z.object({
  requestId: z.string(),
  request: z.object({
    url: z.string(),
    method: z.string(),
  }),
  type: z.string().optional(),
  wallTime: z.number().optional(),
});

const NetworkResponseReceivedSchema = z.object({
  requestId: z.string(),
  response: z.object({
    status: z.number(),
    statusText: z.string().optional(),
    mimeType: z.string().optional(),
  }),
});

const NetworkLoadingFailedSchema = z.object({
  requestId: z.string(),
  errorText: z.string().optional(),
});

const FileChooserOpenedSchema = z.object({
  backendNodeId: z.number().int(),
  mode: z.string().default("selectSingle"),
  frameId: z.string().default(""),
});

function formatRemoteObject(obj: z.infer<typeof RemoteObjectSchema>): string {
  if (obj.value !== undefined) {
    if (typeof obj.value === "string") {
      return obj.value;
    }
    try {
      return JSON.stringify(obj.value);
    } catch {
      return String(obj.value);
    }
  }
  if (obj.description !== undefined) {
    return obj.description;
  }
  return `[${obj.type}]`;
}

function pushRing<T>(buffer: T[], item: T): void {
  buffer.push(item);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
  }
}

function compileRegex(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${label} regex "${pattern}": ${detail}`);
  }
}

export class DebuggerSessionManager {
  private readonly attachedTabs = new Set<number>();
  private readonly attachingPromises = new Map<number, Promise<void>>();
  private readonly consoleLogs = new Map<number, ConsoleEntry[]>();
  private readonly networkRequests = new Map<number, NetworkEntry[]>();
  private readonly networkById = new Map<number, Map<string, NetworkEntry>>();
  private readonly fileChooserWaiters = new Map<number, Set<FileChooserWaiter>>();

  constructor() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId !== undefined) {
        this.handleEvent(source.tabId, method, params);
      }
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined) {
        this.attachedTabs.delete(source.tabId);
        this.rejectFileChooserWaiters(
          source.tabId,
          new Error(`Debugger detached from tab ${source.tabId}: ${reason}`),
        );
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.attachedTabs.delete(tabId);
      this.consoleLogs.delete(tabId);
      this.networkRequests.delete(tabId);
      this.networkById.delete(tabId);
      this.rejectFileChooserWaiters(tabId, new Error(`Tab ${tabId} was closed`));
    });
  }

  async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) {
      return;
    }

    const inflight = this.attachingPromises.get(tabId);
    if (inflight) {
      return inflight;
    }

    const promise = this.attachAndEnable(tabId).finally(() => {
      this.attachingPromises.delete(tabId);
    });
    this.attachingPromises.set(tabId, promise);
    return promise;
  }

  private async attachAndEnable(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already attached/i.test(msg)) {
        throw err;
      }
    }

    const domains = ["DOM", "Runtime", "Log", "Network", "Page"] as const;
    for (const domain of domains) {
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
    }

    this.attachedTabs.add(tabId);
  }

  async send<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    await this.ensureAttached(tabId);
    try {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return (result ?? {}) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/debugger is not attached|not attached/i.test(msg)) {
        this.attachedTabs.delete(tabId);
        await this.ensureAttached(tabId);
        const retryResult = await chrome.debugger.sendCommand({ tabId }, method, params);
        return (retryResult ?? {}) as T;
      }
      throw err;
    }
  }

  async detach(tabId: number): Promise<void> {
    this.attachedTabs.delete(tabId);
    this.rejectFileChooserWaiters(tabId, new Error(`Debugger detached from tab ${tabId}`));
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached or tab closed.
    }
  }

  waitForFileChooser(tabId: number, timeoutMs: number): Promise<FileChooserEvent> {
    return new Promise<FileChooserEvent>((resolve, reject) => {
      let waiters = this.fileChooserWaiters.get(tabId);
      if (!waiters) {
        waiters = new Set<FileChooserWaiter>();
        this.fileChooserWaiters.set(tabId, waiters);
      }

      const waiter: FileChooserWaiter = {
        resolve: (event) => {
          clearTimeout(waiter.timer);
          waiters?.delete(waiter);
          resolve(event);
        },
        reject: (err) => {
          clearTimeout(waiter.timer);
          waiters?.delete(waiter);
          reject(err);
        },
        timer: setTimeout(() => {
          waiters?.delete(waiter);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for file chooser dialog on tab ${tabId}`,
            ),
          );
        }, timeoutMs),
      };

      waiters.add(waiter);
    });
  }

  getConsoleMessages(
    tabId: number,
    opts: {
      pattern?: string;
      onlyErrors: boolean;
      clear: boolean;
      limit: number;
    },
  ): {
    tabId: number;
    count: number;
    totalBuffered: number;
    messages: ConsoleEntry[];
  } {
    const buffer = this.consoleLogs.get(tabId) ?? [];
    const totalBuffered = buffer.length;
    const regex = opts.pattern ? compileRegex(opts.pattern, "pattern") : null;

    let filtered = buffer;
    if (opts.onlyErrors) {
      filtered = filtered.filter((m) => m.level === "error" || m.level === "assert");
    }
    if (regex) {
      filtered = filtered.filter(
        (m) => regex.test(m.text) || (m.url !== undefined && regex.test(m.url)),
      );
    }

    const messages = filtered.slice(-opts.limit);
    if (opts.clear) {
      this.consoleLogs.set(tabId, []);
    }

    return {
      tabId,
      count: messages.length,
      totalBuffered,
      messages,
    };
  }

  getNetworkRequests(
    tabId: number,
    opts: {
      urlPattern?: string;
      clear: boolean;
      limit: number;
    },
  ): {
    tabId: number;
    count: number;
    totalBuffered: number;
    requests: NetworkEntry[];
  } {
    const buffer = this.networkRequests.get(tabId) ?? [];
    const totalBuffered = buffer.length;
    const regex = opts.urlPattern ? compileRegex(opts.urlPattern, "urlPattern") : null;

    const filtered = regex ? buffer.filter((r) => regex.test(r.url)) : buffer;
    const requests = filtered.slice(-opts.limit);

    if (opts.clear) {
      this.networkRequests.set(tabId, []);
      this.networkById.delete(tabId);
    }

    return {
      tabId,
      count: requests.length,
      totalBuffered,
      requests,
    };
  }

  private getOrCreateConsoleBuffer(tabId: number): ConsoleEntry[] {
    let buffer = this.consoleLogs.get(tabId);
    if (!buffer) {
      buffer = [];
      this.consoleLogs.set(tabId, buffer);
    }
    return buffer;
  }

  private getOrCreateNetworkBuffers(tabId: number): {
    list: NetworkEntry[];
    byId: Map<string, NetworkEntry>;
  } {
    let list = this.networkRequests.get(tabId);
    if (!list) {
      list = [];
      this.networkRequests.set(tabId, list);
    }
    let byId = this.networkById.get(tabId);
    if (!byId) {
      byId = new Map<string, NetworkEntry>();
      this.networkById.set(tabId, byId);
    }
    return { list, byId };
  }

  private rejectFileChooserWaiters(tabId: number, error: Error): void {
    const waiters = this.fileChooserWaiters.get(tabId);
    if (!waiters) {
      return;
    }
    for (const waiter of [...waiters]) {
      waiter.reject(error);
    }
    this.fileChooserWaiters.delete(tabId);
  }

  private handleEvent(tabId: number, method: string, params: unknown): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const parsed = ConsoleAPICalledSchema.safeParse(params);
        if (!parsed.success) return;
        const topFrame = parsed.data.stackTrace?.callFrames[0];
        const entry: ConsoleEntry = {
          level: parsed.data.type,
          text: parsed.data.args.map(formatRemoteObject).join(" "),
          source: "console",
          timestamp: parsed.data.timestamp ?? Date.now(),
          url: topFrame?.url,
          lineNumber: topFrame?.lineNumber,
        };
        pushRing(this.getOrCreateConsoleBuffer(tabId), entry);
        break;
      }

      case "Runtime.exceptionThrown": {
        const parsed = ExceptionThrownSchema.safeParse(params);
        if (!parsed.success) return;
        const details = parsed.data.exceptionDetails;
        const text = details.exception
          ? formatRemoteObject(details.exception)
          : details.text;
        const entry: ConsoleEntry = {
          level: "error",
          text,
          source: "exception",
          timestamp: parsed.data.timestamp ?? Date.now(),
          url: details.url,
          lineNumber: details.lineNumber,
        };
        pushRing(this.getOrCreateConsoleBuffer(tabId), entry);
        break;
      }

      case "Log.entryAdded": {
        const parsed = LogEntryAddedSchema.safeParse(params);
        if (!parsed.success) return;
        const entry: ConsoleEntry = {
          level: parsed.data.entry.level,
          text: parsed.data.entry.text,
          source: "log",
          timestamp: parsed.data.entry.timestamp ?? Date.now(),
          url: parsed.data.entry.url,
          lineNumber: parsed.data.entry.lineNumber,
        };
        pushRing(this.getOrCreateConsoleBuffer(tabId), entry);
        break;
      }

      case "Network.requestWillBeSent": {
        const parsed = NetworkRequestWillBeSentSchema.safeParse(params);
        if (!parsed.success) return;
        const { list, byId } = this.getOrCreateNetworkBuffers(tabId);
        const entry: NetworkEntry = {
          requestId: parsed.data.requestId,
          url: parsed.data.request.url,
          method: parsed.data.request.method,
          resourceType: parsed.data.type,
          timestamp: parsed.data.wallTime
            ? Math.round(parsed.data.wallTime * 1000)
            : Date.now(),
        };
        pushRing(list, entry);
        byId.set(entry.requestId, entry);
        if (byId.size > MAX_BUFFER_SIZE * 2) {
          const activeIds = new Set(list.map((item) => item.requestId));
          for (const key of byId.keys()) {
            if (!activeIds.has(key)) {
              byId.delete(key);
            }
          }
        }
        break;
      }

      case "Network.responseReceived": {
        const parsed = NetworkResponseReceivedSchema.safeParse(params);
        if (!parsed.success) return;
        const existing = this.networkById.get(tabId)?.get(parsed.data.requestId);
        if (existing) {
          existing.status = parsed.data.response.status;
          existing.statusText = parsed.data.response.statusText;
          existing.mimeType = parsed.data.response.mimeType;
        }
        break;
      }

      case "Network.loadingFailed": {
        const parsed = NetworkLoadingFailedSchema.safeParse(params);
        if (!parsed.success) return;
        const existing = this.networkById.get(tabId)?.get(parsed.data.requestId);
        if (existing) {
          existing.failed = true;
          existing.errorText = parsed.data.errorText;
        }
        break;
      }

      case "Page.fileChooserOpened": {
        const parsed = FileChooserOpenedSchema.safeParse(params);
        if (!parsed.success) return;
        const waiters = this.fileChooserWaiters.get(tabId);
        if (!waiters || waiters.size === 0) return;
        for (const waiter of [...waiters]) {
          waiter.resolve(parsed.data);
        }
        break;
      }

      default:
        break;
    }
  }
}
