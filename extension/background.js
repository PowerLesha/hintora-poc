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
  var SEARCH_TIMEOUT_MS = 6e3;
  function decodeHtmlEntities(text) {
    return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
  }
  function stripTags(html) {
    return decodeHtmlEntities(html.replace(/<[^>]*>/g, "")).trim();
  }
  function resolveDuckDuckGoRedirect(href) {
    try {
      const url = new URL(href.startsWith("//") ? "https:" + href : href);
      const target = url.searchParams.get("uddg");
      return target ? decodeURIComponent(target) : href;
    } catch {
      return href;
    }
  }
  async function webSearch(query) {
    if (!query.trim()) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        signal: controller.signal
      });
      if (!res.ok) return [];
      const html = await res.text();
      const snippets = [];
      const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let sm;
      while (sm = snippetRe.exec(html)) snippets.push(stripTags(sm[1]));
      const results = [];
      const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let lm;
      let i = 0;
      while ((lm = linkRe.exec(html)) && results.length < 4) {
        results.push({
          title: stripTags(lm[2]),
          url: resolveDuckDuckGoRedirect(lm[1]),
          snippet: snippets[i] || ""
        });
        i++;
      }
      return results;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
  function captureScreenshot(windowId) {
    return new Promise((resolve) => {
      if (windowId == null) {
        resolve(null);
        return;
      }
      chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 60 }, (dataUrl) => {
        void chrome.runtime.lastError;
        resolve(dataUrl || null);
      });
    });
  }
  chrome.runtime.onMessage.addListener(
    (msg, sender, sendResponse) => {
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
      if (msg?.type === "HINTORA_CAPTURE_SCREENSHOT") {
        captureScreenshot(sender.tab?.windowId).then((dataUrl) => sendResponse({ dataUrl }));
        return true;
      }
      if (msg?.type === "HINTORA_WEB_SEARCH") {
        webSearch(msg.query).then((results) => sendResponse({ results }));
        return true;
      }
    }
  );
})();
