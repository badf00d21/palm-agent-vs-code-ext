/**
 * Build the extension and pack a VSIX that includes vendor/@vscode/ripgrep
 * plus the host-platform binary package.
 *
 * Output: packages/extension/palm-agent-<version>.vsix
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, "..");
const staging = path.join(extRoot, ".vsix-staging");

function copyTree(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

console.log("Building extension…");
execSync("npm run build", { cwd: extRoot, stdio: "inherit" });

const distExt = path.join(extRoot, "dist", "extension.js");
const distWeb = path.join(extRoot, "dist", "webview", "index.js");
if (!existsSync(distExt) || !existsSync(distWeb)) {
  throw new Error("Build did not produce dist/extension.js and dist/webview/index.js");
}
if (!existsSync(path.join(extRoot, "vendor", "node_modules", "@vscode", "ripgrep"))) {
  throw new Error("vendor/node_modules/@vscode/ripgrep missing after build (sync-vendor failed)");
}

console.log("Staging VSIX…");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

copyTree(path.join(extRoot, "package.json"), path.join(staging, "package.json"));
copyTree(path.join(extRoot, "media"), path.join(staging, "media"));
copyTree(path.join(extRoot, "dist"), path.join(staging, "dist"));
rmSync(path.join(staging, "dist", "extension.js.map"), { force: true });
copyTree(path.join(extRoot, "vendor"), path.join(staging, "vendor"));

const stagingPkgPath = path.join(staging, "package.json");
const stagingPkg = JSON.parse(readFileSync(stagingPkgPath, "utf8"));
stagingPkg.files = ["dist", "media", "vendor"];
delete stagingPkg.dependencies;
delete stagingPkg.devDependencies;
delete stagingPkg.scripts;
writeFileSync(stagingPkgPath, `${JSON.stringify(stagingPkg, null, 2)}\n`, "utf8");

const pkg = JSON.parse(readFileSync(path.join(extRoot, "package.json"), "utf8"));
const outPath = path.join(extRoot, `${pkg.name}-${pkg.version}.vsix`);

console.log("Running vsce package…");
execSync(
  `npm exec --yes @vscode/vsce -- package --no-dependencies --allow-missing-repository --out "${outPath}"`,
  { cwd: staging, stdio: "inherit", shell: true },
);

rmSync(staging, { recursive: true, force: true });
console.log(`Wrote ${outPath}`);
