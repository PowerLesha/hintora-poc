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
  var PROACTIVE = {
    "github.com": {
      message: "This looks like a GitHub repo \u2014 want me to check it for known security issues?",
      cta: "Check it",
      query: "Does this repo have any known security vulnerabilities?"
    }
  };
  function proactiveSuggestionFor(hostname) {
    return PROACTIVE[hostname] || null;
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

  // lib/localLLM.ts
  function getModel() {
    const g = globalThis;
    return g.LanguageModel || g.ai?.languageModel || null;
  }
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("local LLM timed out")), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }
  async function getLocalLLMStatus() {
    try {
      const model = getModel();
      if (!model) return "unavailable";
      if (model.availability) return await model.availability();
      if (model.capabilities) return (await model.capabilities()).available || "unavailable";
      return "available";
    } catch (e) {
      console.warn("[Hintora] LanguageModel.availability() threw:", e);
      return "unavailable";
    }
  }
  function startLocalLLMDownload() {
    const model = getModel();
    if (!model) return { progress: () => 0, done: Promise.resolve(false) };
    let loaded = 0;
    const done = model.create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          loaded = e.loaded;
        });
      }
    }).then((session) => {
      session.destroy?.();
      return true;
    }).catch(() => false);
    return { progress: () => loaded, done };
  }
  async function askLocalLLM(prompt) {
    try {
      const model = getModel();
      if (!model) return null;
      const session = await withTimeout(model.create(), 8e3);
      try {
        const text = await withTimeout(session.prompt(prompt), 2e4);
        return text?.trim() || null;
      } finally {
        session.destroy?.();
      }
    } catch {
      return null;
    }
  }

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
    reasoning: "No canned reasoning for this one, and either the on-device model isn't available on this browser or the live search didn't turn up anything to ground an answer in.",
    answer: `This demo has no scripted answer for that exact question. Try one of the example chips \u2014 or enable Chrome's on-device model ("Prompt API for Gemini Nano" in chrome://flags) and this would generate a real one instead.`
  };
  function pickEntry(query) {
    const qTokens = tokenize(query);
    let best = null;
    let bestScore = 0;
    for (const entry of KNOWLEDGE_BASE) {
      let score = 0;
      for (const t of qTokens) {
        if (t.length > 2 && entry.triggerTokens.some((trig) => t.includes(trig) || trig.includes(t))) score += 1;
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
  var ACTION_VERBS = /* @__PURE__ */ new Set([
    "click",
    "open",
    "press",
    "tap",
    "select",
    "choose",
    "download",
    "expand",
    "collapse",
    "toggle",
    "check",
    "uncheck",
    "fill",
    "type",
    "enter",
    "submit",
    "navigate",
    "switch",
    "subscribe",
    "unsubscribe",
    "follow",
    "unfollow",
    "star",
    "unstar",
    "watch",
    "unwatch",
    "close",
    "dismiss",
    "delete",
    "remove",
    "enable",
    "disable"
  ]);
  function looksLikeActionRequest(query) {
    return tokenize(query).some((t) => ACTION_VERBS.has(t));
  }
  var ACTION_MATCH_THRESHOLD = 1;
  function resolveActionTarget(name, candidates) {
    const ranked = match(name, candidates);
    const top = ranked[0];
    return top && top.score >= ACTION_MATCH_THRESHOLD ? top : null;
  }
  function parseAction(text, candidates) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const first = lines[0] || "";
    const explanation = lines.slice(1).join(" ").trim();
    const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
    const clickMatch = first.match(/^ACTION:\s*CLICK\s+(.+)$/i);
    if (clickMatch) {
      const resolved = resolveActionTarget(unquote(clickMatch[1]), candidates);
      if (!resolved) return null;
      return {
        action: { kind: "click", targetName: resolved.name, el: resolved.el },
        explanation: explanation || `Clicking "${resolved.name}" for you.`
      };
    }
    const typeMatch = first.match(/^ACTION:\s*TYPE\s+(.+?)\s+INTO\s+(.+)$/i);
    if (typeMatch) {
      const resolved = resolveActionTarget(unquote(typeMatch[2]), candidates);
      if (!resolved) return null;
      return {
        action: { kind: "type", targetName: resolved.name, el: resolved.el, value: unquote(typeMatch[1]) },
        explanation: explanation || `Typing "${unquote(typeMatch[1])}" into "${resolved.name}" for you.`
      };
    }
    return null;
  }
  function webSearch(query) {
    if (!query.trim()) return Promise.resolve([]);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "HINTORA_WEB_SEARCH", query }, (res) => {
        resolve(Array.isArray(res?.results) ? res.results : []);
      });
    });
  }
  async function* run(query, screenshotDataUrl, history = []) {
    const entry = pickEntry(query);
    await sleep(450);
    yield {
      phase: "vision",
      text: screenshotDataUrl ? entry?.visionNote || "Screenshot captured \u2014 reasoning on the question and whatever's on the page." : "Couldn't capture a screenshot on this page (blocked page, or the toolbar icon hasn't been clicked yet this tab) \u2014 reasoning on the question alone."
    };
    const searchQuery = entry?.searchQuery || query;
    const liveResults = await webSearch(searchQuery);
    const usingLive = liveResults.length > 0;
    const sources = usingLive ? liveResults.slice(0, 3).map((r) => ({ title: r.title, url: r.url })) : entry?.sources || [];
    yield {
      phase: "search",
      text: usingLive ? `Searched the web for "${searchQuery}" \u2014 found ${liveResults.length} real result${liveResults.length === 1 ? "" : "s"}.` : entry ? `Live web search didn't return anything usable for "${searchQuery}" \u2014 falling back to this demo's cached sources.` : `Live web search didn't return anything usable for "${searchQuery}", and no scripted fallback covers this question.`,
      sources
    };
    let llmStatus = await getLocalLLMStatus();
    if (llmStatus === "downloadable" || llmStatus === "after-download" || llmStatus === "downloading") {
      const { progress, done } = startLocalLLMDownload();
      let finished = false;
      done.then(() => {
        finished = true;
      });
      let lastPct = -1;
      while (!finished) {
        const pct = Math.round(progress() * 100);
        if (pct !== lastPct) {
          yield { phase: "download", text: `Downloading Chrome's on-device model (first time only) \u2014 ${pct}%\u2026`, pending: true };
          lastPct = pct;
        }
        await sleep(400);
      }
      const ready = await done;
      llmStatus = ready ? "available" : llmStatus;
      yield {
        phase: "download",
        text: ready ? "On-device model downloaded \u2014 using it for this answer." : "Model download didn't finish \u2014 falling back to scripted reasoning.",
        pending: false
      };
    }
    const llmAvailable = llmStatus === "available" || llmStatus === "readily";
    let reasoning;
    let answer;
    let action;
    if (llmAvailable && (usingLive || entry)) {
      const grounding = usingLive ? liveResults.slice(0, 3).map((r, i) => `${i + 1}. ${r.title} \u2014 ${r.snippet}`).join("\n") : entry?.reasoning || "";
      const historyBlock = history.length ? history.map((h) => `Q: ${h.query}
A: ${h.answer}`).join("\n\n") : "";
      const actionRequested = looksLikeActionRequest(query);
      const candidates = actionRequested ? scan(document).filter((c) => c.name) : [];
      const candidateList = candidates.slice(0, 40).map((c) => `- ${c.name} (${c.role})`).join("\n");
      const pageTitle = document.title.replace(/\s+/g, " ").trim().slice(0, 80);
      const prompt = [
        `You are a browser assistant helping someone on ${location.hostname || "this site"}.`,
        pageTitle ? `This page's title is: "${pageTitle}"` : "",
        historyBlock ? `Conversation so far:
${historyBlock}` : "",
        `New question: "${query}"`,
        grounding ? `Relevant information:
${grounding}` : "",
        candidateList ? [
          `Visible clickable/typeable elements on this page right now:`,
          candidateList,
          `If satisfying this request means clicking one of the elements above, reply with EXACTLY:`,
          `ACTION: CLICK <exact element text from the list>`,
          `then a one-sentence explanation on the next line.`,
          `If it means typing into one of the elements above, reply with EXACTLY:`,
          `ACTION: TYPE <text to type> INTO <exact element text from the list>`,
          `then a one-sentence explanation on the next line.`,
          `Otherwise \u2014 a plain question that isn't about interacting with this page \u2014 answer normally in 2-4 concise sentences with no ACTION line, taking the conversation above into account.`
        ].join("\n") : "Answer in 2-4 concise, actionable sentences, taking the conversation above into account. No preamble."
      ].filter(Boolean).join("\n\n");
      yield { phase: "reason", text: "Thinking through the question and the page\u2026", pending: true };
      const generated = await askLocalLLM(prompt);
      if (generated) {
        const parsed = actionRequested ? parseAction(generated, candidates) : null;
        if (parsed) {
          answer = parsed.explanation;
          action = parsed.action;
          reasoning = "Chrome's on-device model decided this needs an action on the page rather than just an answer, and picked a specific element that's actually there right now.";
        } else {
          answer = generated;
          reasoning = "Chrome's on-device model (Gemini Nano) reasoned over the question and the information above.";
        }
      } else {
        reasoning = entry?.reasoning || FALLBACK.reasoning;
        answer = entry?.answer || FALLBACK.answer;
      }
    } else {
      reasoning = entry?.reasoning || (usingLive ? "No on-device model available on this browser to reason over the live results \u2014 see the sources above." : FALLBACK.reasoning);
      answer = entry?.answer || (usingLive ? `No scripted answer for that exact question, and the local model isn't available on this browser to summarize the sources above for "${searchQuery}".` : FALLBACK.answer);
    }
    await sleep(350);
    yield { phase: "reason", text: reasoning };
    await sleep(350);
    yield { phase: "answer", text: answer, targetName: action ? void 0 : entry?.targetName, action };
  }

  // content.ts
  var CONFIDENCE_THRESHOLD = 2;
  var MARK_ICON = `<svg class="hintora-mark-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V4H10"/><path d="M14 4H20V10"/><path d="M4 14V20H10"/><path d="M20 14V20H14"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`;
  var CLOSE_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>`;
  var CHECK_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>`;
  var CROSS_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`;
  var THINKING_ICON = `<div class="hintora-thinking">${MARK_ICON}</div>`;
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
  var threadEl;
  var nudge;
  var nudgeTextEl;
  var nudgeCtaEl;
  var activeWorkflowCleanup = null;
  var conversationHistory = [];
  var mode = "agent";
  var nudgeTimer = null;
  var nudgeDismissed = false;
  var hasEngaged = false;
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
        <button type="button" class="hintora-mode-btn hintora-mode-active" data-mode="agent">Ask the agent</button>
        <button type="button" class="hintora-mode-btn" data-mode="page">On this page</button>
      </div>
      <div class="hintora-input-row">
        <input type="text" placeholder="Ask a how-to question\u2026" />
        <button type="button" data-send>Ask</button>
      </div>
      <div class="hintora-chips"></div>
      <div class="hintora-status"></div>
      <div class="hintora-feedback hintora-hidden"></div>
      <div class="hintora-thread"></div>
    </div>
  `;
    nudge = document.createElement("div");
    nudge.className = "hintora-nudge hintora-hidden";
    nudge.innerHTML = `
    <button type="button" class="hintora-icon-btn hintora-nudge-close" aria-label="Dismiss">${CLOSE_ICON}</button>
    <p class="hintora-nudge-text"></p>
    <button type="button" class="hintora-nudge-cta"></button>
  `;
    root.appendChild(nudge);
    root.appendChild(bubble);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
    input = panel.querySelector("input");
    status = panel.querySelector(".hintora-status");
    chipsEl = panel.querySelector(".hintora-chips");
    feedbackEl = panel.querySelector(".hintora-feedback");
    sendBtn = panel.querySelector("[data-send]");
    modeToggleEls = Array.from(panel.querySelectorAll(".hintora-mode-btn"));
    threadEl = panel.querySelector(".hintora-thread");
    nudgeTextEl = nudge.querySelector(".hintora-nudge-text");
    nudgeCtaEl = nudge.querySelector(".hintora-nudge-cta");
    renderChips(agentExamplesFor(location.hostname));
    nudge.querySelector(".hintora-nudge-close").addEventListener("click", () => {
      nudgeDismissed = true;
      hideNudge();
    });
    bubble.addEventListener("click", () => {
      panel.classList.toggle("hintora-hidden");
      if (!panel.classList.contains("hintora-hidden")) {
        input.focus();
        cancelNudgeTimer();
        hideNudge();
      } else {
        maybeScheduleNudge();
      }
    });
    panel.querySelector("[data-close]").addEventListener("click", () => {
      panel.classList.add("hintora-hidden");
      overlay.hide();
      maybeScheduleNudge();
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
        maybeScheduleNudge();
      }
    });
  }
  function setMode(newMode) {
    mode = newMode;
    for (const btn of modeToggleEls) btn.classList.toggle("hintora-mode-active", btn.dataset.mode === newMode);
    cleanupWorkflow();
    overlay.hide();
    hideFeedback();
    threadEl.innerHTML = "";
    conversationHistory = [];
    setStatus("");
    input.value = "";
    input.placeholder = newMode === "page" ? "What are you trying to do?" : "Ask a how-to question\u2026";
    renderChips(newMode === "page" ? examplesFor(location.hostname) : agentExamplesFor(location.hostname));
  }
  function hideNudge() {
    nudge.classList.add("hintora-hidden");
  }
  function cancelNudgeTimer() {
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }
  function showNudge(suggestion) {
    if (hasEngaged || nudgeDismissed) return;
    nudgeTextEl.textContent = suggestion.message;
    nudgeCtaEl.textContent = suggestion.cta;
    nudgeCtaEl.onclick = () => {
      hideNudge();
      panel.classList.remove("hintora-hidden");
      setMode("agent");
      input.value = suggestion.query;
      runAgentQuery(suggestion.query);
    };
    nudge.classList.remove("hintora-hidden");
  }
  function maybeScheduleNudge() {
    cancelNudgeTimer();
    if (hasEngaged || nudgeDismissed) return;
    const suggestion = proactiveSuggestionFor(location.hostname);
    if (!suggestion) return;
    nudgeTimer = setTimeout(() => showNudge(suggestion), 4e3);
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
    hasEngaged = true;
    cancelNudgeTimer();
    hideNudge();
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
  function createTurn(query) {
    const turn = document.createElement("div");
    turn.className = "hintora-turn";
    const question = document.createElement("div");
    question.className = "hintora-turn-question";
    question.textContent = query;
    turn.appendChild(question);
    const traceRoot = document.createElement("div");
    traceRoot.className = "hintora-trace";
    turn.appendChild(traceRoot);
    const answerRoot = document.createElement("div");
    answerRoot.className = "hintora-answer hintora-hidden";
    turn.appendChild(answerRoot);
    threadEl.appendChild(turn);
    threadEl.scrollTop = threadEl.scrollHeight;
    return { traceRoot, answerRoot };
  }
  function addTraceStep(traceRoot, id, text, pending, sources) {
    const row = document.createElement("div");
    row.className = "hintora-trace-step";
    row.dataset.stepId = id;
    const icon = document.createElement("div");
    icon.className = "hintora-trace-icon";
    icon.innerHTML = pendingIcon(id, pending);
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
    traceRoot.appendChild(row);
  }
  function pendingIcon(stepId, pending) {
    if (!pending) return CHECK_ICON;
    return stepId === "reason" ? THINKING_ICON : `<div class="hintora-trace-spinner"></div>`;
  }
  function updateTraceStep(traceRoot, id, text, pending = false) {
    const row = traceRoot.querySelector(`[data-step-id="${id}"]`);
    if (!row) return;
    row.querySelector(".hintora-trace-icon").innerHTML = pendingIcon(id, pending);
    row.querySelector(".hintora-trace-text").textContent = text;
  }
  function formatAnswer(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }
  function continueWorkflow(query, clickedName, statusEl) {
    const queryTokens = new Set(tokenize(query));
    const step1 = { name: clickedName };
    const workflow = WORKFLOWS.find((w) => w.appliesTo(queryTokens, step1));
    if (!workflow) return false;
    statusEl.textContent = `Done \u2014 clicked "${clickedName}". Looking for the next step\u2026`;
    setTimeout(() => {
      const next = workflow.findNextStep();
      if (!next) {
        statusEl.textContent = `Clicked "${clickedName}", but couldn't find the expected next step.`;
        return;
      }
      overlay.show({ el: next.el, message: `Doing this for you: "${next.name}"` });
      setTimeout(() => {
        next.el.click();
        statusEl.textContent = `Done \u2014 clicked "${clickedName}", then "${next.name}".`;
      }, 350);
    }, 350);
    return true;
  }
  function performAction(action, statusEl, query) {
    if (!document.documentElement.contains(action.el)) {
      statusEl.textContent = "That element disappeared from the page \u2014 the answer above may be stale, try asking again.";
      return;
    }
    overlay.show({ el: action.el, message: `Doing this for you: "${action.targetName}"` });
    statusEl.textContent = action.kind === "click" ? `Clicking "${action.targetName}"\u2026` : `Typing "${action.value}" into "${action.targetName}"\u2026`;
    setTimeout(() => {
      if (action.kind === "click") {
        action.el.click();
      } else if (action.el instanceof HTMLInputElement || action.el instanceof HTMLTextAreaElement) {
        action.el.focus();
        action.el.value = action.value || "";
        action.el.dispatchEvent(new Event("input", { bubbles: true }));
        action.el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        action.el.focus();
      }
      if (action.kind === "click") {
        if (!continueWorkflow(query, action.targetName, statusEl)) {
          statusEl.textContent = `Done \u2014 clicked "${action.targetName}".`;
        }
        return;
      }
      statusEl.textContent = `Done \u2014 typed into "${action.targetName}".`;
    }, 350);
  }
  function renderAnswer(answerRoot, text, targetName, action, query) {
    answerRoot.classList.remove("hintora-hidden");
    answerRoot.innerHTML = "";
    const body = document.createElement("div");
    body.innerHTML = formatAnswer(text);
    answerRoot.appendChild(body);
    const caption = document.createElement("div");
    caption.className = "hintora-answer-caption";
    caption.textContent = "See the trace above for exactly what ran for real vs. the scripted fallback \u2014 lib/agent.ts.";
    answerRoot.appendChild(caption);
    if (action) {
      const actionStatus = document.createElement("div");
      actionStatus.className = "hintora-answer-caption";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = action.kind === "click" ? `Do it \u2014 click "${action.targetName}"` : `Do it \u2014 fill in "${action.targetName}"`;
      btn.addEventListener("click", () => {
        btn.disabled = true;
        performAction(action, actionStatus, query);
      });
      answerRoot.appendChild(btn);
      answerRoot.appendChild(actionStatus);
    } else if (targetName) {
      const found = scan(document).find((c) => c.name.toLowerCase().includes(targetName.toLowerCase()));
      if (found) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Show me on the page";
        btn.addEventListener("click", () => showStep(found, query, "From the agent's answer"));
        answerRoot.appendChild(btn);
      }
    }
  }
  async function runAgentQuery(rawQuery) {
    const query = (rawQuery || "").trim();
    if (!query) return;
    hasEngaged = true;
    cancelNudgeTimer();
    hideNudge();
    cleanupWorkflow();
    hideFeedback();
    overlay.hide();
    setStatus("");
    input.value = "";
    const { traceRoot, answerRoot } = createTurn(query);
    addTraceStep(traceRoot, "capture", "Capturing a screenshot of this tab\u2026", true);
    const screenshot = await captureScreenshot();
    updateTraceStep(
      traceRoot,
      "capture",
      screenshot ? "Captured a screenshot of this tab." : "Couldn't capture a screenshot on this page."
    );
    let finalAnswer = "";
    for await (const step of run(query, screenshot, conversationHistory)) {
      if (step.phase !== "answer") {
        if (traceRoot.querySelector(`[data-step-id="${step.phase}"]`)) {
          updateTraceStep(traceRoot, step.phase, step.text, step.pending ?? false);
        } else {
          addTraceStep(traceRoot, step.phase, step.text, step.pending ?? false, step.sources);
        }
      }
      if (step.phase === "answer") {
        finalAnswer = step.text;
        renderAnswer(answerRoot, step.text, step.targetName, step.action, query);
      }
    }
    conversationHistory.push({ query, answer: finalAnswer });
    threadEl.scrollTop = threadEl.scrollHeight;
  }
  buildWidget();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "HINTORA_TOGGLE") {
      root.classList.toggle("hintora-hidden");
      if (!root.classList.contains("hintora-hidden")) {
        panel.classList.remove("hintora-hidden");
        input.focus();
        cancelNudgeTimer();
        hideNudge();
      } else {
        overlay.hide();
        cancelNudgeTimer();
        hideNudge();
      }
    }
  });
})();
