// Orchestrates the widget UI and wires scanner -> matcher -> overlay
// together. This file is the only thing that would look meaningfully
// different in a real product (it would call an API instead of the local
// heuristic matcher) — everything else here is reusable as-is.
(function () {
  const { scan, match, overlay, boostFor, examplesFor } = window.__hintora;

  const CONFIDENCE_THRESHOLD = 2; // below this, admit uncertainty instead of guessing

  // A tiny illustration of "workflow steps", not just single clicks: once
  // step 1 is resolved AND actually clicked by the user, look for step 2
  // inside whatever just appeared. A real version would store this as a
  // small step-graph per intent instead of one hardcoded rule.
  const WORKFLOWS = [
    {
      id: "download-zip",
      appliesTo: (queryTokens, step1) =>
        step1.name.toLowerCase().includes("code") &&
        ["download", "zip", "export", "local"].some((t) => queryTokens.has(t)),
      findNextStep: () => scan(document).find((c) => c.name.toLowerCase().includes("download zip")),
      instruction: "Click here to download the ZIP.",
    },
  ];

  let root, bubble, panel, input, status, chipsEl, sendBtn;
  let activeWorkflowCleanup = null;

  function buildWidget() {
    if (root) return;
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
      </div>
    `;

    root.appendChild(bubble);
    root.appendChild(panel);
    document.documentElement.appendChild(root);

    input = panel.querySelector("input");
    status = panel.querySelector(".hintora-status");
    chipsEl = panel.querySelector(".hintora-chips");
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

  function setStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle("hintora-status-error", !!isError);
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

    const candidates = scan(document);
    const boost = boostFor(location.hostname);
    const ranked = match(query, candidates, boost);
    const top = ranked[0];

    if (!top || top.score < CONFIDENCE_THRESHOLD) {
      const alternatives = ranked.slice(0, 3).filter((c) => c.name);
      overlay.hide();
      if (alternatives.length) {
        setStatus("Not confident enough to guess — did you mean:");
        renderChips(alternatives.map((c) => c.name));
      } else {
        setStatus("Couldn't find anything on this page for that. Try rephrasing.", true);
      }
      return;
    }

    setStatus(`Found it: "${top.name}" (confidence score ${top.score.toFixed(1)})`);
    showStep(top, query);
    renderChips(examplesFor(location.hostname));
  }

  function showStep(target, query, stepLabel) {
    const queryTokens = new Set(window.__hintora.tokenize(query));
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
            setStatus("Expected a follow-up step to appear but couldn't find it — page may differ from what this demo expects.", true);
          }
        }, 350); // give the page's own UI (e.g. a dropdown) time to render
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
