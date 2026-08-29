import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const watch = process.argv.includes("--watch");
const here = path.dirname(fileURLToPath(import.meta.url));
/** UMD entry does `require("./impl/format")` at runtime; esbuild leaves that as a
 *  live require next to dist/extension.js and activate() dies. ESM uses static imports. */
const jsoncUmd = createRequire(path.join(here, "../agent-core/package.json")).resolve("jsonc-parser");
const jsoncEsm = path.join(path.dirname(jsoncUmd), "..", "esm", "main.js");

/** @vscode/ripgrep 1.18 is ESM and resolves rg.exe via createRequire(import.meta.url).
 *  esbuild's CJS bundle would otherwise emit `var import_meta = {}` and crash activate. */
const ripgrepImportMetaPlugin = {
  name: "ripgrep-import-meta-url",
  setup(build) {
    build.onLoad({ filter: /[\\/]@vscode[\\/]ripgrep[\\/]lib[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      return {
        contents: source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(args.path).href)),
        loader: "js",
      };
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  logLevel: "info",
  alias: {
    "jsonc-parser": jsoncEsm,
  },
  plugins: [ripgrepImportMetaPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
