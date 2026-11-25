import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const extDistDir = path.join(rootDir, "extension", "dist");
const mcpEntry = path.join(rootDir, "dist", "server", "mcp-server.js");
const bridgeEntry = path.join(rootDir, "dist", "server", "bridge.js");

const BRIDGE_PORT = 19923;
const APP_PORT = 19924;
const CDP_PORT = 19925;
const VIDEO_SIZE = 50 * 1024 * 1024;
const MP4_HEADER = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-e2e-"));
const videoPath = path.join(tmpDir, "tiktok-big-50mb.mp4");
{
  const fd = fs.openSync(videoPath, "w");
  fs.writeSync(fd, MP4_HEADER, 0, MP4_HEADER.length, 0);
  fs.ftruncateSync(fd, VIDEO_SIZE);
  fs.closeSync(fd);
}

const uploads = new Map();

const appServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${APP_PORT}`);
  if (url.pathname === "/studio") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end(`<!doctype html>
<html>
<head><title>TikTok Studio Mock</title></head>
<body>
  <h1>Upload Video</h1>
  <input id="caption" type="text" placeholder="Describe your video" aria-label="Caption">
  <button id="open-picker" type="button">Select video</button>
  <input id="video-input" type="file" accept="video/mp4,video/*" style="display:none">
  <div id="dropzone" style="width:300px;height:120px;border:2px dashed #666;">Drop video here</div>
  <div id="status">idle</div>
  <script>
    window.__uploads = {};
    async function sendFile(tag, file) {
      if (!file) return;
      document.getElementById("status").textContent = "uploading:" + tag;
      const resp = await fetch("/upload?tag=" + encodeURIComponent(tag) + "&name=" + encodeURIComponent(file.name), {
        method: "POST",
        body: file,
      });
      const data = await resp.json();
      window.__uploads[tag] = { name: file.name, size: file.size, type: file.type, server: data };
      document.getElementById("status").textContent = "uploaded:" + tag + ":" + data.receivedBytes;
      console.log("UPLOAD_COMPLETE", tag, data.receivedBytes);
    }

    const input = document.getElementById("video-input");
    let nextTag = "auto";
    window.__setNextTag = (t) => { nextTag = t; };
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) sendFile(nextTag, f);
    });
    document.getElementById("open-picker").addEventListener("click", () => {
      nextTag = "chooser";
      input.click();
    });
    const dz = document.getElementById("dropzone");
    dz.addEventListener("dragover", (e) => e.preventDefault());
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) sendFile("drop", f);
    });
    console.log("STUDIO_READY");
  </script>
</body>
</html>`);
    return;
  }

  if (url.pathname === "/upload" && req.method === "POST") {
    const tag = url.searchParams.get("tag") ?? "unknown";
    const name = url.searchParams.get("name") ?? "";
    let receivedBytes = 0;
    let first12 = null;
    req.on("data", (chunk) => {
      if (!first12) first12 = chunk.subarray(0, 12).toString("hex");
      receivedBytes += chunk.length;
    });
    req.on("end", () => {
      const rec = { tag, name, receivedBytes, first12 };
      uploads.set(tag, rec);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rec));
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

async function waitFor(fn, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

function createCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", reject);
  });
}

function parseToolText(result) {
  assert.ok(!result.isError, `Tool returned error: ${JSON.stringify(result)}`);
  const textBlock = result.content.find((c) => c.type === "text");
  assert.ok(textBlock && "text" in textBlock, `Missing text block: ${JSON.stringify(result)}`);
  return textBlock.text;
}

let bridgeProc;
let chromeProc;
let client;
let cdp;

try {
  await new Promise((r) => appServer.listen(APP_PORT, "127.0.0.1", r));

  // Start isolated bridge on BRIDGE_PORT so we don't clash with any user bridge on 18923
  bridgeProc = spawn(process.execPath, [bridgeEntry], {
    env: { ...process.env, CLAUDE_BROWSER_PORT: String(BRIDGE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProc.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));

  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
    return r.ok ? r.json() : null;
  }, "bridge /health");

  // Patch a temp copy of extension/dist? No: configure default port via storage after load OR test on BRIDGE_PORT!
  // Let's launch Chrome with the real extension/dist, then set storage bridgePort via CDP on the extension service worker.
  const userDataDir = path.join(tmpDir, "chrome-profile");
  chromeProc = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--enable-unsafe-extension-debugging",
      "--disable-extensions-file-access-check",
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const browserWsUrl = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.webSocketDebuggerUrl;
  }, "Chrome CDP");

  cdp = await createCdp(browserWsUrl);
  const loaded = await cdp.send("Extensions.loadUnpacked", { path: extDistDir });
  console.log("Loaded extension:", loaded.id);

  // Point extension at our isolated test bridge port via its service worker target
  const swTarget = await waitFor(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.includes(loaded.id));
  }, "extension service worker");

  const swWsUrl = `ws://127.0.0.1:${CDP_PORT}/devtools/page/${swTarget.targetId}`;
  // Use browser-level Target.attachToTarget with flatten: false? Simpler: evaluate via CDP session
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: swTarget.targetId,
    flatten: false,
  });
  await cdp.send("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({
      id: 99,
      method: "Runtime.evaluate",
      params: {
        expression: `chrome.storage.local.set({ bridgePort: ${BRIDGE_PORT} })`,
        awaitPromise: true,
      },
    }),
  });

  const health = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
    const j = await r.json();
    return j.extensionConnected ? j : null;
  }, "extension connected to bridge");
  console.log("Bridge health:", JSON.stringify(health));
  assert.equal(health.extensionConnected, true);

  // Connect real MCP client over stdio to dist/server/mcp-server.js
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: { ...process.env, CLAUDE_BROWSER_PORT: String(BRIDGE_PORT) },
  });
  client = new Client({ name: "e2e-verifier", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  console.log("MCP tools exposed:", toolNames.join(", "));
  for (const required of [
    "tabs_context",
    "tabs_create",
    "navigate",
    "read_page",
    "find",
    "form_input",
    "computer",
    "file_upload",
    "javascript_tool",
    "read_console_messages",
    "read_network_requests",
  ]) {
    assert.ok(toolNames.includes(required), `Missing MCP tool ${required}`);
  }

  // 1. Create tab on mock TikTok Studio page
  const created = JSON.parse(
    parseToolText(
      await client.callTool({
        name: "tabs_create",
        arguments: { url: `http://127.0.0.1:${APP_PORT}/studio`, active: true },
      })
    )
  );
  const tabId = created.id;
  assert.equal(typeof tabId, "number");
  console.log("Created tab:", tabId);

  // Wait for page load
  await waitFor(async () => {
    const txt = parseToolText(await client.callTool({ name: "get_page_text", arguments: { tabId } }));
    return txt.includes("Upload Video") ? txt : null;
  }, "studio page load");

  // 2. read_page & find & form_input
  const pageTree = parseToolText(
    await client.callTool({ name: "read_page", arguments: { tabId, filter: "interactive" } })
  );
  assert.ok(pageTree.includes("Select video"), "read_page should include Select video button");
  assert.ok(pageTree.includes("file"), "read_page should expose hidden file input");

  const foundCaption = JSON.parse(
    parseToolText(await client.callTool({ name: "find", arguments: { tabId, query: "Caption" } }))
  );
  assert.ok(foundCaption.matches?.length > 0, "find should locate Caption input");
  const captionRef = foundCaption.matches[0].ref;

  parseToolText(
    await client.callTool({
      name: "form_input",
      arguments: { tabId, ref: captionRef, value: "My 50MB TikTok video #ai" },
    })
  );

  const captionCheck = JSON.parse(
    parseToolText(
      await client.callTool({
        name: "javascript_tool",
        arguments: { tabId, code: "document.getElementById('caption').value" },
      })
    )
  );
  assert.equal(captionCheck.value, "My 50MB TikTok video #ai");
  console.log("form_input + javascript_tool verified!");

  // 3. Screenshot via computer tool
  const shot = await client.callTool({
    name: "computer",
    arguments: { tabId, action: "screenshot" },
  });
  assert.ok(!shot.isError, `screenshot error: ${JSON.stringify(shot)}`);
  const imgBlock = shot.content.find((c) => c.type === "image");
  assert.ok(imgBlock && imgBlock.mimeType === "image/png" && imgBlock.data.length > 1000);
  console.log("computer screenshot verified! base64 length:", imgBlock.data.length);

  // 4. Hero Test A: 50 MB upload via auto (CDP zero-copy)
  parseToolText(
    await client.callTool({
      name: "javascript_tool",
      arguments: { tabId, code: "window.__setNextTag('cdp')" },
    })
  );
  const upCdp = JSON.parse(
    parseToolText(
      await client.callTool({
        name: "file_upload",
        arguments: { tabId, paths: [videoPath], mode: "auto" },
      })
    )
  );
  console.log("Upload A (auto/cdp):", JSON.stringify(upCdp));
  assert.equal(upCdp.method, "cdp_zero_copy");
  const recCdp = await waitFor(() => uploads.get("cdp"), "server received cdp 50MB upload", 20_000);
  assert.equal(recCdp.receivedBytes, VIDEO_SIZE);
  assert.equal(recCdp.first12, MP4_HEADER.toString("hex"));

  // 5. Hero Test B: 50 MB upload via HTTP stream fallback on STRICT CSP page!
  parseToolText(
    await client.callTool({
      name: "javascript_tool",
      arguments: { tabId, code: "window.__setNextTag('stream')" },
    })
  );
  const upStream = JSON.parse(
    parseToolText(
      await client.callTool({
        name: "file_upload",
        arguments: { tabId, paths: [videoPath], mode: "stream" },
      })
    )
  );
  console.log("Upload B (stream/strict-CSP):", JSON.stringify(upStream));
  assert.equal(upStream.method, "http_stream_datatransfer");
  const recStream = await waitFor(() => uploads.get("stream"), "server received stream 50MB upload", 20_000);
  assert.equal(recStream.receivedBytes, VIDEO_SIZE);
  assert.equal(recStream.first12, MP4_HEADER.toString("hex"));

  // 6. Hero Test C: 50 MB drag-and-drop upload onto #dropzone!
  const upDrop = JSON.parse(
    parseToolText(
      await client.callTool({
        name: "file_upload",
        arguments: { tabId, paths: [videoPath], selector: "#dropzone", mode: "drop" },
      })
    )
  );
  console.log("Upload C (drop):", JSON.stringify(upDrop));
  assert.equal(upDrop.method, "http_stream_drop");
  const recDrop = await waitFor(() => uploads.get("drop"), "server received drop 50MB upload", 20_000);
  assert.equal(recDrop.receivedBytes, VIDEO_SIZE);
  assert.equal(recDrop.first12, MP4_HEADER.toString("hex"));

  // 7. Hero Test D: 50 MB upload via file_chooser interception on #open-picker!
  const upChooser = JSON.parse(
    parseToolText(
      await client.callTool({
        name: "file_upload",
        arguments: {
          tabId,
          paths: [videoPath],
          triggerSelector: "#open-picker",
          mode: "file_chooser",
        },
      })
    )
  );
  console.log("Upload D (file_chooser):", JSON.stringify(upChooser));
  assert.equal(upChooser.method, "cdp_file_chooser");
  const recChooser = await waitFor(() => uploads.get("chooser"), "server received chooser 50MB upload", 20_000);
  assert.equal(recChooser.receivedBytes, VIDEO_SIZE);
  assert.equal(recChooser.first12, MP4_HEADER.toString("hex"));

  // 8. Verify console & network capture
  const consoleOut = parseToolText(
    await client.callTool({ name: "read_console_messages", arguments: { tabId, pattern: "UPLOAD_COMPLETE" } })
  );
  assert.ok(consoleOut.includes("UPLOAD_COMPLETE"), `Expected console capture, got: ${consoleOut}`);
  const netOut = parseToolText(
    await client.callTool({ name: "read_network_requests", arguments: { tabId, urlPattern: "/upload" } })
  );
  assert.ok(netOut.includes("/upload"), `Expected network capture, got: ${netOut}`);

  console.log("\nALL E2E CHECKS PASSED (4x 50 MB uploads = 200 MB verified byte-accurate)!");
} finally {
  try {
    await client?.close();
  } catch {}
  try {
    cdp?.close();
  } catch {}
  if (chromeProc && chromeProc.exitCode === null) {
    await new Promise((resolve) => {
      chromeProc.once("exit", resolve);
      chromeProc.kill("SIGTERM");
      setTimeout(() => {
        if (chromeProc.exitCode === null) chromeProc.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
  }
  if (bridgeProc && bridgeProc.exitCode === null) {
    bridgeProc.kill("SIGTERM");
  }
  appServer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
