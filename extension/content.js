"use strict";
(() => {
  // lib/domScanner.ts
  var INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "summary",
    "input",
    "select",
    "textarea",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    "[onclick]",
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }
  function resolveLabelledBy(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    return ids.map((id) => document.getElementById(id)?.textContent?.trim() || "").filter(Boolean).join(" ");
  }
  function cleanText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }
  function getFormValue(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return "";
  }
  function getAccessibleName(el) {
    const ariaLabel = cleanText(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = cleanText(resolveLabelledBy(el));
    if (labelledBy) return labelledBy;
    const text = cleanText(el.innerText || el.textContent);
    if (text && text.length <= 120) return text;
    if (text) return text.slice(0, 120);
    const value = cleanText(el.getAttribute("placeholder")) || cleanText(getFormValue(el));
    if (value) return value;
    const title = cleanText(el.getAttribute("title"));
    if (title) return title;
    const img = el.querySelector("img[alt], svg title");
    if (img) {
      const altText = cleanText(img.getAttribute?.("alt") || img.textContent);
      if (altText) return altText;
    }
    return "";
  }
  var ROLE_BY_TAG = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    SELECT: "listbox",
    TEXTAREA: "textbox",
    SUMMARY: "button"
  };
  function getRole(el) {
    return el.getAttribute("role") || ROLE_BY_TAG[el.tagName] || "generic";
  }
  function scan(root2) {
    const scope = root2 || document;
    const nodes = Array.from(scope.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
      (el) => !el.closest("#hintora-root")
      // skip the widget's own UI
    );
    const seen = /* @__PURE__ */ new Set();
    const candidates = [];
    for (const el of nodes) {
      if (seen.has(el) || !isVisible(el)) continue;
      if (nodes.some((other) => other !== el && el.contains(other))) continue;
      seen.add(el);
      candidates.push({
        el,
        name: getAccessibleName(el),
        role: getRole(el),
        rect: el.getBoundingClientRect()
      });
    }
    return candidates;
  }

  // lib/matcher.ts
  var STOPWORDS = /* @__PURE__ */ new Set([
    "a",
    "an",
    "the",
    "to",
    "do",
    "i",
    "how",
    "can",
    "could",
    "where",
    "is",
    "are",
    "for",
    "my",
    "this",
    "that",
    "on",
    "in",
    "of",
    "with",
    "get",
    "want",
    "would",
    "like",
    "please",
    "it",
    "me",
    "and",
    "up",
    "so",
    "does",
    "you",
    "your"
  ]);
  var SYNONYM_GROUPS = [
    ["create", "new", "add", "make", "start"],
    ["delete", "remove", "cancel", "discard"],
    ["edit", "change", "update", "modify", "rename"],
    ["save", "star", "bookmark", "favorite", "keep"],
    ["copy", "duplicate", "fork", "clone", "own"],
    ["download", "export", "zip", "local"],
    ["share", "invite", "collaborate", "collaborator", "team"],
    ["notify", "watch", "subscribe", "follow", "updates", "alert"],
    ["report", "flag", "issue", "bug", "problem"],
    ["settings", "preferences", "options", "config", "configuration"],
    ["profile", "avatar", "picture", "account"]
  ];
  var SYNONYM_LOOKUP = /* @__PURE__ */ new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) SYNONYM_LOOKUP.set(word, group);
  }
  function tokenize(text) {
    return (text || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOPWORDS.has(t));
  }
  function expand(tokens) {
    const expanded = new Set(tokens);
    for (const t of tokens) {
      const group = SYNONYM_LOOKUP.get(t);
      if (group) group.forEach((g) => expanded.add(g));
    }
    return expanded;
  }
  var ROLE_WEIGHT = {
    button: 1.2,
    link: 1,
    tab: 1,
    menuitem: 1,
    checkbox: 0.8,
    textbox: 0.6,
    generic: 0.5
  };
  function match(query, candidates, siteBoost) {
    const queryTokens = expand(tokenize(query));
    const results = candidates.map((c) => {
      const nameTokens = new Set(tokenize(c.name));
      let overlap = 0;
      for (const t of queryTokens) if (nameTokens.has(t)) overlap += 1;
      const nameLower = c.name.toLowerCase();
      const substringHit = [...queryTokens].some((t) => t.length > 2 && nameLower.includes(t));
      let score = overlap * 2 + (substringHit ? 1 : 0);
      score *= ROLE_WEIGHT[c.role] ?? 1;
      if (!c.name) score -= 0.5;
      if (siteBoost) score += siteBoost(queryTokens, c) || 0;
      return { ...c, score };
    });
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // lib/siteHints.ts
  var HINTS = {
    "github.com": [
      { tokens: ["report", "bug", "issue", "problem"], nameIncludes: ["issue"], boost: 4 },
      { tokens: ["save", "star", "favorite", "bookmark"], nameIncludes: ["star"], boost: 4 },
      { tokens: ["copy", "fork", "duplicate", "own"], nameIncludes: ["fork"], boost: 4 },
      { tokens: ["download", "export", "zip", "local"], nameIncludes: ["code"], boost: 3 },
      { tokens: ["notify", "watch", "follow", "updates", "alert"], nameIncludes: ["watch", "notifications"], boost: 4 },
      { tokens: ["download", "zip"], nameIncludes: ["download zip"], boost: 6 }
    ]
  };
  var EXAMPLES = {
    "github.com": [
      "How do I download this project's code?",
      "How do I get notified about updates?",
      "How do I save this for later?",
      "How do I report a bug?"
    ]
  };
  function boostFor(hostname) {
    const rules = HINTS[hostname];
    if (!rules) return null;
    return (queryTokens, candidate) => {
      const nameLower = candidate.name.toLowerCase();
      let bonus = 0;
      for (const rule of rules) {
        const tokenHit = rule.tokens.some((t) => queryTokens.has(t));
        const nameHit = rule.nameIncludes.some((n) => nameLower.includes(n));
        if (tokenHit && nameHit) bonus += rule.boost;
      }
      return bonus;
    };
  }
  function examplesFor(hostname) {
    return EXAMPLES[hostname] || ["How do I find the settings?", "How do I sign out?"];
  }

  // lib/overlay.ts
  var box = null;
  var callout = null;
  var calloutTextEl = null;
  var mo = null;
  var pollId = null;
  var currentTarget = null;
  var onLostCallback = null;
  function ensureNodes() {
    if (box) return;
    box = document.createElement("div");
    box.className = "hintora-spotlight";
    callout = document.createElement("div");
    callout.className = "hintora-callout";
    const arrow = document.createElement("div");
    callout.appendChild(arrow);
    calloutTextEl = document.createElement("div");
    calloutTextEl.className = "hintora-callout-text";
    callout.appendChild(calloutTextEl);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(callout);
  }
  function place() {
    if (!currentTarget || !document.documentElement.contains(currentTarget)) {
      lostTarget();
      return;
    }
    const rect = currentTarget.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      lostTarget();
      return;
    }
    if (!box || !callout) return;
    const pad = 6;
    box.style.top = `${rect.top - pad}px`;
    box.style.left = `${rect.left - pad}px`;
    box.style.width = `${rect.width + pad * 2}px`;
    box.style.height = `${rect.height + pad * 2}px`;
    const calloutHeight = callout.offsetHeight || 70;
    const spaceBelow = window.innerHeight - rect.bottom;
    const below = spaceBelow > calloutHeight + 16;
    const top = below ? rect.bottom + 14 : rect.top - calloutHeight - 14;
    let left = rect.left + rect.width / 2 - callout.offsetWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - callout.offsetWidth - 8));
    callout.style.top = `${Math.max(8, top)}px`;
    callout.style.left = `${left}px`;
    callout.classList.toggle("hintora-callout-above", !below);
  }
  function lostTarget() {
    if (currentTarget && onLostCallback) onLostCallback();
    hide();
  }
  function stopTracking() {
    window.removeEventListener("scroll", place, { capture: true });
    window.removeEventListener("resize", place);
    if (pollId) clearInterval(pollId);
    if (mo) mo.disconnect();
    pollId = null;
    mo = null;
  }
  function show({ el, message, onLost }) {
    ensureNodes();
    stopTracking();
    currentTarget = el;
    onLostCallback = onLost || null;
    if (calloutTextEl) calloutTextEl.textContent = message;
    box.style.display = "block";
    callout.style.display = "block";
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    place();
    setTimeout(place, 350);
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place, { passive: true });
    pollId = setInterval(place, 250);
    mo = new MutationObserver(() => {
      if (!currentTarget || !document.documentElement.contains(currentTarget)) lostTarget();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  function hide() {
    currentTarget = null;
    if (box) box.style.display = "none";
    if (callout) callout.style.display = "none";
    stopTracking();
  }
  var overlay = { show, hide };

  // content.ts
  var CONFIDENCE_THRESHOLD = 2;
  var CLOSE_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>`;
  var CHECK_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>`;
  var CROSS_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`;
  var WORKFLOWS = [
    {
      id: "download-zip",
      appliesTo: (queryTokens, step1) => step1.name.toLowerCase().includes("code") && ["download", "zip", "export", "local"].some((t) => queryTokens.has(t)),
      findNextStep: () => scan(document).find((c) => c.name.toLowerCase().includes("download zip"))
    }
  ];
  var root;
  var bubble;
  var panel;
  var input;
  var status;
  var chipsEl;
  var feedbackEl;
  var sendBtn;
  var activeWorkflowCleanup = null;
  var dynamicHints = [];
  chrome.runtime.sendMessage({ type: "HINTORA_GET_HINTS", hostname: location.hostname }, (res) => {
    if (res?.hints) dynamicHints = res.hints;
  });
  function logResolution(query, matchedName, score, confirmed) {
    chrome.runtime.sendMessage({
      type: "HINTORA_LOG",
      payload: { hostname: location.hostname, query, matchedName, score, confirmed }
    });
  }
  function dynamicBoost(queryTokens, candidate) {
    if (!dynamicHints.length) return 0;
    const nameLower = candidate.name.toLowerCase();
    let bonus = 0;
    for (const hint of dynamicHints) {
      const hintTokens = tokenize(hint.query);
      if (!hintTokens.length || !hint.matchedName) continue;
      const shared = hintTokens.filter((t) => queryTokens.has(t)).length;
      const overlapRatio = shared / hintTokens.length;
      if (overlapRatio >= 0.5 && nameLower.includes(hint.matchedName.toLowerCase())) {
        bonus += 3 + Math.min(hint.confirmations || 1, 5);
      }
    }
    return bonus;
  }
  function buildWidget() {
    root = document.createElement("div");
    root.id = "hintora-root";
    root.classList.add("hintora-hidden");
    bubble = document.createElement("button");
    bubble.className = "hintora-bubble";
    bubble.textContent = "H";
    bubble.title = "Ask Hintora";
    panel = document.createElement("div");
    panel.className = "hintora-panel hintora-hidden";
    panel.innerHTML = `
    <div class="hintora-panel-header">
      <div class="hintora-logo-mark">H</div>
      <span class="hintora-panel-header-title">Ask Hintora</span>
      <button type="button" class="hintora-icon-btn" data-close aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="hintora-panel-body">
      <div class="hintora-input-row">
        <input type="text" placeholder="What are you trying to do?" />
        <button type="button" data-send>Ask</button>
      </div>
      <div class="hintora-chips"></div>
      <div class="hintora-status"></div>
      <div class="hintora-feedback hintora-hidden"></div>
    </div>
  `;
    root.appendChild(bubble);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
    input = panel.querySelector("input");
    status = panel.querySelector(".hintora-status");
    chipsEl = panel.querySelector(".hintora-chips");
    feedbackEl = panel.querySelector(".hintora-feedback");
    sendBtn = panel.querySelector("[data-send]");
    renderChips(examplesFor(location.hostname));
    bubble.addEventListener("click", () => {
      panel.classList.toggle("hintora-hidden");
      if (!panel.classList.contains("hintora-hidden")) input.focus();
    });
    panel.querySelector("[data-close]").addEventListener("click", () => {
      panel.classList.add("hintora-hidden");
      overlay.hide();
    });
    sendBtn.addEventListener("click", () => runQuery(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runQuery(input.value);
      if (e.key === "Escape") {
        panel.classList.add("hintora-hidden");
        overlay.hide();
      }
    });
  }
  function renderChips(examples) {
    chipsEl.innerHTML = "";
    for (const ex of examples) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "hintora-chip";
      chip.textContent = ex;
      chip.addEventListener("click", () => {
        input.value = ex;
        runQuery(ex);
      });
      chipsEl.appendChild(chip);
    }
  }
  function renderAlternativeChips(originalQuery, alternatives) {
    chipsEl.innerHTML = "";
    for (const alt of alternatives) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "hintora-chip";
      chip.textContent = alt.name;
      chip.addEventListener("click", () => {
        logResolution(originalQuery, alt.name, alt.score, true);
        setStatus(`Found it: "${alt.name}" (confirmed correction)`);
        showStep(alt, originalQuery);
        renderChips(examplesFor(location.hostname));
        hideFeedback();
      });
      chipsEl.appendChild(chip);
    }
  }
  function setStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle("hintora-status-error", !!isError);
  }
  function hideFeedback() {
    feedbackEl.innerHTML = "";
    feedbackEl.classList.add("hintora-hidden");
  }
  function showFeedback(query, top) {
    feedbackEl.innerHTML = "";
    feedbackEl.classList.remove("hintora-hidden");
    const label = document.createElement("span");
    label.textContent = "Right answer?";
    feedbackEl.appendChild(label);
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "hintora-fb-btn hintora-fb-up";
    yes.setAttribute("aria-label", "Correct");
    yes.innerHTML = CHECK_ICON;
    yes.addEventListener("click", () => {
      logResolution(query, top.name, top.score, true);
      feedbackEl.textContent = "Thanks \u2014 remembered for next time on this site.";
    });
    const no = document.createElement("button");
    no.type = "button";
    no.className = "hintora-fb-btn hintora-fb-down";
    no.setAttribute("aria-label", "Wrong");
    no.innerHTML = CROSS_ICON;
    no.addEventListener("click", () => {
      logResolution(query, top.name, top.score, false);
      feedbackEl.textContent = "Noted \u2014 won't be reinforced.";
    });
    feedbackEl.appendChild(yes);
    feedbackEl.appendChild(no);
  }
  function cleanupWorkflow() {
    if (activeWorkflowCleanup) {
      activeWorkflowCleanup();
      activeWorkflowCleanup = null;
    }
  }
  function runQuery(rawQuery) {
    const query = (rawQuery || "").trim();
    if (!query) return;
    cleanupWorkflow();
    hideFeedback();
    const candidates = scan(document);
    const staticBoost = boostFor(location.hostname);
    const combinedBoost = (queryTokens, candidate) => (staticBoost ? staticBoost(queryTokens, candidate) : 0) + dynamicBoost(queryTokens, candidate);
    const ranked = match(query, candidates, combinedBoost);
    const top = ranked[0];
    if (!top || top.score < CONFIDENCE_THRESHOLD) {
      const alternatives = ranked.slice(0, 3).filter((c) => c.name);
      overlay.hide();
      if (alternatives.length) {
        setStatus("Not confident enough to guess \u2014 did you mean:");
        renderAlternativeChips(query, alternatives);
      } else {
        setStatus("Couldn't find anything on this page for that. Try rephrasing.", true);
      }
      return;
    }
    setStatus(`Found it: "${top.name}" (confidence score ${top.score.toFixed(1)})`);
    showStep(top, query);
    showFeedback(query, top);
    renderChips(examplesFor(location.hostname));
  }
  function showStep(target, query, stepLabel) {
    const queryTokens = new Set(tokenize(query));
    const workflow = !stepLabel && WORKFLOWS.find((w) => w.appliesTo(queryTokens, target));
    const label = stepLabel || (workflow ? "Step 1 of 2" : "");
    const message = `${label ? label + " \u2014 " : ""}Click here for "${query}".`;
    overlay.show({
      el: target.el,
      message,
      onLost: () => setStatus("That element just disappeared from the page \u2014 re-ask to re-check.", true)
    });
    if (workflow) {
      const onClick = () => {
        setStatus("Looking for the next step\u2026");
        setTimeout(() => {
          const next = workflow.findNextStep();
          if (next) {
            showStep(next, query, "Step 2 of 2");
            setStatus(`Found it: "${next.name}"`);
          } else {
            setStatus(
              "Expected a follow-up step to appear but couldn't find it \u2014 page may differ from what this demo expects.",
              true
            );
          }
        }, 350);
      };
      target.el.addEventListener("click", onClick, { capture: true, once: true });
      activeWorkflowCleanup = () => target.el.removeEventListener("click", onClick, { capture: true });
    }
  }
  buildWidget();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "HINTORA_TOGGLE") {
      root.classList.toggle("hintora-hidden");
      if (!root.classList.contains("hintora-hidden")) {
        panel.classList.remove("hintora-hidden");
        input.focus();
      } else {
        overlay.hide();
      }
    }
  });
})();
