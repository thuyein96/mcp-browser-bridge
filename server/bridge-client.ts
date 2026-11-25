import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  type BridgeCommand,
  type BridgeRequestEnvelope,
  DEFAULT_BRIDGE_HOST,
  type ResolvedUploadFile,
  ResolvedUploadFileSchema,
  WireMessageSchema,
} from "../shared/protocol.js";
import { type BridgeHealth, BridgeHealthSchema, resolveBridgePort } from "./bridge.js";

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const FILE_UPLOAD_TIMEOUT_MS = 300_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const HEALTH_WAIT_DEADLINE_MS = 4_000;
const HEALTH_FETCH_TIMEOUT_MS = 600;
const RECONNECT_DELAY_MS = 500;

const RegisterFilesResponseSchema = z.object({
  files: z.array(ResolvedUploadFileSchema),
});

const ErrorPayloadSchema = z.object({
  error: z.string(),
});

export interface BridgeClientOptions {
  readonly host?: string;
  readonly port?: number;
  readonly bridgeEntryPath?: string;
}

export class BridgeError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function defaultBridgeEntryPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "bridge.js");
}

async function fetchBridgeHealth(host: string, port: number): Promise<BridgeHealth> {
  const response = await fetch(`http://${host}:${port}/health`, {
    signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new BridgeError(`Bridge /health responded with HTTP ${response.status}`);
  }
  const raw: unknown = await response.json();
  return BridgeHealthSchema.parse(raw);
}

export async function ensureBridgeRunning(options?: BridgeClientOptions): Promise<BridgeHealth> {
  const host = options?.host ?? DEFAULT_BRIDGE_HOST;
  const port = resolveBridgePort(options?.port);

  try {
    return await fetchBridgeHealth(host, port);
  } catch {
    // Bridge daemon not yet reachable.
  }

  const entryPath = options?.bridgeEntryPath ?? defaultBridgeEntryPath();
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLAUDE_BROWSER_PORT: String(port),
    },
  });
  child.unref();

  const deadline = Date.now() + HEALTH_WAIT_DEADLINE_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await delay(HEALTH_POLL_INTERVAL_MS);
    try {
      return await fetchBridgeHealth(host, port);
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : "unknown error";
  throw new BridgeError(
    `Timed out waiting for local bridge daemon at http://${host}:${port}/health (${detail}).`,
    "BRIDGE_UNAVAILABLE"
  );
}

export class BridgeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly bridgeEntryPath: string;
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly pending = new Map<string, PendingCall>();

  constructor(options?: BridgeClientOptions) {
    this.host = options?.host ?? DEFAULT_BRIDGE_HOST;
    this.port = resolveBridgePort(options?.port);
    this.bridgeEntryPath = options?.bridgeEntryPath ?? defaultBridgeEntryPath();
  }

  async health(): Promise<BridgeHealth> {
    return fetchBridgeHealth(this.host, this.port);
  }

  async registerFiles(paths: readonly string[]): Promise<ResolvedUploadFile[]> {
    const response = await fetch(`http://${this.host}:${this.port}/register-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });

    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsedErr = ErrorPayloadSchema.safeParse(raw);
      const message = parsedErr.success
        ? parsedErr.data.error
        : `Failed to register files (HTTP ${response.status}).`;
      throw new BridgeError(message, "REGISTER_FILES_FAILED");
    }

    const parsed = RegisterFilesResponseSchema.parse(raw);
    return parsed.files;
  }

  async call(command: BridgeCommand, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      throw new BridgeError("Bridge client is closed.", "CLIENT_CLOSED");
    }

    const effectiveTimeoutMs =
      timeoutMs ?? (command.method === "file_upload" ? FILE_UPLOAD_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS);

    await this.ensureConnected();

    const socket = this.ws;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError("Bridge WebSocket is not connected.", "BRIDGE_DISCONNECTED");
    }

    const id = crypto.randomUUID();
    const envelope: BridgeRequestEnvelope = {
      type: "request",
      id,
      command,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`Bridge command "${command.method}" timed out after ${effectiveTimeoutMs}ms.`, "TIMEOUT"));
      }, effectiveTimeoutMs);
      timer.unref();

      this.pending.set(id, { resolve, reject, timer });

      socket.send(JSON.stringify(envelope), (err) => {
        if (err !== undefined && err !== null) {
          const entry = this.pending.get(id);
          if (entry !== undefined) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            reject(new BridgeError(`Failed to send command to bridge: ${err.message}`, "SEND_FAILED"));
          }
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new BridgeError("Bridge client closed.", "CLIENT_CLOSED"));
    if (this.ws !== null) {
      const socket = this.ws;
      this.ws = null;
      socket.terminate();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      await this.connectSocket();
    } catch {
      await ensureBridgeRunning({
        host: this.host,
        port: this.port,
        bridgeEntryPath: this.bridgeEntryPath,
      });
      await this.connectSocket();
    }
  }

  private connectSocket(): Promise<void> {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connecting !== null) {
      return this.connecting;
    }

    const promise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.host}:${this.port}/mcp`);
      let settled = false;

      socket.once("open", () => {
        settled = true;
        this.ws = socket;
        this.connecting = null;
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        resolve();
      });

      socket.on("message", (data: WebSocket.RawData) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }

        const parsed = WireMessageSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.type !== "response") {
          return;
        }

        const msg = parsed.data;
        const entry = this.pending.get(msg.id);
        if (entry === undefined) {
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);

        if (msg.ok) {
          entry.resolve(msg.result);
        } else {
          entry.reject(new BridgeError(msg.error, msg.code));
        }
      });

      socket.on("close", () => {
        if (this.ws === socket) {
          this.ws = null;
        }
        if (!settled) {
          settled = true;
          this.connecting = null;
          reject(new BridgeError("Bridge WebSocket closed before opening.", "BRIDGE_DISCONNECTED"));
        } else {
          this.rejectAllPending(new BridgeError("Bridge WebSocket connection dropped.", "BRIDGE_DISCONNECTED"));
          this.scheduleReconnect();
        }
      });

      socket.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          this.connecting = null;
          reject(new BridgeError(`Failed to connect to bridge: ${err.message}`, "BRIDGE_DISCONNECTED"));
        }
      });
    });

    this.connecting = promise;
    return promise;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) {
        return;
      }
      void this.connectSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  private rejectAllPending(err: BridgeError): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }
}
