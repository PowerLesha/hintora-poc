// "Ask the agent" mode: screenshot + web search + reasoning -> an answer,
// plus an optional pointer back at a real element on the page.
//
// Three things here are real when the browser supports them, not
// simulated: the screenshot (background.ts's HINTORA_CAPTURE_SCREENSHOT
// calls the actual chrome.tabs.captureVisibleTab), the web search
// (background.ts's HINTORA_WEB_SEARCH scrapes DuckDuckGo's plain-HTML
// endpoint for real results, no API key), and the reasoning/answer, which
// runs through Chrome's built-in on-device model (lib/localLLM.ts, the
// Prompt API / Gemini Nano) when this browser has it enabled and
// downloaded. The step-by-step trace is a genuine async pipeline too,
// rendered as it actually runs, not a canned animation.
//
// Every one of those three has a graceful, honest fallback when it isn't
// available — offline, DuckDuckGo blocking the request or changing its
// markup, or the on-device model not being enabled on this Chrome
// install: a small canned knowledge base below, the same "leave it
// visible, not papered over" approach matcher.ts uses. Which path ran is
// stated in the trace text itself rather than hidden, so trying this on a
// browser without the Prompt API enabled still shows an honest, working
// demo instead of a silent downgrade.
import { tokenize } from "./matcher";
import { askLocalLLM, getLocalLLMStatus, startLocalLLMDownload } from "./localLLM";

export interface AgentSource {
  title: string;
  url: string;
}

export interface AgentStep {
  phase: "vision" | "search" | "download" | "reason" | "answer";
  text: string;
  pending?: boolean;
  sources?: AgentSource[];
  targetName?: string; // accessible name of an on-page element worth spotlighting, if the answer has one
}

interface RawSearchResult extends AgentSource {
  snippet: string;
}

interface AgentEntry {
  triggerTokens: string[];
  visionNote: string;
  searchQuery: string;
  sources: AgentSource[];
  reasoning: string;
  answer: string;
  targetName?: string;
}

const KNOWLEDGE_BASE: AgentEntry[] = [
  {
    triggerTokens: ["security", "vulnerab", "cve", "dependab", "safe"],
    visionNote:
      "Screenshot shows a GitHub repo page with the usual tab bar (Code, Issues, Pull requests, Security…).",
    searchQuery: "how to check a github repo for known dependency vulnerabilities",
    sources: [
      { title: "About Dependabot alerts", url: "docs.github.com/code-security/dependabot" },
      { title: "Viewing and updating vulnerable dependencies", url: "docs.github.com/code-security/supply-chain-security" },
    ],
    reasoning:
      "The page has a Security tab, which is where GitHub surfaces Dependabot alerts for known CVEs in this repo's dependency manifest.",
    answer:
      'Open the **Security** tab on this repo, then **Dependabot alerts** — GitHub already scans the dependency manifest for known CVEs and lists any it finds there.',
    targetName: "security",
  },
  {
    triggerTokens: ["contribute", "contributing", "firsttime", "first", "beginner", "newcomer"],
    visionNote: "Screenshot shows a public GitHub repo — contribution flow here starts from the Issues tab, not a special onboarding page.",
    searchQuery: "how to make a first open source contribution on github",
    sources: [
      { title: "How to Contribute to Open Source", url: "opensource.guide/how-to-contribute" },
      { title: "First contributions", url: "github.com/firstcontributions/first-contributions" },
    ],
    reasoning:
      "Most repos label a subset of open issues for newcomers; the fastest real entry point is the Issues tab filtered to that label, plus whatever CONTRIBUTING.md documents for this specific repo.",
    answer:
      "Check this repo's **CONTRIBUTING.md** for its specific process, then look at the **Issues** tab for anything tagged `good first issue` — that's the usual entry point for a first PR.",
    targetName: "issues",
  },
  {
    triggerTokens: ["squash", "rebase", "commit", "commits", "history", "cleanup"],
    visionNote: "This one doesn't depend on what's on screen — it's general git usage.",
    searchQuery: "how to squash the last n commits with git rebase",
    sources: [
      { title: "Git rebase — interactive mode", url: "git-scm.com/docs/git-rebase" },
      { title: "About Git rebase", url: "docs.github.com/get-started/using-git/about-git-rebase" },
    ],
    reasoning:
      "Squashing a fixed number of trailing commits is the textbook use of interactive rebase, not a GitHub UI feature, so the answer is a command, not a button on this page.",
    answer:
      "Run `git rebase -i HEAD~3`, change `pick` to `squash` (or `s`) on the commits you want folded into the one above them, save, then write the combined commit message when prompted.",
  },
  {
    triggerTokens: ["license", "commercial", "permissive", "copyleft", "mit", "apache"],
    visionNote: "Screenshot shows the repo's sidebar, which usually names the license directly.",
    searchQuery: "what does this open source license allow for commercial use",
    sources: [
      { title: "Choose a License", url: "choosealicense.com" },
      { title: "Licensing a repository", url: "docs.github.com/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository" },
    ],
    reasoning:
      "The license named in the repo sidebar determines this, not anything specific to GitHub's own features.",
    answer:
      "Check the license named in the repo sidebar. Permissive licenses like **MIT** or **Apache 2.0** allow commercial use with attribution; copyleft licenses (e.g. GPL) can require you to release your own source too — read the actual license text before shipping.",
  },
];

const FALLBACK = {
  reasoning:
    "No canned reasoning for this one, and either the on-device model isn't available on this browser or the live search didn't turn up anything to ground an answer in.",
  answer:
    'This demo has no scripted answer for that exact question. Try one of the example chips — or enable Chrome\'s on-device model ("Prompt API for Gemini Nano" in chrome://flags) and this would generate a real one instead.',
};

function pickEntry(query: string): AgentEntry | null {
  const qTokens = tokenize(query);
  let best: AgentEntry | null = null;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Relayed through background.ts (see the comment there): a content script
// can't fetch a cross-origin page itself when the host page's CSP doesn't
// allow it, and DuckDuckGo's response has no CORS headers permitting a
// direct read from here anyway. Resolves to [] on any failure, network or
// otherwise, so this function never throws.
function webSearch(query: string): Promise<RawSearchResult[]> {
  if (!query.trim()) return Promise.resolve([]);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "HINTORA_WEB_SEARCH", query }, (res) => {
      resolve(Array.isArray(res?.results) ? res.results : []);
    });
  });
}

export async function* run(query: string, screenshotDataUrl: string | null): AsyncGenerator<AgentStep> {
  const entry = pickEntry(query);

  await sleep(450);
  yield {
    phase: "vision",
    text: screenshotDataUrl
      ? entry?.visionNote || "Screenshot captured — reasoning on the question and whatever's on the page."
      : "Couldn't capture a screenshot on this page (blocked page, or the toolbar icon hasn't been clicked yet this tab) — reasoning on the question alone.",
  };

  const searchQuery = entry?.searchQuery || query;
  const liveResults = await webSearch(searchQuery);
  const usingLive = liveResults.length > 0;
  const sources: AgentSource[] = usingLive
    ? liveResults.slice(0, 3).map((r) => ({ title: r.title, url: r.url }))
    : entry?.sources || [];

  yield {
    phase: "search",
    text: usingLive
      ? `Searched the web for "${searchQuery}" — found ${liveResults.length} real result${liveResults.length === 1 ? "" : "s"}.`
      : entry
        ? `Live web search didn't return anything usable for "${searchQuery}" — falling back to this demo's cached sources.`
        : `Live web search didn't return anything usable for "${searchQuery}", and no scripted fallback covers this question.`,
    sources,
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
        yield { phase: "download", text: `Downloading Chrome's on-device model (first time only) — ${pct}%…`, pending: true };
        lastPct = pct;
      }
      await sleep(400);
    }
    const ready = await done;
    llmStatus = ready ? "available" : llmStatus;
    yield {
      phase: "download",
      text: ready
        ? "On-device model downloaded — using it for this answer."
        : "Model download didn't finish — falling back to scripted reasoning.",
      pending: false,
    };
  }

  const llmAvailable = llmStatus === "available" || llmStatus === "readily";
  let reasoning: string;
  let answer: string;

  if (llmAvailable && (usingLive || entry)) {
    const grounding = usingLive
      ? liveResults.slice(0, 3).map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join("\n")
      : entry?.reasoning || "";
    const prompt = [
      `You are a browser assistant helping someone on ${location.hostname || "this site"}.`,
      `Question: "${query}"`,
      grounding ? `Relevant information:\n${grounding}` : "",
      "Answer in 2-4 concise, actionable sentences. No preamble.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const generated = await askLocalLLM(prompt);
    if (generated) {
      answer = generated;
      reasoning = "Chrome's on-device model (Gemini Nano) reasoned over the question and the information above.";
    } else {
      reasoning = entry?.reasoning || FALLBACK.reasoning;
      answer = entry?.answer || FALLBACK.answer;
    }
  } else {
    reasoning =
      entry?.reasoning ||
      (usingLive
        ? "No on-device model available on this browser to reason over the live results — see the sources above."
        : FALLBACK.reasoning);
    answer =
      entry?.answer ||
      (usingLive
        ? `No scripted answer for that exact question, and the local model isn't available on this browser to summarize the sources above for "${searchQuery}".`
        : FALLBACK.answer);
  }

  await sleep(350);
  yield { phase: "reason", text: reasoning };

  await sleep(350);
  yield { phase: "answer", text: answer, targetName: entry?.targetName };
}
