// Build the extension and zip it for upload to the Chrome Web Store.
//
// Usage:
//   npm run package                 # package the current version
//   npm run package -- --bump patch # bump patch|minor|major first (store needs a new version per upload)
//
// Output: release/mcp-browser-bridge-<version>.zip (manifest.json at the zip root, no source maps).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const manifestSrc = path.join(rootDir, "extension", "manifest.json");
const packageJson = path.join(rootDir, "package.json");
const distDir = path.join(rootDir, "extension", "dist");
const releaseDir = path.join(rootDir, "release");

function bump(version, part) {
  const [major, minor, patch] = version.split(".").map(Number);
  if ([major, minor, patch].some((n) => !Number.isInteger(n))) {
    throw new Error(`Cannot bump non-semver version "${version}"`);
  }
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  if (part === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`--bump must be patch, minor or major (got "${part}")`);
}

function writeJsonVersion(file, version) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

const manifest = JSON.parse(fs.readFileSync(manifestSrc, "utf8"));
let version = manifest.version;

const bumpIdx = process.argv.indexOf("--bump");
if (bumpIdx !== -1) {
  const part = process.argv[bumpIdx + 1] ?? "patch";
  version = bump(version, part);
  writeJsonVersion(manifestSrc, version);
  writeJsonVersion(packageJson, version);
  console.log(`Bumped version ${manifest.version} -> ${version}`);
}

execFileSync("npm", ["run", "build"], { cwd: rootDir, stdio: "inherit" });

const built = JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"));
if (built.version !== version) {
  throw new Error(`Built manifest version ${built.version} != expected ${version}`);
}
for (const size of [16, 48, 128]) {
  if (!fs.existsSync(path.join(distDir, "icons", `icon${size}.png`))) {
    throw new Error(`Missing icons/icon${size}.png in ${distDir}`);
  }
}

fs.mkdirSync(releaseDir, { recursive: true });
const zipPath = path.join(releaseDir, `mcp-browser-bridge-${version}.zip`);
fs.rmSync(zipPath, { force: true });
// -X drops macOS extra attributes; source maps stay out of the store build.
execFileSync("zip", ["-r", "-X", "-q", zipPath, ".", "-x", "*.map", "-x", ".DS_Store"], {
  cwd: distDir,
  stdio: "inherit",
});

const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
  .trim()
  .split("\n");
if (!listing.includes("manifest.json")) {
  throw new Error("manifest.json is not at the zip root");
}
const sizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`\nPackaged ${listing.length} files (${sizeKb} KB):\n  ${zipPath}`);
console.log(listing.map((f) => `    ${f}`).join("\n"));
