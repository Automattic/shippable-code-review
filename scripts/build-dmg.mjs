import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptDir);
const tauriDir = path.join(rootDir, "src-tauri");
const tauriConfigPath = path.join(tauriDir, "tauri.conf.json");
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));

const productName = tauriConfig.productName;
const version = tauriConfig.version;

if (!productName || !version) {
  throw new Error(`Expected productName and version in ${tauriConfigPath}`);
}

const targetArg = process.argv
  .slice(2)
  .find((a) => a.startsWith("--target="))
  ?.slice("--target=".length);

const hostTriple =
  process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const targetTriple = targetArg ?? hostTriple;

const TRIPLES = {
  "aarch64-apple-darwin": { archSuffix: "aarch64", sidecarScript: "build:sidecar" },
  "x86_64-apple-darwin": { archSuffix: "x64", sidecarScript: "build:sidecar:x64" },
};

const tripleMeta = TRIPLES[targetTriple];
if (!tripleMeta) {
  throw new Error(
    `Unsupported --target=${targetTriple}. Known: ${Object.keys(TRIPLES).join(", ")}`,
  );
}
const { archSuffix, sidecarScript } = tripleMeta;

const bundleDir = targetArg
  ? path.join(tauriDir, "target", targetTriple, "release", "bundle")
  : path.join(tauriDir, "target", "release", "bundle");
const appPath = path.join(bundleDir, "macos", `${productName}.app`);
const dmgDir = path.join(bundleDir, "dmg");
const dmgPath = path.join(dmgDir, `${productName}_${version}_${archSuffix}.dmg`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Cross-arch sidecars: ensure the matching binaries exist before cargo runs.
// The tauri beforeBuildCommand builds host-arch sidecars unconditionally;
// when targeting the other arch we need its sidecars built too.
if (targetArg && targetTriple !== hostTriple) {
  run("bun", ["run", sidecarScript], path.join(rootDir, "server"));
  run("bun", ["run", sidecarScript], path.join(rootDir, "mcp-server"));
}

const cargoArgs = ["tauri", "build", "-b", "app"];
if (targetArg) cargoArgs.push("--target", targetTriple);
if (process.env.SHIPPABLE_DEVTOOLS) {
  cargoArgs.push("--features", "devtools");
  console.log("[build-dmg] SHIPPABLE_DEVTOOLS set — enabling devtools feature");
}
run("cargo", cargoArgs, tauriDir);

if (!existsSync(appPath)) {
  throw new Error(`Expected bundled app at ${appPath}`);
}

mkdirSync(dmgDir, { recursive: true });
rmSync(dmgPath, { force: true });

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "shippable-dmg-"));
const volumeDir = path.join(tempRoot, productName);

try {
  mkdirSync(volumeDir);
  cpSync(appPath, path.join(volumeDir, `${productName}.app`), {
    recursive: true,
  });
  symlinkSync("/Applications", path.join(volumeDir, "Applications"));

  run(
    "hdiutil",
    [
      "create",
      "-volname",
      productName,
      "-srcfolder",
      volumeDir,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ],
    rootDir,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`DMG ready at ${dmgPath}`);
