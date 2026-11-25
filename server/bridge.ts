import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  type BridgeResponseEnvelope,
  type ResolvedUploadFile,
  WireMessageSchema,
} from "../shared/protocol.js";
import { FileStreamRegistry, type RegisteredFile } from "./file-registry.js";

const MAX_JSON_BODY_BYTES = 1_048_576;

const RegisterFilesBodySchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

export const BridgeHealthSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.number().int(),
  extensionConnected: z.boolean(),
  extensionId: z.string().nullable(),
  allowedFileAccess: z.boolean(),
  activeMcpClients: z.number().int().nonnegative(),
  port: z.number().int().nonnegative(),
});
export type BridgeHealth = z.infer<typeof BridgeHealthSchema>;

export interface BridgeServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly tokenTtlMs?: number;
}

export interface BridgeServerHandle {
  readonly host: string;
  readonly port: number;
  readonly server: http.Server;
  close(): Promise<void>;
}

interface PendingBridgeRequest {
  readonly mcpWs: WebSocket;
  readonly clientRequestId: string;
  readonly extSocket: WebSocket;
}

type ByteRangeResult =
  | { readonly kind: "valid"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

function logStderr(level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component: "bridge",
    event,
    ...(details ?? {}),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function resolveBridgePort(explicitPort?: number): number {
  if (explicitPort !== undefined) {
    if (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535) {
      throw new Error(`Invalid bridge port: ${explicitPort}`);
    }
    return explicitPort;
  }

  const rawEnv = process.env.CLAUDE_BROWSER_PORT;
  if (rawEnv !== undefined && rawEnv.trim().length > 0) {
    const parsed = Number(rawEnv.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid CLAUDE_BROWSER_PORT value: ${rawEnv}`);
    }
    return parsed;
  }

  return DEFAULT_BRIDGE_PORT;
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
    "Cache-Control": "no-store",
  });
  res.end(serialized);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        reject(new Error("Request body exceeds maximum allowed size."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function parseSingleByteRange(rangeHeader: string, sizeBytes: number): ByteRangeResult {
  if (sizeBytes === 0) {
    return { kind: "unsatisfiable" };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (match === null) {
    return { kind: "unsatisfiable" };
  }

  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  if (startStr.length === 0 && endStr.length === 0) {
    return { kind: "unsatisfiable" };
  }

  if (startStr.length === 0) {
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable" };
    }
    const start = Math.max(0, sizeBytes - suffixLength);
    return { kind: "valid", start, end: sizeBytes - 1 };
  }

  const start = Number(startStr);
  const rawEnd = endStr.length > 0 ? Number(endStr) : sizeBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(rawEnd) || start < 0 || start >= sizeBytes) {
    return { kind: "unsatisfiable" };
  }

  const end = Math.min(rawEnd, sizeBytes - 1);
  if (end < start) {
    return { kind: "unsatisfiable" };
  }

  return { kind: "valid", start, end };
}

function streamRegisteredFile(req: http.IncomingMessage, res: http.ServerResponse, entry: RegisteredFile): void {
  const baseHeaders: http.OutgoingHttpHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Content-Type": entry.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  const rangeHeader = req.headers.range;
  let streamOptions: { start?: number; end?: number } = {};

  if (rangeHeader !== undefined) {
    const parsedRange = parseSingleByteRange(rangeHeader, entry.sizeBytes);
    if (parsedRange.kind === "unsatisfiable") {
      res.writeHead(416, {
        ...baseHeaders,
        "Content-Range": `bytes */${entry.sizeBytes}`,
      });
      res.end();
      return;
    }

    const contentLength = parsedRange.end - parsedRange.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${parsedRange.start}-${parsedRange.end}/${entry.sizeBytes}`,
      "Content-Length": contentLength,
    });
    streamOptions = { start: parsedRange.start, end: parsedRange.end };
  } else {
    res.writeHead(200, {
      ...baseHeaders,
      "Content-Length": entry.sizeBytes,
    });
    if (entry.sizeBytes === 0) {
      res.end();
      return;
    }
  }

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const fileStream = fs.createReadStream(entry.absolutePath, streamOptions);

  const destroyStream = (): void => {
    if (!fileStream.destroyed) {
      fileStream.destroy();
    }
  };

  req.on("aborted", destroyStream);
  res.on("close", () => {
    if (!res.writableEnded) {
      destroyStream();
    }
  });

  fileStream.on("error", (err) => {
    logStderr("error", "stream_read_error", { path: entry.absolutePath, error: err.message });
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "Failed to read file stream." });
      return;
    }
    res.destroy();
  });

  fileStream.pipe(res);
}

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function sendWsJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export async function createBridgeServer(options?: BridgeServerOptions): Promise<BridgeServerHandle> {
  const host = options?.host ?? DEFAULT_BRIDGE_HOST;
  if (host !== DEFAULT_BRIDGE_HOST) {
    throw new Error(`Bridge server must bind strictly to ${DEFAULT_BRIDGE_HOST}, got "${host}".`);
  }

  const requestedPort = resolveBridgePort(options?.port);
  const registry = new FileStreamRegistry({ ttlMs: options?.tokenTtlMs });

  const extWss = new WebSocketServer({ noServer: true });
  const mcpWss = new WebSocketServer({ noServer: true });

  let activeExt: WebSocket | null = null;
  let extensionId: string | null = null;
  let allowedFileAccess = false;
  const mcpClients = new Set<WebSocket>();
  const pendingRequests = new Map<string, PendingBridgeRequest>();

  let actualPort = requestedPort;

  const failPendingForExtension = (extSocket: WebSocket, errorMessage: string): void => {
    for (const [internalId, pending] of pendingRequests) {
      if (pending.extSocket !== extSocket) {
        continue;
      }
      pendingRequests.delete(internalId);
      const response: BridgeResponseEnvelope = {
        type: "response",
        id: pending.clientRequestId,
        ok: false,
        code: "EXTENSION_DISCONNECTED",
        error: errorMessage,
      };
      sendWsJson(pending.mcpWs, response);
    }
  };

  extWss.on("connection", (ws: WebSocket) => {
    if (activeExt !== null && activeExt !== ws) {
      const staleExt = activeExt;
      failPendingForExtension(staleExt, "Chrome extension connection was replaced before completing the request.");
      staleExt.close(4000, "Replaced by newer extension connection");
    }

    activeExt = ws;
    extensionId = null;
    allowedFileAccess = false;
    logStderr("info", "extension_connected");

    ws.on("message", (data: WebSocket.RawData) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(data.toString("utf8"));
      } catch {
        logStderr("warn", "extension_invalid_json");
        return;
      }

      const parsed = WireMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        logStderr("warn", "extension_invalid_message", { issues: parsed.error.issues });
        return;
      }

      const msg = parsed.data;
      switch (msg.type) {
        case "hello": {
          if (activeExt === ws) {
            extensionId = msg.extensionId;
            allowedFileAccess = msg.allowedFileAccess;
            logStderr("info", "extension_hello", {
              extensionId: msg.extensionId,
              allowedFileAccess: msg.allowedFileAccess,
              version: msg.version,
            });
          }
          break;
        }
        case "ping": {
          sendWsJson(ws, { type: "pong", ts: msg.ts });
          break;
        }
        case "response": {
          const pending = pendingRequests.get(msg.id);
          if (pending === undefined) {
            return;
          }
          pendingRequests.delete(msg.id);
          const forwarded: BridgeResponseEnvelope = msg.ok
            ? { type: "response", id: pending.clientRequestId, ok: true, result: msg.result }
            : {
                type: "response",
                id: pending.clientRequestId,
                ok: false,
                error: msg.error,
                ...(msg.code !== undefined ? { code: msg.code } : {}),
              };
          sendWsJson(pending.mcpWs, forwarded);
          break;
        }
        case "pong":
        case "request":
          break;
        default: {
          const _exhaustive: never = msg;
          return _exhaustive;
        }
      }
    });

    const handleDisconnect = (): void => {
      if (activeExt === ws) {
        activeExt = null;
        extensionId = null;
        allowedFileAccess = false;
        logStderr("info", "extension_disconnected");
      }
      failPendingForExtension(ws, "Chrome extension disconnected before completing the request.");
    };

    ws.on("close", handleDisconnect);
    ws.on("error", (err: Error) => {
      logStderr("warn", "extension_socket_error", { error: err.message });
    });
  });

  mcpWss.on("connection", (ws: WebSocket) => {
    mcpClients.add(ws);
    logStderr("info", "mcp_client_connected", { activeMcpClients: mcpClients.size });

    ws.on("message", (data: WebSocket.RawData) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(data.toString("utf8"));
      } catch {
        logStderr("warn", "mcp_invalid_json");
        return;
      }

      const parsed = WireMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        logStderr("warn", "mcp_invalid_message", { issues: parsed.error.issues });
        return;
      }

      const msg = parsed.data;
      switch (msg.type) {
        case "ping": {
          sendWsJson(ws, { type: "pong", ts: msg.ts });
          break;
        }
        case "request": {
          if (activeExt === null || activeExt.readyState !== WebSocket.OPEN) {
            const response: BridgeResponseEnvelope = {
              type: "response",
              id: msg.id,
              ok: false,
              code: "EXTENSION_DISCONNECTED",
              error:
                "Chrome extension is not connected. Load extension/dist in chrome://extensions and ensure Chrome is open.",
            };
            sendWsJson(ws, response);
            return;
          }

          const internalId = crypto.randomUUID();
          pendingRequests.set(internalId, {
            mcpWs: ws,
            clientRequestId: msg.id,
            extSocket: activeExt,
          });
          sendWsJson(activeExt, {
            type: "request",
            id: internalId,
            command: msg.command,
          });
          break;
        }
        case "hello":
        case "response":
        case "pong":
          break;
        default: {
          const _exhaustive: never = msg;
          return _exhaustive;
        }
      }
    });

    ws.on("close", () => {
      mcpClients.delete(ws);
      for (const [internalId, pending] of pendingRequests) {
        if (pending.mcpWs === ws) {
          pendingRequests.delete(internalId);
        }
      }
      logStderr("info", "mcp_client_disconnected", { activeMcpClients: mcpClients.size });
    });

    ws.on("error", (err: Error) => {
      logStderr("warn", "mcp_socket_error", { error: err.message });
    });
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${actualPort}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      const health: BridgeHealth = {
        ok: true,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        extensionConnected: activeExt !== null && activeExt.readyState === WebSocket.OPEN,
        extensionId,
        allowedFileAccess,
        activeMcpClients: mcpClients.size,
        port: actualPort,
      };
      sendJson(res, 200, health);
      return;
    }

    if (req.method === "POST" && pathname === "/register-files") {
      if (req.headers.origin !== undefined) {
        sendJson(res, 403, { ok: false, error: "Forbidden: Origin header is not allowed on /register-files." });
        return;
      }

      void (async () => {
        try {
          const rawBody = await readJsonBody(req);
          const parsed = RegisterFilesBodySchema.safeParse(rawBody);
          if (!parsed.success) {
            sendJson(res, 400, {
              ok: false,
              error: "Invalid request body: expected { paths: string[] } with at least one path.",
            });
            return;
          }

          const files: ResolvedUploadFile[] = [];
          for (const inputPath of parsed.data.paths) {
            const registered = await registry.register(inputPath);
            files.push({
              absolutePath: registered.absolutePath,
              name: registered.name,
              mimeType: registered.mimeType,
              sizeBytes: registered.sizeBytes,
              streamUrl: `http://${host}:${actualPort}/stream/${registered.token}`,
            });
          }

          sendJson(res, 200, { files });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { ok: false, error: message });
        }
      })();
      return;
    }

    if (pathname.startsWith("/stream/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const token = pathname.slice("/stream/".length);
        const entry = token.length > 0 && !token.includes("/") ? registry.get(token) : undefined;
        if (entry === undefined) {
          sendJson(res, 404, { ok: false, error: "Stream token not found or expired." });
          return;
        }
        streamRegisteredFile(req, res, entry);
        return;
      }
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", `http://${host}:${actualPort}`).pathname;

    if (pathname === "/ext") {
      const origin = req.headers.origin;
      if (origin !== undefined && !origin.startsWith("chrome-extension://")) {
        logStderr("warn", "ext_origin_rejected", { origin });
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }
      extWss.handleUpgrade(req, socket, head, (ws) => {
        extWss.emit("connection", ws, req);
      });
      return;
    }

    if (pathname === "/mcp") {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        logStderr("warn", "mcp_origin_rejected", { origin });
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }
      mcpWss.handleUpgrade(req, socket, head, (ws) => {
        mcpWss.emit("connection", ws, req);
      });
      return;
    }

    rejectUpgrade(socket, "404 Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (address !== null && typeof address === "object") {
    actualPort = address.port;
  }

  const close = async (): Promise<void> => {
    registry.dispose();
    if (activeExt !== null) {
      activeExt.terminate();
      activeExt = null;
    }
    for (const client of mcpClients) {
      client.terminate();
    }
    mcpClients.clear();
    pendingRequests.clear();

    await Promise.all([
      new Promise<void>((resolve) => extWss.close(() => resolve())),
      new Promise<void>((resolve) => mcpWss.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  };

  return { host, port: actualPort, server, close };
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const resolved = path.resolve(entry);
  if (import.meta.url === pathToFileURL(resolved).href) {
    return true;
  }
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(resolved)).href;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  createBridgeServer()
    .then((handle) => {
      logStderr("info", "bridge_started", { host: handle.host, port: handle.port });

      let shuttingDown = false;
      const shutdown = (signal: string): void => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        logStderr("info", "bridge_stopping", { signal });
        void handle.close().finally(() => {
          process.exit(0);
        });
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logStderr("error", "bridge_start_failed", { error: message });
      process.exit(1);
    });
}
