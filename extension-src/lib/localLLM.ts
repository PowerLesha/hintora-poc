// Real, local, free reasoning: Chrome's built-in on-device model (the
// "Prompt API", backed by Gemini Nano), when this browser has it enabled
// and downloaded. No API key, no network call, no cost — it runs on the
// user's machine. This is genuinely optional infrastructure: the API's
// exact shape has moved between Chrome versions (`window.ai.languageModel`
// in older builds, `self.LanguageModel` in newer ones), so every entry
// point here is probed defensively, and any failure — API missing, model
// not downloaded, a prompt that times out — is treated identically to
// "not available on this browser": a silent fall back to lib/agent.ts's
// scripted reasoning, the same fallback shape already used for the
// backend fetch and the screenshot capture elsewhere in this extension.
interface PromptSession {
  prompt(input: string): Promise<string>;
  destroy?: () => void;
}

interface DownloadProgressEvent {
  loaded: number;
}

interface CreateMonitor {
  addEventListener(type: "downloadprogress", listener: (e: DownloadProgressEvent) => void): void;
}

interface CreateOptions {
  monitor?: (m: CreateMonitor) => void;
}

interface LanguageModelLike {
  availability?: () => Promise<string>;
  capabilities?: () => Promise<{ available?: string }>;
  create: (opts?: CreateOptions) => Promise<PromptSession>;
}

function getModel(): LanguageModelLike | null {
  const g = globalThis as unknown as {
    LanguageModel?: LanguageModelLike;
    ai?: { languageModel?: LanguageModelLike };
  };
  return g.LanguageModel || g.ai?.languageModel || null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("local LLM timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Raw status string from the browser: "unavailable" (no API, or API present
// but the device doesn't qualify), "downloadable" (API present, model not
// yet fetched — nothing fetches it until something calls create()),
// "downloading" (a download is already in flight from an earlier call),
// or "available"/"readily" (ready to use right now). Older Chrome builds
// exposing only capabilities() collapse this to "available" or a status
// string that isn't one of the above.
export async function getLocalLLMStatus(): Promise<string> {
  try {
    const model = getModel();
    if (!model) return "unavailable";
    if (model.availability) return await model.availability();
    if (model.capabilities) return (await model.capabilities()).available || "unavailable";
    return "available"; // API present with no capability check exposed; let create() below be the real test
  } catch {
    return "unavailable";
  }
}

export async function isLocalLLMAvailable(): Promise<boolean> {
  const status = await getLocalLLMStatus();
  return status === "available" || status === "readily";
}

// Triggers Chrome's model download (a no-op if it's already downloaded).
// The browser doesn't fetch the model on its own — this is the only thing
// that starts it, which is why it's called explicitly from agent.ts rather
// than folded into askLocalLLM: the caller needs to show real progress for
// what can be a multi-minute, multi-hundred-MB fetch the first time.
// Returns a live progress reader (0-1) plus a promise that resolves to
// whether the model ended up ready.
export function startLocalLLMDownload(): { progress: () => number; done: Promise<boolean> } {
  const model = getModel();
  if (!model) return { progress: () => 0, done: Promise.resolve(false) };

  let loaded = 0;
  const done = model
    .create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          loaded = e.loaded;
        });
      },
    })
    .then((session) => {
      session.destroy?.();
      return true;
    })
    .catch(() => false);

  return { progress: () => loaded, done };
}

export async function askLocalLLM(prompt: string): Promise<string | null> {
  try {
    const model = getModel();
    if (!model) return null;
    const session = await withTimeout(model.create(), 8000);
    try {
      const text = await withTimeout(session.prompt(prompt), 20000);
      return text?.trim() || null;
    } finally {
      session.destroy?.();
    }
  } catch {
    return null;
  }
}
