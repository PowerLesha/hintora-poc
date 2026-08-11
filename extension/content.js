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
  var AGENT_EXAMPLES = {
    "github.com": [
      "Does this repo have any known security vulnerabilities?",
      "How do I contribute here for the first time?",
      "How do I squash my last 3 commits?",
      "Can I use this in a commercial project?"
    ]
  };
  function agentExamplesFor(hostname) {
    return AGENT_EXAMPLES[hostname] || ["Can I use this in a commercial project?", "How do I squash my last 3 commits?"];
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

  // lib/agent.ts
  var KNOWLEDGE_BASE = [
    {
      triggerTokens: ["security", "vulnerab", "cve", "dependab", "safe"],
      visionNote: "Screenshot shows a GitHub repo page with the usual tab bar (Code, Issues, Pull requests, Security\u2026).",
      searchQuery: "how to check a github repo for known dependency vulnerabilities",
      sources: [
        { title: "About Dependabot alerts", url: "docs.github.com/code-security/dependabot" },
        { title: "Viewing and updating vulnerable dependencies", url: "docs.github.com/code-security/supply-chain-security" }
      ],
      reasoning: "The page has a Security tab, which is where GitHub surfaces Dependabot alerts for known CVEs in this repo's dependency manifest.",
      answer: "Open the **Security** tab on this repo, then **Dependabot alerts** \u2014 GitHub already scans the dependency manifest for known CVEs and lists any it finds there.",
      targetName: "security"
    },
    {
      triggerTokens: ["contribute", "contributing", "firsttime", "first", "beginner", "newcomer"],
      visionNote: "Screenshot shows a public GitHub repo \u2014 contribution flow here starts from the Issues tab, not a special onboarding page.",
      searchQuery: "how to make a first open source contribution on github",
      sources: [
        { title: "How to Contribute to Open Source", url: "opensource.guide/how-to-contribute" },
        { title: "First contributions", url: "github.com/firstcontributions/first-contributions" }
      ],
      reasoning: "Most repos label a subset of open issues for newcomers; the fastest real entry point is the Issues tab filtered to that label, plus whatever CONTRIBUTING.md documents for this specific repo.",
      answer: "Check this repo's **CONTRIBUTING.md** for its specific process, then look at the **Issues** tab for anything tagged `good first issue` \u2014 that's the usual entry point for a first PR.",
      targetName: "issues"
    },
    {
      triggerTokens: ["squash", "rebase", "commit", "commits", "history", "cleanup"],
      visionNote: "This one doesn't depend on what's on screen \u2014 it's general git usage.",
      searchQuery: "how to squash the last n commits with git rebase",
      sources: [
        { title: "Git rebase \u2014 interactive mode", url: "git-scm.com/docs/git-rebase" },
        { title: "About Git rebase", url: "docs.github.com/get-started/using-git/about-git-rebase" }
      ],
      reasoning: "Squashing a fixed number of trailing commits is the textbook use of interactive rebase, not a GitHub UI feature, so the answer is a command, not a button on this page.",
      answer: "Run `git rebase -i HEAD~3`, change `pick` to `squash` (or `s`) on the commits you want folded into the one above them, save, then write the combined commit message when prompted."
    },
    {
      triggerTokens: ["license", "commercial", "permissive", "copyleft", "mit", "apache"],
      visionNote: "Screenshot shows the repo's sidebar, which usually names the license directly.",
      searchQuery: "what does this open source license allow for commercial use",
      sources: [
        { title: "Choose a License", url: "choosealicense.com" },
        { title: "Licensing a repository", url: "docs.github.com/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository" }
      ],
      reasoning: "The license named in the repo sidebar determines this, not anything specific to GitHub's own features.",
      answer: "Check the license named in the repo sidebar. Permissive licenses like **MIT** or **Apache 2.0** allow commercial use with attribution; copyleft licenses (e.g. GPL) can require you to release your own source too \u2014 read the actual license text before shipping."
    }
  ];
  var FALLBACK = {
    visionNote: "Screenshot captured. This demo agent only reasons over a handful of scripted topics, so treat this step as a stand-in for real vision understanding.",
    searchQuery: "",
    sources: [],
    reasoning: "No canned answer matches this question closely enough to fake confidently.",
    answer: "This demo agent only knows a few scripted answers \u2014 try one of the example chips. A real version would send the screenshot and this question to a vision-capable LLM with a web-search tool instead of a lookup table (see the comment at the top of `lib/agent.ts`)."
  };
  function pickEntry(query) {
    const qTokens = tokenize(query);
    let best = null;
    let bestScore = 0;
    for (const entry of KNOWLEDGE_BASE) {
      let score = 0;
      for (const t of qTokens) {
        if (entry.triggerTokens.some((trig) => t.includes(trig) || trig.includes(t))) score += 1;
      }
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function* run(query, screenshotDataUrl) {
    const entry = pickEntry(query);
    const e = entry || FALLBACK;
    await sleep(500);
    yield {
      phase: "vision",
      text: screenshotDataUrl ? e.visionNote : "Couldn't capture a screenshot on this page (blocked page or missing permission) \u2014 reasoning on the question alone."
    };
    await sleep(650);
    if (entry) {
      yield { phase: "search", text: `Searching the web for "${e.searchQuery}"\u2026`, sources: e.sources };
    } else {
      yield { phase: "search", text: "No confident search query for this one \u2014 falling back to a scripted answer." };
    }
    await sleep(700);
    yield { phase: "reason", text: e.reasoning };
    await sleep(500);
    yield { phase: "answer", text: e.answer, targetName: entry?.targetName };
  }

  // content.ts
  var CONFIDENCE_THRESHOLD = 2;
  var MARK_ICON = `<svg class="hintora-mark-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V4H10"/><path d="M14 4H20V10"/><path d="M4 14V20H10"/><path d="M20 14V20H14"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`;
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
  var modeToggleEls;
  var traceEl;
  var answerEl;
  var activeWorkflowCleanup = null;
  var mode = "page";
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
    bubble.innerHTML = MARK_ICON;
    bubble.title = "Ask Hintora";
    panel = document.createElement("div");
    panel.className = "hintora-panel hintora-hidden";
    panel.innerHTML = `
    <div class="hintora-panel-header">
      <div class="hintora-logo-mark">${MARK_ICON}</div>
      <span class="hintora-panel-header-title">Ask Hintora</span>
      <button type="button" class="hintora-icon-btn" data-close aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="hintora-panel-body">
      <div class="hintora-mode-toggle">
        <button type="button" class="hintora-mode-btn hintora-mode-active" data-mode="page">On this page</button>
        <button type="button" class="hintora-mode-btn" data-mode="agent">Ask the agent</button>
      </div>
      <div class="hintora-input-row">
        <input type="text" placeholder="What are you trying to do?" />
        <button type="button" data-send>Ask</button>
      </div>
      <div class="hintora-chips"></div>
      <div class="hintora-status"></div>
      <div class="hintora-feedback hintora-hidden"></div>
      <div class="hintora-trace hintora-hidden"></div>
      <div class="hintora-answer hintora-hidden"></div>
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
    modeToggleEls = Array.from(panel.querySelectorAll(".hintora-mode-btn"));
    traceEl = panel.querySelector(".hintora-trace");
    answerEl = panel.querySelector(".hintora-answer");
    renderChips(examplesFor(location.hostname));
    bubble.addEventListener("click", () => {
      panel.classList.toggle("hintora-hidden");
      if (!panel.classList.contains("hintora-hidden")) input.focus();
    });
    panel.querySelector("[data-close]").addEventListener("click", () => {
      panel.classList.add("hintora-hidden");
      overlay.hide();
    });
    for (const btn of modeToggleEls) {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    }
    const runActive = () => mode === "page" ? runQuery(input.value) : runAgentQuery(input.value);
    sendBtn.addEventListener("click", runActive);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runActive();
      if (e.key === "Escape") {
        panel.classList.add("hintora-hidden");
        overlay.hide();
      }
    });
  }
  function setMode(newMode) {
    mode = newMode;
    for (const btn of modeToggleEls) btn.classList.toggle("hintora-mode-active", btn.dataset.mode === newMode);
    cleanupWorkflow();
    overlay.hide();
    hideFeedback();
    traceEl.classList.add("hintora-hidden");
    traceEl.innerHTML = "";
    answerEl.classList.add("hintora-hidden");
    answerEl.innerHTML = "";
    setStatus("");
    input.value = "";
    input.placeholder = newMode === "page" ? "What are you trying to do?" : "Ask a how-to question\u2026";
    renderChips(newMode === "page" ? examplesFor(location.hostname) : agentExamplesFor(location.hostname));
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
        if (mode === "page") runQuery(ex);
        else runAgentQuery(ex);
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
  function captureScreenshot() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "HINTORA_CAPTURE_SCREENSHOT" }, (res) => resolve(res?.dataUrl || null));
    });
  }
  function addTraceStep(id, text, pending, sources) {
    const row = document.createElement("div");
    row.className = "hintora-trace-step";
    row.dataset.stepId = id;
    const icon = document.createElement("div");
    icon.className = "hintora-trace-icon";
    icon.innerHTML = pending ? `<div class="hintora-trace-spinner"></div>` : CHECK_ICON;
    const textWrap = document.createElement("div");
    const textEl = document.createElement("div");
    textEl.className = "hintora-trace-text";
    textEl.textContent = text;
    textWrap.appendChild(textEl);
    if (sources?.length) {
      const list = document.createElement("ul");
      list.className = "hintora-trace-sources";
      for (const s of sources) {
        const li = document.createElement("li");
        li.textContent = `${s.title} \u2014 ${s.url}`;
        list.appendChild(li);
      }
      textWrap.appendChild(list);
    }
    row.appendChild(icon);
    row.appendChild(textWrap);
    traceEl.appendChild(row);
  }
  function updateTraceStep(id, text) {
    const row = traceEl.querySelector(`[data-step-id="${id}"]`);
    if (!row) return;
    row.querySelector(".hintora-trace-icon").innerHTML = CHECK_ICON;
    row.querySelector(".hintora-trace-text").textContent = text;
  }
  function formatAnswer(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }
  function renderAnswer(text, targetName, query) {
    answerEl.classList.remove("hintora-hidden");
    answerEl.innerHTML = "";
    const body = document.createElement("div");
    body.innerHTML = formatAnswer(text);
    answerEl.appendChild(body);
    const caption = document.createElement("div");
    caption.className = "hintora-answer-caption";
    caption.textContent = "Search + reasoning are mocked for this demo \u2014 see lib/agent.ts.";
    answerEl.appendChild(caption);
    if (targetName) {
      const found = scan(document).find((c) => c.name.toLowerCase().includes(targetName.toLowerCase()));
      if (found) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Show me on the page";
        btn.addEventListener("click", () => showStep(found, query, "From the agent's answer"));
        answerEl.appendChild(btn);
      }
    }
  }
  async function runAgentQuery(rawQuery) {
    const query = (rawQuery || "").trim();
    if (!query) return;
    cleanupWorkflow();
    hideFeedback();
    overlay.hide();
    answerEl.classList.add("hintora-hidden");
    answerEl.innerHTML = "";
    traceEl.classList.remove("hintora-hidden");
    traceEl.innerHTML = "";
    setStatus("");
    addTraceStep("capture", "Capturing a screenshot of this tab\u2026", true);
    const screenshot = await captureScreenshot();
    updateTraceStep(
      "capture",
      screenshot ? "Captured a screenshot of this tab." : "Couldn't capture a screenshot on this page."
    );
    for await (const step of run(query, screenshot)) {
      addTraceStep(step.phase, step.text, false, step.sources);
      if (step.phase === "answer") renderAnswer(step.text, step.targetName, query);
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
