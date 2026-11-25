import {
  ContentResponseEnvelopeSchema,
  type ContentRequest,
} from "./internal-messages";

const MISSING_RECEIVER_RE =
  /receiving end does not exist|could not establish connection|message port closed/i;

export async function ensureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

export async function sendToContentScript(
  tabId: number,
  request: ContentRequest,
): Promise<unknown> {
  let rawResponse: unknown;
  try {
    rawResponse = await chrome.tabs.sendMessage(tabId, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!MISSING_RECEIVER_RE.test(message)) {
      throw err;
    }
    await ensureContentScript(tabId);
    rawResponse = await chrome.tabs.sendMessage(tabId, request);
  }

  const parsed = ContentResponseEnvelopeSchema.safeParse(rawResponse);
  if (!parsed.success) {
    throw new Error(
      `Invalid response from content script for ${request.type}: ${parsed.error.message}`,
    );
  }
  if (!parsed.data.ok) {
    throw new Error(parsed.data.error);
  }
  return parsed.data.data;
}
