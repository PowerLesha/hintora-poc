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
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(size * 0.54)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("H", size / 2, size / 2 + size * 0.03);
    if (size >= 32) {
      const cx = size * 0.78;
      const cy = size * 0.78;
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = "#ffb457";
      ctx.fill();
    }
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
