import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const outDir = resolve(here, ".build");
const outfile = resolve(outDir, "bundle.mjs");

const shim = (name, target) => {
  const dir = resolve(outDir, "node_modules/@minecraft", name);
  const path = relative(dir, resolve(here, target)).split("\\").join("/");
  return { dir, index: `export * from "${path.startsWith(".") ? path : `./${path}`}";\n`, name };
};

const shims = [shim("server", "mock-server.mjs"), shim("server-ui", "mock-ui.mjs")];

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  sourcemap: "inline",
  legalComments: "none",
  logLevel: "warning",
  external: ["@minecraft/server", "@minecraft/server-ui"],
});

await writeFile(resolve(outDir, "package.json"), '{\n  "type": "module"\n}\n');

for (const entry of shims) {
  await mkdir(entry.dir, { recursive: true });
  await writeFile(
    resolve(entry.dir, "package.json"),
    `{\n  "name": "@minecraft/${entry.dir.split("/").pop()}",\n  "version": "0.0.0-stability",\n  "type": "module",\n  "main": "index.js",\n  "exports": "./index.js"\n}\n`,
  );
  await writeFile(resolve(entry.dir, "index.js"), entry.index);
}

console.log(`[stability] bundle ${outfile}`);
