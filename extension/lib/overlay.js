// Renders the spotlight + callout for a resolved target, and keeps it glued
// to the element as the page moves under it (scroll, resize, re-layout) —
// and notices if the element disappears entirely, which is the main failure
// mode of "just remember a CSS selector" approaches.
window.__hintora = window.__hintora || {};

(function () {
  let box, callout, arrow, mo, pollId;
  let currentTarget = null;
  let onLostCallback = null;

  function ensureNodes() {
    if (box) return;
    box = document.createElement("div");
    box.className = "hintora-spotlight";
    callout = document.createElement("div");
    callout.className = "hintora-callout";
    arrow = document.createElement("div");
    callout.appendChild(arrow);
    const text = document.createElement("div");
    text.className = "hintora-callout-text";
    callout.appendChild(text);
    callout._textEl = text;
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(callout);
  }

  function place() {
    if (!currentTarget || !document.documentElement.contains(currentTarget)) {
      lostTarget();
      return;
    }
    const rect = currentTarget.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      lostTarget();
      return;
    }
    const pad = 6;
    box.style.top = `${rect.top - pad}px`;
    box.style.left = `${rect.left - pad}px`;
    box.style.width = `${rect.width + pad * 2}px`;
    box.style.height = `${rect.height + pad * 2}px`;

    // Prefer placing the callout below the target; flip above if it would
    // run off the bottom of the viewport.
    const calloutHeight = callout.offsetHeight || 70;
    const spaceBelow = window.innerHeight - rect.bottom;
    const below = spaceBelow > calloutHeight + 16;
    const top = below ? rect.bottom + 14 : rect.top - calloutHeight - 14;
    let left = rect.left + rect.width / 2 - callout.offsetWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - callout.offsetWidth - 8));

    callout.style.top = `${Math.max(8, top)}px`;
    callout.style.left = `${left}px`;
    callout.classList.toggle("hintora-callout-above", !below);
  }

  function lostTarget() {
    if (currentTarget && onLostCallback) onLostCallback();
    hide();
  }

  function show({ el, message, onLost }) {
    ensureNodes();
    currentTarget = el;
    onLostCallback = onLost || null;
    callout._textEl.textContent = message;
    box.style.display = "block";
    callout.style.display = "block";
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    // scrollIntoView is async/animated — placing once immediately then again
    // shortly after covers both the pre- and post-scroll position.
    place();
    setTimeout(place, 350);

    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place, { passive: true });
    pollId = setInterval(place, 250); // catches layout shifts not driven by scroll/resize

    mo = new MutationObserver(() => {
      if (!document.documentElement.contains(currentTarget)) lostTarget();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function hide() {
    currentTarget = null;
    if (box) box.style.display = "none";
    if (callout) callout.style.display = "none";
    window.removeEventListener("scroll", place, { capture: true });
    window.removeEventListener("resize", place);
    if (pollId) clearInterval(pollId);
    if (mo) mo.disconnect();
  }

  window.__hintora.overlay = { show, hide };
})();
