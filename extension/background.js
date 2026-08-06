"use strict";
(() => {
  // background.ts
  function drawIcon(size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    const radius = size * 0.26;
    const base = ctx.createLinearGradient(0, 0, size, size);
    base.addColorStop(0, "#5b3df0");
    base.addColorStop(1, "#8b6bff");
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, radius);
    ctx.fill();
    const sheen = ctx.createRadialGradient(
      size * 0.32,
      size * 0.24,
      0,
      size * 0.32,
      size * 0.24,
      size * 0.75
    );
    sheen.addColorStop(0, "rgba(255,255,255,0.25)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, radius);
    ctx.fillStyle = sheen;
    ctx.fill();
    const glyph = size * 0.5;
    const ox = (size - glyph) / 2;
    const oy = (size - glyph) / 2;
    const pt = (nx, ny) => [ox + nx * glyph, oy + ny * glyph];
    ctx.save();
    ctx.shadowColor = "rgba(20, 10, 55, 0.35)";
    ctx.shadowBlur = size * 0.06;
    ctx.shadowOffsetY = size * 0.025;
    ctx.beginPath();
    ctx.moveTo(...pt(0, 0));
    ctx.lineTo(...pt(0.4167, 1));
    ctx.lineTo(...pt(0.5645, 0.5645));
    ctx.lineTo(...pt(1, 0.4167));
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();
    return ctx.getImageData(0, 0, size, size);
  }
  async function setActionIcon() {
    try {
      const imageData = {};
      for (const size of [16, 32, 48, 128]) imageData[size] = drawIcon(size);
      await chrome.action.setIcon({ imageData });
    } catch {
    }
  }
  setActionIcon();
  chrome.action.onClicked.addListener((tab) => {
    if (!tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "HINTORA_TOGGLE" }, () => {
      void chrome.runtime.lastError;
    });
  });
  var BACKEND_URL = "http://localhost:3000";
  var BACKEND_TIMEOUT_MS = 2e3;
  async function backendFetch(path, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    try {
      const res = await fetch(BACKEND_URL + path, { ...options, signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "HINTORA_GET_HINTS") {
      backendFetch(`/api/resolutions?hostname=${encodeURIComponent(msg.hostname)}`).then((data) => {
        sendResponse({ hints: data?.hints || [] });
      });
      return true;
    }
    if (msg?.type === "HINTORA_LOG") {
      backendFetch("/api/resolutions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.payload)
      }).then((data) => sendResponse({ ok: !!data }));
      return true;
    }
  });
})();
