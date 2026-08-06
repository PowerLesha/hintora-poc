// DOM understanding layer. Turns the live page into a flat list of
// candidate targets, each with a name computed the way a screen reader
// would read it, instead of a CSS selector that breaks the moment a class
// name changes.
import type { Candidate } from "../types";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "summary",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  "[onclick]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (Number(style.opacity) === 0) return false;
  return true;
}

function resolveLabelledBy(el: Element): string {
  const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  if (!ids.length) return "";
  return ids
    .map((id) => document.getElementById(id)?.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ");
}

function cleanText(text: string | null | undefined): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function getFormValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return "";
}

// Approximates the accessible-name computation algorithm (simplified):
// aria-label > aria-labelledby > visible text content > value/placeholder > title > alt-on-descendant-img.
function getAccessibleName(el: HTMLElement): string {
  const ariaLabel = cleanText(el.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;

  const labelledBy = cleanText(resolveLabelledBy(el));
  if (labelledBy) return labelledBy;

  const text = cleanText(el.innerText || el.textContent);
  if (text && text.length <= 120) return text;
  if (text) return text.slice(0, 120);

  const value = cleanText(el.getAttribute("placeholder")) || cleanText(getFormValue(el));
  if (value) return value;

  const title = cleanText(el.getAttribute("title"));
  if (title) return title;

  const img = el.querySelector("img[alt], svg title");
  if (img) {
    const altText = cleanText(img.getAttribute?.("alt") || img.textContent);
    if (altText) return altText;
  }

  // Icon-only control with no recoverable name. Still returned as a
  // candidate, just a weak one: unlabeled controls are a real reliability
  // risk, not something to quietly filter out.
  return "";
}

const ROLE_BY_TAG: Record<string, string> = {
  A: "link",
  BUTTON: "button",
  INPUT: "textbox",
  SELECT: "listbox",
  TEXTAREA: "textbox",
  SUMMARY: "button",
};

function getRole(el: HTMLElement): string {
  return el.getAttribute("role") || ROLE_BY_TAG[el.tagName] || "generic";
}

/**
 * @param root Scan scope. Defaults to the whole document; callers can pass
 *   a just-opened menu or dialog to search only inside it.
 */
export function scan(root?: ParentNode): Candidate[] {
  const scope = root || document;
  const nodes = Array.from(scope.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter(
    (el) => !el.closest("#hintora-root") // skip the widget's own UI
  );
  const seen = new Set<HTMLElement>();
  const candidates: Candidate[] = [];

  for (const el of nodes) {
    if (seen.has(el) || !isVisible(el)) continue;
    // Layout wrappers sometimes carry a stray tabindex/role and match the
    // selector even though they just contain several other real controls
    // (GitHub's repo header wraps Watch/Fork/Star/Code this way). Their
    // innerText fallback then swallows every child's label into one
    // garbled name. A real leaf control doesn't nest another interactive
    // control, so skip any matched element that contains another one.
    if (nodes.some((other) => other !== el && el.contains(other))) continue;
    seen.add(el);
    candidates.push({
      el,
      name: getAccessibleName(el),
      role: getRole(el),
      rect: el.getBoundingClientRect(),
    });
  }
  return candidates;
}
