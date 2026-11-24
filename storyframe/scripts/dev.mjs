import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const commands = [
  { name: "api", args: ["run", "dev:server"] },
  { name: "web", args: ["run", "dev:web", "--", "--host", "0.0.0.0"] },
];

const children = commands.map(({ name, args }) => {
  const child = spawn(npm, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[storyframe] ${name} process exited (${code ?? "unknown"}); stopping dev servers.`);
      shutdown(code ?? 1);
    }
  });
  return child;
});

let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
