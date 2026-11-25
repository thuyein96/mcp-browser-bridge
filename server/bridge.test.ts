import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeRequestEnvelope,
  type BridgeResponseEnvelope,
  BridgeResponseEnvelopeSchema,
  ResolvedUploadFileSchema,
  WireMessageSchema,
} from "../shared/protocol.js";
import { BridgeHealthSchema, type BridgeServerHandle, createBridgeServer } from "./bridge.js";
import { BridgeClient, BridgeError } from "./bridge-client.js";
import { FileStreamRegistry } from "./file-registry.js";
import { createMcpBrowserServer } from "./mcp-server.js";
import { detectMimeType } from "./mime.js";

const TWO_MIB = 2 * 1024 * 1024;

const RegisterFilesResponseSchema = z.object({
  files: z.array(ResolvedUploadFileSchema),
});

function buildDeterministicPayload(sizeBytes: number): Buffer {
  const buf = Buffer.allocUnsafe(sizeBytes);
  buf[0] = 0x00;
  buf[1] = 0x00;
  buf[2] = 0x00;
  buf[3] = 0x18;
  buf[4] = 0x66;
  buf[5] = 0x74;
  buf[6] = 0x79;
  buf[7] = 0x70;
  for (let i = 8; i < sizeBytes; i += 1) {
    buf[i] = (i * 31 + (i >> 8)) & 0xff;
  }
  return buf;
}

function openWebSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers !== undefined ? { headers } : undefined);
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
  });
}

function expectUpgradeRejected(url: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers !== undefined ? { headers } : undefined);
    ws.once("unexpected-response", (_req, res) => {
      const code = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
      resolve(code);
    });
    ws.once("open", () => {
      ws.terminate();
      reject(new Error(`Expected upgrade rejection for ${url}, but socket opened.`));
    });
    ws.once("error", (err) => {
      reject(err);
    });
  });
}

function nextJsonMessage(ws: WebSocket, timeoutMs = 3_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref();

    const onMessage = (data: WebSocket.RawData): void => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString("utf8")));
    };
    ws.once("message", onMessage);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("detectMimeType", () => {
  it("maps known extensions and sniffs magic bytes when extension is unknown", () => {
    assert.equal(detectMimeType("/tmp/clip.MP4"), "video/mp4");
    assert.equal(detectMimeType("/tmp/clip.mov"), "video/quicktime");
    assert.equal(detectMimeType("/tmp/image.webp"), "image/webp");
    assert.equal(detectMimeType("/tmp/data.csv"), "text/csv");

    assert.equal(
      detectMimeType("/tmp/noext", Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])),
      "video/mp4"
    );
    assert.equal(
      detectMimeType("/tmp/blob.bin", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      "image/png"
    );
    assert.equal(detectMimeType("/tmp/blob", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(detectMimeType("/tmp/blob", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])), "video/webm");
    assert.equal(detectMimeType("/tmp/blob", Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])), "application/pdf");
    assert.equal(detectMimeType("/tmp/unknown.xyz", Uint8Array.from([0x01, 0x02, 0x03])), "application/octet-stream");
  });
});

describe("FileStreamRegistry and bridge HTTP/WS integration", () => {
  const handles: BridgeServerHandle[] = [];
  const tempDirs: string[] = [];
  const openSockets: WebSocket[] = [];
  const clients: BridgeClient[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    for (const client of clients.splice(0)) {
      client.close();
    }
    for (const ws of openSockets.splice(0)) {
      ws.terminate();
    }
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
    for (const dir of tempDirs.splice(0)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function startBridge(tokenTtlMs?: number): Promise<BridgeServerHandle> {
    const handle = await createBridgeServer({ port: 0, tokenTtlMs });
    handles.push(handle);
    return handle;
  }

  async function makeTempDir(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claude-chrome-bridge-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("streams a real 2 MB file fully and by byte range, and rejects invalid/missing/expired inputs", async () => {
    const tempDir = await makeTempDir();
    const videoPath = path.join(tempDir, "tiktok-sample.mp4");
    const expectedBuffer = buildDeterministicPayload(TWO_MIB);
    await fs.promises.writeFile(videoPath, expectedBuffer);

    const registry = new FileStreamRegistry();
    try {
      await assert.rejects(() => registry.register(path.join(tempDir, "does-not-exist.mp4")), /File not found/);
      await assert.rejects(() => registry.register(tempDir), /directory/);
    } finally {
      registry.dispose();
    }

    const bridge = await startBridge();
    const registerRes = await fetch(`http://${bridge.host}:${bridge.port}/register-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [videoPath] }),
    });
    assert.equal(registerRes.status, 200);
    const registerBody = RegisterFilesResponseSchema.parse(await registerRes.json());
    assert.equal(registerBody.files.length, 1);
    const file = registerBody.files[0];
    assert.ok(file !== undefined);
    assert.equal(file.sizeBytes, TWO_MIB);
    assert.equal(file.mimeType, "video/mp4");
    assert.equal(file.name, "tiktok-sample.mp4");

    const fullRes = await fetch(file.streamUrl);
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get("access-control-allow-origin"), "*");
    assert.equal(fullRes.headers.get("accept-ranges"), "bytes");
    assert.equal(fullRes.headers.get("cache-control"), "no-store");
    assert.equal(fullRes.headers.get("content-type"), "video/mp4");
    const downloaded = Buffer.from(await fullRes.arrayBuffer());
    assert.equal(downloaded.length, expectedBuffer.length);
    assert.equal(Buffer.compare(downloaded, expectedBuffer), 0);

    const rangeRes = await fetch(file.streamUrl, {
      headers: { Range: "bytes=0-1023" },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get("content-range"), `bytes 0-1023/${TWO_MIB}`);
    const rangeChunk = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(rangeChunk.length, 1024);
    assert.equal(Buffer.compare(rangeChunk, expectedBuffer.subarray(0, 1024)), 0);

    const midRes = await fetch(file.streamUrl, {
      headers: { Range: "bytes=1048576-1049599" },
    });
    assert.equal(midRes.status, 206);
    const midChunk = Buffer.from(await midRes.arrayBuffer());
    assert.equal(Buffer.compare(midChunk, expectedBuffer.subarray(1048576, 1049600)), 0);

    const missingTokenRes = await fetch(`http://${bridge.host}:${bridge.port}/stream/nonexistenttoken`);
    assert.equal(missingTokenRes.status, 404);

    const missingFileRes = await fetch(`http://${bridge.host}:${bridge.port}/register-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [path.join(tempDir, "missing.mp4")] }),
    });
    assert.equal(missingFileRes.status, 400);

    const dirRes = await fetch(`http://${bridge.host}:${bridge.port}/register-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [tempDir] }),
    });
    assert.equal(dirRes.status, 400);

    const shortTtlBridge = await startBridge(30);
    const shortReg = await fetch(`http://${shortTtlBridge.host}:${shortTtlBridge.port}/register-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [videoPath] }),
    });
    assert.equal(shortReg.status, 200);
    const shortBody = RegisterFilesResponseSchema.parse(await shortReg.json());
    const shortFile = shortBody.files[0];
    assert.ok(shortFile !== undefined);

    await delay(60);
    const expiredRes = await fetch(shortFile.streamUrl);
    assert.equal(expiredRes.status, 404);
  });

  it("enforces Origin boundaries on /ext, /mcp, and /register-files", async () => {
    const bridge = await startBridge();
    const baseHttp = `http://${bridge.host}:${bridge.port}`;
    const baseWs = `ws://${bridge.host}:${bridge.port}`;

    const regForbidden = await fetch(`${baseHttp}/register-files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ paths: ["/etc/hosts"] }),
    });
    assert.equal(regForbidden.status, 403);

    const extRejectedStatus = await expectUpgradeRejected(`${baseWs}/ext`, {
      Origin: "https://evil.example",
    });
    assert.equal(extRejectedStatus, 403);

    const mcpWebRejected = await expectUpgradeRejected(`${baseWs}/mcp`, {
      Origin: "https://evil.example",
    });
    assert.equal(mcpWebRejected, 403);

    const mcpExtRejected = await expectUpgradeRejected(`${baseWs}/mcp`, {
      Origin: "chrome-extension://abcdef",
    });
    assert.equal(mcpExtRejected, 403);

    const extWs = await openWebSocket(`${baseWs}/ext`, {
      Origin: "chrome-extension://abcdef",
    });
    openSockets.push(extWs);

    extWs.send(
      JSON.stringify({
        type: "hello",
        version: BRIDGE_PROTOCOL_VERSION,
        extensionId: "abcdef",
        allowedFileAccess: true,
      })
    );

    const pongPromise = nextJsonMessage(extWs);
    extWs.send(JSON.stringify({ type: "ping", ts: 12345 }));
    const pong = WireMessageSchema.parse(await pongPromise);
    assert.deepEqual(pong, { type: "pong", ts: 12345 });

    const healthRes = await fetch(`${baseHttp}/health`);
    assert.equal(healthRes.status, 200);
    const health = BridgeHealthSchema.parse(await healthRes.json());
    assert.equal(health.extensionConnected, true);
    assert.equal(health.extensionId, "abcdef");
    assert.equal(health.allowedFileAccess, true);
    assert.equal(health.protocolVersion, BRIDGE_PROTOCOL_VERSION);
  });

  it("correlates overlapping request IDs across two concurrent /mcp clients without collision", async () => {
    const bridge = await startBridge();
    const baseWs = `ws://${bridge.host}:${bridge.port}`;

    const extWs = await openWebSocket(`${baseWs}/ext`, {
      Origin: "chrome-extension://ext-router-test",
    });
    const mcpA = await openWebSocket(`${baseWs}/mcp`);
    const mcpB = await openWebSocket(`${baseWs}/mcp`);
    openSockets.push(extWs, mcpA, mcpB);

    const receivedAtExt: BridgeRequestEnvelope[] = [];
    const bothReceived = new Promise<void>((resolve) => {
      extWs.on("message", (raw: WebSocket.RawData) => {
        const parsed = WireMessageSchema.parse(JSON.parse(raw.toString("utf8")));
        if (parsed.type === "request") {
          receivedAtExt.push(parsed);
          if (receivedAtExt.length === 2) {
            resolve();
          }
        }
      });
    });

    const respAPromise = nextJsonMessage(mcpA);
    const respBPromise = nextJsonMessage(mcpB);

    mcpA.send(
      JSON.stringify({
        type: "request",
        id: "1",
        command: { method: "navigate", params: { url: "https://client-a.example" } },
      })
    );
    mcpB.send(
      JSON.stringify({
        type: "request",
        id: "1",
        command: { method: "navigate", params: { url: "https://client-b.example" } },
      })
    );

    await bothReceived;
    assert.equal(receivedAtExt.length, 2);
    const firstReq = receivedAtExt[0];
    const secondReq = receivedAtExt[1];
    assert.ok(firstReq !== undefined && secondReq !== undefined);
    assert.notEqual(firstReq.id, secondReq.id);

    for (const req of [secondReq, firstReq]) {
      const targetUrl = req.command.method === "navigate" ? req.command.params.url : "unexpected";
      const reply: BridgeResponseEnvelope = {
        type: "response",
        id: req.id,
        ok: true,
        result: { navigatedTo: targetUrl },
      };
      extWs.send(JSON.stringify(reply));
    }

    const respA = BridgeResponseEnvelopeSchema.parse(await respAPromise);
    const respB = BridgeResponseEnvelopeSchema.parse(await respBPromise);

    assert.equal(respA.id, "1");
    assert.equal(respA.ok, true);
    if (respA.ok) {
      assert.deepEqual(respA.result, { navigatedTo: "https://client-a.example" });
    }

    assert.equal(respB.id, "1");
    assert.equal(respB.ok, true);
    if (respB.ok) {
      assert.deepEqual(respB.result, { navigatedTo: "https://client-b.example" });
    }
  });

  it("returns EXTENSION_DISCONNECTED when extension is absent or drops mid-request", async () => {
    const bridge = await startBridge();
    const baseWs = `ws://${bridge.host}:${bridge.port}`;

    const client = new BridgeClient({ host: bridge.host, port: bridge.port });
    clients.push(client);

    await assert.rejects(
      () => client.call({ method: "tabs_context", params: {} }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, "EXTENSION_DISCONNECTED");
        return true;
      }
    );

    const extWs = await openWebSocket(`${baseWs}/ext`, {
      Origin: "chrome-extension://ext-drop-test",
    });
    openSockets.push(extWs);

    const requestSeenByExt = new Promise<void>((resolve) => {
      extWs.once("message", () => resolve());
    });

    const inFlightCall = client.call({ method: "tabs_context", params: {} });
    await requestSeenByExt;
    extWs.terminate();

    await assert.rejects(
      () => inFlightCall,
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, "EXTENSION_DISCONNECTED");
        return true;
      }
    );
  });

  it("exposes all 14 MCP tools, returns screenshot image content, and formats file_upload results", async () => {
    const bridge = await startBridge();
    const tempDir = await makeTempDir();
    const videoPath = path.join(tempDir, "upload.mp4");
    await fs.promises.writeFile(videoPath, buildDeterministicPayload(TWO_MIB));

    const extWs = await openWebSocket(`ws://${bridge.host}:${bridge.port}/ext`, {
      Origin: "chrome-extension://mcp-e2e-ext",
    });
    openSockets.push(extWs);

    extWs.on("message", (raw: WebSocket.RawData) => {
      const msg = WireMessageSchema.parse(JSON.parse(raw.toString("utf8")));
      if (msg.type !== "request") {
        return;
      }
      if (msg.command.method === "computer" && msg.command.params.action === "screenshot") {
        const reply: BridgeResponseEnvelope = {
          type: "response",
          id: msg.id,
          ok: true,
          result: { tabId: 7, mimeType: "image/png", base64: "iVBORw0KGgo=", width: 1280, height: 720 },
        };
        extWs.send(JSON.stringify(reply));
        return;
      }
      if (msg.command.method === "file_upload") {
        const uploaded = msg.command.params.files.map((f) => ({
          name: f.name,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
        }));
        const reply: BridgeResponseEnvelope = {
          type: "response",
          id: msg.id,
          ok: true,
          result: {
            method: "http_stream_datatransfer",
            tabId: 7,
            durationMs: 42,
            files: uploaded,
          },
        };
        extWs.send(JSON.stringify(reply));
      }
    });

    const { server, client: bridgeClient } = createMcpBrowserServer({
      host: bridge.host,
      port: bridge.port,
    });
    clients.push(bridgeClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-mcp-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    cleanups.push(async () => {
      await mcpClient.close();
      await server.close();
    });

    const listed = await mcpClient.listTools();
    const toolNames = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "computer",
      "file_upload",
      "find",
      "form_input",
      "get_page_text",
      "javascript_tool",
      "navigate",
      "read_console_messages",
      "read_network_requests",
      "read_page",
      "resize_window",
      "tabs_close",
      "tabs_context",
      "tabs_create",
    ]);

    const shot = await mcpClient.callTool({ name: "computer", arguments: { action: "screenshot" } });
    assert.equal(shot.isError, undefined);
    const shotContent = shot.content;
    assert.ok(Array.isArray(shotContent));
    assert.deepEqual(shotContent[0], {
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });

    const upload = await mcpClient.callTool({ name: "file_upload", arguments: { paths: [videoPath] } });
    assert.equal(upload.isError, undefined);
    const uploadContent = upload.content;
    assert.ok(Array.isArray(uploadContent));
    const firstBlock = uploadContent[0];
    assert.ok(firstBlock !== undefined && firstBlock.type === "text");
    const parsedSummary = z
      .object({
        method: z.string(),
        durationMs: z.number(),
        files: z.array(z.object({ name: z.string(), sizeBytes: z.number(), sizeMB: z.number() })),
        note: z.string(),
      })
      .parse(JSON.parse(firstBlock.text));
    assert.equal(parsedSummary.method, "http_stream_datatransfer");
    assert.equal(parsedSummary.durationMs, 42);
    assert.equal(parsedSummary.files[0]?.sizeBytes, TWO_MIB);
    assert.equal(parsedSummary.files[0]?.sizeMB, 2);
    assert.match(parsedSummary.note, /Allow access to file URLs/);

    const missingUpload = await mcpClient.callTool({
      name: "file_upload",
      arguments: { paths: [path.join(tempDir, "missing.mp4")] },
    });
    assert.equal(missingUpload.isError, true);
  });
});
