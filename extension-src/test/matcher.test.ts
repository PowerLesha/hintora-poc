// Runs matcher.ts's pure (query, candidates) -> ranked matches function
// against a fixed snapshot of a GitHub repo header's real controls, so its
// scoring can be checked without a browser. el/rect are never read by
// match() itself, only by the caller that already resolved them.
import { match, tokenize } from "../lib/matcher";
import type { Candidate } from "../types";

// Runs under plain Node (see run.mjs), not the browser types this project's
// tsconfig otherwise scopes to — declared locally instead of pulling in
// @types/node globally, which would also apply to (and could conflict
// with) every browser file's own globals.
declare const process: { exitCode?: number };

function candidate(name: string, role = "button"): Candidate {
  return { el: null as unknown as HTMLElement, name, role, rect: null as unknown as DOMRect };
}

const candidates: Candidate[] = [
  candidate("Watch"),
  candidate("Fork"),
  candidate("Star"),
  candidate("Code"),
  candidate("Issues", "tab"),
  candidate("Pull requests", "tab"),
  candidate("Security", "tab"),
];

function top(query: string): string {
  return match(query, candidates)[0]?.name ?? "";
}

let failures = 0;
function assertEqual(actual: string, expected: string, label: string): void {
  if (actual === expected) {
    console.log(`ok - ${label}`);
  } else {
    console.error(`FAIL - ${label}: expected "${expected}", got "${actual}"`);
    failures += 1;
  }
}

assertEqual(top("how do I get notified about updates"), "Watch", "notify -> Watch");
assertEqual(top("how do I save this for later"), "Star", "save -> Star");
assertEqual(top("how do I report a bug"), "Issues", "report bug -> Issues");
assertEqual(top("how do I download this project's code"), "Code", "download -> Code");
assertEqual(top("how do I copy this repo to my own account"), "Fork", "copy -> Fork");
assertEqual(tokenize("How do I? Really!!").join(","), "really", "tokenize strips punctuation and stopwords");

if (failures > 0) {
  console.error(`\n${failures} matcher test(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall matcher tests passed");
}
