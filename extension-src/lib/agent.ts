// "Ask the agent" mode: screenshot + web search + reasoning -> an answer,
// plus an optional pointer back at a real element on the page. Two things
// here are real: the screenshot (background.ts's HINTORA_CAPTURE_SCREENSHOT
// calls the actual chrome.tabs.captureVisibleTab) and the step-by-step
// trace (this generator really does run async, in order, with real delays
// between phases, and content.ts renders each step as it arrives rather
// than waiting for a single final response).
//
// What's mocked, the same "leave it visible, not papered over" approach as
// matcher.ts: the vision understanding, the web search, and the reasoning
// over both are a small canned lookup table instead of a model call. run()
// is the seam: (query, screenshotDataUrl) -> AsyncGenerator<AgentStep>. A
// real version would swap the body for one call to a vision-capable LLM
// given the screenshot as an image block and a web-search tool (e.g.
// Claude with the `web_search` tool), streaming its own tool-use/
// reasoning/answer events into this same step shape — nothing downstream
// of run() would need to change.
import { tokenize } from "./matcher";

export interface AgentSource {
  title: string;
  url: string;
}

export interface AgentStep {
  phase: "vision" | "search" | "reason" | "answer";
  text: string;
  sources?: AgentSource[];
  targetName?: string; // accessible name of an on-page element worth spotlighting, if the answer has one
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

const FALLBACK: Omit<AgentEntry, "triggerTokens" | "targetName"> = {
  visionNote:
    "Screenshot captured. This demo agent only reasons over a handful of scripted topics, so treat this step as a stand-in for real vision understanding.",
  searchQuery: "",
  sources: [],
  reasoning: "No canned answer matches this question closely enough to fake confidently.",
  answer:
    "This demo agent only knows a few scripted answers — try one of the example chips. A real version would send the screenshot and this question to a vision-capable LLM with a web-search tool instead of a lookup table (see the comment at the top of `lib/agent.ts`).",
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

export async function* run(query: string, screenshotDataUrl: string | null): AsyncGenerator<AgentStep> {
  const entry = pickEntry(query);
  const e = entry || FALLBACK;

  await sleep(500);
  yield {
    phase: "vision",
    text: screenshotDataUrl
      ? e.visionNote
      : "Couldn't capture a screenshot on this page (blocked page or missing permission) — reasoning on the question alone.",
  };

  await sleep(650);
  if (entry) {
    yield { phase: "search", text: `Searching the web for "${e.searchQuery}"…`, sources: e.sources };
  } else {
    yield { phase: "search", text: "No confident search query for this one — falling back to a scripted answer." };
  }

  await sleep(700);
  yield { phase: "reason", text: e.reasoning };

  await sleep(500);
  yield { phase: "answer", text: e.answer, targetName: entry?.targetName };
}
