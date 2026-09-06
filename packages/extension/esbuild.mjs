import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");
const here = path.dirname(fileURLToPath(import.meta.url));
/** UMD entry does `require("./impl/format")` at runtime; esbuild leaves that as a
 *  live require next to dist/extension.js and activate() dies. ESM uses static imports. */
const jsoncUmd = createRequire(path.join(here, "../agent-core/package.json")).resolve("jsonc-parser");
const jsoncEsm = path.join(path.dirname(jsoncUmd), "..", "esm", "main.js");

/**
 * @vscode/ripgrep 1.18 is ESM and resolves the platform binary via
 * createRequire(import.meta.url). In a CJS bundle import.meta is empty, so we
 * rewrite it to a file URL under extension/vendor — populated by package-vsix
 * (and mirrored for F5 via a junction/copy under the same relative path).
 *
 * Layout (after sync-vendor):
 *   vendor/node_modules/@vscode/ripgrep/lib/index.js
 *   vendor/node_modules/@vscode/ripgrep-<platform>-<arch>/bin/rg[.exe]
 */
const ripgrepImportMetaPlugin = {
  name: "ripgrep-import-meta-url",
  setup(build) {
    build.onLoad({ filter: /[\\/]@vscode[\\/]ripgrep[\\/]lib[\\/]index\.js$/ }, async () => {
      // Hand-rolled so createRequire does not shadow Node's require (the stock
      // file uses createRequire(import.meta.url), which breaks under CJS bundle).
      return {
        contents: `
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(
  pathToFileURL(
    path.join(
      __dirname,
      "..",
      "vendor",
      "node_modules",
      "@vscode",
      "ripgrep",
      "lib",
      "index.js",
    ),
  ).href,
);

const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
const platformPkg = \`@vscode/ripgrep-\${process.platform}-\${arch}\`;

let resolved;
try {
  resolved = require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
} catch {
  throw new Error(
    \`Could not find \${platformPkg}. \` +
      \`Ensure vendor/ is synced (npm run build) for this platform (\${process.platform}-\${arch}).\`,
  );
}

export const rgPath = resolved;
`,
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
