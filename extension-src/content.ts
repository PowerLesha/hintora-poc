// Orchestrates the widget UI and wires scanner -> matcher -> overlay
// together, plus the optional reliability loop: on load it asks the local
// backend (see /backend) for past confirmed matches on this hostname, folds
// them into scoring, and reports back new confirmations/corrections. If the
// backend isn't running, all of that just silently no-ops — the extension
// works exactly as it did with only the static per-site hints.
import { scan } from "./lib/domScanner";
import { match, tokenize } from "./lib/matcher";
import { boostFor, examplesFor } from "./lib/siteHints";
import { overlay } from "./lib/overlay";
import type { Candidate, DynamicHint, RankedCandidate } from "./types";

const CONFIDENCE_THRESHOLD = 2; // below this, admit uncertainty instead of guessing

interface Workflow {
  id: string;
  appliesTo: (queryTokens: Set<string>, step1: Candidate) => boolean;
  findNextStep: () => Candidate | undefined;
}

// A tiny illustration of "workflow steps", not just single clicks: once
// step 1 is resolved AND actually clicked by the user, look for step 2
// inside whatever just appeared. A real version would store this as a
// small step-graph per intent instead of one hardcoded rule.
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
let activeWorkflowCleanup: (() => void) | null = null;

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
  bubble.textContent = "H";
  bubble.title = "Ask Hintora";

  panel = document.createElement("div");
  panel.className = "hintora-panel hintora-hidden";
  panel.innerHTML = `
    <div class="hintora-panel-header">
      <span>Ask Hintora</span>
      <button type="button" data-close aria-label="Close">✕</button>
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

  input = panel.querySelector("input")!;
  status = panel.querySelector(".hintora-status")!;
  chipsEl = panel.querySelector(".hintora-chips")!;
  feedbackEl = panel.querySelector(".hintora-feedback")!;
  sendBtn = panel.querySelector("[data-send]")!;

  renderChips(examplesFor(location.hostname));

  bubble.addEventListener("click", () => {
    panel.classList.toggle("hintora-hidden");
    if (!panel.classList.contains("hintora-hidden")) input.focus();
  });
  panel.querySelector("[data-close]")!.addEventListener("click", () => {
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

function renderChips(examples: string[]): void {
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

// Unlike renderChips(examples), each chip here is bound to a specific
// already-scored candidate, not re-typed as text — clicking one highlights
// that exact element directly and logs it as a correction against the
// ORIGINAL query, rather than re-running the matcher on the button's own
// label (which could match a different element of the same name, or fail
// the confidence threshold on its own).
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
  yes.className = "hintora-fb-btn";
  yes.textContent = "👍";
  yes.addEventListener("click", () => {
    logResolution(query, top.name, top.score, true);
    feedbackEl.textContent = "Thanks — remembered for next time on this site.";
  });

  const no = document.createElement("button");
  no.type = "button";
  no.className = "hintora-fb-btn";
  no.textContent = "👎";
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
