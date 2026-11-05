import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a script with the current Node binary, collecting stdout/stderr and the exit code. */
export function runNode(script: string, args: string[], env: Record<string, string>, stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, ...args], {
      env,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    proc.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) proc.stdin!.end(stdin);
  });
}
