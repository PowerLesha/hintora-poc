// DOM "understanding" layer.
// Goal: turn the live page into a flat list of candidate targets, each with a
// human-readable name, the way a screen reader would see it — not raw CSS
// selectors, which break the moment a class name changes.
window.__hintora = window.__hintora || {};

(function () {
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
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function resolveLabelledBy(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    return ids
      .map((id) => document.getElementById(id)?.textContent?.trim() || "")
      .filter(Boolean)
      .join(" ");
  }

  function cleanText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  // Approximates the accessible-name computation algorithm (simplified):
  // aria-label > aria-labelledby > visible text content > value/placeholder > title > alt-on-descendant-img.
  function getAccessibleName(el) {
    const ariaLabel = cleanText(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;

    const labelledBy = cleanText(resolveLabelledBy(el));
    if (labelledBy) return labelledBy;

    const text = cleanText(el.innerText || el.textContent);
    if (text && text.length <= 120) return text;
    if (text) return text.slice(0, 120);

    const value = cleanText(el.getAttribute("placeholder")) || cleanText(el.value);
    if (value) return value;

    const title = cleanText(el.getAttribute("title"));
    if (title) return title;

    const img = el.querySelector("img[alt], svg title");
    if (img) {
      const altText = cleanText(img.getAttribute?.("alt") || img.textContent);
      if (altText) return altText;
    }

    // Icon-only control with no name we could recover — still a candidate,
    // just a weak one (name-less controls are exactly the reliability risk
    // called out in the brief).
    return "";
  }

  function getRole(el) {
    return (
      el.getAttribute("role") ||
      { A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "listbox", TEXTAREA: "textbox", SUMMARY: "button" }[
        el.tagName
      ] ||
      "generic"
    );
  }

  /**
   * @param {Element} [root] scan scope — defaults to the whole document, but
   *   callers can pass a just-opened menu/dialog to search only inside it.
   */
  function scan(root) {
    const scope = root || document;
    const nodes = Array.from(scope.querySelectorAll(INTERACTIVE_SELECTOR));
    const seen = new Set();
    const candidates = [];

    for (const el of nodes) {
      if (seen.has(el) || !isVisible(el)) continue;
      if (el.closest("#hintora-root")) continue; // never target our own widget
      seen.add(el);
      const name = getAccessibleName(el);
      candidates.push({
        el,
        name,
        role: getRole(el),
        rect: el.getBoundingClientRect(),
      });
    }
    return candidates;
  }

  window.__hintora.scan = scan;
})();
