// Intent understanding layer. Stands in for the real AI backend: tokenizes
// the question, expands it with a small synonym table, and scores each
// candidate's accessible name against that. A real product would replace
// this with an embedding or LLM call over the accessibility tree; the
// (query, candidates) -> ranked matches signature is the seam that swap
// would slot into.
import type { BoostFn, Candidate, RankedCandidate } from "../types";

const STOPWORDS = new Set([
  "a", "an", "the", "to", "do", "i", "how", "can", "could", "where",
  "is", "are", "for", "my", "this", "that", "on", "in", "of", "with",
  "get", "want", "would", "like", "please", "it", "me", "and", "up",
  "so", "does", "you", "your",
]);

// Groups of words that mean roughly the same *intent* in SaaS UIs.
// Any word in a group expands the query to include the whole group.
const SYNONYM_GROUPS: string[][] = [
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
  ["profile", "avatar", "picture", "account"],
];

const SYNONYM_LOOKUP = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) SYNONYM_LOOKUP.set(word, group);
}

export function tokenize(text: string | null | undefined): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function expand(tokens: string[]): Set<string> {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const group = SYNONYM_LOOKUP.get(t);
    if (group) group.forEach((g) => expanded.add(g));
  }
  return expanded;
}

const ROLE_WEIGHT: Record<string, number> = {
  button: 1.2,
  link: 1,
  tab: 1,
  menuitem: 1,
  checkbox: 0.8,
  textbox: 0.6,
  generic: 0.5,
};

export function match(
  query: string,
  candidates: Candidate[],
  siteBoost?: BoostFn | null
): RankedCandidate[] {
  const queryTokens = expand(tokenize(query));
  const results: RankedCandidate[] = candidates.map((c) => {
    // Candidate names are NOT synonym-expanded, only the query is. A button
    // literally named "Report repository" contains the word "report",
    // which under symmetric expansion pulled in the rest of the
    // report/flag/issue/bug/problem group and outscored the real answer to
    // "how do I report a bug" (the Issues tab, whose label doesn't contain
    // "report" at all). Expanding only the query side widens how the user
    // might phrase their intent without also widening what a button's own
    // label is assumed to mean.
    const nameTokens = new Set(tokenize(c.name));
    let overlap = 0;
    for (const t of queryTokens) if (nameTokens.has(t)) overlap += 1;

    // Reward exact substring hits too (e.g. query says "fork" and the
    // element's name literally is "Fork") on top of the token overlap.
    const nameLower = c.name.toLowerCase();
    const substringHit = [...queryTokens].some((t) => t.length > 2 && nameLower.includes(t));

    let score = overlap * 2 + (substringHit ? 1 : 0);
    score *= ROLE_WEIGHT[c.role] ?? 1;
    if (!c.name) score -= 0.5; // unlabeled controls are penalized, not excluded

    if (siteBoost) score += siteBoost(queryTokens, c) || 0;

    return { ...c, score };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}
