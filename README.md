# Hintora PoC — browser-first guidance overlay

A Chrome extension. Click the toolbar icon on any page, type what you're
trying to do, and it draws a spotlight around the real element on the page
that does that. A small local backend lets it get sharper the more it's
used — the whole thing needs zero cost, zero signup, and zero deployment
to run and review.

## Try it

**1. Extension** — `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select the `extension/` folder. (It's pre-built; you
don't need Node to just try it — see [Layout](#layout) below if you want to
change the source and rebuild.)

**2. Backend (optional, but worth the two minutes)**:

```
cd backend
npm install
npm run dev
```

Leave it running and open `http://localhost:3000` — a dashboard of
confirmed matches, empty until you use the extension. If you skip this
step entirely, the extension still works exactly the same, just without
the "gets sharper with usage" part (see [Reliability loop](#reliability-loop-the-backend) below).

**3. Demo**: go to any public GitHub repo, e.g. `https://github.com/facebook/react`.
Click the purple **H** icon in the Chrome toolbar — a small "Ask Hintora"
panel opens bottom-right. Try a chip, or type your own:

- "How do I download this project's code?" → highlights the green **Code**
  button, then — once you actually click it — highlights **Download ZIP**
  inside the dropdown that just appeared. The one deliberately multi-step
  example.
- "How do I get notified about updates?" → **Watch**
- "How do I save this for later?" → **Star**
- "How do I report a bug?" → **Issues** tab
- Something it can't find (e.g. "how do I delete my account") → admits low
  confidence and offers alternatives instead of guessing wrong. Click one
  and it's logged as a correction.
- After any match, hit 👍 — refresh `localhost:3000` and it's there.

It isn't GitHub-specific: the matcher runs against the accessible name of
every interactive element on whatever page is open. GitHub is just the demo
target because its DOM is stable enough to record a walkthrough against.

## Layout

```
extension/            the loadable, pre-built extension (Chrome reads this)
  manifest.json         MV3, host_permissions for localhost only
  content.js             ← built from extension-src (bundled, do not hand-edit)
  background.js          ← built from extension-src (bundled, do not hand-edit)
  widget.css              spotlight / callout / panel styling

extension-src/         TypeScript source — this is what to actually read/edit
  content.ts              orchestrates: scan -> match -> overlay, widget UI, feedback loop
  background.ts           toolbar click relay + backend fetch relay (see below)
  lib/domScanner.ts        "page understanding": interactive elements -> accessible names
  lib/matcher.ts           "intent understanding": query -> ranked element matches
  lib/siteHints.ts         static per-site score boosts + example prompts
  lib/overlay.ts           spotlight/callout rendering, tracks + self-heals
  types.ts                shared interfaces
  build.mjs               esbuild: bundles the above into extension/*.js

backend/               Next.js (TypeScript) + SQLite — the reliability store
  app/api/resolutions/route.ts   GET aggregated hints / POST a confirmation
  app/page.tsx                    dashboard of everything logged
  lib/db.ts                       SQLite connection (stands in for Postgres)
```

`extension/content.js` and `background.js` are committed pre-built so
loading the extension needs no build step at all — but they're generated;
the source of truth is `extension-src/`. To rebuild after editing:

```
cd extension-src
npm install
npm run build       # -> writes extension/content.js and extension/background.js
npm run typecheck   # tsc --noEmit
```

## Page understanding (`domScanner.ts`)

The core idea: don't remember a CSS selector, remember what a screen reader
would say about the element. Every interactive element (`button`, `a[href]`,
`[role=button]`, form controls, etc.) that's actually visible gets an
**accessible name** computed in roughly the same priority order browsers use
for the accessibility tree: `aria-label` → `aria-labelledby` → visible text →
`placeholder`/`value` → `title` → an `alt` on a child icon. That's the same
representation a screen reader — or an accessibility-tree-based LLM tool —
would use.

One extra pass matters in practice: some layout wrappers pick up a stray
`tabindex`/`role` and end up matching the interactive selector even though
they just *contain* several other real controls (GitHub's repo-header
toolbar wraps Watch/Fork/Star/Code this way). Their innerText fallback then
swallows every child's label into one garbled name. Fix: skip any matched
element that itself contains another matched element — real leaf controls
don't nest other interactive controls.

## Intent understanding (`matcher.ts`) — the part that's mocked

This is the one piece the brief says doesn't need to be real AI. Instead of
an LLM call: tokenize the question, expand it with a small synonym table
(`create/new/add`, `download/export/zip`, `notify/watch/follow`, …), score
against each element's accessible name via token overlap + substring match,
weighted slightly by role.

The interface — `match(query, candidates) -> rankedResults` — is exactly the
seam a real backend would plug into: swap the body for an API call that
sends the query + a compact accessibility-tree snapshot to an LLM and gets
back a ranked target. Nothing else would need to change.

**Where the heuristic genuinely breaks**, on purpose left visible rather than
patched into looking smarter than it is: expansion is one-directional (only
the *query* gets synonym-expanded, not a candidate's own label) specifically
because the symmetric version broke — a button literally labeled
"Report repository" (GitHub's abuse-report action) would inflate its own
name into the whole `report/flag/issue/bug/problem` group and outscore the
real answer ("Issues", whose label doesn't contain "report" at all). There's
also no stemming, so "issue" doesn't token-match "Issues" (plural) — only a
substring check plus a per-site hint saves it. A real matcher would use
embeddings precisely to not need a growing patch list for every
plural/synonym/homonym gap like this.

## Reliability loop (the backend)

Three layers, each a concrete answer to "how would you make this reliable
over time":

1. **Confidence threshold, not best-effort guessing.** Below it, the widget
   admits uncertainty and offers alternatives instead of confidently
   highlighting the wrong button. A silent wrong guess erodes trust in a
   guidance product faster than an honest "not sure."
2. **Selectors are never stored — only re-resolved.** The overlay keeps a
   live DOM reference to what it found *this time* plus a `MutationObserver`
   watching for it to disappear. If the page re-renders it out from under
   the overlay, the widget says so rather than pointing at empty space.
3. **Confirmed matches persist and feed back into scoring** — this is the
   part that used to be just a paragraph in this README and is now the
   `backend/` app: every 👍/👎 and every "did you mean" correction gets
   POSTed to `/api/resolutions` (SQLite-backed — swap `lib/db.ts` for a
   pooled `pg` client and nothing else changes; SQLite is here purely so
   this demo needs no signup/deployment/cost). On load, `content.ts` asks
   `GET /api/resolutions?hostname=...` for this site's confirmed history and
   folds it into scoring as an extra boost — the exact same shape as the
   static `siteHints.ts` table, just sourced from real usage instead of
   hardcoded by me. Ask the same (or a similarly-phrased) question again
   after confirming it once, and its score visibly jumps.

   One networking wrinkle worth calling out because it's easy to get wrong:
   this fetch runs from `background.ts` (the service worker), not from
   `content.ts`. A content script's network requests are subject to the
   *host page's* CSP — GitHub's `connect-src` almost certainly doesn't
   allow `localhost`. A service worker with `host_permissions` for that
   origin is exempt from the page's CSP entirely, so `content.ts` sends
   `chrome.runtime.sendMessage` to the background script, which does the
   actual `fetch`. That's the whole reason `background.ts` exists as a
   message relay and not just an icon-click handler.

   If the backend isn't running, every one of these calls fails fast and
   silently — the extension behaves exactly as if this section didn't
   exist. Nothing about the core demo depends on it being up.

## The one multi-step workflow

Guidance products fail the moment they think in single clicks instead of
tasks. The "download code" example proves this generalizes: after step 1
(**Code** button) is *actually clicked* by the user (a real capture-phase
click listener, not a fake "Next" button), the extension waits for GitHub's
own dropdown to render, re-scans *fresh* (the "Download ZIP" link doesn't
exist in the DOM until the click happens), and spotlights it as step 2.
`WORKFLOWS` in `content.ts` is one hardcoded entry, but the shape
(`trigger condition -> wait for real user action -> re-scan -> next target`)
is what a step-graph data model would generalize to for arbitrary N-step
flows.

## Mapping to Hintora's stack

- **TypeScript, browser extensions, injected scripts, DOM understanding,
  overlays** — the extension itself, `extension-src/`.
- **Node, Next.js, Postgres/Supabase** — `backend/`, a Next.js API route +
  SQLite standing in for Postgres/Supabase specifically so trying this out
  costs nothing and needs no account.
- **AI agents/copilots, RAG** — deliberately *not* built as a real LLM call
  (the brief says this isn't needed), but `matcher.ts`'s
  `(query, candidates) -> ranked matches` interface is exactly the seam
  where one would go, and the backend's confirmed-resolutions table is the
  retrieval corpus a RAG-style version would query instead of (or alongside)
  the static hint table.

## What I'd build next if this were the real product

- Swap `matcher.ts`'s body for the LLM call described above, so the callout
  text isn't just "Click here for '\<query\>'".
- A step-graph format for multi-step flows (JSON: node = intent description
  + resolution strategy + advance condition), authored by a customer or
  inferred from recorded successful task completions.
- Scope confirmed resolutions by a DOM fingerprint, not just hostname, so a
  redesign doesn't silently keep reinforcing a selector-shape that no longer
  applies.
- Replace the toolbar-icon toggle with a customer-embeddable script tag
  (`<script src="hintora.js" data-site-id="...">`) — the extension form
  factor is great for *this* demo/dogfooding, but the actual product is
  "sits inside thousands of products," which means shipping as an SDK the
  customer installs, not something the end user installs themselves.
- Real DOM-change detection beyond "did the node get removed" — track SPA
  route changes (`history.pushState` patch) so guidance survives client-side
  navigation, which GitHub, like most modern SaaS, uses heavily.
