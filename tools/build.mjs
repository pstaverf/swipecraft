import { build, context } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "packs/behavior_pack/scripts/main.js");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [resolve(root, "src/main.ts")],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  external: ["@minecraft/server", "@minecraft/server-ui"],
  sourcemap: watch,
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
};

await mkdir(dirname(outfile), { recursive: true });

if (watch) {
  const ctx = await context(options).catch((error) => {
    console.error(error);
    process.exit(1);
  });
  await ctx.watch();
  console.log("[build] watch mode, waiting for changes");
} else {
  await rm(outfile, { force: true });
  await build(options).catch((error) => {
    console.error(error);
    process.exit(1);
  });
  console.log(`[build] ${outfile}`);
}
