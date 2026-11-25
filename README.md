# MCP Browser Bridge for Claude Code

MCP Browser Bridge for Claude Code connects Claude Code to Google Chrome through a local Model Context Protocol (MCP) server and a Manifest V3 extension. It exposes the browser automation tools from Claude in Chrome and removes the 10 MB file upload limit so Claude Code can upload large videos such as TikTok clips.

## How large file uploads work

MCP Browser Bridge for Claude Code supports two upload paths without sending file bytes through Chrome Native Messaging.

| Mode | Mechanism | Limit | Typical speed for 50 MB |
| --- | --- | --- | --- |
| `cdp_zero_copy` and `cdp_file_chooser` | Chrome DevTools Protocol `DOM.setFileInputFiles` passes the local file path directly to Chrome. | Disk size (multi-GB supported) | 13 ms |
| `http_stream_datatransfer` and `http_stream_drop` | The extension content script streams raw binary bytes from `http://127.0.0.1:18923/stream/<token>` into a `File` and `DataTransfer`. | Browser blob storage | 48 ms |

In `auto` mode, the extension uses `cdp_zero_copy` when **Allow access to file URLs** is enabled. When that toggle is off, it falls back to loopback HTTP streaming automatically.

## Install the Chrome extension

1. Build the project if you have not built it yet.

```bash
cd /Users/thu-yein/Documents/claude-chrome-bridge
npm install
npm run build
```

2. Open `chrome://extensions` in Google Chrome.
3. Turn on **Developer mode** in the top right corner.
4. Click **Load unpacked** and select `/Users/thu-yein/Documents/claude-chrome-bridge/extension/dist`.
5. Click **Details** on **MCP Browser Bridge for Claude Code** and turn on **Allow access to file URLs**.

Turning on **Allow access to file URLs** enables zero-copy multi-GB uploads. Without it, the extension still uploads large files through the loopback HTTP stream fallback.

## Connect Claude Code

Run this command to register the MCP server with Claude Code.

```bash
claude mcp add chrome-bridge -- node /Users/thu-yein/Documents/claude-chrome-bridge/dist/server/mcp-server.js
```

When Claude Code calls any browser tool, `mcp-server.js` checks `http://127.0.0.1:18923/health` and starts the local bridge daemon automatically if it is not running. Multiple Claude Code sessions share one Chrome connection.

To use a custom loopback port, set `CLAUDE_BROWSER_PORT` in the MCP server environment and enter the same port in the extension popup.

## Upload a TikTok video with Claude Code

1. Open `https://www.tiktok.com/tiktokstudio/upload` in Chrome and sign in to your account.
2. Tell Claude Code to upload your video file and fill in the caption.

```text
Use chrome-bridge to upload /path/to/my-large-video.mp4 to my open TikTok Studio tab, set the caption to "New video #tiktok", and wait until TikTok finishes processing before asking me to post.
```

The `file_upload` tool accepts one or more local paths in `paths` and supports `mode` values of `auto`, `cdp`, `file_chooser`, `stream`, and `drop`.

## Exposed MCP tools

- `tabs_context`: List open tabs, active tab ID, and whether file URL access is enabled.
- `tabs_create`: Open a new tab at an optional URL.
- `tabs_close`: Close a tab by ID.
- `navigate`: Go to a URL or run `back`, `forward`, or `reload`.
- `read_page`: Extract the interactive accessibility tree with `ref_N` element handles, including hidden file inputs.
- `get_page_text`: Read visible page text.
- `find`: Search elements by text, label, role, or CSS selector.
- `computer`: Capture screenshots and send mouse clicks, drags, scrolls, key chords, typed text, or waits. Pointer actions glide a visible orange **Claude** cursor to the target and show a ripple on each click.
- `form_input`: Fill React, Vue, or native form controls by `ref`.
- `file_upload`: Attach local files of unlimited size to `<input type="file">`, dynamic file choosers, or drag-and-drop zones.
- `javascript_tool`: Evaluate JavaScript in the page main world. `let`/`const` can be redeclared across calls, and top-level `await`/`return` work.
- `read_console_messages`: Read captured console logs and errors.
- `read_network_requests`: Read captured network requests and responses.
- `resize_window`: Resize the browser window.

## When the Chrome debugger is blocked

Chrome refuses `chrome.debugger.attach` on any tab that contains a frame from another extension (error: `Cannot access a chrome-extension:// URL of different extension`). Some extensions, such as audio or recording helpers, inject a hidden iframe into every page, which blocks CDP everywhere.

When that happens the bridge falls back automatically, and each result reports the path it used in `via`:

| Action | Normal path | Fallback |
| --- | --- | --- |
| Screenshot | `Page.captureScreenshot` | `chrome.tabs.captureVisibleTab` (activates the tab; scaled to CSS pixels so image coordinates match click coordinates) |
| Click, hover, drag, scroll, type, key | `Input.dispatch*` (trusted events) | DOM events from the content script (`via: "synthetic"`), with focus, caret placement, text insertion, Enter-to-submit, Tab and scrolling emulated |
| `javascript_tool` | `Runtime.evaluate` | `chrome.userScripts.execute` (`via: "userScripts"`, works on pages whose CSP forbids eval), else `chrome.scripting` + eval (`via: "scripting"`) |

Synthetic events have `isTrusted === false`. Most sites accept them, including React apps such as Facebook, but a few ignore them. Console and network capture still need the debugger.

To use the CSP-proof JavaScript path, open `chrome://extensions`, click **Details** on **MCP Browser Bridge for Claude Code**, and turn on **Allow User Scripts**.

## Verify locally

Run the typecheck, build, server integration tests, and Chrome 50 MB end-to-end test suite.

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:e2e:cursor   # debugger-blocked fallbacks + visible cursor
```
