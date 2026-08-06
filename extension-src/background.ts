// Draw a purple "H" badge for the toolbar button at runtime instead of
// shipping PNG assets — no image tooling required, and it makes the button
// obvious among a toolbar full of generic gray extension icons.
function drawIcon(size: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#6d5bff");
  grad.addColorStop(1, "#a084ff");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(size * 0.62)}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("H", size / 2, size / 2 + size * 0.03);
  return ctx.getImageData(0, 0, size, size);
}

async function setActionIcon(): Promise<void> {
  try {
    const imageData: Record<number, ImageData> = {};
    for (const size of [16, 32, 48, 128]) imageData[size] = drawIcon(size);
    await chrome.action.setIcon({ imageData });
  } catch {
    // OffscreenCanvas unavailable — toolbar keeps the generic default icon.
  }
}
setActionIcon();

// Toolbar icon click -> tell the content script on the active tab to toggle the widget.
// No "tabs"/"scripting" permission needed: sendMessage to a tab you clicked on is always allowed.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "HINTORA_TOGGLE" }, () => {
    // Reading lastError (even without acting on it) prevents Chrome from
    // logging "Unchecked runtime.lastError" when no content script is
    // present on this tab (e.g. a chrome:// page).
    void chrome.runtime.lastError;
  });
});

// Optional local backend (see /backend) that persists confirmed matches per
// site, so the matcher gets sharper with real usage instead of resetting
// every session. This fetch runs from the background service worker, not
// content.js: a content script's network requests are subject to the HOST
// PAGE's CSP (github.com's connect-src almost certainly doesn't allow
// localhost), while a service worker with host_permissions for this origin
// is exempt from the page's CSP entirely. This relay is the whole reason
// that permission is declared in manifest.json.
const BACKEND_URL = "http://localhost:3000";
const BACKEND_TIMEOUT_MS = 2000;

async function backendFetch(path: string, options?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    const res = await fetch(BACKEND_URL + path, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // backend not running / unreachable — treated as "no data available"
  } finally {
    clearTimeout(timer);
  }
}

interface GetHintsMessage {
  type: "HINTORA_GET_HINTS";
  hostname: string;
}

interface LogMessage {
  type: "HINTORA_LOG";
  payload: unknown;
}

chrome.runtime.onMessage.addListener((msg: GetHintsMessage | LogMessage, _sender, sendResponse) => {
  if (msg?.type === "HINTORA_GET_HINTS") {
    backendFetch(`/api/resolutions?hostname=${encodeURIComponent(msg.hostname)}`).then((data: any) => {
      sendResponse({ hints: data?.hints || [] });
    });
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === "HINTORA_LOG") {
    backendFetch("/api/resolutions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload),
    }).then((data) => sendResponse({ ok: !!data }));
    return true;
  }
});
