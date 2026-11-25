import {
  ContentRequestSchema,
  type ContentRequest,
  type ContentResponseEnvelope,
} from "./internal-messages";
import {
  clickCursor,
  cursorPosition,
  moveCursor,
  scrollCursor,
  showCursorAt,
} from "./cursor-overlay";
import {
  scrollIntoViewVisibly,
  syntheticClick,
  syntheticDrag,
  syntheticHover,
  syntheticKey,
  syntheticScroll,
  syntheticType,
} from "./synthetic-input";

declare global {
  interface Window {
    __ccbContentLoaded?: boolean | string;
    __ccbGetElementByRef?: (ref: string) => Element | null;
  }
}

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "details",
  "summary",
  "option",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "treeitem",
]);

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "path",
  "meta",
  "link",
  "head",
]);

const VIDEO_ACCEPT_RE = /video|\.mp4|\.mov|\.webm|\.mkv|\.avi/i;

let nextRefId = 1;
const refToElement = new Map<string, WeakRef<Element>>();
const elementToRef = new WeakMap<Element, string>();

function getOrCreateRef(el: Element): string {
  const existing = elementToRef.get(el);
  if (existing) {
    if (el.getAttribute("data-ccb-ref") !== existing) {
      el.setAttribute("data-ccb-ref", existing);
    }
    return existing;
  }

  const attrRef = el.getAttribute("data-ccb-ref");
  if (attrRef && refToElement.get(attrRef)?.deref() === el) {
    elementToRef.set(el, attrRef);
    return attrRef;
  }

  const ref = `ref_${nextRefId++}`;
  refToElement.set(ref, new WeakRef(el));
  elementToRef.set(el, ref);
  el.setAttribute("data-ccb-ref", ref);
  return ref;
}

function querySelectorDeep(
  root: ParentNode,
  selector: string,
): Element | null {
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch {
    return null;
  }

  const elements = root.querySelectorAll("*");
  for (const el of elements) {
    if (el.shadowRoot) {
      const hit = querySelectorDeep(el.shadowRoot, selector);
      if (hit) return hit;
    }
    if (el instanceof HTMLIFrameElement) {
      try {
        if (el.contentDocument) {
          const hit = querySelectorDeep(el.contentDocument, selector);
          if (hit) return hit;
        }
      } catch {
        // Cross-origin iframe.
      }
    }
  }
  return null;
}

function querySelectorAllDeep(
  root: ParentNode,
  selector: string,
  out: Element[] = [],
): Element[] {
  try {
    for (const hit of root.querySelectorAll(selector)) {
      out.push(hit);
    }
  } catch {
    return out;
  }

  const elements = root.querySelectorAll("*");
  for (const el of elements) {
    if (el.shadowRoot) {
      querySelectorAllDeep(el.shadowRoot, selector, out);
    }
    if (el instanceof HTMLIFrameElement) {
      try {
        if (el.contentDocument) {
          querySelectorAllDeep(el.contentDocument, selector, out);
        }
      } catch {
        // Cross-origin iframe.
      }
    }
  }
  return out;
}

function resolveRefElement(ref: string): Element | null {
  const cached = refToElement.get(ref)?.deref();
  if (cached && cached.isConnected) {
    return cached;
  }
  const attrSelector = `[data-ccb-ref="${CSS.escape(ref)}"]`;
  const hit = querySelectorDeep(document, attrSelector);
  if (hit) {
    refToElement.set(ref, new WeakRef(hit));
    elementToRef.set(hit, ref);
  }
  return hit;
}

function isFileInput(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type.toLowerCase() === "file";
}

function containsFileInput(el: Element): boolean {
  if (isFileInput(el)) return true;
  return querySelectorDeep(el, 'input[type="file"]') !== null;
}

function isInteractiveElement(el: Element): boolean {
  if (isFileInput(el)) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href") || el.getAttribute("role") === "link";
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = el.getAttribute("role")?.toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tabIndex = el.getAttribute("tabindex");
  if (tabIndex !== null && tabIndex !== "-1") return true;
  if (el.hasAttribute("onclick")) return true;
  return false;
}

function isVisuallyHidden(el: Element): boolean {
  if (el instanceof HTMLElement && el.hidden) return true;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  if (Number.parseFloat(style.opacity) === 0) return true;
  const rect = el.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0;
}

function compactText(raw: string, maxLen = 120): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function getAccessibleLabel(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return compactText(ariaLabel);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      const target = document.getElementById(id);
      if (target?.textContent?.trim()) {
        parts.push(target.textContent.trim());
      }
    }
    if (parts.length > 0) return compactText(parts.join(" "));
  }

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el.labels && el.labels.length > 0) {
      const labelText = Array.from(el.labels)
        .map((l) => l.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (labelText) return compactText(labelText);
    }
  }

  const title = el.getAttribute("title");
  if (title?.trim()) return compactText(title);

  const alt = el.getAttribute("alt");
  if (alt?.trim()) return compactText(alt);

  const placeholder = el.getAttribute("placeholder");
  if (placeholder?.trim()) return compactText(placeholder);

  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
    if (el.value.trim()) return compactText(el.value);
  }

  const text = el.textContent;
  if (text?.trim()) return compactText(text);

  return "";
}

function getDirectText(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
      text += `${node.nodeValue} `;
    }
  }
  return compactText(text);
}

function describeElementSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const parts = [tag];
  if (el instanceof HTMLInputElement && el.type) {
    parts.push(`[type="${el.type}"]`);
  }
  const name = el.getAttribute("name");
  if (name) parts.push(`[name="${name}"]`);
  const accept = el.getAttribute("accept");
  if (accept) parts.push(`[accept="${accept}"]`);
  return parts.join("");
}

function formatNodeLine(el: Element, ref: string, visualDepth: number): string {
  const indent = "  ".repeat(Math.min(visualDepth, 12));
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  const isFile = isFileInput(el);
  const hidden = isVisuallyHidden(el);
  const rect = el.getBoundingClientRect();

  let descriptor = role ? `${role} (${tag})` : tag;
  if (el instanceof HTMLInputElement) {
    descriptor = `input[type=${el.type || "text"}]`;
  }

  const label = getAccessibleLabel(el);
  const parts: string[] = [`${indent}[${ref}] ${descriptor}`];

  if (label) {
    parts.push(JSON.stringify(label));
  }

  if (isFile) {
    const accept = el.getAttribute("accept");
    if (accept) parts.push(`accept=${JSON.stringify(accept)}`);
    if (el.multiple) parts.push("multiple");
    if (el.files && el.files.length > 0) {
      const names = Array.from(el.files).map((f) => f.name);
      parts.push(`files=${JSON.stringify(names)}`);
    }
  } else if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") {
      parts.push(`checked=${el.checked}`);
    } else if (el.type !== "password" && el.value) {
      parts.push(`value=${JSON.stringify(compactText(el.value, 80))}`);
    }
    if (el.placeholder) {
      parts.push(`placeholder=${JSON.stringify(compactText(el.placeholder, 60))}`);
    }
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value) {
      parts.push(`value=${JSON.stringify(compactText(el.value, 80))}`);
    }
    if (el.placeholder) {
      parts.push(`placeholder=${JSON.stringify(compactText(el.placeholder, 60))}`);
    }
  } else if (el instanceof HTMLSelectElement) {
    const selected = el.selectedOptions[0]?.textContent?.trim() ?? el.value;
    if (selected) parts.push(`selected=${JSON.stringify(compactText(selected, 60))}`);
  } else if (el instanceof HTMLAnchorElement && el.getAttribute("href")) {
    parts.push(`href=${JSON.stringify(compactText(el.getAttribute("href") ?? "", 80))}`);
  }

  if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
    parts.push("(disabled)");
  }

  if (hidden) {
    parts.push("(hidden)");
  } else if (rect.width > 0 || rect.height > 0) {
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    parts.push(`@ (${cx},${cy} ${Math.round(rect.width)}x${Math.round(rect.height)})`);
  }

  return parts.join(" ");
}

function handleReadPage(
  req: Extract<ContentRequest, { type: "ccb_read_page" }>,
): {
  title: string;
  url: string;
  tree: string;
  refCount: number;
  truncated: boolean;
} {
  const rootEl = req.refId
    ? resolveRefElement(req.refId)
    : (document.body ?? document.documentElement);

  if (!rootEl) {
    throw new Error(
      req.refId
        ? `Element ref "${req.refId}" not found on page`
        : "Document has no root element",
    );
  }

  const lines: string[] = [
    `URL: ${window.location.href}`,
    `Title: ${document.title}`,
    "",
  ];
  let totalChars = lines.join("\n").length;
  let refCount = 0;
  let truncated = false;

  const visit = (el: Element, domDepth: number, visualDepth: number): void => {
    if (truncated || domDepth > req.depth) return;

    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;

    const fileInput = isFileInput(el);
    if (!fileInput) {
      const style = window.getComputedStyle(el);
      if (
        (style.display === "none" || (el instanceof HTMLElement && el.hidden)) &&
        !containsFileInput(el)
      ) {
        return;
      }
    }

    const interactive = isInteractiveElement(el);
    const include =
      fileInput ||
      interactive ||
      (req.filter === "all" &&
        !isVisuallyHidden(el) &&
        (getDirectText(el).length > 0 ||
          tag === "img" ||
          tag === "video" ||
          tag === "h1" ||
          tag === "h2" ||
          tag === "h3"));

    let nextVisualDepth = visualDepth;
    if (include) {
      const ref = getOrCreateRef(el);
      const line = formatNodeLine(el, ref, visualDepth);
      if (totalChars + line.length + 1 > req.maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
      totalChars += line.length + 1;
      refCount += 1;
      nextVisualDepth = visualDepth + 1;
    }

    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) {
        visit(child, domDepth + 1, nextVisualDepth);
        if (truncated) return;
      }
    }

    for (const child of el.children) {
      visit(child, domDepth + 1, nextVisualDepth);
      if (truncated) return;
    }

    if (el instanceof HTMLIFrameElement) {
      try {
        const frameBody = el.contentDocument?.body;
        if (frameBody) {
          visit(frameBody, domDepth + 1, nextVisualDepth);
        }
      } catch {
        // Cross-origin iframe.
      }
    }
  };

  visit(rootEl, 0, 0);

  if (truncated) {
    lines.push("...[truncated]");
  }

  return {
    title: document.title,
    url: window.location.href,
    tree: lines.join("\n"),
    refCount,
    truncated,
  };
}

function handleGetPageText(
  req: Extract<ContentRequest, { type: "ccb_get_page_text" }>,
): {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
} {
  const raw = document.body?.innerText ?? document.documentElement?.textContent ?? "";
  const normalized = raw.replace(/\n{3,}/g, "\n\n").trim();
  const truncated = normalized.length > req.maxChars;
  const text = truncated
    ? `${normalized.slice(0, req.maxChars)}\n...[truncated]`
    : normalized;
  return {
    title: document.title,
    url: window.location.href,
    text,
    truncated,
  };
}

function handleFind(req: Extract<ContentRequest, { type: "ccb_find" }>): {
  matches: Array<{
    ref: string;
    tag: string;
    role: string | null;
    label: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    inputType?: string;
    accept?: string;
    src?: string;
  }>;
} {
  const queryLower = req.query.trim().toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(Boolean);

  const candidates: Element[] = req.selector
    ? querySelectorAllDeep(document, req.selector)
    : [];

  if (!req.selector) {
    const collect = (root: ParentNode): void => {
      const elements = root.querySelectorAll("*");
      for (const el of elements) {
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        candidates.push(el);
        if (el.shadowRoot) collect(el.shadowRoot);
        if (el instanceof HTMLIFrameElement) {
          try {
            if (el.contentDocument) collect(el.contentDocument);
          } catch {
            // Cross-origin iframe.
          }
        }
      }
    };
    collect(document);
  }

  const scored: Array<{ el: Element; score: number }> = [];

  for (const el of candidates) {
    const fileInput = isFileInput(el);
    if (!fileInput && !req.selector && isVisuallyHidden(el)) {
      continue;
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role")?.toLowerCase() ?? "";
    const ariaLabel = (el.getAttribute("aria-label") ?? "").toLowerCase();
    const placeholder = (el.getAttribute("placeholder") ?? "").toLowerCase();
    const title = (el.getAttribute("title") ?? "").toLowerCase();
    const name = (el.getAttribute("name") ?? "").toLowerCase();
    const id = el.id.toLowerCase();
    const accept = (el.getAttribute("accept") ?? "").toLowerCase();
    const inputType =
      el instanceof HTMLInputElement ? el.type.toLowerCase() : "";
    const directText = getDirectText(el).toLowerCase();
    const label = getAccessibleLabel(el).toLowerCase();

    let score = 0;
    if (req.selector) {
      score += 50;
    }

    const primaryFields = [ariaLabel, placeholder, title, label, directText];
    const secondaryFields = [role, tag, inputType, name, id, accept];

    if (primaryFields.some((f) => f === queryLower)) {
      score += 100;
    } else if (primaryFields.some((f) => f.includes(queryLower))) {
      score += 60;
    } else if (secondaryFields.some((f) => f.includes(queryLower))) {
      score += 40;
    } else if (queryTokens.length > 1) {
      const haystack = [...primaryFields, ...secondaryFields].join(" ");
      if (queryTokens.every((t) => haystack.includes(t))) {
        score += 35;
      }
    }

    if (score === 0) continue;

    if (isInteractiveElement(el)) score += 20;
    if (fileInput) score += 15;
    // Prefer tighter leaf elements over massive container divs.
    if (el.children.length === 0) score += 10;

    scored.push({ el, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<Element>();
  const matches: Array<{
    ref: string;
    tag: string;
    role: string | null;
    label: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    inputType?: string;
    accept?: string;
    src?: string;
  }> = [];

  for (const item of scored) {
    if (seen.has(item.el)) continue;
    seen.add(item.el);
    const el = item.el;
    const rect = el.getBoundingClientRect();
    matches.push({
      ref: getOrCreateRef(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      label: getAccessibleLabel(el),
      text: compactText(el.textContent ?? "", 140),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      inputType: el instanceof HTMLInputElement ? el.type : undefined,
      accept: el.getAttribute("accept") ?? undefined,
      src: el instanceof HTMLIFrameElement ? el.src || undefined : undefined,
    });
    if (matches.length >= req.limit) break;
  }

  return { matches };
}

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
}

function setNativeChecked(el: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "checked",
  );
  if (descriptor?.set) {
    descriptor.set.call(el, checked);
  } else {
    el.checked = checked;
  }
}

function handleFormInput(
  req: Extract<ContentRequest, { type: "ccb_form_input" }>,
): {
  ref: string;
  tag: string;
  value: string | boolean | number;
} {
  const el = resolveRefElement(req.ref);
  if (!el) {
    throw new Error(`Element ref "${req.ref}" not found on page`);
  }

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (el instanceof HTMLElement) {
    el.focus();
  }

  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === "checkbox" || type === "radio") {
      setNativeChecked(el, Boolean(req.value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const strVal = String(req.value);
      setNativeValue(el, strVal);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: strVal,
          inputType: "insertText",
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (el instanceof HTMLTextAreaElement) {
    const strVal = String(req.value);
    setNativeValue(el, strVal);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: strVal,
        inputType: "insertText",
      }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLSelectElement) {
    const desired = String(req.value);
    let matchedValue = desired;
    const byValue = Array.from(el.options).find((o) => o.value === desired);
    if (!byValue) {
      const desiredLower = desired.trim().toLowerCase();
      const byText = Array.from(el.options).find(
        (o) => (o.textContent?.trim().toLowerCase() ?? "") === desiredLower,
      );
      if (byText) {
        matchedValue = byText.value;
      }
    }
    setNativeValue(el, matchedValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    const strVal = String(req.value);
    el.textContent = strVal;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: strVal,
        inputType: "insertText",
      }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    throw new Error(
      `Element ${req.ref} (<${el.tagName.toLowerCase()}>) is not an editable form control`,
    );
  }

  return {
    ref: req.ref,
    tag: el.tagName.toLowerCase(),
    value: req.value,
  };
}

async function handleResolveRef(
  req: Extract<ContentRequest, { type: "ccb_resolve_ref" }>,
): Promise<{
  x: number;
  y: number;
  rect: { x: number; y: number; width: number; height: number };
  tag: string;
}> {
  let el: Element | null = null;
  if (req.ref) {
    el = resolveRefElement(req.ref);
  } else if (req.selector) {
    el = querySelectorDeep(document, req.selector);
  }

  if (!el) {
    throw new Error(
      `Could not resolve element (${req.ref ?? req.selector ?? "no ref or selector"})`,
    );
  }

  // Smooth-scroll only when the target is off-screen, so the page visibly
  // travels to it (and the cursor follows) instead of jumping.
  await scrollIntoViewVisibly(el);
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    tag: el.tagName.toLowerCase(),
  };
}

function findStreamFileInput(
  ref: string | undefined,
  selector: string | undefined,
  preferVideo: boolean,
): HTMLInputElement {
  if (ref) {
    const el = resolveRefElement(ref);
    if (!el) {
      throw new Error(`Element ref "${ref}" not found for upload`);
    }
    if (isFileInput(el)) return el;
    const nested = querySelectorDeep(el, 'input[type="file"]');
    if (nested && isFileInput(nested)) return nested;
    throw new Error(
      `Element ${ref} (<${el.tagName.toLowerCase()}>) is not or does not contain an <input type="file">`,
    );
  }

  if (selector) {
    const el = querySelectorDeep(document, selector);
    if (!el) {
      throw new Error(`No element matched selector "${selector}"`);
    }
    if (isFileInput(el)) return el;
    const nested = querySelectorDeep(el, 'input[type="file"]');
    if (nested && isFileInput(nested)) return nested;
    throw new Error(
      `Element matching "${selector}" is not an <input type="file">`,
    );
  }

  const allInputs = querySelectorAllDeep(document, 'input[type="file"]').filter(
    isFileInput,
  );
  if (allInputs.length === 0) {
    throw new Error(
      'No <input type="file"> found on page. Try mode: "drop" on a dropzone or provide triggerRef/triggerSelector.',
    );
  }

  if (preferVideo) {
    const videoInput = allInputs.find((input) =>
      VIDEO_ACCEPT_RE.test(input.getAttribute("accept") ?? ""),
    );
    if (videoInput) return videoInput;
  }

  const first = allInputs[0];
  if (!first) {
    throw new Error('No <input type="file"> found on page.');
  }
  return first;
}

function findDropzone(
  ref: string | undefined,
  selector: string | undefined,
): Element {
  if (ref) {
    const el = resolveRefElement(ref);
    if (!el) throw new Error(`Dropzone ref "${ref}" not found`);
    return el;
  }
  if (selector) {
    const el = querySelectorDeep(document, selector);
    if (!el) throw new Error(`Dropzone selector "${selector}" not found`);
    return el;
  }

  const fallbackSelectors = [
    '[data-e2e*="upload"]',
    '[class*="upload-card"]',
    '[class*="dropzone"]',
    '[class*="drop-zone"]',
    '[class*="drag"]',
    '[class*="upload"]',
  ];
  for (const sel of fallbackSelectors) {
    const hit = querySelectorDeep(document, sel);
    if (hit) return hit;
  }

  if (!document.body) {
    throw new Error("Document has no body element for drop upload");
  }
  return document.body;
}

async function handleStreamUpload(
  req: Extract<ContentRequest, { type: "ccb_stream_upload" }>,
): Promise<{
  count: number;
  inputSelector: string;
  uploadedNames: string[];
}> {
  const dt = new DataTransfer();
  const uploadedNames: string[] = [];

  for (const fileInfo of req.files) {
    const response = await fetch(fileInfo.streamUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch file stream for "${fileInfo.name}": HTTP ${response.status}`,
      );
    }
    const blob = await response.blob();
    const file = new File([blob], fileInfo.name, {
      type: fileInfo.mimeType,
      lastModified: Date.now(),
    });
    dt.items.add(file);
    uploadedNames.push(fileInfo.name);
  }

  if (req.drop) {
    const target = findDropzone(req.ref, req.selector);
    const dragInit: DragEventInit = {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    };
    target.dispatchEvent(new DragEvent("dragenter", dragInit));
    target.dispatchEvent(new DragEvent("dragover", dragInit));
    target.dispatchEvent(new DragEvent("drop", dragInit));
    return {
      count: uploadedNames.length,
      inputSelector: describeElementSelector(target),
      uploadedNames,
    };
  }

  const preferVideo = req.files.some((f) => f.mimeType.startsWith("video/"));
  const input = findStreamFileInput(req.ref, req.selector, preferVideo);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  return {
    count: uploadedNames.length,
    inputSelector: describeElementSelector(input),
    uploadedNames,
  };
}

async function handleContentRequest(req: ContentRequest): Promise<unknown> {
  switch (req.type) {
    case "ccb_read_page":
      return handleReadPage(req);
    case "ccb_get_page_text":
      return handleGetPageText(req);
    case "ccb_find":
      return handleFind(req);
    case "ccb_form_input":
      return handleFormInput(req);
    case "ccb_resolve_ref":
      return handleResolveRef(req);
    case "ccb_stream_upload":
      return handleStreamUpload(req);
    case "ccb_cursor": {
      const from =
        req.fromX !== undefined && req.fromY !== undefined
          ? { x: req.fromX, y: req.fromY }
          : undefined;
      switch (req.op) {
        case "show":
          await showCursorAt(req.x, req.y);
          break;
        case "move":
          await moveCursor(req.x, req.y, from);
          break;
        case "click":
          if (!cursorPosition()) await moveCursor(req.x, req.y, from);
          await clickCursor(req.x, req.y, req.button ?? "left");
          break;
        case "scroll":
          if (!cursorPosition()) await moveCursor(req.x, req.y, from);
          await scrollCursor(req.x, req.y, req.direction ?? "down");
          break;
        default: {
          const _exhaustiveOp: never = req.op;
          throw new Error(`Unhandled cursor op: ${String(_exhaustiveOp)}`);
        }
      }
      return { x: req.x, y: req.y };
    }
    case "ccb_viewport":
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      };
    case "ccb_synthetic_mouse":
      switch (req.kind) {
        case "click":
          return syntheticClick(req.x, req.y, req.button, req.clickCount, req.modifiers);
        case "move":
          return { tag: syntheticHover(req.x, req.y, req.modifiers).tagName.toLowerCase() };
        case "drag":
          syntheticDrag(req.startX ?? req.x, req.startY ?? req.y, req.x, req.y, req.modifiers);
          return {};
        case "scroll":
          await syntheticScroll(req.x, req.y, req.deltaX, req.deltaY, req.modifiers);
          return { scrollX: window.scrollX, scrollY: window.scrollY };
        default: {
          const _exhaustiveKind: never = req.kind;
          throw new Error(`Unhandled synthetic mouse kind: ${String(_exhaustiveKind)}`);
        }
      }
    case "ccb_synthetic_key":
      return syntheticKey(
        { key: req.key, code: req.code, keyCode: req.keyCode, text: req.text },
        req.modifiers,
      );
    case "ccb_synthetic_type":
      return syntheticType(req.text);
    default: {
      const _exhaustive: never = req;
      throw new Error(`Unhandled content request: ${String(_exhaustive)}`);
    }
  }
}

// Keyed by build so a reloaded extension's fresh script takes over from an
// orphaned copy left in an already-open tab (whose runtime is invalidated).
declare const __CCB_BUILD__: string;
if (window.__ccbContentLoaded !== __CCB_BUILD__) {
  window.__ccbContentLoaded = __CCB_BUILD__;
  window.__ccbGetElementByRef = resolveRefElement;

  chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
    const parsed = ContentRequestSchema.safeParse(rawMessage);
    if (!parsed.success) {
      return false;
    }

    handleContentRequest(parsed.data)
      .then((data) => {
        const envelope: ContentResponseEnvelope = { ok: true, data };
        sendResponse(envelope);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        const envelope: ContentResponseEnvelope = { ok: false, error };
        sendResponse(envelope);
      });

    return true;
  });
}
