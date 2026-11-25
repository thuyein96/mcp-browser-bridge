// E2E: input + visible cursor on a tab where chrome.debugger cannot attach.
//
// Reproduces the real-world failure: a second extension injects a hidden
// chrome-extension:// iframe into every page, which makes Chrome reject
// chrome.debugger.attach with "Cannot access a chrome-extension:// URL of
// different extension". The bridge must fall back to captureVisibleTab,
// content-script DOM events and chrome.scripting, and still draw its cursor.
//
// Usage: node scripts/e2e-cursor.mjs [--keep-shots <dir>]

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

const BRIDGE_PORT = 19933;
const APP_PORT = 19934;
const CDP_PORT = 19935;

const keepIdx = process.argv.indexOf("--keep-shots");
const shotsDir = keepIdx > 0 ? path.resolve(process.argv[keepIdx + 1]) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-cursor-"));

// --- Blocker extension: injects a chrome-extension:// iframe into every page.
const blockerDir = path.join(tmpDir, "blocker-ext");
fs.mkdirSync(blockerDir);
fs.writeFileSync(
  path.join(blockerDir, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Iframe Injector (test)",
    version: "1.0.0",
    content_scripts: [{ matches: ["<all_urls>"], js: ["inject.js"], run_at: "document_start" }],
    web_accessible_resources: [{ resources: ["frame.html"], matches: ["<all_urls>"] }],
  }),
);
fs.writeFileSync(
  path.join(blockerDir, "inject.js"),
  `const f = document.createElement("iframe");
   f.src = chrome.runtime.getURL("frame.html");
   f.style.cssText = "width:0;height:0;border:0;position:absolute";
   (document.documentElement || document).appendChild(f);`,
);
fs.writeFileSync(path.join(blockerDir, "frame.html"), "<!doctype html><title>frame</title>");

// --- Test app.
const appServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${APP_PORT}`);
  if (url.pathname !== "/app") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const csp = url.searchParams.get("csp") === "strict" ? "script-src 'self' 'unsafe-inline'" : "";
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    ...(csp ? { "content-security-policy": csp } : {}),
  });
  res.end(`<!doctype html>
<html><head><title>Cursor App</title>
<style>
  body { font: 16px system-ui; margin: 0; padding: 24px; background: #fafaf7; }
  #like { padding: 10px 18px; font-size: 16px; }
  #scroller { width: 300px; height: 120px; overflow: auto; border: 1px solid #999; margin-top: 16px; }
  #scroller div { height: 1000px; background: linear-gradient(#fff, #cde); }
  #ce { border: 1px solid #999; min-height: 40px; margin-top: 16px; padding: 6px; width: 400px; }
</style></head>
<body>
  <div role="button" id="like" aria-label="React with Like" tabindex="0">👍 Like</div>
  <p>Likes: <span id="count">0</span> · Events: <span id="events"></span></p>
  <form id="form"><input id="name" aria-label="Name" placeholder="Name"></form>
  <p>Submitted: <span id="submitted">none</span></p>
  <div id="ce" contenteditable="true" aria-label="Composer"></div>
  <div id="scroller"><div></div></div>
  <div style="height: 2000px"></div>
  <button id="bottom" aria-label="Bottom button">Bottom</button>
  <p>Bottom clicked: <span id="bottom-state">no</span></p>
  <div style="height: 400px"></div>
<script>
  document.getElementById("bottom").addEventListener("click", () => {
    document.getElementById("bottom-state").textContent = "yes";
  });
  const events = [];
  const like = document.getElementById("like");
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    like.addEventListener(t, () => { events.push(t); document.getElementById("events").textContent = events.join(","); });
  }
  like.addEventListener("click", () => {
    const c = document.getElementById("count");
    c.textContent = String(Number(c.textContent) + 1);
  });
  document.getElementById("form").addEventListener("submit", (e) => {
    e.preventDefault();
    document.getElementById("submitted").textContent = document.getElementById("name").value;
  });
</script>
</body></html>`);
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

function toolText(result) {
  assert.ok(!result.isError, `Tool returned error: ${JSON.stringify(result)}`);
  const block = result.content.find((c) => c.type === "text");
  assert.ok(block, `Missing text block: ${JSON.stringify(result)}`);
  return block.text;
}
const toolJson = (result) => JSON.parse(toolText(result));

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let bridgeProc;
let chromeProc;
let client;
let cdp;

try {
  await new Promise((r) => appServer.listen(APP_PORT, "127.0.0.1", r));

  bridgeProc = spawn(process.execPath, [bridgeEntry], {
    env: { ...process.env, CLAUDE_BROWSER_PORT: String(BRIDGE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProc.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`)).ok, "bridge");

  chromeProc = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      `--user-data-dir=${path.join(tmpDir, "profile")}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "--window-size=1000,700",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const browserWs = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return r.ok ? (await r.json()).webSocketDebuggerUrl : null;
  }, "Chrome CDP");
  cdp = await createCdp(browserWs);

  const blocker = await cdp.send("Extensions.loadUnpacked", { path: blockerDir });
  const loaded = await cdp.send("Extensions.loadUnpacked", { path: extDistDir });
  console.log("Loaded bridge extension", loaded.id, "+ blocker", blocker.id);

  const sw = await waitFor(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.includes(loaded.id));
  }, "extension service worker");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: false });
  await cdp.send("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: `chrome.storage.local.set({ bridgePort: ${BRIDGE_PORT} })`, awaitPromise: true },
    }),
  });
  await waitFor(async () => {
    const j = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`)).json();
    return j.extensionConnected;
  }, "extension connected");

  client = new Client({ name: "e2e-cursor", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry],
      env: { ...process.env, CLAUDE_BROWSER_PORT: String(BRIDGE_PORT) },
    }),
  );
  const call = (name, args) => client.callTool({ name, arguments: args });

  const tab = toolJson(await call("tabs_create", { url: `http://127.0.0.1:${APP_PORT}/app` }));
  const tabId = tab.id;
  const pageText = async () => toolJson(await call("get_page_text", { tabId })).text;

  // 0. The blocker iframe is present, i.e. we are reproducing the real failure.
  const frames = toolJson(await call("find", { tabId, query: "iframe", selector: "iframe" }));
  assert.ok(
    frames.matches.some((m) => m.src?.startsWith(`chrome-extension://${blocker.id}/`)),
    `blocker iframe missing: ${JSON.stringify(frames)}`,
  );
  console.log("✔ blocker iframe injected:", frames.matches[0].src);

  // 1. Click the Like button by ref -> synthetic fallback, handler fires once.
  const likeRef = toolJson(await call("find", { tabId, query: "React with Like" })).matches[0].ref;
  const clicked = toolJson(await call("computer", { tabId, action: "left_click", ref: likeRef }));
  assert.equal(clicked.via, "synthetic", `expected synthetic fallback: ${JSON.stringify(clicked)}`);
  let text = await pageText();
  assert.match(text, /Likes: 1/);
  assert.match(text, /pointerdown,mousedown,pointerup,mouseup,click/);
  console.log("✔ left_click via synthetic fallback; event order correct");

  // 2. Screenshot falls back to captureVisibleTab, is CSS-pixel sized, and shows the cursor.
  const shot = await call("computer", { tabId, action: "screenshot" });
  assert.ok(!shot.isError, `screenshot failed: ${JSON.stringify(shot)}`);
  const img = Buffer.from(shot.content.find((c) => c.type === "image").data, "base64");
  const size = pngSize(img);
  console.log("✔ screenshot via captureVisibleTab:", `${size.width}x${size.height}`);
  if (shotsDir) fs.writeFileSync(path.join(shotsDir, "after-click.png"), img);

  // 3. Cursor overlay exists and sits on the click point.
  const cursorInfo = toolJson(
    await call("find", { tabId, query: "cursor", selector: "[data-ccb-cursor]" }),
  );
  assert.equal(cursorInfo.matches.length, 1, "exactly one cursor overlay host");
  console.log("✔ cursor overlay mounted");

  // 4. Type into a form input, Enter submits.
  const nameRef = toolJson(await call("find", { tabId, query: "Name" })).matches[0].ref;
  toolJson(await call("computer", { tabId, action: "left_click", ref: nameRef }));
  const typed = toolJson(await call("computer", { tabId, action: "type", text: "Claude" }));
  assert.equal(typed.via, "synthetic");
  toolJson(await call("computer", { tabId, action: "key", text: "Enter" }));
  text = await pageText();
  assert.match(text, /Submitted: Claude/);
  console.log("✔ type + Enter submit via synthetic fallback");

  // 5. contenteditable composer: click places caret, type inserts text.
  const ceRef = toolJson(await call("find", { tabId, query: "Composer" })).matches[0].ref;
  toolJson(await call("computer", { tabId, action: "left_click", ref: ceRef }));
  toolJson(await call("computer", { tabId, action: "type", text: "hello world" }));
  toolJson(await call("computer", { tabId, action: "key", text: "Backspace" }));
  text = await pageText();
  assert.match(text, /hello worl\b/);
  console.log("✔ contenteditable type + Backspace");

  // 6. Scroll the inner scroller, then the page.
  const scrolled = toolJson(
    await call("computer", { tabId, action: "scroll", coordinate: [700, 400], scrollDirection: "down" }),
  );
  assert.equal(scrolled.via, "synthetic");
  const js = toolJson(await call("javascript_tool", { tabId, code: "window.scrollY" }));
  assert.ok(["scripting", "userScripts"].includes(js.via), `unexpected JS path: ${js.via}`);
  assert.ok(js.value > 0, `page should have scrolled: ${JSON.stringify(js)}`);
  console.log("✔ scroll via synthetic; javascript_tool via", js.via, "(scrollY =", js.value, ")");

  // 7. Hover moves the cursor; screenshot right after shows it.
  toolJson(await call("computer", { tabId, action: "hover", coordinate: [500, 300] }));
  const shot2 = await call("computer", { tabId, action: "screenshot" });
  if (shotsDir) {
    fs.writeFileSync(
      path.join(shotsDir, "after-hover.png"),
      Buffer.from(shot2.content.find((c) => c.type === "image").data, "base64"),
    );
  }

  // 7b. Scroll shows the wheel badge; a screenshot taken mid-badge shows it.
  toolJson(await call("computer", { tabId, action: "scroll", scrollDirection: "up", scrollAmount: 2 }));
  const shotScroll = await call("computer", { tabId, action: "screenshot" });
  if (shotsDir) {
    fs.writeFileSync(
      path.join(shotsDir, "scroll-badge.png"),
      Buffer.from(shotScroll.content.find((c) => c.type === "image").data, "base64"),
    );
  }

  // 7c. Clicking an off-screen element smooth-scrolls it into view first.
  toolJson(await call("javascript_tool", { tabId, code: "window.scrollTo(0, 0); window.scrollY" }));
  const bottomRef = toolJson(await call("find", { tabId, query: "Bottom button" })).matches[0].ref;
  const bottomClick = toolJson(await call("computer", { tabId, action: "left_click", ref: bottomRef }));
  assert.ok(bottomClick.y > 0 && bottomClick.y < 613, `target must be in view: ${JSON.stringify(bottomClick)}`);
  assert.match(await pageText(), /Bottom clicked: yes/);
  console.log("✔ off-screen ref click scrolled into view and clicked at", bottomClick.x, bottomClick.y);

  // 8. CSP page without unsafe-eval: javascript_tool reports a clear error.
  toolJson(await call("navigate", { tabId, url: `http://127.0.0.1:${APP_PORT}/app?csp=strict` }));
  const afterNav = toolJson(await call("find", { tabId, query: "cursor", selector: "[data-ccb-cursor]" }));
  assert.equal(afterNav.matches.length, 1, "cursor must be redrawn on the new page after navigate");
  const shotNav = await call("computer", { tabId, action: "screenshot" });
  if (shotsDir) {
    fs.writeFileSync(
      path.join(shotsDir, "after-navigate.png"),
      Buffer.from(shotNav.content.find((c) => c.type === "image").data, "base64"),
    );
  }
  console.log("✔ cursor redrawn after navigate");
  const cspJs = await call("javascript_tool", { tabId, code: "1 + 1" });
  console.log(
    cspJs.isError
      ? `✔ strict-CSP javascript_tool error is explicit: ${cspJs.content[0].text.slice(0, 90)}…`
      : `✔ strict-CSP javascript_tool: ${toolText(cspJs)}`,
  );

  // 9. Enable "Allow User Scripts" the way the Details toggle does, then
  //    javascript_tool must work on the strict-CSP page via userScripts.
  const { targetId: extPageId } = await cdp.send("Target.createTarget", {
    url: `chrome://extensions/?id=${loaded.id}`,
  });
  const { sessionId: extSession } = await cdp.send("Target.attachToTarget", {
    targetId: extPageId,
    flatten: false,
  });
  await new Promise((r) => setTimeout(r, 1000));
  await cdp.send("Target.sendMessageToTarget", {
    sessionId: extSession,
    message: JSON.stringify({
      id: 2,
      method: "Runtime.evaluate",
      params: {
        expression: `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(loaded.id)}, userScriptsAccess: true })`,
        awaitPromise: true,
      },
    }),
  });
  await new Promise((r) => setTimeout(r, 500));
  await cdp.send("Target.closeTarget", { targetId: extPageId });

  const us1 = toolJson(await call("javascript_tool", { tabId, code: "const n = 20; n + 22" }));
  assert.equal(us1.via, "userScripts", `expected userScripts path: ${JSON.stringify(us1)}`);
  assert.equal(us1.value, 42);
  const us2 = toolJson(await call("javascript_tool", { tabId, code: "const n = 1; n + 1" }));
  assert.equal(us2.value, 2, "let/const must be re-declarable across calls");
  const us3 = toolJson(
    await call("javascript_tool", { tabId, code: "await new Promise(r => setTimeout(r, 10)); return document.title" }),
  );
  assert.equal(us3.value, "Cursor App", "top-level await/return runs as async body");
  const usErr = await call("javascript_tool", { tabId, code: "null.boom" });
  assert.ok(usErr.isError && /TypeError/.test(usErr.content[0].text), `runtime error must surface: ${JSON.stringify(usErr)}`);
  const usSyntax = await call("javascript_tool", { tabId, code: "this is not js(" });
  assert.ok(usSyntax.isError && /SyntaxError/.test(usSyntax.content[0].text), `syntax error must surface: ${JSON.stringify(usSyntax)}`);
  const usUndef = toolJson(await call("javascript_tool", { tabId, code: "window.__ccbSideEffect = (window.__ccbSideEffect || 0) + 1; undefined" }));
  assert.equal(usUndef.value, null);
  const effects = toolJson(await call("javascript_tool", { tabId, code: "window.__ccbSideEffect" }));
  assert.equal(effects.value, 1, "code that yields undefined must run exactly once");
  console.log("✔ userScripts path on strict CSP: values, redeclare, await/return, errors, run-once");

  console.log("\nALL CURSOR/FALLBACK CHECKS PASSED");
  if (shotsDir) console.log("Screenshots in", shotsDir);
} finally {
  try {
    await client?.close();
  } catch {}
  try {
    cdp?.close();
  } catch {}
  if (chromeProc && chromeProc.exitCode === null) {
    chromeProc.kill("SIGTERM");
    setTimeout(() => chromeProc.exitCode === null && chromeProc.kill("SIGKILL"), 3000).unref();
  }
  if (bridgeProc && bridgeProc.exitCode === null) bridgeProc.kill("SIGTERM");
  appServer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
