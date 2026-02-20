import { spawn } from "child_process";
import { realpathSync } from "fs";

const HOME = process.env.HOME || "/root";
const CLAUDE_BIN = realpathSync(`${HOME}/.local/bin/claude`);

console.log(`Using: ${CLAUDE_BIN}`);

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_SSE_PORT;
delete env.CLAUDE_CODE_ENTRYPOINT;

// Log all CLAUDE* env vars
for (const [k, v] of Object.entries(env)) {
  if (k.toUpperCase().includes("CLAUDE")) {
    console.log(`  env ${k}=${v}`);
  }
}

console.log("Spawning with inherited stdio...");

const child = spawn(CLAUDE_BIN, [
  "-p", "hi",
  "--output-format", "json",
  "--dangerously-skip-permissions",
  "--model", "claude-opus-4-6",
], { env, stdio: "inherit" });

child.on("exit", (code) => {
  console.log(`Exited with code ${code}`);
});
