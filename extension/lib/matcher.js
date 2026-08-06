// "Intent understanding" layer — stands in for the real AI backend.
// Deliberately not an LLM call: tokenize the user's question, expand with a
// small synonym table, and score it against each candidate element's
// accessible name. This is the part a real product would replace with an
// embedding/LLM call over the accessibility tree — the interface below
// (query, candidates) -> ranked matches is exactly what that swap would slot
// into.
window.__hintora = window.__hintora || {};

(function () {
  const STOPWORDS = new Set([
    "a", "an", "the", "to", "do", "i", "how", "can", "could", "where",
    "is", "are", "for", "my", "this", "that", "on", "in", "of", "with",
    "get", "want", "would", "like", "please", "it", "me", "and", "up",
    "so", "does", "you", "your",
  ]);

  // Groups of words that mean roughly the same *intent* in SaaS UIs.
  // Any word in a group expands the query to include the whole group.
  const SYNONYM_GROUPS = [
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

  const SYNONYM_LOOKUP = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) SYNONYM_LOOKUP.set(word, group);
  }

  function tokenize(text) {
    return (text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOPWORDS.has(t));
  }

  function expand(tokens) {
    const expanded = new Set(tokens);
    for (const t of tokens) {
      const group = SYNONYM_LOOKUP.get(t);
      if (group) group.forEach((g) => expanded.add(g));
    }
    return expanded;
  }

  const ROLE_WEIGHT = { button: 1.2, link: 1, tab: 1, menuitem: 1, checkbox: 0.8, textbox: 0.6, generic: 0.5 };

  /**
   * @param {string} query user's raw question
   * @param {Array} candidates output of domScanner.scan()
   * @param {Function} [siteBoost] (queryTokens, candidate) => extra score
   */
  function match(query, candidates, siteBoost) {
    const queryTokens = expand(tokenize(query));
    const results = candidates.map((c) => {
      // Deliberately NOT expanded with synonyms: a button literally named
      // "Report repository" contains the word "report", which would
      // otherwise pull in unrelated words from the whole report/flag/issue/
      // bug/problem group and make it look like a strong match for "how do
      // I report a bug" — beating the real answer (the Issues tab, whose
      // literal name doesn't contain "report" at all). Expanding only the
      // user's side keeps the widening one-directional: we're generous
      // about how the user might phrase their intent, not about what a
      // button's own label secretly "means".
      const nameTokens = new Set(tokenize(c.name));
      let overlap = 0;
      for (const t of queryTokens) if (nameTokens.has(t)) overlap += 1;

      // Reward exact substring hits too (e.g. query says "fork" and the
      // element's name literally is "Fork") on top of the token overlap.
      const nameLower = c.name.toLowerCase();
      const substringHit = [...queryTokens].some((t) => t.length > 2 && nameLower.includes(t));

      let score = overlap * 2 + (substringHit ? 1 : 0);
      score *= ROLE_WEIGHT[c.role] || 1;
      if (!c.name) score -= 0.5; // unlabeled controls are a reliability risk — penalize, don't exclude

      if (siteBoost) score += siteBoost(queryTokens, c) || 0;

      return { ...c, score };
    });

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  window.__hintora.tokenize = tokenize;
  window.__hintora.match = match;
})();
