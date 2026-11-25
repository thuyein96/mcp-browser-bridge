import {
  PopupStateSchema,
  type PopupRequest,
  type PopupState,
} from "./internal-messages";

function requireElement<T extends HTMLElement>(
  id: string,
  ctor: { new (): T },
): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) {
    throw new Error(`Missing required popup element #${id}`);
  }
  return el;
}

const statusPill = requireElement("status-pill", HTMLElement);
const statusDot = requireElement("status-dot", HTMLElement);
const statusText = requireElement("status-text", HTMLElement);
const portForm = requireElement("port-form", HTMLFormElement);
const portInput = requireElement("port-input", HTMLInputElement);
const errorNote = requireElement("error-note", HTMLElement);
const uploadBadge = requireElement("upload-badge", HTMLElement);
const uploadDesc = requireElement("upload-desc", HTMLElement);
const openSettingsBtn = requireElement("open-settings-btn", HTMLButtonElement);
const activityCount = requireElement("activity-count", HTMLElement);
const activityList = requireElement("activity-list", HTMLUListElement);
const activityEmpty = requireElement("activity-empty", HTMLElement);

let currentExtensionId = chrome.runtime.id;
let lastPortSynced: number | null = null;

async function sendPopupRequest(req: PopupRequest): Promise<PopupState | null> {
  const raw: unknown = await chrome.runtime.sendMessage(req);
  const parsed = PopupStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function renderState(state: PopupState): void {
  currentExtensionId = state.extensionId;

  if (state.connected) {
    statusPill.className = "pill pill-on";
    statusDot.className = "dot dot-on";
    statusText.textContent = "Connected";
  } else if (state.connecting) {
    statusPill.className = "pill pill-warn";
    statusDot.className = "dot dot-warn";
    statusText.textContent = "Connecting…";
  } else {
    statusPill.className = "pill pill-off";
    statusDot.className = "dot dot-off";
    statusText.textContent = "Disconnected";
  }

  if (lastPortSynced !== state.port && document.activeElement !== portInput) {
    portInput.value = String(state.port);
    lastPortSynced = state.port;
  }

  if (state.lastError && !state.connected) {
    errorNote.textContent = state.lastError;
    errorNote.classList.remove("hidden");
  } else {
    errorNote.classList.add("hidden");
  }

  if (state.allowedFileAccess) {
    uploadBadge.textContent = "Zero-Copy Unlimited GB Ready";
    uploadBadge.className = "badge badge-ok";
    uploadDesc.textContent =
      "Allow access to file URLs is ON. Multi-GB videos attach directly from disk via CDP with zero RAM copy.";
    openSettingsBtn.classList.add("hidden");
  } else {
    uploadBadge.textContent = "HTTP Stream Fallback Active";
    uploadBadge.className = "badge badge-warn";
    uploadDesc.textContent =
      'HTTP Stream Fallback Active — click below to enable "Allow access to file URLs" for instant multi-GB zero-copy uploads.';
    openSettingsBtn.classList.remove("hidden");
  }

  activityCount.textContent = String(state.activity.length);
  activityList.replaceChildren();

  if (state.activity.length === 0) {
    activityEmpty.classList.remove("hidden");
    return;
  }

  activityEmpty.classList.add("hidden");
  for (const item of state.activity) {
    const li = document.createElement("li");
    li.className = "activity-item";

    const top = document.createElement("div");
    top.className = "activity-top";

    const method = document.createElement("span");
    method.className = "activity-method";
    method.textContent = item.method;

    const meta = document.createElement("span");
    meta.className = "activity-meta";

    const badge = document.createElement("span");
    badge.className = item.status === "ok" ? "status-ok" : "status-err";
    badge.textContent = item.status === "ok" ? "OK" : "ERR";

    const dur = document.createElement("span");
    dur.textContent = `${item.durationMs}ms`;

    meta.append(badge, dur);
    top.append(method, meta);

    const target = document.createElement("div");
    target.className = "activity-target";
    target.textContent = item.detail ? `${item.target} — ${item.detail}` : item.target;
    target.title = target.textContent;

    li.append(top, target);
    activityList.append(li);
  }
}

async function refresh(): Promise<void> {
  const state = await sendPopupRequest({ type: "ccb_popup_state" });
  if (state) {
    renderState(state);
  }
}

portForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const parsedPort = Number.parseInt(portInput.value, 10);
  if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
    lastPortSynced = parsedPort;
    void sendPopupRequest({
      type: "ccb_popup_set_port",
      port: parsedPort,
    }).then((state) => {
      if (state) renderState(state);
    });
  } else {
    void sendPopupRequest({ type: "ccb_popup_reconnect" }).then((state) => {
      if (state) renderState(state);
    });
  }
});

openSettingsBtn.addEventListener("click", () => {
  void chrome.tabs.create({
    url: `chrome://extensions/?id=${currentExtensionId}`,
  });
});

void refresh();
setInterval(() => {
  void refresh();
}, 2000);
