import { z } from "zod";

export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 18923;
export const BRIDGE_PROTOCOL_VERSION = 1;

export const TabInfoSchema = z.object({
  id: z.number().int(),
  windowId: z.number().int(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  status: z.string().optional(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const ExtensionHelloSchema = z.object({
  type: z.literal("hello"),
  version: z.number().int(),
  extensionId: z.string(),
  allowedFileAccess: z.boolean(),
  userAgent: z.string().optional(),
});
export type ExtensionHello = z.infer<typeof ExtensionHelloSchema>;

export const TabsContextParamsSchema = z.object({});

export const TabsCreateParamsSchema = z.object({
  url: z.string().optional(),
  active: z.boolean().optional(),
});

export const TabsCloseParamsSchema = z.object({
  tabId: z.number().int(),
});

export const NavigateParamsSchema = z.object({
  tabId: z.number().int().optional(),
  url: z.string().min(1),
});

export const ReadPageParamsSchema = z.object({
  tabId: z.number().int().optional(),
  filter: z.enum(["interactive", "all"]).default("interactive"),
  depth: z.number().int().min(1).max(30).default(15),
  refId: z.string().optional(),
  maxChars: z.number().int().min(500).max(200000).default(50000),
});

export const GetPageTextParamsSchema = z.object({
  tabId: z.number().int().optional(),
  maxChars: z.number().int().min(500).max(200000).default(50000),
});

export const FindParamsSchema = z.object({
  tabId: z.number().int().optional(),
  query: z.string().min(1),
  selector: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const CoordinateSchema = z.tuple([z.number(), z.number()]);

export const ComputerParamsSchema = z.object({
  tabId: z.number().int().optional(),
  action: z.enum([
    "screenshot",
    "left_click",
    "right_click",
    "double_click",
    "triple_click",
    "middle_click",
    "hover",
    "scroll",
    "type",
    "key",
    "left_click_drag",
    "wait",
  ]),
  coordinate: CoordinateSchema.optional(),
  startCoordinate: CoordinateSchema.optional(),
  ref: z.string().optional(),
  text: z.string().optional(),
  scrollDirection: z.enum(["up", "down", "left", "right"]).optional(),
  scrollAmount: z.number().min(1).max(20).optional(),
  modifiers: z.string().optional(),
  repeat: z.number().int().min(1).max(100).optional(),
  duration: z.number().min(0.05).max(30).optional(),
});

export const FormInputParamsSchema = z.object({
  tabId: z.number().int().optional(),
  ref: z.string().min(1),
  value: z.union([z.string(), z.boolean(), z.number()]),
});

export const ResolvedUploadFileSchema = z.object({
  absolutePath: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  streamUrl: z.string().url(),
});
export type ResolvedUploadFile = z.infer<typeof ResolvedUploadFileSchema>;

export const FileUploadCommandParamsSchema = z.object({
  tabId: z.number().int().optional(),
  files: z.array(ResolvedUploadFileSchema).min(1),
  ref: z.string().optional(),
  selector: z.string().optional(),
  triggerRef: z.string().optional(),
  triggerSelector: z.string().optional(),
  mode: z.enum(["auto", "cdp", "stream", "drop", "file_chooser"]).default("auto"),
});
export type FileUploadCommandParams = z.infer<typeof FileUploadCommandParamsSchema>;

export const JavascriptToolParamsSchema = z.object({
  tabId: z.number().int().optional(),
  code: z.string().min(1),
});

export const ReadConsoleParamsSchema = z.object({
  tabId: z.number().int().optional(),
  pattern: z.string().optional(),
  onlyErrors: z.boolean().default(false),
  clear: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
});

export const ReadNetworkParamsSchema = z.object({
  tabId: z.number().int().optional(),
  urlPattern: z.string().optional(),
  clear: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
});

export const ResizeWindowParamsSchema = z.object({
  tabId: z.number().int().optional(),
  width: z.number().int().min(200).max(7680),
  height: z.number().int().min(200).max(4320),
});

export const BridgeCommandSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("tabs_context"), params: TabsContextParamsSchema }),
  z.object({ method: z.literal("tabs_create"), params: TabsCreateParamsSchema }),
  z.object({ method: z.literal("tabs_close"), params: TabsCloseParamsSchema }),
  z.object({ method: z.literal("navigate"), params: NavigateParamsSchema }),
  z.object({ method: z.literal("read_page"), params: ReadPageParamsSchema }),
  z.object({ method: z.literal("get_page_text"), params: GetPageTextParamsSchema }),
  z.object({ method: z.literal("find"), params: FindParamsSchema }),
  z.object({ method: z.literal("computer"), params: ComputerParamsSchema }),
  z.object({ method: z.literal("form_input"), params: FormInputParamsSchema }),
  z.object({ method: z.literal("file_upload"), params: FileUploadCommandParamsSchema }),
  z.object({ method: z.literal("javascript_tool"), params: JavascriptToolParamsSchema }),
  z.object({ method: z.literal("read_console_messages"), params: ReadConsoleParamsSchema }),
  z.object({ method: z.literal("read_network_requests"), params: ReadNetworkParamsSchema }),
  z.object({ method: z.literal("resize_window"), params: ResizeWindowParamsSchema }),
]);
export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;

export const BridgeRequestEnvelopeSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1),
  command: BridgeCommandSchema,
});
export type BridgeRequestEnvelope = z.infer<typeof BridgeRequestEnvelopeSchema>;

export const BridgeResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string().min(1),
    ok: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
  }),
]);
export type BridgeResponseEnvelope = z.infer<typeof BridgeResponseEnvelopeSchema>;

export const PingEnvelopeSchema = z.object({
  type: z.literal("ping"),
  ts: z.number(),
});

export const PongEnvelopeSchema = z.object({
  type: z.literal("pong"),
  ts: z.number(),
});

export const WireMessageSchema = z.union([
  ExtensionHelloSchema,
  BridgeRequestEnvelopeSchema,
  BridgeResponseEnvelopeSchema,
  PingEnvelopeSchema,
  PongEnvelopeSchema,
]);
export type WireMessage = z.infer<typeof WireMessageSchema>;

export const FileUploadResultSchema = z.object({
  method: z.enum(["cdp_zero_copy", "cdp_file_chooser", "http_stream_datatransfer", "http_stream_drop"]),
  tabId: z.number().int(),
  durationMs: z.number().nonnegative(),
  files: z.array(
    z.object({
      name: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      mimeType: z.string(),
    })
  ),
  inputSelector: z.string().optional(),
  note: z.string().optional(),
});
export type FileUploadResult = z.infer<typeof FileUploadResultSchema>;

export const ScreenshotResultSchema = z.object({
  tabId: z.number().int(),
  mimeType: z.literal("image/png"),
  base64: z.string().min(1),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;
