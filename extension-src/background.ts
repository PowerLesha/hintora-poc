// Draws a squircle badge with a cursor/pointer glyph for the toolbar
// button at runtime instead of shipping PNG assets. A single capital
// letter on a gradient badge reads as a generic account avatar, not a
// product mark, so the glyph is a pointer instead: the extension's whole
// job is pointing at the right element on the page.
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

  // Classic four-point cursor/arrow silhouette, normalized to a unit box
  // (tip at the origin corner) so it can be scaled and centered at any
  // icon size without redoing the geometry.
  const glyph = size * 0.5;
  const ox = (size - glyph) / 2;
  const oy = (size - glyph) / 2;
  const pt = (nx: number, ny: number): [number, number] => [ox + nx * glyph, oy + ny * glyph];

  ctx.save();
  ctx.shadowColor = "rgba(20, 10, 55, 0.35)";
  ctx.shadowBlur = size * 0.06;
  ctx.shadowOffsetY = size * 0.025;
  ctx.beginPath();
  ctx.moveTo(...pt(0, 0));
  ctx.lineTo(...pt(0.4167, 1.0));
  ctx.lineTo(...pt(0.5645, 0.5645));
  ctx.lineTo(...pt(1.0, 0.4167));
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();

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
