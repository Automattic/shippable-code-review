import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptDir);
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

run(npmCmd, ["run", "build"], path.join(rootDir, "web"));
run(npmCmd, ["run", "build"], path.join(rootDir, "mcp-server"));

const server = spawn(npmCmd, ["start"], {
  cwd: path.join(rootDir, "server"),
  env: {
    ...process.env,
    SHIPPABLE_WEB_DIST: path.join("..", "web", "dist"),
  },
  stdio: "inherit",
});

server.on("error", (err) => {
  console.error(`[start] failed to run ${npmCmd} start: ${err.message}`);
  process.exit(1);
});

server.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[start] failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
