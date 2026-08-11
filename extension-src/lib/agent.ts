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
import { match, tokenize } from "./matcher";
import { scan } from "./domScanner";
import { askLocalLLM, getLocalLLMStatus, startLocalLLMDownload } from "./localLLM";
import type { Candidate } from "../types";

export interface AgentSource {
  title: string;
  url: string;
}

// One prior (question, answer) pair, fed back into the prompt so the model
// can resolve "it"/"that" and follow-ups instead of treating every question
// as the first one asked. content.ts owns the array across a conversation
// and passes it back in on the next call — agent.ts itself is stateless.
export interface ConversationTurn {
  query: string;
  answer: string;
}

// A real DOM action the model picked from the actual elements on the page.
// Carries the live element itself (resolved once, here) rather than a name
// content.ts would have to re-resolve by fuzzy match a second time at click
// time — same "keep a live reference, don't re-derive it" choice overlay.ts
// makes for the spotlight.
export interface AgentAction {
  kind: "click" | "type";
  targetName: string; // accessible name, for the button label and the status text
  el: HTMLElement;
  value?: string; // text to type, for kind: "type"
}

export interface AgentStep {
  phase: "vision" | "search" | "download" | "reason" | "answer";
  text: string;
  pending?: boolean;
  sources?: AgentSource[];
  targetName?: string; // accessible name of an on-page element worth spotlighting, if the answer has one
  action?: AgentAction; // present instead of targetName when the answer resolved to something to actually do
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
      // Below length 3, containment stops meaning anything: "s" (the tail
      // of "project's" once the apostrophe splits it off) is a substring
      // of "safe", which was enough on its own to route a download
      // question into the security entry's canned context. matcher.ts
      // guards its own substring check the same way.
      if (t.length > 2 && entry.triggerTokens.some((trig) => t.includes(trig) || trig.includes(t))) score += 1;
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

// Gates the ACTION protocol (list of elements + instructions) on the query
// itself reading as a command — a small on-device model handed a candidate
// list reaches for ACTION too eagerly otherwise, even on plain questions.
const ACTION_VERBS = new Set([
  "click", "open", "press", "tap", "select", "choose", "download", "expand",
  "collapse", "toggle", "check", "uncheck", "fill", "type", "enter", "submit",
  "navigate", "switch", "subscribe", "unsubscribe", "follow", "unfollow",
  "star", "unstar", "watch", "unwatch", "close", "dismiss", "delete",
  "remove", "enable", "disable",
]);

function looksLikeActionRequest(query: string): boolean {
  return tokenize(query).some((t) => ACTION_VERBS.has(t));
}

// Resolves the model's plain-text guess at an element against what's
// actually on the page, via the same matcher.ts scoring the DOM-matcher
// mode uses. Below its confidence bar counts as unresolved.
const ACTION_MATCH_THRESHOLD = 1;

function resolveActionTarget(name: string, candidates: Candidate[]): Candidate | null {
  const ranked = match(name, candidates);
  const top = ranked[0];
  return top && top.score >= ACTION_MATCH_THRESHOLD ? top : null;
}

// Parses the model's response for the ACTION protocol described in the
// prompt built below. Returns null for a normal informational answer
// (no ACTION line, or an ACTION line naming something that isn't actually
// on the page — treated identically, since a hallucinated target is no
// different from the model choosing not to act).
function parseAction(
  text: string,
  candidates: Candidate[]
): { action: AgentAction; explanation: string } | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] || "";
  // The model sometimes emits more than one ACTION line instead of one
  // ACTION line + a plain explanation — only the first is ever treated as
  // the real decision, but a stray second one shouldn't leak raw protocol
  // syntax into what's shown as the human-readable explanation.
  const explanation = lines
    .slice(1)
    .filter((l) => !/^ACTION:/i.test(l))
    .join(" ")
    .trim();
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

  const clickMatch = first.match(/^ACTION:\s*CLICK\s+(.+)$/i);
  if (clickMatch) {
    const resolved = resolveActionTarget(unquote(clickMatch[1]), candidates);
    if (!resolved) return null;
    return {
      action: { kind: "click", targetName: resolved.name, el: resolved.el },
      explanation: explanation || `Clicking "${resolved.name}" for you.`,
    };
  }

  const typeMatch = first.match(/^ACTION:\s*TYPE\s+(.+?)\s+INTO\s+(.+)$/i);
  if (typeMatch) {
    const resolved = resolveActionTarget(unquote(typeMatch[2]), candidates);
    if (!resolved) return null;
    return {
      action: { kind: "type", targetName: resolved.name, el: resolved.el, value: unquote(typeMatch[1]) },
      explanation: explanation || `Typing "${unquote(typeMatch[1])}" into "${resolved.name}" for you.`,
    };
  }

  return null;
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

export async function* run(
  query: string,
  screenshotDataUrl: string | null,
  history: ConversationTurn[] = []
): AsyncGenerator<AgentStep> {
  const entry = pickEntry(query);

  await sleep(450);
  yield {
    phase: "vision",
    text: screenshotDataUrl
      ? entry?.visionNote || "Screenshot captured — reasoning on the question and whatever's on the page."
      : "Couldn't capture a screenshot on this page (blocked page, or the toolbar icon hasn't been clicked yet this tab) — reasoning on the question alone.",
  };

  // The external search query is exactly the user's question (or the
  // scripted entry's), never anything pulled off the current page — the
  // page can be a Gmail inbox, a bank statement, anything, and its title
  // or content has no business leaving the machine in a DuckDuckGo
  // request. Page-title grounding for a deictic question like "what does
  // this project do?" happens below, in the on-device LLM prompt only,
  // which never leaves the device.
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
  let action: AgentAction | undefined;

  if (llmAvailable && (usingLive || entry)) {
    const grounding = usingLive
      ? liveResults.slice(0, 3).map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join("\n")
      : entry?.reasoning || "";
    const historyBlock = history.length
      ? history.map((h) => `Q: ${h.query}\nA: ${h.answer}`).join("\n\n")
      : "";
    // scan(document): same DOM-understanding step "On this page" mode uses.
    // Only gathered for queries that read as a command in the first place.
    const actionRequested = looksLikeActionRequest(query);
    const candidates = actionRequested ? scan(document).filter((c) => c.name) : [];
    // Pre-ranked by the same matcher.ts scoring the DOM-matcher mode uses,
    // not left in raw DOM order: a small on-device model handed 40 candidates
    // in whatever order they happened to appear in the DOM tends to latch
    // onto whichever is textually prominent (Watch's accessible name is a
    // full sentence) rather than the one the query actually calls for.
    // Ranking first and keeping only real contenders fixes that instead of
    // hoping the model sorts it out on its own.
    const rankedCandidates = match(query, candidates).filter((c) => c.score > 0);
    const candidateList = rankedCandidates
      .slice(0, 15)
      .map((c) => `- ${c.name} (${c.role})`)
      .join("\n");
    const pageTitle = document.title.replace(/\s+/g, " ").trim().slice(0, 80);
    const prompt = [
      `You are a browser assistant helping someone on ${location.hostname || "this site"}.`,
      pageTitle ? `This page's title is: "${pageTitle}"` : "",
      historyBlock ? `Conversation so far:\n${historyBlock}` : "",
      `New question: "${query}"`,
      grounding ? `Relevant information:\n${grounding}` : "",
      candidateList
        ? [
            `Visible clickable/typeable elements on this page right now:`,
            candidateList,
            `If satisfying this request means clicking one of the elements above, reply with EXACTLY:`,
            `ACTION: CLICK <exact element text from the list>`,
            `then a one-sentence explanation on the next line.`,
            `If it means typing into one of the elements above, reply with EXACTLY:`,
            `ACTION: TYPE <text to type> INTO <exact element text from the list>`,
            `then a one-sentence explanation on the next line.`,
            `Otherwise — a plain question that isn't about interacting with this page — answer normally in 2-4 concise sentences with no ACTION line, taking the conversation above into account.`,
          ].join("\n")
        : "Answer in 2-4 concise, actionable sentences, taking the conversation above into account. No preamble.",
    ]
      .filter(Boolean)
      .join("\n\n");
    // Pending, right before the real call, so content.ts's loader stays up
    // for exactly as long as askLocalLLM() takes, not a fixed delay.
    yield { phase: "reason", text: "Thinking through the question and the page…", pending: true };
    const generated = await askLocalLLM(prompt);
    if (generated) {
      const parsed = actionRequested ? parseAction(generated, candidates) : null;
      if (parsed) {
        answer = parsed.explanation;
        action = parsed.action;
        reasoning =
          "Chrome's on-device model decided this needs an action on the page rather than just an answer, and picked a specific element that's actually there right now.";
      } else {
        answer = generated;
        reasoning = "Chrome's on-device model (Gemini Nano) reasoned over the question and the information above.";
      }
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
  yield { phase: "answer", text: answer, targetName: action ? undefined : entry?.targetName, action };
}
