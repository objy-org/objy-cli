import { spawn } from "node:child_process";

export function runProcess(command, args = [], {
  cwd = process.cwd(),
  stdio = "pipe",
  env = process.env,
  input,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio, env });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    if (child.stdin) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") reject(new Error(`${command} stdin failed: ${error.message}`));
      });
      child.stdin.end(input);
    }
    child.once("error", (error) => reject(new Error(`${command} could not be started: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = stderr.trim() || stdout.trim() || `exit ${code ?? signal}`;
      reject(new Error(`${command} ${args.join(" ")} failed: ${detail}`));
    });
  });
}

export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
