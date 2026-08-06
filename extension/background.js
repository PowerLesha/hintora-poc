// Draw a purple "H" badge for the toolbar button at runtime instead of
// shipping PNG assets — no image tooling required, and it makes the button
// obvious among a toolbar full of generic gray extension icons.
function drawIcon(size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#6d5bff");
  grad.addColorStop(1, "#a084ff");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(size * 0.62)}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("H", size / 2, size / 2 + size * 0.03);
  return ctx.getImageData(0, 0, size, size);
}

async function setActionIcon() {
  try {
    const imageData = {};
    for (const size of [16, 32, 48, 128]) imageData[size] = drawIcon(size);
    await chrome.action.setIcon({ imageData });
  } catch {
    // OffscreenCanvas unavailable — toolbar keeps the generic default icon.
  }
}
setActionIcon();

// Toolbar icon click -> tell the content script on the active tab to toggle the widget.
// No "tabs"/"scripting" permission needed: sendMessage to a tab you clicked on is always allowed.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "HINTORA_TOGGLE" }, () => {
    // Reading lastError (even without acting on it) prevents Chrome from
    // logging "Unchecked runtime.lastError" when no content script is
    // present on this tab (e.g. a chrome:// page).
    void chrome.runtime.lastError;
  });
});
