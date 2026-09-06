/**
 * Copy @vscode/ripgrep + host platform binary into
 * packages/extension/vendor/node_modules/@vscode/ so Node module resolution
 * from ripgrep/lib finds the sibling platform package.
 */
import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, "..");
const require = createRequire(path.join(extRoot, "package.json"));

function copyTree(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

const ripgrepEntry = require.resolve("@vscode/ripgrep");
const ripgrepRoot = path.resolve(path.dirname(ripgrepEntry), "..");
const ripgrepRequire = createRequire(path.join(ripgrepRoot, "package.json"));
const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
const platformEntry = ripgrepRequire.resolve(`${platformPkg}/bin/${binaryName}`);
const platformRoot = path.resolve(path.dirname(platformEntry), "..");
const platformFolder = platformPkg.slice("@vscode/".length);
const vendorNm = path.join(extRoot, "vendor", "node_modules", "@vscode");

rmSync(path.join(extRoot, "vendor"), { recursive: true, force: true });
copyTree(ripgrepRoot, path.join(vendorNm, "ripgrep"));
copyTree(platformRoot, path.join(vendorNm, platformFolder));
console.log(`vendor: @vscode/ripgrep + ${platformPkg}`);
