import { execFileSync } from "node:child_process";
import path from "node:path";

/** Build once; CLI tests run the real bundle (no reliance on Node's TypeScript support). */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, "..");

  execFileSync(process.execPath, [path.join(root, "scripts/build.mjs")], { stdio: "inherit", cwd: root });
}
