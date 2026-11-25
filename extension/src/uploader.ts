import { z } from "zod";
import type {
  FileUploadCommandParams,
  FileUploadResult,
} from "../../shared/protocol";
import { sendToContentScript } from "./content-bridge";
import type { DebuggerSessionManager } from "./debugger-session";
import {
  ResolveRefDataSchema,
  StreamUploadDataSchema,
} from "./internal-messages";

interface CdpDomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
}

const CdpDomNodeSchema: z.ZodType<CdpDomNode> = z.lazy(() =>
  z.object({
    nodeId: z.number().int(),
    backendNodeId: z.number().int(),
    nodeType: z.number().int(),
    nodeName: z.string(),
    localName: z.string().optional(),
    attributes: z.array(z.string()).optional(),
    children: z.array(CdpDomNodeSchema).optional(),
    shadowRoots: z.array(CdpDomNodeSchema).optional(),
    contentDocument: CdpDomNodeSchema.optional(),
  }),
);

const GetDocumentResultSchema = z.object({
  root: CdpDomNodeSchema,
});

const QuerySelectorResultSchema = z.object({
  nodeId: z.number().int(),
});

const DescribeNodeResultSchema = z.object({
  node: z.object({
    backendNodeId: z.number().int(),
    nodeName: z.string(),
    attributes: z.array(z.string()).optional(),
  }),
});

const RuntimeEvaluateObjectSchema = z.object({
  result: z.object({
    type: z.string(),
    subtype: z.string().optional(),
    objectId: z.string().optional(),
  }),
});

const BoxModelResultSchema = z.object({
  model: z.object({
    content: z.array(z.number()),
  }),
});

interface LocatedNode {
  backendNodeId: number;
  selector: string;
}

const VIDEO_ACCEPT_RE = /video|\.mp4|\.mov|\.webm|\.mkv|\.avi/i;
const NOT_ALLOWED_RE = /not allowed/i;

function parseAttributes(attrs?: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!attrs) return map;
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const key = attrs[i];
    const value = attrs[i + 1];
    if (key !== undefined && value !== undefined) {
      map.set(key.toLowerCase(), value);
    }
  }
  return map;
}

function isFileInputNode(node: CdpDomNode): boolean {
  if (node.nodeName.toLowerCase() !== "input") {
    return false;
  }
  const attrs = parseAttributes(node.attributes);
  return (attrs.get("type") ?? "").toLowerCase() === "file";
}

function describeDomNode(node: {
  nodeName: string;
  attributes?: string[];
}): string {
  const tag = node.nodeName.toLowerCase();
  const attrs = parseAttributes(node.attributes);
  const id = attrs.get("id");
  if (id) {
    return `${tag}#${id}`;
  }
  const parts = [tag];
  const type = attrs.get("type");
  if (type) parts.push(`[type="${type}"]`);
  const name = attrs.get("name");
  if (name) parts.push(`[name="${name}"]`);
  const accept = attrs.get("accept");
  if (accept) parts.push(`[accept="${accept}"]`);
  return parts.join("");
}

function walkPiercedTree(
  root: CdpDomNode,
  visitor: (node: CdpDomNode) => boolean | void,
): boolean {
  if (visitor(root) === true) {
    return true;
  }
  if (root.shadowRoots) {
    for (const sr of root.shadowRoots) {
      if (walkPiercedTree(sr, visitor)) return true;
    }
  }
  if (root.contentDocument) {
    if (walkPiercedTree(root.contentDocument, visitor)) return true;
  }
  if (root.children) {
    for (const child of root.children) {
      if (walkPiercedTree(child, visitor)) return true;
    }
  }
  return false;
}

function findNodeByAttribute(
  root: CdpDomNode,
  attrName: string,
  attrValue: string,
): CdpDomNode | null {
  let found: CdpDomNode | null = null;
  const targetAttr = attrName.toLowerCase();
  walkPiercedTree(root, (node) => {
    const attrs = parseAttributes(node.attributes);
    if (attrs.get(targetAttr) === attrValue) {
      found = node;
      return true;
    }
    return false;
  });
  return found;
}

function collectFileInputs(root: CdpDomNode): CdpDomNode[] {
  const inputs: CdpDomNode[] = [];
  walkPiercedTree(root, (node) => {
    if (isFileInputNode(node)) {
      inputs.push(node);
    }
  });
  return inputs;
}

function pickBestFileInput(
  inputs: CdpDomNode[],
  preferVideo: boolean,
): CdpDomNode | null {
  if (inputs.length === 0) return null;
  if (preferVideo) {
    const videoMatch = inputs.find((node) => {
      const accept = parseAttributes(node.attributes).get("accept") ?? "";
      return VIDEO_ACCEPT_RE.test(accept);
    });
    if (videoMatch) {
      return videoMatch;
    }
  }
  return inputs[0] ?? null;
}

async function getPiercedDocument(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
): Promise<CdpDomNode> {
  const raw = await debuggerMgr.send(tabId, "DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  const parsed = GetDocumentResultSchema.parse(raw);
  return parsed.root;
}

async function describeByObjectId(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
  objectId: string,
): Promise<LocatedNode> {
  const raw = await debuggerMgr.send(tabId, "DOM.describeNode", { objectId });
  const parsed = DescribeNodeResultSchema.parse(raw);
  return {
    backendNodeId: parsed.node.backendNodeId,
    selector: describeDomNode(parsed.node),
  };
}

async function findByDeepRuntimeSelector(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
  selector: string,
): Promise<LocatedNode | null> {
  const expression = `(() => {
    const sel = ${JSON.stringify(selector)};
    const search = (root) => {
      try {
        const direct = root.querySelector(sel);
        if (direct) return direct;
      } catch {}
      const all = root.querySelectorAll("*");
      for (const el of all) {
        if (el.shadowRoot) {
          const hit = search(el.shadowRoot);
          if (hit) return hit;
        }
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument) {
              const hit = search(el.contentDocument);
              if (hit) return hit;
            }
          } catch {}
        }
      }
      return null;
    };
    return search(document);
  })()`;

  const raw = await debuggerMgr.send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: false,
  });
  const parsed = RuntimeEvaluateObjectSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.result.objectId) {
    return null;
  }
  if (parsed.data.result.subtype === "null") {
    return null;
  }
  return describeByObjectId(debuggerMgr, tabId, parsed.data.result.objectId);
}

async function locateFileInputForCdp(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
  params: FileUploadCommandParams,
): Promise<LocatedNode> {
  const preferVideo = params.files.some((f) => f.mimeType.startsWith("video/"));
  const root = await getPiercedDocument(debuggerMgr, tabId);

  if (params.ref) {
    const byAttr = findNodeByAttribute(root, "data-ccb-ref", params.ref);
    if (byAttr) {
      if (isFileInputNode(byAttr)) {
        return {
          backendNodeId: byAttr.backendNodeId,
          selector: describeDomNode(byAttr),
        };
      }
      const nested = pickBestFileInput(collectFileInputs(byAttr), preferVideo);
      if (nested) {
        return {
          backendNodeId: nested.backendNodeId,
          selector: describeDomNode(nested),
        };
      }
      return {
        backendNodeId: byAttr.backendNodeId,
        selector: describeDomNode(byAttr),
      };
    }

    const rawEval = await debuggerMgr.send(tabId, "Runtime.evaluate", {
      expression: `window.__ccbGetElementByRef?.(${JSON.stringify(params.ref)}) ?? null`,
      returnByValue: false,
    });
    const parsedEval = RuntimeEvaluateObjectSchema.safeParse(rawEval);
    if (
      parsedEval.success &&
      parsedEval.data.result.objectId &&
      parsedEval.data.result.subtype !== "null"
    ) {
      return describeByObjectId(
        debuggerMgr,
        tabId,
        parsedEval.data.result.objectId,
      );
    }

    throw new Error(`Could not locate element for ref "${params.ref}"`);
  }

  if (params.selector) {
    const rawQuery = await debuggerMgr.send(tabId, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector: params.selector,
    });
    const parsedQuery = QuerySelectorResultSchema.safeParse(rawQuery);
    if (parsedQuery.success && parsedQuery.data.nodeId !== 0) {
      const rawDesc = await debuggerMgr.send(tabId, "DOM.describeNode", {
        nodeId: parsedQuery.data.nodeId,
      });
      const parsedDesc = DescribeNodeResultSchema.parse(rawDesc);
      return {
        backendNodeId: parsedDesc.node.backendNodeId,
        selector: params.selector,
      };
    }

    const deepHit = await findByDeepRuntimeSelector(
      debuggerMgr,
      tabId,
      params.selector,
    );
    if (deepHit) {
      return {
        backendNodeId: deepHit.backendNodeId,
        selector: params.selector,
      };
    }

    throw new Error(
      `No element matched selector "${params.selector}" for file upload`,
    );
  }

  const allInputs = collectFileInputs(root);
  const chosen = pickBestFileInput(allInputs, preferVideo);
  if (!chosen) {
    throw new Error(
      'No <input type="file"> found in page DOM, shadow roots, or iframes. Provide triggerRef/triggerSelector (file_chooser mode) or use mode: "drop" on a dropzone.',
    );
  }

  return {
    backendNodeId: chosen.backendNodeId,
    selector: describeDomNode(chosen),
  };
}

async function resolveTriggerCoordinates(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
  params: FileUploadCommandParams,
): Promise<{ x: number; y: number; label: string }> {
  try {
    const raw = await sendToContentScript(tabId, {
      type: "ccb_resolve_ref",
      ref: params.triggerRef,
      selector: params.triggerSelector,
    });
    const parsed = ResolveRefDataSchema.parse(raw);
    return {
      x: parsed.x,
      y: parsed.y,
      label: params.triggerRef ?? params.triggerSelector ?? parsed.tag,
    };
  } catch {
    // Fallback to CDP pierced DOM lookup (handles cross-origin iframes).
  }

  const root = await getPiercedDocument(debuggerMgr, tabId);
  let targetBackendNodeId: number | null = null;

  if (params.triggerRef) {
    const node = findNodeByAttribute(root, "data-ccb-ref", params.triggerRef);
    if (node) targetBackendNodeId = node.backendNodeId;
  } else if (params.triggerSelector) {
    const rawQuery = await debuggerMgr.send(tabId, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector: params.triggerSelector,
    });
    const parsedQuery = QuerySelectorResultSchema.safeParse(rawQuery);
    if (parsedQuery.success && parsedQuery.data.nodeId !== 0) {
      const desc = DescribeNodeResultSchema.parse(
        await debuggerMgr.send(tabId, "DOM.describeNode", {
          nodeId: parsedQuery.data.nodeId,
        }),
      );
      targetBackendNodeId = desc.node.backendNodeId;
    } else {
      const deep = await findByDeepRuntimeSelector(
        debuggerMgr,
        tabId,
        params.triggerSelector,
      );
      if (deep) targetBackendNodeId = deep.backendNodeId;
    }
  }

  if (targetBackendNodeId === null) {
    throw new Error(
      `Could not locate trigger element (${params.triggerRef ?? params.triggerSelector ?? "none"})`,
    );
  }

  await debuggerMgr
    .send(tabId, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: targetBackendNodeId,
    })
    .catch(() => undefined);

  const boxRaw = await debuggerMgr.send(tabId, "DOM.getBoxModel", {
    backendNodeId: targetBackendNodeId,
  });
  const box = BoxModelResultSchema.parse(boxRaw);
  const q = box.model.content;
  if (q.length < 8) {
    throw new Error("Trigger element has no visible layout box");
  }
  const x = Math.round(((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4);
  const y = Math.round(((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4);
  return {
    x,
    y,
    label: params.triggerRef ?? params.triggerSelector ?? "trigger",
  };
}

function summarizeFiles(params: FileUploadCommandParams): FileUploadResult["files"] {
  return params.files.map((f) => ({
    name: f.name,
    sizeBytes: f.sizeBytes,
    mimeType: f.mimeType,
  }));
}

async function runCdpZeroCopyUpload(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
  params: FileUploadCommandParams,
  startedAt: number,
): Promise<FileUploadResult> {
  const located = await locateFileInputForCdp(debuggerMgr, tabId, params);
  await debuggerMgr.send(tabId, "DOM.setFileInputFiles", {
    backendNodeId: located.backendNodeId,
    files: params.files.map((f) => f.absolutePath),
  });

  return {
    method: "cdp_zero_copy",
    tabId,
    durationMs: Date.now() - startedAt,
    files: summarizeFiles(params),
    inputSelector: located.selector,
  };
}

async function runFileChooserUpload(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
  params: FileUploadCommandParams,
  startedAt: number,
): Promise<FileUploadResult> {
  if (!params.triggerRef && !params.triggerSelector) {
    throw new Error(
      'file_chooser mode requires either "triggerRef" or "triggerSelector".',
    );
  }

  await debuggerMgr.send(tabId, "Page.setInterceptFileChooserDialog", {
    enabled: true,
  });

  try {
    const chooserPromise = debuggerMgr.waitForFileChooser(tabId, 10_000);
    const coords = await resolveTriggerCoordinates(debuggerMgr, tabId, params);

    await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: coords.x,
      y: coords.y,
    });
    await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: coords.x,
      y: coords.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await debuggerMgr.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: coords.x,
      y: coords.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });

    const chooser = await chooserPromise;
    await debuggerMgr.send(tabId, "DOM.setFileInputFiles", {
      backendNodeId: chooser.backendNodeId,
      files: params.files.map((f) => f.absolutePath),
    });

    return {
      method: "cdp_file_chooser",
      tabId,
      durationMs: Date.now() - startedAt,
      files: summarizeFiles(params),
      inputSelector: coords.label,
    };
  } finally {
    await debuggerMgr
      .send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false })
      .catch(() => undefined);
  }
}

async function runStreamUpload(
  tabId: number,
  params: FileUploadCommandParams,
  drop: boolean,
  startedAt: number,
  note?: string,
): Promise<FileUploadResult> {
  const raw = await sendToContentScript(tabId, {
    type: "ccb_stream_upload",
    files: params.files,
    ref: params.ref,
    selector: params.selector,
    drop,
  });
  const parsed = StreamUploadDataSchema.parse(raw);

  return {
    method: drop ? "http_stream_drop" : "http_stream_datatransfer",
    tabId,
    durationMs: Date.now() - startedAt,
    files: summarizeFiles(params),
    inputSelector: parsed.inputSelector,
    note,
  };
}

function isNotAllowedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NOT_ALLOWED_RE.test(message);
}

const FILE_ACCESS_HINT =
  'Enable "Allow access to file URLs" in chrome://extensions for MCP Browser Bridge for Claude Code to unlock instant zero-copy multi-GB uploads.';

export async function executeFileUpload(
  debuggerMgr: DebuggerSessionManager,
  tabId: number,
  params: FileUploadCommandParams,
): Promise<FileUploadResult> {
  const startedAt = Date.now();
  const hasTrigger = Boolean(params.triggerRef || params.triggerSelector);

  switch (params.mode) {
    case "file_chooser":
      return runFileChooserUpload(debuggerMgr, tabId, params, startedAt);

    case "cdp":
      return runCdpZeroCopyUpload(debuggerMgr, tabId, params, startedAt);

    case "stream":
      return runStreamUpload(tabId, params, false, startedAt);

    case "drop":
      return runStreamUpload(tabId, params, true, startedAt);

    case "auto": {
      if (hasTrigger) {
        try {
          return await runFileChooserUpload(debuggerMgr, tabId, params, startedAt);
        } catch (err) {
          if (isNotAllowedError(err)) {
            return runStreamUpload(
              tabId,
              params,
              false,
              startedAt,
              `Fell back to HTTP stream DataTransfer because CDP file access was denied. ${FILE_ACCESS_HINT}`,
            );
          }
          throw err;
        }
      }

      const allowedFileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (allowedFileAccess) {
        try {
          return await runCdpZeroCopyUpload(debuggerMgr, tabId, params, startedAt);
        } catch (err) {
          if (isNotAllowedError(err)) {
            return runStreamUpload(
              tabId,
              params,
              false,
              startedAt,
              `Fell back to HTTP stream DataTransfer because CDP returned "Not allowed". ${FILE_ACCESS_HINT}`,
            );
          }
          throw err;
        }
      }

      return runStreamUpload(
        tabId,
        params,
        false,
        startedAt,
        `Used HTTP stream DataTransfer fallback because "Allow access to file URLs" is OFF. ${FILE_ACCESS_HINT}`,
      );
    }

    default: {
      const _exhaustive: never = params.mode;
      throw new Error(`Unsupported file upload mode: ${String(_exhaustive)}`);
    }
  }
}
