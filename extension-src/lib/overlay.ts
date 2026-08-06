// Renders the spotlight + callout for a resolved target, and keeps it glued
// to the element as the page moves under it (scroll, resize, re-layout) —
// and notices if the element disappears entirely, which is the main failure
// mode of "just remember a CSS selector" approaches.

interface ShowOptions {
  el: HTMLElement;
  message: string;
  onLost?: () => void;
}

let box: HTMLDivElement | null = null;
let callout: HTMLDivElement | null = null;
let calloutTextEl: HTMLDivElement | null = null;
let mo: MutationObserver | null = null;
let pollId: ReturnType<typeof setInterval> | null = null;
let currentTarget: HTMLElement | null = null;
let onLostCallback: (() => void) | null = null;

function ensureNodes(): void {
  if (box) return;
  box = document.createElement("div");
  box.className = "hintora-spotlight";

  callout = document.createElement("div");
  callout.className = "hintora-callout";
  const arrow = document.createElement("div");
  callout.appendChild(arrow);
  calloutTextEl = document.createElement("div");
  calloutTextEl.className = "hintora-callout-text";
  callout.appendChild(calloutTextEl);

  document.documentElement.appendChild(box);
  document.documentElement.appendChild(callout);
}

function place(): void {
  if (!currentTarget || !document.documentElement.contains(currentTarget)) {
    lostTarget();
    return;
  }
  const rect = currentTarget.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    lostTarget();
    return;
  }
  if (!box || !callout) return;

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

function lostTarget(): void {
  if (currentTarget && onLostCallback) onLostCallback();
  hide();
}

// Tears down whatever the *previous* show() set up. Without this, calling
// show() again (e.g. advancing to step 2 of a workflow) leaked the old
// interval/observer/listeners, which piled up across every query in a
// session — harmless individually, but each leaked MutationObserver kept
// firing on every DOM mutation on the page for as long as the tab stayed
// open.
function stopTracking(): void {
  window.removeEventListener("scroll", place, { capture: true });
  window.removeEventListener("resize", place);
  if (pollId) clearInterval(pollId);
  if (mo) mo.disconnect();
  pollId = null;
  mo = null;
}

function show({ el, message, onLost }: ShowOptions): void {
  ensureNodes();
  stopTracking();
  currentTarget = el;
  onLostCallback = onLost || null;
  if (calloutTextEl) calloutTextEl.textContent = message;
  box!.style.display = "block";
  callout!.style.display = "block";
  el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  // scrollIntoView is async/animated — placing once immediately then again
  // shortly after covers both the pre- and post-scroll position.
  place();
  setTimeout(place, 350);

  window.addEventListener("scroll", place, { passive: true, capture: true });
  window.addEventListener("resize", place, { passive: true });
  pollId = setInterval(place, 250); // catches layout shifts not driven by scroll/resize

  mo = new MutationObserver(() => {
    if (!currentTarget || !document.documentElement.contains(currentTarget)) lostTarget();
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function hide(): void {
  currentTarget = null;
  if (box) box.style.display = "none";
  if (callout) callout.style.display = "none";
  stopTracking();
}

export const overlay = { show, hide };
