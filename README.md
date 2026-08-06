# Hintora PoC: browser-first guidance overlay

A Chrome extension. Click the toolbar icon on any page, type what you're
trying to do, and it draws a spotlight around the real element on the page
that does that. A small local backend lets it get sharper the more it's
used. Running and reviewing the whole thing costs nothing: no signup, no
deployment.

## Try it

**1. Extension.** `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select the `extension/` folder. It's pre-built, so you
don't need Node just to try it (see [Layout](#layout) if you want to change
the source and rebuild).

**2. Backend (optional, two minutes):**

```
cd backend
npm install
npm run dev
```

Leave it running and open `http://localhost:3000`, a dashboard of confirmed
matches, empty until you use the extension. Skip this step and the
extension still works the same, just without the part described in
[Reliability loop](#reliability-loop-the-backend).

**3. Demo.** Go to any public GitHub repo, e.g. `https://github.com/facebook/react`.
Click the purple **H** icon in the toolbar; a small "Ask Hintora" panel
opens bottom-right. Try a chip, or type your own:

- "How do I download this project's code?" highlights the green **Code**
  button, then, once you actually click it, highlights **Download ZIP**
  inside the dropdown that just appeared. The one multi-step example.
- "How do I get notified about updates?" → **Watch**
- "How do I save this for later?" → **Star**
- "How do I report a bug?" → **Issues** tab
- Something it can't find, e.g. "how do I delete my account", makes it
  admit low confidence and offer alternatives instead of guessing wrong.
  Click one and it's logged as a correction.
- After any match, hit 👍. Refresh `localhost:3000` and it's there.

It isn't GitHub-specific. The matcher runs against the accessible name of
every interactive element on whatever page is open; GitHub is just the demo
target because its DOM holds still long enough to record a walkthrough.

## Layout

```
extension/            the loadable, pre-built extension (Chrome reads this)
  manifest.json         MV3, host_permissions for localhost only
  content.js             built from extension-src, do not hand-edit
  background.js          built from extension-src, do not hand-edit
  widget.css              spotlight / callout / panel styling

extension-src/         TypeScript source, the actual thing to read or edit
  content.ts              orchestrates: scan -> match -> overlay, widget UI, feedback loop
  background.ts           toolbar click relay + backend fetch relay (see below)
  lib/domScanner.ts        page understanding: interactive elements -> accessible names
  lib/matcher.ts           intent understanding: query -> ranked element matches
  lib/siteHints.ts         static per-site score boosts + example prompts
  lib/overlay.ts           spotlight/callout rendering, tracks and self-heals
  types.ts                shared interfaces
  build.mjs               esbuild config, bundles the above into extension/*.js

backend/               Next.js (TypeScript) + SQLite, the reliability store
  app/api/resolutions/route.ts   GET aggregated hints / POST a confirmation
  app/page.tsx                    dashboard of everything logged
  lib/db.ts                       SQLite connection, stands in for Postgres
```

`extension/content.js` and `background.js` are committed pre-built, so
loading the extension needs no build step. They're generated, though; the
source of truth is `extension-src/`. To rebuild after editing:

```
cd extension-src
npm install
npm run build       # writes extension/content.js and extension/background.js
npm run typecheck   # tsc --noEmit
```

## Page understanding (`domScanner.ts`)

The core idea: don't remember a CSS selector, remember what a screen reader
would say about the element. Every visible interactive element (`button`,
`a[href]`, `[role=button]`, form controls, etc.) gets an **accessible
name** computed in roughly the priority order browsers use for the
accessibility tree: `aria-label`, then `aria-labelledby`, then visible
text, then `placeholder`/`value`, then `title`, then an `alt` on a child
icon. That's the same representation a screen reader, or an
accessibility-tree-based LLM tool, would use.

One extra pass matters in practice. Some layout wrappers pick up a stray
`tabindex` or `role` and match the interactive selector even though they
just contain several other real controls (GitHub's repo header wraps
Watch/Fork/Star/Code this way). Their innerText fallback then swallows
every child's label into one garbled name. The fix is to skip any matched
element that itself contains another matched element, since a real leaf
control doesn't nest other interactive controls.

## Intent understanding (`matcher.ts`), the part that's mocked

This is the one piece the brief says doesn't need to be real AI. Instead of
an LLM call: tokenize the question, expand it with a small synonym table
(`create/new/add`, `download/export/zip`, `notify/watch/follow`, and so
on), score against each element's accessible name via token overlap plus a
substring check, weighted slightly by role.

The interface, `match(query, candidates) -> rankedResults`, is the seam a
real backend would plug into: swap the body for an API call that sends the
query plus a compact accessibility-tree snapshot to an LLM and gets back a
ranked target. Nothing else would need to change.

Where the heuristic breaks is left visible rather than papered over.
Expansion runs one direction only: the query gets synonym-expanded, a
candidate's own label doesn't. The symmetric version broke this, because a
button literally labeled "Report repository" (GitHub's abuse-report
action) inflated its own name into the whole
`report/flag/issue/bug/problem` group and outscored the real answer,
"Issues", whose label doesn't contain "report" at all. There's also no
stemming, so "issue" doesn't token-match "Issues" (plural); only a
substring check plus a per-site hint saves it. A real matcher would use
embeddings so it doesn't need a growing patch list for every
plural/synonym/homonym gap like this one.

## Reliability loop (the backend)

Three mechanisms answer "how would this get more reliable over time":

**Confidence threshold instead of best-effort guessing.** Below it, the
widget admits uncertainty and offers alternatives instead of confidently
highlighting the wrong button. A silent wrong guess erodes trust in a
guidance product faster than an honest "not sure."

**Selectors are never stored, only re-resolved.** The overlay keeps a live
DOM reference to what it found this time, plus a `MutationObserver`
watching for it to disappear. If the page re-renders it out from under the
overlay, the widget says so instead of pointing at empty space.

**Confirmed matches persist and feed back into scoring**, which is what
`backend/` is for. Every 👍/👎 and every "did you mean" correction gets
POSTed to `/api/resolutions`, SQLite-backed (swap `lib/db.ts` for a pooled
`pg` client and nothing else changes; SQLite is here so this demo needs no
signup, deployment, or cost). On load, `content.ts` asks
`GET /api/resolutions?hostname=...` for this site's confirmed history and
folds it into scoring as an extra boost, the same shape as the static
`siteHints.ts` table, just sourced from real usage instead of hardcoded.
Ask the same or a similarly-phrased question again after confirming it
once, and its score visibly jumps.

One networking detail matters here: the fetch runs from `background.ts`,
the service worker, not from `content.ts`. A content script's network
requests are subject to the host page's CSP, and GitHub's `connect-src`
almost certainly doesn't allow `localhost`. A service worker with
`host_permissions` for that origin is exempt from the page's CSP, so
`content.ts` sends a `chrome.runtime.sendMessage` to the background
script, which does the actual `fetch`. That's why `background.ts` exists
as a message relay and not just an icon-click handler.

If the backend isn't running, every one of these calls fails fast and
silently. The extension behaves exactly as if this section didn't exist;
nothing in the core demo depends on it being up.

## The one multi-step workflow

Guidance products fail the moment they think in single clicks instead of
tasks. The "download code" example is a small proof that this generalizes:
after step 1 (**Code** button) is actually clicked by the user, via a real
capture-phase click listener rather than a fake "Next" button, the
extension waits for GitHub's own dropdown to render, re-scans fresh (the
"Download ZIP" link doesn't exist in the DOM until the click happens), and
spotlights it as step 2. `WORKFLOWS` in `content.ts` is one hardcoded
entry, but the shape (trigger condition, wait for a real user action,
re-scan, next target) is what a step-graph data model would generalize to
for arbitrary flows.

## Mapping to Hintora's stack

- TypeScript, browser extensions, injected scripts, DOM understanding,
  overlays: the extension itself, `extension-src/`.
- Node, Next.js, Postgres/Supabase: `backend/`, a Next.js API route with
  SQLite standing in for Postgres/Supabase so trying this out costs
  nothing and needs no account.
- AI agents/copilots, RAG: not built as a real LLM call, since the brief
  says that isn't needed, but `matcher.ts`'s
  `(query, candidates) -> ranked matches` interface is the seam where one
  would go, and the backend's confirmed-resolutions table is the retrieval
  corpus a RAG-style version would query instead of, or alongside, the
  static hint table.

## What's next if this were the real product

- Swap `matcher.ts`'s body for the LLM call described above, so the
  callout text isn't just "Click here for '\<query\>'".
- A step-graph format for multi-step flows: a node holding an intent
  description, a resolution strategy, and an advance condition, authored
  by a customer or inferred from recorded successful task completions.
- Scope confirmed resolutions by a DOM fingerprint, not just hostname, so a
  redesign doesn't keep reinforcing a selector shape that no longer
  applies.
- Replace the toolbar-icon toggle with a customer-embeddable script tag
  (`<script src="hintora.js" data-site-id="...">`). The extension form
  factor works well for this demo, but the actual product is meant to sit
  inside thousands of other products, which means shipping as an SDK the
  customer installs, not something the end user installs themselves.
- DOM-change detection beyond "did the node get removed": track SPA route
  changes (patching `history.pushState`) so guidance survives client-side
  navigation, which GitHub, like most modern SaaS, uses heavily.
