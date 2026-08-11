// Orchestrates the widget UI and wires scanner -> matcher -> overlay
// together, plus the optional reliability loop: on load it asks the local
// backend (see /backend) for past confirmed matches on this hostname, folds
// them into scoring, and reports new confirmations/corrections back. If the
// backend isn't running, all of that no-ops silently and the extension
// falls back to the static per-site hints only.
import { scan } from "./lib/domScanner";
import { match, tokenize } from "./lib/matcher";
import { boostFor, examplesFor, agentExamplesFor } from "./lib/siteHints";
import { overlay } from "./lib/overlay";
import { run as runAgent } from "./lib/agent";
import type { Candidate, DynamicHint, RankedCandidate } from "./types";

const CONFIDENCE_THRESHOLD = 2; // below this, admit uncertainty instead of guessing

// Small inline icon set (stroke-based, single weight) so the widget doesn't
// mix emoji rendering (which varies by OS) with hand-drawn glyphs.
// Same viewfinder-brackets mark as the toolbar icon (background.ts's
// drawIcon): four corner brackets around a dot, the same motif the overlay
// itself draws around a resolved element, instead of a lettermark or a
// generic arrow glyph.
const MARK_ICON = `<svg class="hintora-mark-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V4H10"/><path d="M14 4H20V10"/><path d="M4 14V20H10"/><path d="M20 14V20H14"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>`;
const CROSS_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`;

interface Workflow {
  id: string;
  appliesTo: (queryTokens: Set<string>, step1: Candidate) => boolean;
  findNextStep: () => Candidate | undefined;
}

// A small illustration of workflow steps rather than single clicks: once
// step 1 is resolved and actually clicked by the user, look for step 2
// inside whatever just appeared. A real version would store this as a
// step-graph per intent instead of one hardcoded rule.
const WORKFLOWS: Workflow[] = [
  {
    id: "download-zip",
    appliesTo: (queryTokens, step1) =>
      step1.name.toLowerCase().includes("code") &&
      ["download", "zip", "export", "local"].some((t) => queryTokens.has(t)),
    findNextStep: () => scan(document).find((c) => c.name.toLowerCase().includes("download zip")),
  },
];

let root: HTMLDivElement;
let bubble: HTMLButtonElement;
let panel: HTMLDivElement;
let input: HTMLInputElement;
let status: HTMLDivElement;
let chipsEl: HTMLDivElement;
let feedbackEl: HTMLDivElement;
let sendBtn: HTMLButtonElement;
let modeToggleEls: HTMLButtonElement[];
let traceEl: HTMLDivElement;
let answerEl: HTMLDivElement;
let activeWorkflowCleanup: (() => void) | null = null;

// "On this page" (existing DOM matcher) vs "Ask the agent" (screenshot +
// mocked web search/reasoning, see lib/agent.ts). Same input box, different
// pipeline behind Ask/Enter.
let mode: "page" | "agent" = "page";

// Past confirmed resolutions for this hostname, fetched once on load from
// the backend. Empty array (not an error state) if the backend is
// unreachable.
let dynamicHints: DynamicHint[] = [];
chrome.runtime.sendMessage({ type: "HINTORA_GET_HINTS", hostname: location.hostname }, (res) => {
  if (res?.hints) dynamicHints = res.hints;
});

function logResolution(query: string, matchedName: string, score: number, confirmed: boolean): void {
  chrome.runtime.sendMessage({
    type: "HINTORA_LOG",
    payload: { hostname: location.hostname, query, matchedName, score, confirmed },
  });
}

// Same shape as siteHints.boostFor: (queryTokens, candidate) -> bonus.
// A past confirmation counts if this query shares at least half its words
// with the one that was confirmed before, and the candidate's name looks
// like the one that got confirmed.
function dynamicBoost(queryTokens: Set<string>, candidate: Candidate): number {
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

function buildWidget(): void {
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

  input = panel.querySelector("input")!;
  status = panel.querySelector(".hintora-status")!;
  chipsEl = panel.querySelector(".hintora-chips")!;
  feedbackEl = panel.querySelector(".hintora-feedback")!;
  sendBtn = panel.querySelector("[data-send]")!;
  modeToggleEls = Array.from(panel.querySelectorAll(".hintora-mode-btn"));
  traceEl = panel.querySelector(".hintora-trace")!;
  answerEl = panel.querySelector(".hintora-answer")!;

  renderChips(examplesFor(location.hostname));

  bubble.addEventListener("click", () => {
    panel.classList.toggle("hintora-hidden");
    if (!panel.classList.contains("hintora-hidden")) input.focus();
  });
  panel.querySelector("[data-close]")!.addEventListener("click", () => {
    panel.classList.add("hintora-hidden");
    overlay.hide();
  });
  for (const btn of modeToggleEls) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode as "page" | "agent"));
  }
  const runActive = () => (mode === "page" ? runQuery(input.value) : runAgentQuery(input.value));
  sendBtn.addEventListener("click", runActive);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runActive();
    if (e.key === "Escape") {
      panel.classList.add("hintora-hidden");
      overlay.hide();
    }
  });
}

function setMode(newMode: "page" | "agent"): void {
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
  input.placeholder = newMode === "page" ? "What are you trying to do?" : "Ask a how-to question…";
  renderChips(newMode === "page" ? examplesFor(location.hostname) : agentExamplesFor(location.hostname));
}

function renderChips(examples: string[]): void {
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

// Unlike renderChips(examples), each chip here is bound to a specific
// already-scored candidate rather than plain text. Clicking one highlights
// that exact element and logs it as a correction against the original
// query, instead of re-running the matcher on the button's own label,
// which could match a different element with the same name or fail the
// confidence threshold on its own.
function renderAlternativeChips(originalQuery: string, alternatives: RankedCandidate[]): void {
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

function setStatus(text: string, isError?: boolean): void {
  status.textContent = text;
  status.classList.toggle("hintora-status-error", !!isError);
}

function hideFeedback(): void {
  feedbackEl.innerHTML = "";
  feedbackEl.classList.add("hintora-hidden");
}

function showFeedback(query: string, top: RankedCandidate): void {
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
    feedbackEl.textContent = "Thanks — remembered for next time on this site.";
  });

  const no = document.createElement("button");
  no.type = "button";
  no.className = "hintora-fb-btn hintora-fb-down";
  no.setAttribute("aria-label", "Wrong");
  no.innerHTML = CROSS_ICON;
  no.addEventListener("click", () => {
    logResolution(query, top.name, top.score, false);
    feedbackEl.textContent = "Noted — won't be reinforced.";
  });

  feedbackEl.appendChild(yes);
  feedbackEl.appendChild(no);
}

function cleanupWorkflow(): void {
  if (activeWorkflowCleanup) {
    activeWorkflowCleanup();
    activeWorkflowCleanup = null;
  }
}

function runQuery(rawQuery: string): void {
  const query = (rawQuery || "").trim();
  if (!query) return;
  cleanupWorkflow();
  hideFeedback();

  const candidates = scan(document);
  const staticBoost = boostFor(location.hostname);
  const combinedBoost = (queryTokens: Set<string>, candidate: Candidate) =>
    (staticBoost ? staticBoost(queryTokens, candidate) : 0) + dynamicBoost(queryTokens, candidate);
  const ranked = match(query, candidates, combinedBoost);
  const top = ranked[0];

  if (!top || top.score < CONFIDENCE_THRESHOLD) {
    const alternatives = ranked.slice(0, 3).filter((c) => c.name);
    overlay.hide();
    if (alternatives.length) {
      setStatus("Not confident enough to guess — did you mean:");
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

function showStep(target: Candidate, query: string, stepLabel?: string): void {
  const queryTokens = new Set(tokenize(query));
  const workflow = !stepLabel && WORKFLOWS.find((w) => w.appliesTo(queryTokens, target));
  const label = stepLabel || (workflow ? "Step 1 of 2" : "");
  const message = `${label ? label + " — " : ""}Click here for "${query}".`;

  overlay.show({
    el: target.el,
    message,
    onLost: () => setStatus("That element just disappeared from the page — re-ask to re-check.", true),
  });

  if (workflow) {
    const onClick = () => {
      setStatus("Looking for the next step…");
      setTimeout(() => {
        const next = workflow.findNextStep();
        if (next) {
          showStep(next, query, "Step 2 of 2");
          setStatus(`Found it: "${next.name}"`);
        } else {
          setStatus(
            "Expected a follow-up step to appear but couldn't find it — page may differ from what this demo expects.",
            true
          );
        }
      }, 350); // give the page's own UI (e.g. a dropdown) time to render
    };
    target.el.addEventListener("click", onClick, { capture: true, once: true });
    activeWorkflowCleanup = () => target.el.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
  }
}

// Real screenshot capture, relayed through background.ts the same way the
// backend fetch is (a content script can't call chrome.tabs.* itself).
function captureScreenshot(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "HINTORA_CAPTURE_SCREENSHOT" }, (res) => resolve(res?.dataUrl || null));
  });
}

function addTraceStep(id: string, text: string, pending: boolean, sources?: { title: string; url: string }[]): void {
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
      li.textContent = `${s.title} — ${s.url}`;
      list.appendChild(li);
    }
    textWrap.appendChild(list);
  }

  row.appendChild(icon);
  row.appendChild(textWrap);
  traceEl.appendChild(row);
}

function updateTraceStep(id: string, text: string): void {
  const row = traceEl.querySelector<HTMLDivElement>(`[data-step-id="${id}"]`);
  if (!row) return;
  row.querySelector(".hintora-trace-icon")!.innerHTML = CHECK_ICON;
  row.querySelector(".hintora-trace-text")!.textContent = text;
}

function formatAnswer(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function renderAnswer(text: string, targetName: string | undefined, query: string): void {
  answerEl.classList.remove("hintora-hidden");
  answerEl.innerHTML = "";

  const body = document.createElement("div");
  body.innerHTML = formatAnswer(text);
  answerEl.appendChild(body);

  const caption = document.createElement("div");
  caption.className = "hintora-answer-caption";
  caption.textContent = "Search + reasoning are mocked for this demo — see lib/agent.ts.";
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

async function runAgentQuery(rawQuery: string): Promise<void> {
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

  addTraceStep("capture", "Capturing a screenshot of this tab…", true);
  const screenshot = await captureScreenshot();
  updateTraceStep(
    "capture",
    screenshot ? "Captured a screenshot of this tab." : "Couldn't capture a screenshot on this page."
  );

  for await (const step of runAgent(query, screenshot)) {
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
