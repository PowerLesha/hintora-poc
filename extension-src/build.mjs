import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "..", "extension");

await esbuild.build({
  entryPoints: [path.join(here, "content.ts"), path.join(here, "background.ts")],
  bundle: true,
  outdir,
  format: "iife",
  target: ["chrome110"],
  sourcemap: false,
  logLevel: "info",
});

console.log("Built extension-src/*.ts -> extension/{content,background}.js");
