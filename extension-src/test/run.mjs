// Bundles matcher.test.ts with esbuild (the same tool build.mjs already
// uses) and runs it under plain Node, so the matcher's ranking is checked
// without spinning up a browser or adding a test framework dependency.
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, ".matcher.test.mjs");

await esbuild.build({
  entryPoints: [path.join(here, "matcher.test.ts")],
  bundle: true,
  outfile,
  format: "esm",
  platform: "node",
  target: ["node18"],
  logLevel: "warning",
});

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
fs.rmSync(outfile, { force: true });
process.exit(result.status ?? 1);
