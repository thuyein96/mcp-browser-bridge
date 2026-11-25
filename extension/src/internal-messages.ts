import { z } from "zod";
import { ResolvedUploadFileSchema } from "../../shared/protocol";

const MouseButtonSchema = z.enum(["left", "right", "middle"]);

export const ContentRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ccb_read_page"),
    filter: z.enum(["interactive", "all"]),
    depth: z.number().int().min(1).max(30),
    refId: z.string().optional(),
    maxChars: z.number().int().min(500).max(200000),
  }),
  z.object({
    type: z.literal("ccb_get_page_text"),
    maxChars: z.number().int().min(500).max(200000),
  }),
  z.object({
    type: z.literal("ccb_find"),
    query: z.string().min(1),
    selector: z.string().optional(),
    limit: z.number().int().min(1).max(50),
  }),
  z.object({
    type: z.literal("ccb_form_input"),
    ref: z.string().min(1),
    value: z.union([z.string(), z.boolean(), z.number()]),
  }),
  z.object({
    type: z.literal("ccb_resolve_ref"),
    ref: z.string().optional(),
    selector: z.string().optional(),
  }),
  z.object({
    type: z.literal("ccb_stream_upload"),
    files: z.array(ResolvedUploadFileSchema).min(1),
    ref: z.string().optional(),
    selector: z.string().optional(),
    drop: z.boolean(),
  }),
  z.object({
    type: z.literal("ccb_cursor"),
    op: z.enum(["move", "click", "scroll", "show"]),
    x: z.number(),
    y: z.number(),
    button: MouseButtonSchema.optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    fromX: z.number().optional(),
    fromY: z.number().optional(),
  }),
  z.object({
    type: z.literal("ccb_viewport"),
  }),
  z.object({
    type: z.literal("ccb_synthetic_mouse"),
    kind: z.enum(["click", "move", "drag", "scroll"]),
    x: z.number(),
    y: z.number(),
    button: MouseButtonSchema.default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers: z.number().int().default(0),
    startX: z.number().optional(),
    startY: z.number().optional(),
    deltaX: z.number().default(0),
    deltaY: z.number().default(0),
  }),
  z.object({
    type: z.literal("ccb_synthetic_key"),
    key: z.string(),
    code: z.string(),
    keyCode: z.number().int(),
    text: z.string().optional(),
    modifiers: z.number().int().default(0),
  }),
  z.object({
    type: z.literal("ccb_synthetic_type"),
    text: z.string(),
  }),
]);
export type ContentRequest = z.infer<typeof ContentRequestSchema>;

export const ElementRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type ElementRect = z.infer<typeof ElementRectSchema>;

export const ResolveRefDataSchema = z.object({
  x: z.number(),
  y: z.number(),
  rect: ElementRectSchema,
  tag: z.string(),
});
export type ResolveRefData = z.infer<typeof ResolveRefDataSchema>;

export const ViewportDataSchema = z.object({
  width: z.number(),
  height: z.number(),
  devicePixelRatio: z.number(),
});
export type ViewportData = z.infer<typeof ViewportDataSchema>;

export const StreamUploadDataSchema = z.object({
  count: z.number().int().nonnegative(),
  inputSelector: z.string(),
  uploadedNames: z.array(z.string()),
});
export type StreamUploadData = z.infer<typeof StreamUploadDataSchema>;

export const ContentResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);
export type ContentResponseEnvelope = z.infer<typeof ContentResponseEnvelopeSchema>;

export const ActivityEntrySchema = z.object({
  id: z.string(),
  method: z.string(),
  target: z.string(),
  status: z.enum(["ok", "error"]),
  durationMs: z.number().nonnegative(),
  timestamp: z.number(),
  detail: z.string().optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

export const PopupStateSchema = z.object({
  connected: z.boolean(),
  connecting: z.boolean(),
  port: z.number().int(),
  lastError: z.string().nullable(),
  allowedFileAccess: z.boolean(),
  extensionId: z.string(),
  activity: z.array(ActivityEntrySchema),
});
export type PopupState = z.infer<typeof PopupStateSchema>;

export const PopupRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ccb_popup_state") }),
  z.object({ type: z.literal("ccb_popup_reconnect") }),
  z.object({ type: z.literal("ccb_popup_set_port"), port: z.number().int().min(1).max(65535) }),
]);
export type PopupRequest = z.infer<typeof PopupRequestSchema>;
