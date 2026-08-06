// Draws a squircle badge with a viewfinder/focus-brackets glyph for the
// toolbar button at runtime instead of shipping PNG assets. A single
// capital letter on a gradient badge reads as a generic account avatar,
// and a diagonal dart shape reads as a paper-plane (Telegram et al.), so
// the mark is four corner brackets around a dot instead: this is the same
// motif the overlay itself draws around a resolved element (see
// widget.css's .hintora-spotlight), so the icon shows what the product
// actually does rather than a generic arrow.
function drawIcon(size: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  const radius = size * 0.26;

  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, "#5b3df0");
  base.addColorStop(1, "#8b6bff");
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();

  // Soft sheen toward the top-left for a bit of depth, instead of a flat fill.
  const sheen = ctx.createRadialGradient(
    size * 0.32, size * 0.24, 0,
    size * 0.32, size * 0.24, size * 0.75
  );
  sheen.addColorStop(0, "rgba(255,255,255,0.25)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fillStyle = sheen;
  ctx.fill();

  const box = size * 0.56;
  const ox = (size - box) / 2;
  const oy = (size - box) / 2;
  const arm = box * 0.4;
  const lineWidth = Math.max(1.4, size * 0.075);

  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(ox, oy + arm);
  ctx.lineTo(ox, oy);
  ctx.lineTo(ox + arm, oy);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(ox + box - arm, oy);
  ctx.lineTo(ox + box, oy);
  ctx.lineTo(ox + box, oy + arm);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(ox, oy + box - arm);
  ctx.lineTo(ox, oy + box);
  ctx.lineTo(ox + arm, oy + box);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(ox + box - arm, oy + box);
  ctx.lineTo(ox + box, oy + box);
  ctx.lineTo(ox + box, oy + box - arm);
  ctx.stroke();
  ctx.restore();

  if (size >= 24) {
    ctx.beginPath();
    ctx.arc(ox + box / 2, oy + box / 2, size * 0.05, 0, Math.PI * 2);
    ctx.fillStyle = "#ffb457";
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}

async function setActionIcon(): Promise<void> {
  try {
    const imageData: Record<number, ImageData> = {};
    for (const size of [16, 32, 48, 128]) imageData[size] = drawIcon(size);
    await chrome.action.setIcon({ imageData });
  } catch {
    // OffscreenCanvas unavailable; toolbar keeps the generic default icon.
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
// every session. The fetch runs here, in the service worker, rather than
// in content.ts: a content script's network requests are subject to the
// host page's CSP, and github.com's connect-src almost certainly doesn't
// allow localhost. A service worker with host_permissions for this origin
// is exempt from the page's CSP, which is why this relay exists and why
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
    return null; // backend not running or unreachable, treated as "no data available"
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
