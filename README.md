# Hintora PoC — browser-first guidance overlay

A small Chrome extension. Click the toolbar icon on any page, type what you're
trying to do, and it draws a spotlight around the real element on the page
that does that — no backend, no LLM call, no per-site config required to get
started.

## Try it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `extension/` folder.
2. Go to any public GitHub repo, e.g. `https://github.com/facebook/react`.
3. Click the purple **H** icon in the Chrome toolbar. A small "Ask Hintora"
   panel opens in the bottom-right corner of the page.
4. Try one of the suggested chips, or type your own:
   - "How do I download this project's code?" → highlights the green **Code**
     button, then — once you actually click it — highlights **Download ZIP**
     inside the dropdown that just appeared. That's the one deliberately
     multi-step example.
   - "How do I get notified about updates?" → **Watch**
   - "How do I save this for later?" → **Star**
   - "How do I report a bug?" → **Issues** tab
   - Try something it can't find (e.g. "how do I delete my account") — it
     should admit low confidence and offer alternatives instead of guessing
     wrong.

It isn't GitHub-specific: the matcher runs against the accessible name of
every interactive element on whatever page is open. GitHub is just the demo
target because its DOM is stable enough to record a walkthrough against.

## How it's built

```
extension/
  manifest.json        MV3, content script injected on every page (dormant
                        until toggled), no host permissions needed
  background.js        toolbar icon click -> message to the active tab
  content.js           orchestrates: scan -> match -> overlay, widget UI
  widget.css           spotlight / callout / panel styling
  lib/domScanner.js     "page understanding": interactive elements -> accessible names
  lib/matcher.js        "intent understanding": query -> ranked element matches
  lib/siteHints.js       per-site score boosts + example prompts
  lib/overlay.js         spotlight/callout rendering, tracks + self-heals
```

No build step, no dependencies — it's plain JS so anyone reviewing this can
read every line without a bundler.

### Page understanding (`domScanner.js`)

The core idea: don't remember a CSS selector, remember what a screen reader
would say about the element. I collect every interactive element (`button`,
`a[href]`, `[role=button]`, form controls, etc.) that's actually visible, and
compute an **accessible name** for it using roughly the same priority order
browsers use for the accessibility tree: `aria-label` → `aria-labelledby` →
visible text → `placeholder`/`value` → `title` → an `alt` on a child icon.

This is deliberately the same representation a screen reader or an
accessibility-tree-based LLM tool would use — which matters for the next
point.

### Intent understanding (`matcher.js`) — the part that's mocked

This is the one piece the brief says doesn't need to be real AI. Instead of
an LLM call, I tokenize the user's question, expand it with a small synonym
table (`create/new/add`, `download/export/zip`, `notify/watch/follow`, …),
and score it against each element's accessible name via token overlap +
substring match, weighted slightly by role (buttons/links favored over
generic divs).

The interface this exposes — `match(query, candidates) -> rankedResults` — is
exactly the seam where a real backend would plug in: swap the body of
`match()` for an API call that sends `{query, candidates}` (or a trimmed
accessibility-tree snapshot) to an LLM and gets back a ranked/structured
answer. Nothing else in the extension would need to change.

**Where the heuristic genuinely breaks**, and I want to be upfront about it
rather than hide it: it has no stemming, so "issue" (in my synonym table)
doesn't token-match GitHub's "Issues" tab (plural) — only a substring check
saves it, propped up further by a per-site hint. A real matcher would use
embeddings (or hand it to an LLM) precisely to not need a per-site patch list
for every plural/synonym gap. I kept the heuristic instead of stubbing in a
fake "AI" that always returns the right answer, because I'd rather show a
matcher that visibly has edges than one that fakes competence.

### Reliability over time (`siteHints.js`, confidence threshold, overlay self-heal)

Three concrete mechanisms, aimed at "how would you make this reliable":

1. **Confidence threshold, not best-effort guessing.** If the top score is
   too low, the widget says so and offers the top alternatives as chips
   instead of confidently highlighting the wrong button. Silent wrong
   guesses are worse than an honest "not sure" — they're what erodes trust in
   a guidance product fastest.
2. **Per-site score boosts as a growth path, not a crutch.** `siteHints.js`
   nudges scores for a known hostname without hardcoding a selector. In a
   real product this is what you'd persist server-side once a (site, intent)
   pair has been confirmed enough times by real usage — the generic matcher
   is always the fallback, hints just make the common cases sharper. This
   also implies a natural analytics story: log low-confidence queries and
   confirmed corrections per site, and the hint table grows itself.
3. **Selectors are never stored — only re-resolved.** The overlay never
   remembers "the 3rd button in `.header`"; it keeps a live reference to the
   DOM node it found *this time* and a `MutationObserver` watching for it to
   be removed. If the page re-renders and the element is gone, the widget
   says so explicitly rather than pointing at empty space. A production
   version would go further and re-run the matcher automatically on loss,
   with the last resolution cached as a hint for the retry.

### The one multi-step workflow

Guidance products fail the moment they think in single clicks instead of
tasks. The "download code" example is a small proof that this generalizes:
after step 1 (**Code** button) is *actually clicked* by the user (not a fake
"Next" button — a real capture-phase click listener), the extension waits for
GitHub's own dropdown to render, re-scans *fresh* (the "Download ZIP" link
doesn't exist in the DOM until the click happens), and spotlights it as step
2. `WORKFLOWS` in `content.js` is one hardcoded entry, but the shape
(`trigger condition -> wait for real user action -> re-scan -> next target`)
is what a step-graph data model would generalize to for arbitrary N-step
flows.

## What I'd build next if this were the real product

- Swap `matcher.js`'s body for a call that sends the query + a compact
  accessibility-tree snapshot (not full HTML — token budget matters) to an
  LLM, and gets back a target + a short spoken-style instruction, so the
  callout text isn't just "Click here for '\<query\>'".
- A step-graph format for multi-step flows (JSON: node = intent description +
  resolution strategy + advance condition), authored either by a customer or
  inferred from recorded successful task completions.
- Persist per-site hints + confirmed resolutions server-side, scoped by
  (hostname, intent, DOM fingerprint), so reliability compounds with usage
  instead of resetting every session.
- Replace the toolbar-icon toggle with a customer-embeddable script tag
  (`<script src="hintora.js" data-site-id="...">`) — the extension form
  factor is great for *this* demo/dogfooding, but the actual product is
  "sits inside thousands of products," which means shipping as an SDK the
  customer installs, not something the end user installs themselves.
- Real DOM-change detection beyond "did the node get removed" — track SPA
  route changes (`history.pushState` patch) so guidance survives client-side
  navigation, which GitHub, like most modern SaaS, uses heavily.
