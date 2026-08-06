"use strict";
(() => {
  // background.ts
  function drawIcon(size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
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
