// Per-site tuning. The matcher works on ANY page with zero configuration —
// this file is the "learn a site over time" story: once Hintora has seen a
// site enough times (or a customer has configured it), small boosts push the
// generic heuristic toward the answers we already know are right, without
// hardcoding brittle CSS selectors. dynamicBoost in content.ts is the same
// idea sourced from the backend instead of hardcoded here.
import type { BoostFn } from "../types";

interface HintRule {
  tokens: string[];
  nameIncludes: string[];
  boost: number;
}

const HINTS: Record<string, HintRule[]> = {
  "github.com": [
    { tokens: ["report", "bug", "issue", "problem"], nameIncludes: ["issue"], boost: 4 },
    { tokens: ["save", "star", "favorite", "bookmark"], nameIncludes: ["star"], boost: 4 },
    { tokens: ["copy", "fork", "duplicate", "own"], nameIncludes: ["fork"], boost: 4 },
    { tokens: ["download", "export", "zip", "local"], nameIncludes: ["code"], boost: 3 },
    { tokens: ["notify", "watch", "follow", "updates", "alert"], nameIncludes: ["watch", "notifications"], boost: 4 },
    { tokens: ["download", "zip"], nameIncludes: ["download zip"], boost: 6 },
  ],
};

// Example prompts shown as quick-pick chips, per host, so the demo doesn't
// depend on the visitor guessing good phrasing on the first try.
const EXAMPLES: Record<string, string[]> = {
  "github.com": [
    "How do I download this project's code?",
    "How do I get notified about updates?",
    "How do I save this for later?",
    "How do I report a bug?",
  ],
};

export function boostFor(hostname: string): BoostFn | null {
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

export function examplesFor(hostname: string): string[] {
  return EXAMPLES[hostname] || ["How do I find the settings?", "How do I sign out?"];
}
