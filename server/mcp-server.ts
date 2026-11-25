#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type BridgeCommand,
  ComputerParamsSchema,
  DEFAULT_BRIDGE_HOST,
  FileUploadResultSchema,
  FindParamsSchema,
  FormInputParamsSchema,
  GetPageTextParamsSchema,
  JavascriptToolParamsSchema,
  NavigateParamsSchema,
  ReadConsoleParamsSchema,
  ReadNetworkParamsSchema,
  ReadPageParamsSchema,
  ResizeWindowParamsSchema,
  ScreenshotResultSchema,
  TabsCloseParamsSchema,
  TabsContextParamsSchema,
  TabsCreateParamsSchema,
} from "../shared/protocol.js";
import { resolveBridgePort } from "./bridge.js";
import { BridgeClient, BridgeError, ensureBridgeRunning } from "./bridge-client.js";

const FILE_UPLOAD_TIMEOUT_MS = 300_000;
const BYTES_PER_MIB = 1024 * 1024;

const FileUploadToolInputSchema = z.object({
  tabId: z.number().int().optional(),
  paths: z.array(z.string().min(1)).min(1),
  ref: z.string().optional(),
  selector: z.string().optional(),
  triggerRef: z.string().optional(),
  triggerSelector: z.string().optional(),
  mode: z.enum(["auto", "cdp", "stream", "drop", "file_chooser"]).default("auto"),
});

function formatError(err: unknown): string {
  if (err instanceof BridgeError) {
    return err.code !== undefined ? `[${err.code}] ${err.message}` : err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function textResult(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
  };
}

function errorResult(err: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: formatError(err) }],
  };
}

async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}

export function createMcpBrowserServer(options?: { host?: string; port?: number }): {
  server: McpServer;
  client: BridgeClient;
} {
  const host = options?.host ?? DEFAULT_BRIDGE_HOST;
  const port = resolveBridgePort(options?.port);
  const client = new BridgeClient({ host, port });

  const server = new McpServer({
    name: "claude-chrome-bridge",
    version: "1.0.0",
  });

  const forwardCommand = async (command: BridgeCommand, timeoutMs?: number): Promise<CallToolResult> => {
    const result = await client.call(command, timeoutMs);
    return textResult(result);
  };

  server.registerTool(
    "tabs_context",
    {
      description: "List open Chrome tabs with IDs, titles, URLs, and active status.",
      inputSchema: TabsContextParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "tabs_context", params: args }))
  );

  server.registerTool(
    "tabs_create",
    {
      description: "Open a new Chrome tab, optionally navigating to a URL.",
      inputSchema: TabsCreateParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "tabs_create", params: args }))
  );

  server.registerTool(
    "tabs_close",
    {
      description: "Close an open Chrome tab by tabId.",
      inputSchema: TabsCloseParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "tabs_close", params: args }))
  );

  server.registerTool(
    "navigate",
    {
      description: "Navigate a Chrome tab to a URL or history action (back/forward/reload).",
      inputSchema: NavigateParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "navigate", params: args }))
  );

  server.registerTool(
    "read_page",
    {
      description: "Return an accessibility tree snapshot of the page with stable element refs.",
      inputSchema: ReadPageParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "read_page", params: args }))
  );

  server.registerTool(
    "get_page_text",
    {
      description: "Extract visible text content from the current page.",
      inputSchema: GetPageTextParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "get_page_text", params: args }))
  );

  server.registerTool(
    "find",
    {
      description: "Find matching elements on the page by query text or CSS selector and return their refs.",
      inputSchema: FindParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "find", params: args }))
  );

  server.registerTool(
    "computer",
    {
      description:
        "Perform mouse, keyboard, scroll, wait, or screenshot actions on a Chrome tab.",
      inputSchema: ComputerParamsSchema.shape,
    },
    async (args) =>
      runTool(async () => {
        const result = await client.call({ method: "computer", params: args });
        if (args.action === "screenshot") {
          const parsed = ScreenshotResultSchema.parse(result);
          return {
            content: [
              {
                type: "image",
                data: parsed.base64,
                mimeType: parsed.mimeType,
              },
            ],
          };
        }
        return textResult(result);
      })
  );

  server.registerTool(
    "form_input",
    {
      description: "Set the value of a form input, select, checkbox, or textarea by element ref.",
      inputSchema: FormInputParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "form_input", params: args }))
  );

  server.registerTool(
    "file_upload",
    {
      description:
        "Upload one or more local files of unlimited size (50 MB to multi-GB) into a page file input or drop zone via Chrome.",
      inputSchema: FileUploadToolInputSchema.shape,
    },
    async (args) =>
      runTool(async () => {
        await ensureBridgeRunning({ host, port });
        const files = await client.registerFiles(args.paths);
        const raw = await client.call(
          {
            method: "file_upload",
            params: {
              tabId: args.tabId,
              files,
              ref: args.ref,
              selector: args.selector,
              triggerRef: args.triggerRef,
              triggerSelector: args.triggerSelector,
              mode: args.mode,
            },
          },
          FILE_UPLOAD_TIMEOUT_MS
        );

        const parsed = FileUploadResultSchema.safeParse(raw);
        if (!parsed.success) {
          return textResult(raw);
        }

        const data = parsed.data;
        const usedStreamingFallback =
          data.method === "http_stream_datatransfer" || data.method === "http_stream_drop";
        const fileAccessTip =
          'Fallback HTTP streaming was used. Enable "Allow access to file URLs" for this extension in chrome://extensions for instant zero-copy multi-GB uploads.';

        const noteParts = [data.note, usedStreamingFallback ? fileAccessTip : undefined].filter(
          (part): part is string => part !== undefined && part.length > 0
        );

        const summary = {
          method: data.method,
          tabId: data.tabId,
          durationMs: data.durationMs,
          ...(data.inputSelector !== undefined ? { inputSelector: data.inputSelector } : {}),
          files: data.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            sizeMB: Number((file.sizeBytes / BYTES_PER_MIB).toFixed(2)),
          })),
          ...(noteParts.length > 0 ? { note: noteParts.join(" ") } : {}),
        };

        return textResult(summary);
      })
  );

  server.registerTool(
    "javascript_tool",
    {
      description: "Execute JavaScript in the context of a Chrome tab and return the serialized result.",
      inputSchema: JavascriptToolParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "javascript_tool", params: args }))
  );

  server.registerTool(
    "read_console_messages",
    {
      description: "Read captured console logs and errors from a Chrome tab.",
      inputSchema: ReadConsoleParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "read_console_messages", params: args }))
  );

  server.registerTool(
    "read_network_requests",
    {
      description: "Read captured network requests from a Chrome tab.",
      inputSchema: ReadNetworkParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "read_network_requests", params: args }))
  );

  server.registerTool(
    "resize_window",
    {
      description: "Resize the Chrome browser window containing the target tab.",
      inputSchema: ResizeWindowParamsSchema.shape,
    },
    async (args) => runTool(() => forwardCommand({ method: "resize_window", params: args }))
  );

  return { server, client };
}

async function main(): Promise<void> {
  const { server, client } = createMcpBrowserServer();
  const transport = new StdioServerTransport();

  void ensureBridgeRunning().catch(() => undefined);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    client.close();
    void server.close().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
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
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ level: "error", component: "mcp-server", error: message })}\n`);
    process.exit(1);
  });
}
